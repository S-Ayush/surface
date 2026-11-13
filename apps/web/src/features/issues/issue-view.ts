// What the issue page shows, as plain data (SPEC-012 §3.4). The page renders one shape whether the
// issue came from the replica (live, editable) or from `issue.get` (an archived or deleted issue,
// or one the replica doesn't hold yet: read-only), so `IssuePage` has no second code path.
import {
  COLOR_HUES,
  isPriority,
  isValidEstimate,
  issueIdentifier,
  type ColorHue,
  type EstimateConfig,
  type Priority,
  type StatusCategory,
} from '@surface/domain';
import { Issue, Label, Team, User, WorkflowStatus } from '@surface/domain/model';
import type { IssueOutputSchema } from '@surface/operations';
import type { ReadonlyPool } from '@surface/sync-client';
import type { z } from 'zod';

export type IssueLifecycle = 'live' | 'archived' | 'deleted';

export type IssueView = {
  readonly id: string;
  readonly teamId: string;
  readonly teamKey: string;
  /** Null while the issue is pending (no number yet). */
  readonly number: number | null;
  readonly identifier: string | null;
  readonly title: string;
  readonly status: {
    readonly name: string;
    readonly category: StatusCategory;
    readonly color: ColorHue;
  };
  readonly priority: Priority;
  readonly assignee: { readonly name: string } | null;
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: ColorHue;
  }[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly creatorName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle: IssueLifecycle;
  /**
   * The team's estimate settings, from the replica. Null when the replica doesn't hold the team
   * (a read-only view of an issue of a team the user isn't in), so no hint can be worked out.
   */
  readonly estimateConfig: EstimateConfig | null;
};

export function isColorHue(value: string): value is ColorHue {
  return COLOR_HUES.some((hue) => hue === value);
}

function lifecycleOf(row: {
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}): IssueLifecycle {
  if (row.deletedAt !== null) return 'deleted';
  return row.archivedAt !== null ? 'archived' : 'live';
}

/** The issue `id` as the replica holds it; undefined when it, or its team or status, is missing. */
export function issueViewFromPool(pool: ReadonlyPool, id: string): IssueView | undefined {
  const issue = pool.get(Issue, id);
  if (issue === undefined) return undefined;
  const team = pool.get(Team, issue.teamId);
  const status = pool.get(WorkflowStatus, issue.statusId);
  if (team === undefined || status === undefined) return undefined;
  const assignee = issue.assigneeId === null ? undefined : pool.get(User, issue.assigneeId);
  const creator = pool.get(User, issue.creatorId);
  const labels = issue.labelIds.flatMap((labelId) => {
    // A label deleted while its deltas are on the way is skipped (SPEC-012 §3.5).
    const label = pool.get(Label, labelId);
    return label === undefined ? [] : [{ id: label.id, name: label.name, color: label.color }];
  });
  labels.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
  return {
    id: issue.id,
    teamId: issue.teamId,
    teamKey: team.key,
    number: issue.number,
    identifier: issue.number === null ? null : issueIdentifier(team.key, issue.number),
    title: issue.title,
    status: { name: status.name, category: status.category, color: status.color },
    priority: isPriority(issue.priority) ? issue.priority : 0,
    assignee: assignee === undefined ? null : { name: assignee.displayName || assignee.name },
    labels,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    creatorName: creator === undefined ? null : creator.displayName || creator.name,
    createdAt: String(issue.createdAt),
    updatedAt: String(issue.updatedAt),
    lifecycle: lifecycleOf(issue),
    estimateConfig: {
      scale: team.estimateScale,
      extended: team.estimateExtended,
      allowZero: team.estimateAllowZero,
    },
  };
}

export type IssueOutput = z.output<typeof IssueOutputSchema>;

/**
 * An issue as `issue.get` answers it: always read-only, nothing of it is in the replica. `pool`
 * only supplies the team's estimate settings when the user's replica happens to hold the team.
 */
export function issueViewFromOutput(output: IssueOutput, pool?: ReadonlyPool): IssueView {
  const team = pool?.findBy(Team, 'key', output.teamKey)[0];
  const number = Number(output.identifier.slice(output.identifier.lastIndexOf('-') + 1));
  return {
    id: output.id,
    teamId: team?.id ?? '',
    teamKey: output.teamKey,
    number: Number.isInteger(number) ? number : null,
    identifier: output.identifier,
    title: output.title,
    status: {
      name: output.status.name,
      category: output.status.category,
      // The answer carries no colour; the category's glyph tells statuses apart (design-system §5.1).
      color: 'gray',
    },
    priority: isPriority(output.priority) ? output.priority : 0,
    assignee: output.assignee === null ? null : { name: output.assignee.name },
    labels: output.labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: isColorHue(label.color) ? label.color : 'gray',
    })),
    estimate: output.estimate,
    dueDate: output.dueDate,
    creatorName: output.creator.name,
    createdAt: output.createdAt,
    updatedAt: output.updatedAt,
    lifecycle: lifecycleOf(output),
    estimateConfig:
      team === undefined
        ? null
        : {
            scale: team.estimateScale,
            extended: team.estimateExtended,
            allowZero: team.estimateAllowZero,
          },
  };
}

export type EstimateRow =
  /** Nothing to show: the team doesn't use estimates and the issue has none. */
  | { readonly shown: false }
  | { readonly shown: true; readonly value: number | null; readonly offScale: boolean };

/**
 * The estimate row (§3.4 item 5): shown while the team uses estimates or the issue has one. A
 * value that is off the team's scale shows as its number with an "Off scale" hint (SPEC-010 E5).
 * Without the team's settings (a read-only view) a value is shown plainly.
 */
export function estimateRow(view: Pick<IssueView, 'estimate' | 'estimateConfig'>): EstimateRow {
  const { estimate, estimateConfig: config } = view;
  if (estimate === null) {
    return config === null || config.scale === 'off'
      ? { shown: false }
      : { shown: true, value: null, offScale: false };
  }
  return {
    shown: true,
    value: estimate,
    offScale: config !== null && !isValidEstimate(config, estimate),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });

/** "2h ago" (SPEC-012 §3.4 item 5); a date past a week. */
export function agoText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ago = now.getTime() - at.getTime();
  if (ago < 2 * MINUTE) return 'just now';
  if (ago < HOUR) return relative.format(-Math.floor(ago / MINUTE), 'minute');
  if (ago < DAY) return relative.format(-Math.floor(ago / HOUR), 'hour');
  if (ago < 7 * DAY) return relative.format(-Math.floor(ago / DAY), 'day');
  return shortDate(at, now);
}

/** "Nov 6", with the year when it isn't this one. */
export function shortDate(at: Date, now: Date): string {
  return at.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
