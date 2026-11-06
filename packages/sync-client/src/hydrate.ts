/**
 * Warm start (SPEC-002 §3.2): if the stored replica is complete and matches
 * this client's schema, load it into the pool page by page. The worker reads
 * each page, so the main thread only receives finished rows.
 */
import type { Persistence } from './persistence.js';
import type { ObjectPool } from './pool.js';
import type { StoredMeta } from './storage/types.js';

export interface HydrateResult {
  /**
   * The meta as it was when reading began. Rows read later may be newer than
   * its `lastSyncId`; replaying deltas from there is harmless (row versions).
   */
  readonly meta: StoredMeta;
  readonly rows: number;
}

export const DEFAULT_PAGE_SIZE = 1000;

/**
 * Returns `undefined` when there is nothing usable to hydrate from (no replica,
 * an unfinished bootstrap, another schema, failed storage, or a replica that
 * another tab replaced while it was being read); the caller then bootstraps.
 * On success, base rows the replica does not have are dropped from the pool.
 */
export async function hydrate(
  pool: ObjectPool,
  persistence: Persistence,
  schemaHash: string,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<HydrateResult | undefined> {
  const meta = await persistence.write((storage) => storage.readMeta());
  if (meta?.state !== 'ready' || meta.schemaHash !== schemaHash) return undefined;

  const seen = new Map<string, Set<string>>();
  let rows = 0;
  for (const def of pool.models) {
    const ids = new Set<string>();
    seen.set(def.name, ids);
    let after: string | undefined;
    do {
      const cursor = after;
      const page = await persistence.write((storage) =>
        storage.readRows(def.name, cursor, pageSize),
      );
      // Storage failed mid-way: a partial replica must not look complete.
      if (page === undefined) return undefined;
      pool.loadBase(def.name, page.rows);
      for (const { row } of page.rows) ids.add(row.id);
      rows += page.rows.length;
      after = page.next;
    } while (after !== undefined);
  }

  // Pages from two generations are not a replica (E5). Web Locks rule this out
  // where they exist; this check covers insecure origins, which have none.
  const end = await persistence.write((storage) => storage.readMeta());
  if (end?.generation !== meta.generation || end.state !== 'ready') return undefined;

  pool.sweepBase((model, id) => seen.get(model)?.has(id) ?? false);
  return { meta, rows };
}
