/**
 * `IssueAccess` over the operation's Postgres transaction, and the issue output shapes
 * (SPEC-011 §6.1). The rows an output names (team, status, users, labels) are read in one query
 * each for a whole page. Every one of them is visible to whoever sees the issue: its team's status
 * and labels or workspace labels (INV-06), and users, who are workspace-wide.
 */
import { issueIdentifier, issueUrl, isStatusCategory } from '@surface/domain';
import type { IssueOutputSchema } from '@surface/operations';
import { asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { labels, teams, users, workflowStatuses } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { lockIssueForWrite } from '../../issues/lifecycle.js';
import { newIssuePosition } from '../../issues/numbering.js';
import type { IssueAccess, IssueRow, IssueTeam, IssueWriteContext } from './core.js';

type IssueOutput = z.input<typeof IssueOutputSchema>;

const teamColumns = {
  id: teams.id,
  key: teams.key,
  defaultStatusId: teams.defaultStatusId,
  estimateScale: teams.estimateScale,
  estimateExtended: teams.estimateExtended,
  estimateAllowZero: teams.estimateAllowZero,
};

export function issueAccess(ctx: HandlerContext): IssueAccess {
  const { tx } = ctx;
  return {
    async shareTeam(teamId) {
      const [row] = await tx
        .select(teamColumns)
        .from(teams)
        .where(eq(teams.id, teamId))
        .for('share');
      return row;
    },
    async readTeam(teamId): Promise<IssueTeam | undefined> {
      const [row] = await tx.select(teamColumns).from(teams).where(eq(teams.id, teamId));
      return row;
    },
    async shareStatus(statusId) {
      const [row] = await tx
        .select({
          id: workflowStatuses.id,
          teamId: workflowStatuses.teamId,
          category: workflowStatuses.category,
        })
        .from(workflowStatuses)
        .where(eq(workflowStatuses.id, statusId))
        .for('key share');
      return row;
    },
    shareLabels: (labelIds) =>
      tx
        .select()
        .from(labels)
        .where(inArray(labels.id, [...labelIds]))
        .orderBy(asc(labels.id))
        .for('key share'),
    readLabels: (labelIds) =>
      tx
        .select()
        .from(labels)
        .where(inArray(labels.id, [...labelIds])),
    async statusCategory(statusId) {
      const [row] = await tx
        .select({ category: workflowStatuses.category })
        .from(workflowStatuses)
        .where(eq(workflowStatuses.id, statusId));
      return row?.category;
    },
    position: (teamId) => newIssuePosition(tx, teamId),
    lockIssue: (issueId, mode) => lockIssueForWrite(tx, issueId, { actor: ctx.actor }, mode),
  };
}

/** The write context `createIssue` and `updateIssue` run with. */
export function issueWriteContext(ctx: HandlerContext): IssueWriteContext {
  return {
    access: issueAccess(ctx),
    repo: ctx.repo,
    emit: (event) => ctx.emit(event),
    now: ctx.now(),
  };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The full output of each row, in the rows' order (§6.1). */
export async function issueOutputs(
  ctx: Pick<HandlerContext, 'tx' | 'publicUrl'>,
  rows: readonly IssueRow[],
): Promise<IssueOutput[]> {
  if (rows.length === 0) return [];
  const { tx, publicUrl } = ctx;
  if (publicUrl === undefined) throw new Error('Issue outputs need the executor’s publicUrl');
  const unique = (ids: (string | null)[]) => [
    ...new Set(ids.filter((id): id is string => id !== null)),
  ];
  const teamIds = unique(rows.map((r) => r.teamId));
  const statusIds = unique(rows.map((r) => r.statusId));
  const userIds = unique(rows.flatMap((r) => [r.assigneeId, r.creatorId, r.deletedById]));
  const labelIds = unique(rows.flatMap((r) => r.labelIds));

  const [teamRows, statusRows, userRows, labelRows] = [
    await tx.select({ id: teams.id, key: teams.key }).from(teams).where(inArray(teams.id, teamIds)),
    await tx
      .select({
        id: workflowStatuses.id,
        name: workflowStatuses.name,
        category: workflowStatuses.category,
      })
      .from(workflowStatuses)
      .where(inArray(workflowStatuses.id, statusIds)),
    userIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds)),
    labelIds.length === 0
      ? []
      : await tx
          .select({ id: labels.id, name: labels.name, color: labels.color })
          .from(labels)
          .where(inArray(labels.id, labelIds)),
  ];
  const keys = new Map(teamRows.map((t) => [t.id, t.key]));
  const statuses = new Map(statusRows.map((s) => [s.id, s]));
  const names = new Map(userRows.map((u) => [u.id, u.name]));
  const labelsById = new Map(labelRows.map((l) => [l.id, l]));
  const person = (id: string | null) => {
    const name = id === null ? undefined : names.get(id);
    return id === null || name === undefined ? null : { id, name };
  };

  return rows.map((row) => {
    const teamKey = keys.get(row.teamId);
    const status = statuses.get(row.statusId);
    const creator = person(row.creatorId);
    if (teamKey === undefined || status === undefined || creator === null) {
      // Foreign keys guarantee all three; a miss is a bug, never input.
      throw new Error(`Issue ${row.id} references a missing team, status or creator`);
    }
    if (!isStatusCategory(status.category) || row.number === null) {
      throw new Error(`Issue ${row.id} has an unknown status category or no number`);
    }
    const identifier = issueIdentifier(teamKey, row.number);
    return {
      id: row.id,
      identifier,
      teamKey,
      title: row.title,
      status: { id: status.id, name: status.name, category: status.category },
      priority: row.priority,
      assignee: person(row.assigneeId),
      // A label deleted before the cascade reaches this issue is skipped (SPEC-010 §5).
      labels: row.labelIds.flatMap((id) => {
        const label = labelsById.get(id);
        return label === undefined ? [] : [label];
      }),
      estimate: row.estimate,
      dueDate: row.dueDate,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: iso(row.completedAt),
      archivedAt: iso(row.archivedAt),
      deletedAt: iso(row.deletedAt),
      deletedBy: person(row.deletedById),
      // Absolute, on `SURFACE_URL`, as Linear's (§6.1, D11).
      url: issueUrl(publicUrl, identifier, row.title),
      creator,
      startedAt: iso(row.startedAt),
      canceledAt: iso(row.canceledAt),
    };
  });
}

/** One row's full output. */
export async function issueOutput(
  ctx: Pick<HandlerContext, 'tx' | 'publicUrl'>,
  row: IssueRow,
): Promise<IssueOutput> {
  const [output] = await issueOutputs(ctx, [row]);
  if (output === undefined) throw new Error(`No output for issue ${row.id}`);
  return output;
}
