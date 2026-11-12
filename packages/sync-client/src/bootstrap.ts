/**
 * Cold start (SPEC-002 §3.1): stream `GET /sync/bootstrap`, validate each frame
 * and row, store rows in chunks, and fill the pool as they arrive.
 *
 * Re-bootstrapping over a populated pool (resync, E7/E8) replaces rows in
 * place and, at the end, drops base rows the server no longer sent. Overlays
 * and pending mutations are untouched.
 */
import type { ModelRow } from '@surface/domain/model';
import type { BootstrapMeta, SyncGroup } from '@surface/sync-protocol';
import {
  BOOTSTRAP_PATH,
  encodeBootstrapQuery,
  NdjsonDecoder,
  ProtocolError,
  decodeBootstrapFrame,
} from '@surface/sync-protocol';
import type { Persistence } from './persistence.js';
import type { BootstrapRecord } from './storage/types.js';
import type { ObjectPool } from './pool.js';
import type { Timers } from './socket.js';
import { globalTimers } from './socket.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BootstrapProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface BootstrapOptions {
  readonly fetch: FetchLike;
  /** Origin and base path of the server; `''` for same-origin. */
  readonly baseUrl: string;
  /** The user this replica belongs to; the server refuses another session (SPEC-002 E14). */
  readonly userId: string;
  readonly schemaHash: string;
  readonly pool: ObjectPool;
  readonly persistence: Persistence;
  /** Rows per storage write and pool batch (SPEC-002 §3.1: 1,000). */
  readonly chunkSize?: number;
  readonly onProgress?: (progress: BootstrapProgress) => void;
  readonly signal?: AbortSignal;
  /** For the response deadline; defaults to the global timers. */
  readonly timers?: Timers;
}

/**
 * How long the bootstrap response may take to start, as for a mutate request
 * (sync-protocol.md §4.4). Rows that follow may take longer: a large workspace
 * streams for seconds (SPEC-002 AC-8), and the body read stops on `signal`.
 */
export const BOOTSTRAP_RESPONSE_TIMEOUT_MS = 30_000;

export interface BootstrapResult {
  readonly lastSyncId: number;
  readonly groups: readonly SyncGroup[];
  readonly rows: number;
  /** The generation this tab writes rows to, or `undefined` if storage failed or was fenced. */
  readonly generation: string | undefined;
}

/** The server runs a different schema: the client must reload (SPEC-002 E7). */
export class ClientOutdatedError extends Error {
  override readonly name = 'ClientOutdatedError';
  constructor() {
    super('Surface was updated. Reload the page to continue.');
  }
}

