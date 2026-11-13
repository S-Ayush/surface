/**
 * An in-memory workspace for the issue rules (`handlers/issues/core.ts`): the access the rules read
 * and lock through, a repo that records its writes, and the events they emit. Every read and lock
 * is logged in order, so a test can read the lock order (SPEC-011 §4.8). Two public teams, ENG
 * and DES, each with the default workflow; labels are added per test.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEAM_WORKFLOW,
  editRefusal,
  issueIdentifier,
  lifecycleOf,
  type StatusCategory,
} from '@surface/domain';
import type { DomainEvent } from '../../src/executor/context.js';
import { SurfaceError } from '../../src/executor/errors.js';
import { refNotFound } from '../../src/executor/refs/sources.js';
import type {
  IssueAccess,
  IssueRow,
  IssueTeam,
  IssueWriteContext,
  LabelRow,
  StatusFacts,
} from '../../src/handlers/issues/core.js';
import type { Repo, RowChange } from '../../src/sync/repo.js';

export const NOW = new Date('2026-11-13T10:00:00.000Z');

export interface MemoryStatus extends StatusFacts {
  readonly name: string;
}

export interface IssueWrite {
  readonly action: 'insert' | 'update' | 'updateWhere';
  readonly ids: readonly string[];
  /** The fields a patch carried. */
  readonly fields: readonly string[];
  readonly touchUpdatedAt?: boolean;
}

export interface MemoryIssues {
  readonly eng: IssueTeam;
  readonly des: IssueTeam;
  readonly statuses: Map<string, MemoryStatus>;
  readonly labels: Map<string, LabelRow>;
  readonly issues: Map<string, IssueRow>;
  /** Reads and locks, in order: `shareTeam`, `shareStatus:<name>`, `shareLabels:<a,b>`, … */
  readonly calls: string[];
  readonly writes: IssueWrite[];
  readonly events: DomainEvent[];
  readonly ctx: IssueWriteContext;
  readonly repo: Repo;
  status(team: IssueTeam, name: string): MemoryStatus;
  addLabel(fields: Partial<LabelRow> & { name: string }): LabelRow;
  /** Sets a team's estimate settings; `eng` and `des` read them afterwards. */
  setEstimates(team: IssueTeam, settings: Partial<IssueTeam>): IssueTeam;
}

