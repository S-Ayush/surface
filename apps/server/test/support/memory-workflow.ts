/**
 * An in-memory workflow for the status rules (`handlers/statuses/core.ts`): the access the rules
 * read and lock through, and a repo that records its writes. The calls are logged in order, so a
 * test can read the lock order (SPEC-010 §4.4, E3).
 */
import { randomUUID } from 'node:crypto';
import type { Repo, RowChange } from '../../src/sync/repo.js';
import { SurfaceError } from '../../src/executor/errors.js';
import type { StatusRow, WorkflowAccess, WorkflowTeam } from '../../src/handlers/statuses/core.js';
import { teamWorkflow } from '../../src/handlers/teams/seed.js';

const NOW = new Date('2026-11-12T10:00:00Z');

export interface Write {
  readonly action: 'insert' | 'update' | 'purge';
  readonly id: string;
  /** The fields a patch carried. */
  readonly fields?: readonly string[];
}

export interface MemoryWorkflow {
  readonly team: { -readonly [K in keyof WorkflowTeam]: WorkflowTeam[K] };
  readonly rows: Map<string, StatusRow>;
  /** Lock and read calls, in order: `lockTeam`, `statuses`, `lockStatus:<name>`, `shareStatus:<name>`. */
  readonly calls: string[];
  readonly writes: Write[];
  readonly access: WorkflowAccess;
  readonly repo: Repo;
  /** Issues per status id, for delete tests. */
  readonly issues: Map<string, { live: number; archived: number; recentlyDeleted: number }>;
  byName(name: string): StatusRow;
  /** Rows as a comparable snapshot, for "a rejected operation changes nothing". */
  snapshot(): string;
}

export function memoryWorkflow(): MemoryWorkflow {
  const teamId = randomUUID();
  const seeded = teamWorkflow(teamId);
  const rows = new Map<string, StatusRow>();
  for (const s of seeded.statuses) {
    rows.set(s.id, {
      id: s.id,
      teamId,
      name: s.name,
      category: s.category,
      color: s.color ?? 'gray',
      description: null,
      position: s.position,
      syncGroups: ['workspace'],
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    });
  }
  const team = { id: teamId, key: 'ENG', defaultStatusId: seeded.defaultStatusId };
  const calls: string[] = [];
  const writes: Write[] = [];
  const issues = new Map<string, { live: number; archived: number; recentlyDeleted: number }>();
  const nameOf = (id: string) => rows.get(id)?.name ?? id;

  const access: WorkflowAccess = {
    lockTeam: (id) => {
      calls.push('lockTeam');
      return Promise.resolve(id === team.id ? team : undefined);
    },
    statuses: (id) => {
      calls.push('statuses');
      return Promise.resolve([...rows.values()].filter((r) => r.teamId === id));
    },
    lockStatus: (id) => {
      calls.push(`lockStatus:${nameOf(id)}`);
      return Promise.resolve(rows.get(id));
    },
    shareStatus: (id) => {
      calls.push(`shareStatus:${nameOf(id)}`);
      return Promise.resolve(rows.get(id));
    },
    issueCounts: (id) =>
      Promise.resolve(issues.get(id) ?? { live: 0, archived: 0, recentlyDeleted: 0 }),
  };

  // The repo is typed per model; the rules only write WorkflowStatus, so anything else is a bug.
  const repo: Repo = {
    insert(model, values) {
      if (model !== 'WorkflowStatus') throw new Error(`unexpected insert into ${model}`);
      if (rows.has(values.id)) throw new SurfaceError('CONFLICT', `${model} id already exists.`);
      const row = {
        description: null,
        archivedAt: null,
        syncGroups: ['workspace'],
        ...values,
        createdAt: NOW,
        updatedAt: NOW,
      } as StatusRow;
      rows.set(row.id, row);
      writes.push({ action: 'insert', id: row.id });
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      if (model === 'Team' && id === team.id) {
        // The whole patch is applied, so a rule that writes an extra field shows in `writes` and
        // in the snapshot. Only the fields the rules read are modelled on the returned row.
        Object.assign(team, patch);
        writes.push({ action: 'update', id, fields: Object.keys(patch) });
        return Promise.resolve({ ...team, updatedAt: NOW } as never);
      }
      const row = rows.get(id);
      if (model !== 'WorkflowStatus' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: NOW } as StatusRow;
      rows.set(id, next);
      writes.push({ action: 'update', id, fields: Object.keys(patch) });
      return Promise.resolve(next as never);
    },
    archive: () => Promise.reject(new Error('statuses are never archived')),
    unarchive: () => Promise.reject(new Error('statuses are never archived')),
    purge(model, id) {
      if (model !== 'WorkflowStatus' || !rows.delete(id)) {
        throw new SurfaceError('NOT_FOUND', 'not found');
      }
      writes.push({ action: 'purge', id });
      return Promise.resolve();
    },
    updateWhere: () => Promise.reject(new Error('statuses are not bulk-updated')),
    deleteWhere: () => Promise.reject(new Error('statuses are not bulk-deleted')),
    changes: (): readonly RowChange[] => [],
  };

  return {
    team,
    rows,
    calls,
    writes,
    access,
    repo,
    issues,
    byName(name) {
      const row = [...rows.values()].find((r) => r.name === name);
      if (!row) throw new Error(`no status ${name}`);
      return row;
    },
    snapshot: () =>
      JSON.stringify([...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) +
      JSON.stringify(team),
  };
}
