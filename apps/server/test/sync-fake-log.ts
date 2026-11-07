// An in-memory `sync_log` with the Postgres source's contract (`src/sync/hub-source.ts`), for the
// hub's unit tests. Hooks let a test pause catch-up, drop the listen connection or commit without
// notifying, to create the races the hub must survive.
import { randomUUID } from 'node:crypto';
import type { LogRow } from '../src/sync/delta-writer.js';
import type {
  CatchUpEvent,
  CatchUpRequest,
  Listener,
  SyncLogSource,
} from '../src/sync/hub-source.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** `Promise.withResolvers`, which the ES2023 lib these tests compile against lacks. */
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** An in-memory sync log with the Postgres source's contract, and hooks to create races. */
export class FakeLog implements SyncLogSource {
  readonly rows: LogRow[] = [];
  retainedFrom = 1;
  /** When set, catch-up waits on it after its first page. */
  catchUpGate: Promise<void> | undefined;
  catchUpStarted = deferred<void>();
  snapshotsOpen = 0;
  #notify: (() => void) | undefined;
  #revoked: ((ids: readonly string[]) => void) | undefined;
  #end = deferred<unknown>();
  listens = 0;
  listenersClosed = 0;
  failListen = false;
  /** The next `head()` calls that fail, like a lost database. */
  failHeads = 0;
  /** The next `read()` calls that fail. */
  failReads = 0;

  get headId(): number {
    return this.rows.at(-1)?.syncId ?? 0;
  }

  /** Commits rows (one transaction) without notifying. */
  commit(...rows: Partial<LogRow>[]): LogRow[] {
    const added = rows.map((over) => {
      const syncId = this.headId + 1;
      const modelId = over.modelId ?? randomUUID();
      const groups = over.groups ?? ['workspace'];
      const row: LogRow = {
        syncId,
        model: 'DebugItem',
        modelId,
        action: 'U',
        data: { id: modelId, title: `t${syncId}`, counter: syncId, syncGroups: groups },
        groups,
        clientId: null,
        clientSeq: null,
        ...over,
      };
      this.rows.push(row);
      return row;
    });
    return added;
  }

  /** Commits and notifies, like `flush` + COMMIT. */
  write(...rows: Partial<LogRow>[]): LogRow[] {
    const added = this.commit(...rows);
    this.#notify?.();
    return added;
  }

  /** Another replica ended these sessions (`NOTIFY session_revoked`). */
  revokeSessions(ids: readonly string[]): void {
    this.#revoked?.(ids);
  }

  /** The listen connection drops. */
  dropListener(): void {
    this.#end.resolve(new Error('connection lost'));
    this.#notify = undefined;
  }

  head = (): Promise<number> => {
    if (this.failHeads > 0) {
      this.failHeads -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(this.headId);
  };

  read = (after: number, upTo: number): Promise<LogRow[]> => {
    if (this.failReads > 0) {
      this.failReads -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(this.rows.filter((r) => r.syncId > after && r.syncId <= upTo));
  };

  async *catchUp(request: CatchUpRequest): AsyncGenerator<CatchUpEvent> {
    const { since, upTo, groups, clientId, pageSize } = request;
    this.snapshotsOpen += 1;
    try {
      this.catchUpStarted.resolve();
      if (since > this.headId || since + 1 < this.retainedFrom) {
        yield { t: 'too_old' };
        return;
      }
      const visible = (r: LogRow) => r.groups.some((g) => groups.includes(g));
      // As the Postgres source: the client's own rows it can't see come without data or groups.
      const rows = this.rows
        .filter(
          (r) => r.syncId > since && r.syncId <= upTo && (visible(r) || r.clientId === clientId),
        )
        .map((r) => (visible(r) ? r : { ...r, data: null, groups: [] }));
      for (let i = 0; i < rows.length; i += pageSize) {
        yield { t: 'rows', rows: rows.slice(i, i + pageSize) };
        if (i === 0 && this.catchUpGate) await this.catchUpGate;
      }
    } finally {
      this.snapshotsOpen -= 1;
    }
  }

  listen = (
    onNotify: () => void,
    onSessionsRevoked?: (ids: readonly string[]) => void,
  ): Promise<Listener> => {
    this.listens += 1;
    if (this.failListen) return Promise.reject(new Error('database unavailable'));
    this.#notify = onNotify;
    this.#revoked = onSessionsRevoked;
    this.#end = deferred<unknown>();
    let closed = false;
    const close = () => {
      if (!closed) this.listenersClosed += 1;
      closed = true;
      return Promise.resolve();
    };
    return Promise.resolve({ ended: this.#end.promise, close });
  };
}
