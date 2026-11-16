/**
 * Content rules shared by the storage backends (SPEC-011 §5.3, §5.4; PLAN-011 S5b), so IndexedDB
 * and memory keep and drop content rows alike. Storage holds a content row only while its parent
 * is in the hydrated set, which the replica's tabs share.
 */
import type { ContentModelRef, PartialWrite, StoredChange, StoredRecord } from './types.js';
import type { RecordPut, ReadRecords } from './partial-plan.js';
import { teamOf } from './types.js';

/** The content models by name. */
export function contentByModel(
  content: readonly ContentModelRef[],
): ReadonlyMap<string, ContentModelRef> {
  return new Map(content.map((ref) => [ref.model, ref]));
}

/** The parent a content upsert names; `undefined` for a delete or a model that isn't content. */
export function upsertParent(
  change: StoredChange,
  byModel: ReadonlyMap<string, ContentModelRef>,
): string | undefined {
  const ref = byModel.get(change.model);
  if (ref === undefined || change.kind === 'delete') return undefined;
  const parent = change.row[ref.field];
  return typeof parent === 'string' ? parent : '';
}

/**
 * Parents (rows of a content parent model) whose last change in the batch deletes them: their
 * content and hydration mark go after the batch (§5.3 step 4). A `D` then `U` of the same row in
 * one batch (a group change) leaves it present.
 */
export function goneParents(
  changes: readonly StoredChange[],
  content: readonly ContentModelRef[],
): Set<string> {
  const parents = new Set(content.map((ref) => ref.parent));
  const last = new Map<string, boolean>();
  for (const change of changes) {
    if (!parents.has(change.model)) continue;
    last.set(change.kind === 'delete' ? change.id : change.row.id, change.kind === 'delete');
  }
  return new Set([...last].filter(([, deleted]) => deleted).map(([id]) => id));
}

/** Whether a content answer's row may overwrite `existing`: only an older one, or none. */
export function contentRowIsNewer(version: number, existing: StoredRecord | undefined): boolean {
  return existing === undefined || existing.version < version;
}

/** The Issue rows a partial write tombstones (the sweep): their hydration marks go too. */
export function sweptIssues(write: PartialWrite, puts: readonly RecordPut[]): string[] {
  return puts
    .filter(({ model, record }) => model === write.shape.issue && record.row === null)
    .map(({ record }) => record.id);
}

/** Every stored Issue row of `teams`: an unsubscribe drops their content and marks (§5.7). */
export function teamIssues(
  issueModel: string,
  teams: readonly string[],
  read: ReadRecords,
): string[] {
  const wanted = new Set(teams);
  return read(issueModel)
    .filter((record) => record.row !== null && wanted.has(teamOf(record.row) ?? ''))
    .map((record) => record.id);
}
