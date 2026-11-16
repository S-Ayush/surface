/**
 * An in-memory label store for the label rules (`handlers/labels/core.ts`): the access the rules
 * read and lock through, and a repo that records its writes. The calls are logged in order, so a
 * test can read the lock order (SPEC-010 §4.4). Two teams (ENG, DES) and the workspace.
 */
import { randomUUID } from 'node:crypto';
import { SurfaceError } from '../../src/executor/errors.js';
import type { LabelAccess, LabelRow, LabelTeam } from '../../src/handlers/labels/core.js';
import type { Repo, RowChange } from '../../src/sync/repo.js';

const NOW = new Date('2026-11-13T10:00:00Z');

export interface LabelWrite {
  readonly action: 'insert' | 'update' | 'purge' | 'archive' | 'unarchive' | 'updateWhere';
  readonly id: string;
  readonly model: string;
  /** The fields a patch carried. */
  readonly fields?: readonly string[];
  /** An `updateWhere`'s rows, in the order given. */
  readonly ids?: readonly string[];
  readonly touchUpdatedAt?: boolean;
}

/** An issue as the label cascade sees it (SPEC-010 §4.4). */
export interface MemoryIssue {
  readonly id: string;
  labelIds: string[];
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  updatedAt: Date;
  /** Whether the actor of the test can see it (`visibleTo`). */
  readonly visible: boolean;
}

export interface MemoryLabels {
  readonly eng: LabelTeam;
  readonly des: LabelTeam;
  readonly rows: Map<string, LabelRow>;
  /** Lock and read calls, in order: `lockWorkspace`, `lockTeam`, `scopeLabels`, `lockLabel:<name>`… */
  readonly calls: string[];
  readonly writes: LabelWrite[];
  readonly access: LabelAccess;
  readonly repo: Repo;
  /** Issues by id, for the delete cascade. */
  readonly issues: Map<string, MemoryIssue>;
  add(fields: Partial<LabelRow> & { name: string }): LabelRow;
  /** An issue carrying `labelIds`; visible to the actor unless `visible: false`. */
  addIssue(labelIds: readonly string[], fields?: Partial<Omit<MemoryIssue, 'id'>>): MemoryIssue;
  byName(name: string): LabelRow;
  snapshot(): string;
}

export function memoryLabels(): MemoryLabels {
  const eng = { id: randomUUID(), key: 'ENG' };
  const des = { id: randomUUID(), key: 'DES' };
  const teams = [eng, des];
  const rows = new Map<string, LabelRow>();
  const calls: string[] = [];
  const writes: LabelWrite[] = [];
  const issues = new Map<string, MemoryIssue>();
  const nameOf = (id: string) => rows.get(id)?.name ?? id;

  function add(fields: Partial<LabelRow> & { name: string }): LabelRow {
    const row: LabelRow = {
      id: randomUUID(),
      teamId: eng.id,
      color: 'gray',
      description: null,
      parentId: null,
      isGroup: false,
      exclusive: true,
      syncGroups: ['workspace'],
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      ...fields,
    };
    rows.set(row.id, row);
    return row;
  }

  const access: LabelAccess = {
    lockWorkspace: () => {
      calls.push('lockWorkspace');
      return Promise.resolve();
    },
    lockTeam: (id) => {
      calls.push('lockTeam');
      return Promise.resolve(teams.find((t) => t.id === id));
    },
    scopeLabels: (teamId) => {
      calls.push('scopeLabels');
      return Promise.resolve([...rows.values()].filter((r) => r.teamId === teamId));
    },
    lockLabel: (id) => {
      calls.push(`lockLabel:${nameOf(id)}`);
      return Promise.resolve(rows.get(id));
    },
    shareLabel: (id) => {
      calls.push(`shareLabel:${nameOf(id)}`);
      return Promise.resolve(rows.get(id));
    },
    removeFromIssues: (labelId) => {
      calls.push(`removeFromIssues:${nameOf(labelId)}`);
      // As `removeLabelFromIssues`: every state, ascending id, `updatedAt` left alone.
      const ids = [...issues.values()]
        .filter((issue) => issue.labelIds.includes(labelId))
        .map((issue) => issue.id)
        .sort();
      if (ids.length === 0) return Promise.resolve([]);
      for (const id of ids) {
        const issue = issues.get(id);
        if (issue) issue.labelIds = issue.labelIds.filter((l) => l !== labelId);
      }
      writes.push({
        action: 'updateWhere',
        id: labelId,
        model: 'Issue',
        ids,
        fields: ['labelIds'],
        touchUpdatedAt: false,
      });
      return Promise.resolve(ids);
    },
    visibleIssueCount: (ids) => {
      calls.push('visibleIssueCount');
      return Promise.resolve(ids.filter((id) => issues.get(id)?.visible === true).length);
    },
  };

  function setArchived(model: string, id: string, action: 'archive' | 'unarchive') {
    const row = rows.get(id);
    if (model !== 'Label' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
    const next = { ...row, archivedAt: action === 'archive' ? NOW : null, updatedAt: NOW };
    rows.set(id, next);
    writes.push({ action, id, model });
    return Promise.resolve(next as never);
  }

  // The repo is typed per model; the rules only write Label, so anything else is a bug.
  const repo: Repo = {
    insert(model, values) {
      if (model !== 'Label') throw new Error(`unexpected insert into ${model}`);
      if (rows.has(values.id)) throw new SurfaceError('CONFLICT', `${model} id already exists.`);
      const row = {
        description: null,
        parentId: null,
        isGroup: false,
        exclusive: true,
        archivedAt: null,
        color: 'gray',
        syncGroups: ['workspace'],
        ...values,
        createdAt: NOW,
        updatedAt: NOW,
      } as LabelRow;
      rows.set(row.id, row);
      writes.push({ action: 'insert', id: row.id, model });
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      const row = rows.get(id);
      if (model !== 'Label' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: NOW } as LabelRow;
      rows.set(id, next);
      writes.push({ action: 'update', id, model, fields: Object.keys(patch) });
      return Promise.resolve(next as never);
    },
    archive: (model, id) => setArchived(model, id, 'archive'),
    unarchive: (model, id) => setArchived(model, id, 'unarchive'),
    purge(model, id) {
      if (model !== 'Label' || !rows.delete(id)) throw new SurfaceError('NOT_FOUND', 'not found');
      writes.push({ action: 'purge', id, model });
      return Promise.resolve();
    },
    updateWhere: () => Promise.reject(new Error('labels are not bulk-updated here')),
    deleteWhere: () => Promise.reject(new Error('labels are not bulk-deleted here')),
    changes: (): readonly RowChange[] => [],
  };

  return {
    eng,
    des,
    rows,
    calls,
    writes,
    access,
    repo,
    issues,
    add,
    addIssue(labelIds, fields = {}) {
      const issue: MemoryIssue = {
        id: randomUUID(),
        labelIds: [...labelIds],
        archivedAt: null,
        deletedAt: null,
        updatedAt: NOW,
        visible: true,
        ...fields,
      };
      issues.set(issue.id, issue);
      return issue;
    },
    byName(name) {
      const row = [...rows.values()].find((r) => r.name === name);
      if (!row) throw new Error(`no label ${name}`);
      return row;
    },
    snapshot: () => JSON.stringify([...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))),
  };
}