/** The bootstrap request failed; `status` is the HTTP status when there was a response. */
export class BootstrapFailedError extends Error {
  override readonly name = 'BootstrapFailedError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const DEFAULT_CHUNK_SIZE = 1000;

/**
 * The bootstrap request, abandoned when its response has not started within
 * the deadline: a server that never answers would otherwise leave the store
 * `bootstrapping` for good, and block every later start or resync.
 */
async function request(options: BootstrapOptions): Promise<Response> {
  const timers = options.timers ?? globalTimers;
  const controller = new AbortController();
  const outer = options.signal;
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  const deadline = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BOOTSTRAP_RESPONSE_TIMEOUT_MS);
  try {
    const query = encodeBootstrapQuery({ userId: options.userId });
    return await options.fetch(`${options.baseUrl}${BOOTSTRAP_PATH}?${query}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/x-ndjson' },
      signal: controller.signal,
    });
  } catch (error) {
    if (!timedOut) throw error;
    throw new BootstrapFailedError(
      'The server did not answer within 30 seconds. Check your connection and try again.',
    );
  } finally {
    timers.clearTimeout(deadline);
    outer?.removeEventListener('abort', forward);
  }
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { pool, persistence } = options;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const response = await request(options);
  // A server of a later protocol, e.g. one that needs `userId` (sync-protocol §4.1).
  if (response.status === 426) {
    await response.body?.cancel();
    throw new ClientOutdatedError();
  }
  if (!response.ok || response.body === null) {
    throw new BootstrapFailedError(
      `Could not load workspace data (HTTP ${response.status})`,
      response.status,
    );
  }

  const decoder = new NdjsonDecoder();
  const seen = new Map<string, Set<string>>();
  let meta: BootstrapMeta | undefined;
  let generation: string | undefined;
  let chunk: BootstrapRecord[] = [];
  let loaded = 0;
  let ended = false;

  const flush = async () => {
    if (chunk.length === 0) return;
    const rows = chunk;
    chunk = [];
    const current = generation;
    if (current !== undefined) {
      await persistence.writeReplica(current, (storage) =>
        storage.writeBootstrapRows(current, rows),
      );
    }
    for (const [model, group] of groupByModel(rows)) {
      pool.loadBase(
        model,
        group.map(({ row, archived }) => ({ row, archived })),
      );
    }
    loaded += rows.length;
    options.onProgress?.({ loaded, total: meta?.rows ?? loaded });
  };

  const handle = async (value: unknown) => {
    if (ended) throw new ProtocolError('Invalid bootstrap stream: data after end');
    const frame = decodeBootstrapFrame(value);
    switch (frame.t) {
      case 'meta': {
        if (meta !== undefined)
          throw new ProtocolError('Invalid bootstrap stream: second meta frame');
        if (frame.schemaHash !== options.schemaHash) throw new ClientOutdatedError();
        meta = frame;
        const start = {
          schemaHash: frame.schemaHash,
          lastSyncId: frame.lastSyncId,
          groups: frame.groups,
        };
        generation = await persistence.write((storage) => storage.beginBootstrap(start));
        options.onProgress?.({ loaded: 0, total: frame.rows });
        return;
      }
      case 'row': {
        if (meta === undefined)
          throw new ProtocolError('Invalid bootstrap stream: row before meta');
        const row = decodeRow(pool, frame.m, frame.d);
        let ids = seen.get(frame.m);
        if (ids === undefined) seen.set(frame.m, (ids = new Set()));
        ids.add(row.id);
        chunk.push({ model: frame.m, row, archived: frame.archived === true });
        if (chunk.length >= chunkSize) await flush();
        return;
      }
      case 'end': {
        if (meta === undefined)
          throw new ProtocolError('Invalid bootstrap stream: end before meta');
        await flush();
        if (frame.rows !== loaded || meta.rows !== loaded) {
          throw new ProtocolError(
            `Invalid bootstrap stream: ${loaded} rows received, meta announced ${meta.rows}, end announced ${frame.rows}`,
          );
        }
        ended = true;
        return;
      }
    }
  };

  const { signal } = options;
  const reader = response.body.getReader();
  // Cancelling, not just releasing, stops the download (abort or bad data).
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      for (const item of decoder.push(value)) await handle(item);
    }
    for (const item of decoder.end()) await handle(item);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (!ended || meta === undefined) {
    throw new BootstrapFailedError(
      'Workspace data stopped arriving before it was complete. Check your connection and reload the page.',
    );
  }

  const current = generation;
  if (current !== undefined) {
    await persistence.writeReplica(current, (storage) => storage.finishBootstrap(current));
  }
  // Rows still in the pool from before this bootstrap are gone from the server.
  pool.sweepBase((model, id) => seen.get(model)?.has(id) ?? false);
  return {
    lastSyncId: meta.lastSyncId,
    groups: meta.groups,
    rows: loaded,
    generation: current !== undefined && persistence.isCurrent(current) ? current : undefined,
  };
}

/** Validate a wire row against its model (strips columns the model does not declare). */
export function decodeRow(pool: ObjectPool, model: string, data: unknown): ModelRow {
  let def;
  try {
    def = pool.model(model);
  } catch {
    throw new ProtocolError(`Invalid row: unknown model ${model}`);
  }
  const result = def.rowSchema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
  // Name the field and rule, never the value (CLAUDE.md rule 6).
  throw new ProtocolError(`Invalid ${model} row${where}: ${issue?.message ?? 'unknown problem'}`);
}

function groupByModel(rows: readonly BootstrapRecord[]): Map<string, BootstrapRecord[]> {
  const groups = new Map<string, BootstrapRecord[]>();
  for (const record of rows) {
    let group = groups.get(record.model);
    if (group === undefined) groups.set(record.model, (group = []));
    group.push(record);
  }
  return groups;
}
