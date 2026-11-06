import type { ModelRow } from '../../sync/models.js';

/** `DebugItemSchema`'s shape from a row. */
export function debugItemOutput(row: ModelRow<'DebugItem'>) {
  return {
    id: row.id,
    title: row.title,
    counter: row.counter,
    updatedAt: row.updatedAt.toISOString(),
  };
}
