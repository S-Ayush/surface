import type { ModelRow } from '@surface/domain/model';
import type { BootstrapFrame } from '@surface/sync-protocol';
import { computeSchemaHash, encodeNdjsonLine } from '@surface/sync-protocol';
import type { FetchLike } from '../../src/bootstrap.js';
import { TEST_MODELS } from './models.js';

export const TEST_SCHEMA_HASH = computeSchemaHash(TEST_MODELS);

/** The frames of a well-formed bootstrap for `rows`. */
export function bootstrapFrames(
  rows: readonly { model: string; row: ModelRow; archived?: boolean }[],
  options: { lastSyncId?: number; schemaHash?: string } = {},
): BootstrapFrame[] {
  return [
    {
      t: 'meta',
      schemaHash: options.schemaHash ?? TEST_SCHEMA_HASH,
      lastSyncId: options.lastSyncId ?? 100,
      groups: ['workspace'],
      serverTime: '2026-11-06T10:00:00.000Z',
      rows: rows.length,
    },
    ...rows.map(({ model, row, archived }): BootstrapFrame => ({
      t: 'row',
      m: model,
      d: { ...row },
      ...(archived ? { archived: true as const } : {}),
    })),
    { t: 'end', rows: rows.length },
  ];
}

/**
 * A response whose body arrives in chunks of `chunkBytes`, cutting through
 * lines and multi-byte characters like a real network would.
 */
export function ndjsonResponse(
  frames: readonly unknown[],
  chunkBytes = 64,
  status = 200,
): Response {
  const bytes = new TextEncoder().encode(frames.map(encodeNdjsonLine).join(''));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

/** A fetch that serves the given bootstrap responses in order and records requests. */
export function fakeFetch(
  ...responses: (() => Response)[]
): FetchLike & { readonly urls: string[] } {
  const urls: string[] = [];
  const fetch = (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('Unexpected fetch'));
    return Promise.resolve(next());
  };
  return Object.assign(fetch, { urls });
}

/**
 * A response that sends `first`, then stalls until `release()` and sends
 * `rest`. `cancelled` records whether the reader cancelled the body.
 */
export function gatedResponse(first: readonly unknown[], rest: readonly unknown[]) {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const encode = (frames: readonly unknown[]) =>
    new TextEncoder().encode(frames.map(encodeNdjsonLine).join(''));
  const state = { cancelled: false };
  let step = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      step += 1;
      if (step === 1) controller.enqueue(encode(first));
      else if (step === 2) {
        await gate;
        if (!state.cancelled) controller.enqueue(encode(rest));
      } else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
    release: () => open(),
    state,
  };
}
