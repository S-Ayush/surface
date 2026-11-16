/**
 * `label.usage` (SPEC-010 §5, §6, D15, AC-26): per label in scope, archived labels included, the
 * issues the actor can see that carry it and aren't deleted (archived issues count), the teams of
 * those issues and their latest `updatedAt` (D7's "Last applied"). The replica holds only some
 * issues (SPEC-011 §5.7), so the labels page asks the server.
 *
 * Two reads: the labels in scope (as `label.list` scopes them, at most `LABEL_USAGE_LIMIT`), then
 * one query over `issues` (the GIN index on `label_ids` finds them) grouped by label and team.
 * Both apply `visibleTo` (`visibleGroups` and an API key's teams), so a private team's labels,
 * issues and team never show to a non-member (permissions §5).
 */
import type { Actor } from '@surface/domain';
import { LABEL_USAGE_LIMIT, labelUsage, type OutputOf } from '@surface/operations';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { issues, labels, teams } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { visibleTo } from '../../executor/list.js';
import { resolved } from '../teams/shared.js';

export interface UsageScope {
  /** The team named in the input, if any. */
  readonly teamId?: string | undefined;
  readonly scope: 'team' | 'workspace' | 'all';
}

/**
 * The labels in scope, as `label.list` reads them (SPEC-010 §6): `workspace` is the workspace's;
 * `team` is the team's (every team's without one); `all` is the team's plus the workspace's (every
 * label without one). A key narrowed to some teams sees those teams' labels and the workspace's.
 */
export function labelScopeCondition(actor: Actor, input: UsageScope): SQL | undefined {
  const inTeam = input.teamId === undefined ? undefined : eq(labels.teamId, input.teamId);
  const scope =
    input.scope === 'workspace'
      ? isNull(labels.teamId)
      : input.scope === 'team'
        ? (inTeam ?? isNotNull(labels.teamId))
        : inTeam === undefined
          ? undefined
          : or(inTeam, isNull(labels.teamId));
  const keyTeams = actor.kind === 'system' ? [] : (actor.apiKey?.teamIds ?? []);
  const key =
    keyTeams.length > 0
      ? or(isNull(labels.teamId), inArray(labels.teamId, [...keyTeams]))
      : undefined;
  return and(visibleTo(actor, labels.syncGroups, null), scope, key);
}

/** One row per label and team: the issues of that team carrying the label. */
export interface UsageRow {
  readonly labelId: string;
  readonly teamId: string;
  readonly teamKey: string;
  readonly teamName: string;
  readonly issues: number;
  /** `max(updated_at)`; the driver gives a Date, a stand-in may give text. */
  readonly lastAppliedAt: Date | string | null;
}

/**
 * The usage query: issues that aren't deleted (archived ones count) and that the actor can see,
 * that carry one of `labelIds`, counted per label (an issue counts once in each of its labels) and
 * team. `&&` uses the GIN index; the lateral `unnest` then splits each issue into its labels.
 */
export function usageStatement(actor: Actor, labelIds: readonly string[]): SQL {
  const ids = sql`${sql.param([...labelIds])}::uuid[]`;
  const visible = visibleTo(actor, issues.syncGroups, issues.teamId) ?? sql`TRUE`;
  return sql`SELECT l.label_id AS "labelId", ${issues.teamId} AS "teamId", ${teams.key} AS "teamKey",
                    ${teams.name} AS "teamName", count(*)::int AS "issues",
                    max(${issues.updatedAt}) AS "lastAppliedAt"
               FROM ${issues}
               CROSS JOIN LATERAL unnest(${issues.labelIds}) AS l(label_id)
               JOIN ${teams} ON ${teams.id} = ${issues.teamId}
              WHERE ${issues.labelIds} && ${ids}
                AND l.label_id = ANY(${ids})
                AND ${issues.deletedAt} IS NULL
                AND ${visible}
              GROUP BY 1, 2, 3, 4`;
}

type UsageOutput = OutputOf<typeof labelUsage>;

function instant(value: Date | string | null): number | null {
  if (value === null) return null;
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * The answer: every label in `inScope` order, with its issue count summed over its teams, the
 * teams by key, and the latest `updatedAt` among them. A label no visible issue carries has 0,
 * no teams and `lastAppliedAt: null`.
 */
export function shapeUsage(
  inScope: readonly { readonly id: string; readonly name: string }[],
  rows: readonly UsageRow[],
): UsageOutput {
  const byLabel = new Map<string, UsageRow[]>();
  for (const row of rows) byLabel.set(row.labelId, [...(byLabel.get(row.labelId) ?? []), row]);
  return {
    labels: inScope.map((label) => {
      const own = byLabel.get(label.id) ?? [];
      const latest = own.reduce<number | null>((at, row) => {
        const time = instant(row.lastAppliedAt);
        return time === null || (at !== null && at >= time) ? at : time;
      }, null);
      return {
        label: { id: label.id, name: label.name },
        issues: own.reduce((sum, row) => sum + row.issues, 0),
        teams: own
          .map((row) => ({ id: row.teamId, key: row.teamKey, name: row.teamName }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
        lastAppliedAt: latest === null ? null : new Date(latest).toISOString(),
      };
    }),
  };
}

export default handler(labelUsage, async (ctx, input) => {
  const teamId = input.team === undefined ? undefined : resolved(ctx.refs['team'], 'team').id;
  const inScope = await ctx.tx
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(labelScopeCondition(ctx.actor, { teamId, scope: input.scope }))
    .orderBy(labels.name, labels.id)
    .limit(LABEL_USAGE_LIMIT);
  if (inScope.length === 0) return { labels: [] };
  const result = await ctx.tx.execute<{ [K in keyof UsageRow]: UsageRow[K] }>(
    usageStatement(
      ctx.actor,
      inScope.map((l) => l.id),
    ),
  );
  return shapeUsage(inScope, result.rows);
});
