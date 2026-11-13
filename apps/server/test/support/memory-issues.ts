/**
 * An in-memory workspace for the issue rules (`handlers/issues/core.ts`): the access the rules read
 * and lock through, a repo that records its writes, and the events they emit. Every read and lock
 * is logged in order, so a test can read the lock order (SPEC-011 §4.8). Two public teams, ENG
 * and DES, each with the default workflow; labels are added per test.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEAM_WORKFLOW,
  issueIdentifier,
  lifecycleOf,
  lifecycleRefusal,
  lockRefusal,
  type Actor,
  type IssueLockMode,
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
import type { ModelName } from '../../src/sync/models.js';
import type {
  LifecycleContext,
  LifecycleHistoryKind,
} from '../../src/handlers/issues/lifecycle-core.js';

export const NOW = new Date('2026-11-13T10:00:00.000Z');

/** The member who acts in the lifecycle tests: Ada, of team ENG. */
export const ADA_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
export const ADA_ACTOR: Actor = {
  kind: 'user',
  userId: ADA_ID,
  groups: ['workspace', `user:${ADA_ID}`],
  memberOf: [],
};

export interface MemoryStatus extends StatusFacts {
  readonly name: string;
}

export interface IssueWrite {
  readonly action: 'insert' | 'update' | 'updateWhere' | 'archive' | 'unarchive';
  /** Set only for a model other than Issue (a restore's re-logged Attachment rows). */
  readonly model?: string;
  readonly ids: readonly string[];
  /** The fields a patch carried. */
  readonly fields: readonly string[];
  readonly touchUpdatedAt?: boolean;
  /** An `updateWhere`'s patch as given, so a test can render its SQL values. */
  readonly patch?: Readonly<Record<string, unknown>>;
}

export interface MemoryIssues {
  readonly eng: IssueTeam;
  readonly des: IssueTeam;
  readonly statuses: Map<string, MemoryStatus>;
  readonly labels: Map<string, LabelRow>;
  readonly issues: Map<string, IssueRow>;
  /** Reads and locks, in order: `shareTeam`, `shareStatus:<name>`, `shareLabels:<a,b>`, … */
  readonly calls: string[];
  /** The mode of each issue lock, in order (SPEC-015 §4.3). */
  readonly lockModes: IssueLockMode[];
  readonly writes: IssueWrite[];
  readonly events: DomainEvent[];
  readonly ctx: IssueWriteContext;
  readonly repo: Repo;
  /** History entries the lifecycle handlers wrote, in order (SPEC-015 §4.8). */
  readonly history: { readonly kind: LifecycleHistoryKind; readonly issueId: string }[];
  /**
   * Fake Attachment rows per issue id (the model arrives with PLAN-014 S4a), which a restore
   * logs again (SPEC-015 §5.1); kept in ascending id like the real step's query.
   */
  readonly attachments: Map<string, string[]>;
  /** The context `deleteIssue` and `restoreIssue` run with, as `actor` at `now`. */
  lifecycle(options?: { readonly actor?: Actor; readonly now?: Date }): LifecycleContext;
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
  const lockModes: IssueLockMode[] = [];
  const history: MemoryIssues['history'] = [];
  const attachments = new Map<string, string[]>();
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

  const identifierOf = (issue: IssueRow) =>
    issueIdentifier(teams.get(issue.teamId)?.key ?? 'ENG', issue.number ?? 0);

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
    lockIssue(issueId, mode) {
      calls.push('lockIssue');
      lockModes.push(mode);
      const issue = issues.get(issueId);
      if (!issue) return Promise.reject(refNotFound('IssueRef', issueId, ['issue']));
      const state = lifecycleOf(issue);
      const refused = lockRefusal(mode, state);
      if (refused !== undefined) {
        const message = lifecycleRefusal(identifierOf(issue), refused);
        return Promise.reject(new SurfaceError('CONFLICT', message));
      }
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
        ...(model === 'Issue' ? {} : { model }),
        ids: [...ids],
        fields: Object.keys(patch),
        touchUpdatedAt: options.touchUpdatedAt,
        patch: { ...patch },
      });
      return Promise.resolve([...ids].sort());
    },
    archive: () => Promise.reject(new Error('issue archive is PLAN-015 S3')),
    unarchive(model, id) {
      const row = issues.get(id);
      if (model !== 'Issue' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, archivedAt: null, updatedAt: NOW };
      issues.set(id, next);
      writes.push({ action: 'unarchive', ids: [id], fields: ['archivedAt'] });
      return Promise.resolve(next as never);
    },
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
    lockModes,
    writes,
    events,
    repo,
    history,
    attachments,
    lifecycle({ actor = ADA_ACTOR, now = NOW } = {}) {
      return {
        access: {
          lockIssue: (issueId, mode) => access.lockIssue(issueId, mode),
          identifier: (issue) => Promise.resolve(identifierOf(issue)),
          relogRows(issueId) {
            const ids = attachments.get(issueId) ?? [];
            // The test stands in for PLAN-014 S4a's model: no Attachment ModelName exists yet.
            const model = 'Attachment' as ModelName;
            return Promise.resolve(
              ids.length === 0 ? [] : [{ model, ids: [...ids].sort().slice(0, 100) }],
            );
          },
        },
        repo,
        actor,
        now,
        emit: (event) => void events.push(event),
        history(kind, issue) {
          history.push({ kind, issueId: issue.id });
          return Promise.resolve();
        },
      };
    },
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
