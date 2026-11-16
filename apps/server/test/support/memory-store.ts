/**
 * The client's optimistic store over a copy of a `memoryComments` thread store (SPEC-013 §6.2), so
 * a test runs an operation's `optimistic` and the server rule on the same rows and compares what
 * each leaves (AC-11). Shared by the comment and reaction rule tests.
 */
import type { OptimisticStore, StoreRow } from '@surface/operations';
import { ADA, NOW, type MemoryComments } from './memory-comments.js';

/** A row as the client replica holds it: ISO timestamps, no groups (content rows carry none). */
export function clientRow(row: object): StoreRow {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== 'syncGroups')
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

export const byId = (rows: Iterable<StoreRow>) =>
  [...rows].sort((a, b) => String(a['id']).localeCompare(String(b['id'])));

/** The client store over a copy of `m`'s rows, with its live issue and `me` (Ada) (§6.2). */
export function storeOver(
  m: MemoryComments,
  me: string = ADA,
): OptimisticStore & { rows(model: string): StoreRow[] } {
  const tables = new Map<string, Map<string, StoreRow>>([
    ['Comment', new Map([...m.comments].map(([id, row]) => [id, clientRow(row)]))],
    ['Reaction', new Map([...m.reactions].map(([id, row]) => [id, clientRow(row)]))],
    ['Issue', new Map([[m.issue.id, clientRow(m.issue)]])],
    ['User', new Map([[me, { id: me, role: 'member' }]])],
  ]);
  const table = (model: string) => {
    const found = tables.get(model);
    if (found === undefined) throw new Error(`no ${model} in this store`);
    return found;
  };
  const get = (model: string, ref: string) =>
    table(model).get(model === 'User' && ref === 'me' ? me : ref);
  return {
    now: NOW,
    get,
    find: (model, fields) =>
      byId(table(model).values()).filter((row) =>
        Object.entries(fields).every(([key, value]) => row[key] === value),
      ),
    insert: (model, row) => void table(model).set(row.id, row),
    patch: (model, ref, changes) => {
      const row = get(model, ref);
      if (row !== undefined) table(model).set(ref, { ...row, ...changes });
    },
    remove: (model, ref) => void table(model).delete(ref),
    archive: () => undefined,
    unarchive: () => undefined,
    rows: (model) => byId(table(model).values()),
  };
}
