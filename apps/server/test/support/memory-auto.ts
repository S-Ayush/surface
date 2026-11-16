/**
 * The in-memory workspace of `memory-issues.ts` run through `autoArchiveIssue` and
 * `autoCloseIssue` (PLAN-015 S3): the access reads the team's settings and statuses from `m`, the
 * repo gains the `archive` the base fake lacks, and the two history seams record their calls.
 */
import { randomUUID } from 'node:crypto';
import { issueIdentifier, type IssueChangeSet } from '@surface/domain';
import { createIssue } from '../../src/handlers/issues/core.js';
import type { AutoContext, AutomationSettings } from '../../src/handlers/issues/auto-core.js';
import type { Repo } from '../../src/sync/repo.js';
import { SurfaceError } from '../../src/executor/errors.js';
import { ADA_ID, NOW, type MemoryIssues } from './memory-issues.js';
import type { IssueRow } from '../../src/handlers/issues/core.js';

export interface MemoryAuto {
  readonly ctx: AutoContext;
  /** The `archived` history entries (the `writeLifecycleHistory` seam), in order. */
  readonly archivedHistory: string[];
  /** The auto-close `updated` entries (the `writeAutoCloseHistory` seam): issue id and changes. */
  readonly closeHistory: { readonly issueId: string; readonly changes: IssueChangeSet }[];
  /** Replaces a team's settings; the next read sees them. */
  setSettings(teamId: string, settings: Partial<AutomationSettings>): void;
}

export function memoryAuto(
  m: MemoryIssues,
  options: { readonly now?: Date; readonly settings?: Partial<AutomationSettings> } = {},
): MemoryAuto {
  const settings = new Map<string, AutomationSettings>();
  const settingsOf = (teamId: string): AutomationSettings => {
    const known = settings.get(teamId);
    if (known) return known;
    const canceled = [...m.statuses.values()].find(
      (s) => s.teamId === teamId && s.category === 'canceled',
    );
    const fresh: AutomationSettings = {
      autoArchiveMonths: 6,
      autoCloseMonths: 6,
      autoCloseStatusId: canceled?.id ?? null,
      ...options.settings,
    };
    settings.set(teamId, fresh);
    return fresh;
  };
  const identifierOf = (issue: IssueRow) =>
    issueIdentifier(
      [m.eng, m.des].find((t) => t.id === issue.teamId)?.key ?? 'ENG',
      issue.number ?? 0,
    );
  const archivedHistory: string[] = [];
  const closeHistory: MemoryAuto['closeHistory'] = [];

  const repo: Repo = {
    ...m.repo,
    archive(model, id) {
      const row = m.issues.get(id);
      if (model !== 'Issue' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      m.calls.push('write:archive');
      const next = { ...row, archivedAt: NOW, updatedAt: NOW };
      m.issues.set(id, next);
      m.writes.push({ action: 'archive', ids: [id], fields: ['archivedAt'] });
      return Promise.resolve(next as never);
    },
  };

  return {
    archivedHistory,
    closeHistory,
    setSettings: (teamId, patch) => settings.set(teamId, { ...settingsOf(teamId), ...patch }),
    ctx: {
      access: {
        shareTeam(teamId) {
          m.calls.push('shareTeam');
          return Promise.resolve(settingsOf(teamId));
        },
        shareStatus(statusId) {
          m.calls.push('shareStatus');
          const status = m.statuses.get(statusId);
          return Promise.resolve(
            status && { id: status.id, teamId: status.teamId, category: status.category },
          );
        },
        lockIssue: (issueId, mode) => m.ctx.access.lockIssue(issueId, mode),
        statusCategory: (statusId) => Promise.resolve(m.statuses.get(statusId)?.category),
        identifier: (issue) => Promise.resolve(identifierOf(issue)),
      },
      repo,
      now: options.now ?? NOW,
      emit: (event) => void m.events.push(event),
      history(kind, issue) {
        if (kind === 'archived') archivedHistory.push(issue.id);
        m.history.push({ kind, issueId: issue.id });
        return Promise.resolve();
      },
      closeHistory(issue, changes) {
        closeHistory.push({ issueId: issue.id, changes });
        return Promise.resolve();
      },
    },
  };
}

/**
 * ENG-n in the workspace of `m`, in `status` (default Backlog) with `fields` laid over the stored
 * row (timestamps, lifecycle), and the writes of creating it forgotten.
 */
export async function seedIssue(
  m: MemoryIssues,
  fields: Partial<IssueRow> & { readonly status?: string } = {},
): Promise<IssueRow> {
  const { status = 'Backlog', ...row } = fields;
  const created = await createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    statusId: m.status(m.eng, status).id,
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
  });
  const issue: IssueRow = { ...created, ...row };
  m.issues.set(issue.id, issue);
  for (const list of [m.writes, m.events, m.calls, m.lockModes, m.history, m.audits]) {
    list.length = 0;
  }
  return issue;
}
