/**
 * What `writePartialRows` and `removeTeamRows` write (SPEC-011 §5.7, PLAN-011 S4c), shared by the
 * storage backends so IndexedDB and memory follow one rule. Each backend reads the records of the
 * models involved inside its transaction, plans, then writes the plan in the same transaction.
 */
import type { IssueShape, PartialWrite, StoredRecord, TeamRemoval } from './types.js';
import { meetsGroups, teamOf } from './types.js';

/** The stored records of a model, read in the writing transaction. */
export type ReadRecords = (model: string) => readonly StoredRecord[];

export interface RecordPut {
  readonly model: string;
  readonly record: StoredRecord;
}

export interface RecordDelete {
  readonly model: string;
  readonly id: string;
}

/** Every model a partial write may touch: the answer's, the Issue model and its children. */
export function partialWriteModels(write: PartialWrite): string[] {
  return [...new Set([...write.rows.map((r) => r.model), ...shapeModels(write.shape)])];
}

export function shapeModels(shape: IssueShape): string[] {
  return [
    ...new Set([
      shape.issue,
      ...shape.children.map((c) => c.model),
      ...shape.content.map((c) => c.model),
    ]),
  ];
}

/**
 * The records a partial answer writes: each answer row unless storage holds it at `version` or
 * newer (E30), then the sweep's tombstones at `version` (E35).
 */
export function planPartialWrite(write: PartialWrite, read: ReadRecords): RecordPut[] {
  const { shape, version } = write;
  const puts: RecordPut[] = [];
  const byModel = new Map<string, Map<string, StoredRecord>>();
  const stored = (model: string): Map<string, StoredRecord> => {
    let records = byModel.get(model);
    if (records === undefined) {
      records = new Map(read(model).map((record) => [record.id, record]));
      byModel.set(model, records);
    }
    return records;
  };
  const answered = new Map<string, Set<string>>();
  for (const { model, row } of write.rows) {
    let ids = answered.get(model);
    if (ids === undefined) answered.set(model, (ids = new Set()));
    ids.add(row.id);
  }
  const newer = (model: string, id: string) => {
    const existing = stored(model).get(id);
    return existing !== undefined && existing.version >= version ? existing : undefined;
  };
  // A child goes in only with its issue: a later packet's lone `D` (a purge, whose children's
  // deletes are not logged) takes the answer's children with it.
  const issueStays = (id: string) => {
    const later = newer(shape.issue, id);
    return later === undefined ? (answered.get(shape.issue)?.has(id) ?? false) : later.row !== null;
  };
  const parentField = new Map(shape.children.map((c) => [c.model, c.field]));
  for (const { model, row, archived } of write.rows) {
    if (newer(model, row.id) !== undefined) continue;
    const field = parentField.get(model);
    if (field !== undefined && !issueStays(String(row[field]))) continue;
    puts.push({ model, record: { id: row.id, version, archived, row } });
  }
  const tombstone = (model: string, id: string) =>
    puts.push({ model, record: { id, version, archived: false, row: null } });

  const teams = new Set(write.teams);
  const answerIssues = answered.get(shape.issue) ?? new Set<string>();
  const swept = new Set<string>();
  for (const record of stored(shape.issue).values()) {
    if (record.row === null || record.version >= version) continue;
    const team = teamOf(record.row);
    if (team === undefined || !teams.has(team) || answerIssues.has(record.id)) continue;
    swept.add(record.id);
    tombstone(shape.issue, record.id);
  }
  const parents = new Set([...answerIssues, ...swept]);
  for (const child of shape.children) {
    const kept = answered.get(child.model) ?? new Set<string>();
    for (const record of stored(child.model).values()) {
      if (record.row === null || record.version >= version || kept.has(record.id)) continue;
      if (parents.has(String(record.row[child.field]))) tombstone(child.model, record.id);
    }
  }
  // The answer carries no content: only the swept issues' content goes.
  for (const content of shape.content) {
    for (const record of stored(content.model).values()) {
      if (record.row === null || record.version >= version) continue;
      if (swept.has(String(record.row[content.field]))) tombstone(content.model, record.id);
    }
  }
  return puts;
}

/** The records an unsubscribe removes (see `SyncStorage.removeTeamRows`). */
export function planTeamRemoval(removal: TeamRemoval, read: ReadRecords): RecordDelete[] {
  const { shape } = removal;
  const teams = new Set(removal.teams);
  const keep = new Set(removal.keep);
  const deletes: RecordDelete[] = [];
  const ofTeams = new Set<string>();
  for (const record of read(shape.issue)) {
    if (record.row === null) continue;
    const team = teamOf(record.row);
    if (team === undefined || !teams.has(team)) continue;
    ofTeams.add(record.id);
    if (!meetsGroups(record.row, keep)) deletes.push({ model: shape.issue, id: record.id });
  }
  for (const child of [...shape.children, ...shape.content]) {
    for (const record of read(child.model)) {
      if (record.row !== null && ofTeams.has(String(record.row[child.field]))) {
        deletes.push({ model: child.model, id: record.id });
      }
    }
  }
  return deletes;
}
