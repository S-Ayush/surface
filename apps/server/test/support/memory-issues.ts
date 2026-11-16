/**
 * An in-memory workspace for the issue rules (`handlers/issues/core.ts`): the access the rules read
 * and lock through, a repo that records its writes, and the events they emit. Every read and lock
 * is logged in order, so a test can read the lock order (SPEC-011 §4.8). Two public teams, ENG
 * and DES, each with the default workflow; labels are added per test.
 *
 * PLAN-011 S6: the repo also keeps IssueContent and IssueHistory rows (`content`, `historyRows`)
 * and the server-only search text (`searchText`); the access reads them back for the history
 * writer. Its clock is `m.now` (settable with `at`), so a test can step past the fold windows.
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
import { claimInlineFiles } from '../../src/files/claim.js';
import type { IssueHistoryRow } from '../../src/issues/history.js';
import type { ModelRow } from '../../src/sync/models.js';
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
import type { LifecycleContext } from '../../src/handlers/issues/lifecycle-core.js';
import type { LifecycleHistoryKind } from '../../src/issues/lifecycle.js';
import type { PurgeContext } from '../../src/issues/purge.js';
import type { PurgeStep } from '../../src/issues/purge-steps.js';
import type { AuditLine } from '../../src/auth/audit.js';
import { recordingDb } from './scripted-db.js';

export const NOW = new Date('2026-11-13T10:00:00.000Z');

/** The member who acts in the lifecycle tests: Ada, of team ENG. */
export const ADA_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
export const ADA_ACTOR: Actor = {
  kind: 'user',
  userId: ADA_ID,
  groups: ['workspace', `user:${ADA_ID}`],
  publicTeams: [],
  memberOf: [],
};

export interface MemoryStatus extends StatusFacts {
  readonly name: string;
}

export interface IssueWrite {
  readonly action:
    'insert' | 'update' | 'updateWhere' | 'archive' | 'unarchive' | 'purge' | 'deleteWhere';
  /** Set only for a model other than Issue (a restore's re-logged Attachment rows). */
  readonly model?: string;
  readonly ids: readonly string[];
  /** The fields a patch carried. */
  readonly fields: readonly string[];
  readonly touchUpdatedAt?: boolean;
  /** An `updateWhere`'s patch as given, so a test can render its SQL values. */
  readonly patch?: Readonly<Record<string, unknown>>;
  /** A `deleteWhere`'s `log` option (false: the unlogged content delete of ADR-0022). */
  readonly log?: boolean;
}

export type IssueContentRow = ModelRow<'IssueContent'>;

export interface MemoryIssues {
  readonly eng: IssueTeam;
  /** IssueContent rows by issue id (PLAN-011 S6). */
  readonly content: Map<string, IssueContentRow>;
  /** IssueHistory rows, in insertion order. */
  readonly historyRows: IssueHistoryRow[];
  /** The server-only `issue_search_text` rows, by issue id. */
  readonly searchText: Map<string, string>;
  /** The clock of the repo and of `ctx` (default `NOW`). */
  readonly now: Date;
  /** Moves the clock: later writes and `ctx.now` read it. */
  at(now: Date): void;
  /** The actor `ctx` writes as (default Ada); set with `as`. */
  as(actor: Actor): void;
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
  /**
   * The context `purgeIssue` runs with (PLAN-015 S2): the same lock and repo, `steps` (default
   * none, so the test sees the issue's own writes), and audit lines recorded in `audits`.
   */
  purge(options?: {
    readonly actor?: Actor;
    readonly now?: Date;
    readonly steps?: readonly PurgeStep[];
  }): PurgeContext;
  /** Audit lines a purge recorded, in order. */
  readonly audits: AuditLine[];
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
  const audits: AuditLine[] = [];
  const content = new Map<string, IssueContentRow>();
  const historyRows: IssueHistoryRow[] = [];
  const searchText = new Map<string, string>();
  let clock = NOW;
  let actor: Actor = ADA_ACTOR;

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
    readContent(issueId) {
      calls.push('readContent');
      return Promise.resolve(content.get(issueId));
    },
    claimFiles(doc, issue) {
      calls.push('claimFiles');
      // The real seam (its stub body needs no database).
      return claimInlineFiles(recordingDb().db, doc, issue, actor, 'description');
    },
    setSearchText(issueId, text) {
      calls.push('setSearchText');
      searchText.set(issueId, text);
      return Promise.resolve();
    },
    latestHistory(issueId) {
      calls.push('latestHistory');
      const rows = historyRows
        .filter((r) => r.issueId === issueId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
      return Promise.resolve(rows.at(-1));
    },
    historyNames({ statusIds, userIds, labelIds }) {
      calls.push('historyNames');
      const named = <T>(ids: readonly string[], get: (id: string) => T | undefined) =>
        new Map(
          ids.flatMap((id) => {
            const found = get(id);
            return found === undefined ? [] : [[id, found] as const];
          }),
        );
      return Promise.resolve({
        statuses: named(statusIds, (id) => {
          const s = statuses.get(id);
          return s && { id: s.id, name: s.name, category: s.category };
        }),
        // Users are workspace-wide and never purged: any id has a name here.
        users: named(userIds, (id) => ({
          id,
          name: id === ADA_ID ? 'Ada' : `User ${id.slice(-4)}`,
        })),
        labels: named(labelIds, (id) => {
          const l = labels.get(id);
          return l && { id: l.id, name: l.name, color: l.color };
        }),
      });
    },
  };