export function memoryIssues(): MemoryIssues {
  const teams = new Map<string, IssueTeam>();
  const statuses = new Map<string, MemoryStatus>();
  const labels = new Map<string, LabelRow>();
  const issues = new Map<string, IssueRow>();
  const counters = new Map<string, number>();
  const calls: string[] = [];
  const writes: IssueWrite[] = [];
  const events: DomainEvent[] = [];

  function team(key: string): IssueTeam {
    const id = randomUUID();
    let defaultStatusId = '';
    for (const seed of DEFAULT_TEAM_WORKFLOW) {
      const status = { id: randomUUID(), teamId: id, name: seed.name, category: seed.category };
      statuses.set(status.id, status);
      if (seed.name === 'Backlog') defaultStatusId = status.id;
    }
    const row: IssueTeam = {
      id,
      key,
      defaultStatusId,
      estimateScale: 'off',
      estimateExtended: false,
      estimateAllowZero: false,
    };
    teams.set(id, row);
    return row;
  }
  const eng = team('ENG');
  const des = team('DES');

  const labelName = (id: string) => labels.get(id)?.name ?? id;
  const statusName = (id: string) => statuses.get(id)?.name ?? id;
  const facts = (s: MemoryStatus): StatusFacts => ({
    id: s.id,
    teamId: s.teamId,
    category: s.category,
  });

  const access: IssueAccess = {
    shareTeam(teamId) {
      calls.push('shareTeam');
      return Promise.resolve(teams.get(teamId));
    },
    readTeam(teamId) {
      calls.push('readTeam');
      return Promise.resolve(teams.get(teamId));
    },
    shareStatus(statusId) {
      calls.push(`shareStatus:${statusName(statusId)}`);
      const status = statuses.get(statusId);
      return Promise.resolve(status && facts(status));
    },
    shareLabels(labelIds) {
      calls.push(`shareLabels:${labelIds.map(labelName).join(',')}`);
      if (labelIds.some((id, i) => i > 0 && (labelIds[i - 1] ?? '') >= id)) {
        throw new Error('labels must be locked in ascending id');
      }
      return Promise.resolve(labelIds.flatMap((id) => labels.get(id) ?? []));
    },
    readLabels(labelIds) {
      calls.push(`readLabels:${labelIds.map(labelName).join(',')}`);
      return Promise.resolve(labelIds.flatMap((id) => labels.get(id) ?? []));
    },
    statusCategory(statusId): Promise<StatusCategory | undefined> {
      calls.push('statusCategory');
      return Promise.resolve(statuses.get(statusId)?.category);
    },
    position(teamId) {
      calls.push('position');
      const number = (counters.get(teamId) ?? 0) + 1;
      counters.set(teamId, number);
      return Promise.resolve({ number, sortOrder: `a${String(1000 - number)}` });
    },
    lockIssue(issueId) {
      calls.push('lockIssue');
      const issue = issues.get(issueId);
      if (!issue) return Promise.reject(refNotFound('IssueRef', issueId, ['issue']));
      const state = lifecycleOf(issue);
      const key = teams.get(issue.teamId)?.key ?? 'ENG';
      const refusal = editRefusal(issueIdentifier(key, issue.number ?? 0), state);
      if (refusal !== undefined) return Promise.reject(new SurfaceError('CONFLICT', refusal));
      return Promise.resolve({ ...issue, state });
    },
  };

  const repo: Repo = {
    insert(model, values) {
      if (model !== 'Issue') throw new Error(`unexpected insert into ${model}`);
      const row = {
        priority: 0,
        assigneeId: null,
        labelIds: [],
        estimate: null,
        dueDate: null,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        archivedAt: null,
        deletedAt: null,
        deletedById: null,
        syncGroups: ['workspace'],
        ...values,
        createdAt: NOW,
        updatedAt: NOW,
        // The generic insert type does not narrow on `model`; the handler under test passes a full row.
      } as unknown as IssueRow;
      issues.set(row.id, row);
      writes.push({ action: 'insert', ids: [row.id], fields: Object.keys(values) });
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      const row = issues.get(id);
      if (model !== 'Issue' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: NOW } as IssueRow;
      issues.set(id, next);
      writes.push({ action: 'update', ids: [id], fields: Object.keys(patch) });
      return Promise.resolve(next as never);
    },
    updateWhere(model, ids, patch, options) {
      writes.push({
        action: 'updateWhere',
        ids: [...ids],
        fields: Object.keys(patch),
        touchUpdatedAt: options.touchUpdatedAt,
      });
      return Promise.resolve([...ids].sort());
    },
    archive: () => Promise.reject(new Error('issue archive is PLAN-015')),
    unarchive: () => Promise.reject(new Error('issue restore is PLAN-015')),
    purge: () => Promise.reject(new Error('issue purge is PLAN-015')),
    deleteWhere: () => Promise.reject(new Error('issues are not bulk-deleted here')),
    changes: (): readonly RowChange[] => [],
  };

  const team_ = (id: string): IssueTeam => {
    const row = teams.get(id);
    if (!row) throw new Error('no such team');
    return row;
  };

  return {
    // Getters, so a team read after `setEstimates` carries the new settings.
    get eng() {
      return team_(eng.id);
    },
    get des() {
      return team_(des.id);
    },
    statuses,
    labels,
    issues,
    calls,
    writes,
    events,
    repo,
    ctx: { access, repo, emit: (event) => void events.push(event), now: NOW },
    status(t, name) {
      const found = [...statuses.values()].find((s) => s.teamId === t.id && s.name === name);
      if (!found) throw new Error(`no status ${name} in ${t.key}`);
      return found;
    },
    addLabel(fields) {
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
      labels.set(row.id, row);
      return row;
    },
    setEstimates(t, settings) {
      const next = { ...t, ...settings };
      teams.set(t.id, next);
      return next;
    },
  };
}