  /** Content and history rows (PLAN-011 S6), recorded in `writes` with their model. */
  function insertChild(model: 'IssueContent' | 'IssueHistory', values: Record<string, unknown>) {
    const issueId = String(values['issueId']);
    const teamId = issues.get(issueId)?.teamId ?? String(values['teamId']);
    const id = String(values['id']);
    writes.push({ action: 'insert', model, ids: [id], fields: Object.keys(values) });
    const base = {
      ...values,
      teamId,
      syncGroups: [`team:${teamId}`],
      createdAt: clock,
      updatedAt: clock,
    };
    if (model === 'IssueContent') {
      const row = base as unknown as IssueContentRow;
      content.set(issueId, row);
      return row;
    }
    const row = base as unknown as IssueHistoryRow;
    historyRows.push(row);
    return row;
  }

  function updateChild(model: 'IssueContent' | 'IssueHistory', id: string, patch: object) {
    writes.push({ action: 'update', model, ids: [id], fields: Object.keys(patch) });
    if (model === 'IssueContent') {
      const row = content.get(id);
      if (!row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: clock };
      content.set(id, next);
      return next;
    }
    const index = historyRows.findIndex((r) => r.id === id);
    const row = historyRows[index];
    if (!row) throw new SurfaceError('NOT_FOUND', 'not found');
    const next = { ...row, ...patch, updatedAt: clock };
    historyRows[index] = next;
    return next;
  }

  const repo: Repo = {
    insert(model, values) {
      if (model === 'IssueContent' || model === 'IssueHistory') {
        return Promise.resolve(insertChild(model, values) as never);
      }
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
        createdAt: clock,
        updatedAt: clock,
        // The generic insert type does not narrow on `model`; the handler under test passes a full row.
      } as unknown as IssueRow;
      issues.set(row.id, row);
      writes.push({ action: 'insert', ids: [row.id], fields: Object.keys(values) });
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      if (model === 'IssueContent' || model === 'IssueHistory') {
        return Promise.resolve(updateChild(model, id, patch) as never);
      }
      const row = issues.get(id);
      if (model !== 'Issue' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: clock } as IssueRow;
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
      const next = { ...row, archivedAt: null, updatedAt: clock };
      issues.set(id, next);
      writes.push({ action: 'unarchive', ids: [id], fields: ['archivedAt'] });
      return Promise.resolve(next as never);
    },
    purge(model, id) {
      if (model !== 'Issue' || !issues.delete(id)) {
        return Promise.reject(new SurfaceError('NOT_FOUND', `${model} ${id} not found.`));
      }
      writes.push({ action: 'purge', ids: [id], fields: [] });
      return Promise.resolve();
    },
    // A purge step's delete (PLAN-015 S2): recorded, with the model, field and `log` option.
    deleteWhere(model, field, ids, options) {
      writes.push({
        action: 'deleteWhere',
        model,
        ids: [...ids],
        fields: [field],
        log: options?.log ?? true,
      });
      return Promise.resolve([]);
    },
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
    content,
    historyRows,
    searchText,
    get now() {
      return clock;
    },
    at(now) {
      clock = now;
    },
    as(next) {
      actor = next;
    },
    calls,
    lockModes,
    writes,
    events,
    repo,
    history,
    attachments,
    audits,
    purge({ actor = ADA_ACTOR, now = NOW, steps = [] } = {}) {
      return {
        access: {
          lockIssue: (issueId, mode) => access.lockIssue(issueId, mode),
          identifier: (issue) => Promise.resolve(identifierOf(issue)),
        },
        tx: recordingDb().db,
        repo,
        actor,
        now,
        steps,
        emit: (event) => void events.push(event),
        audit: (event, fields, message) => void audits.push({ event, fields, message }),
      };
    },
    lifecycle({ actor = ADA_ACTOR, now = NOW } = {}) {
      return {
        access: {
          lockIssue: (issueId, mode) => access.lockIssue(issueId, mode),
          identifier: (issue) => Promise.resolve(identifierOf(issue)),
          relogRows(issueId) {
            const ids = attachments.get(issueId) ?? [];
            // The test stands in for PLAN-014 S4a's model: no Attachment ModelName exists yet.
            const model = 'Attachment' as ModelName;
            return Promise.resolve(ids.length === 0 ? [] : [{ model, ids: [...ids].sort() }]);
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
    // A getter, so `at` and `as` reach the next operation.
    get ctx() {
      return {
        access,
        repo,
        emit: (event: DomainEvent) => void events.push(event),
        now: clock,
        actor,
      };
    },
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
