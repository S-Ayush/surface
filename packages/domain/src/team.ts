/**
 * Team rules shared by the client's optimistic team operations and the server (SPEC-001 §3.7,
 * §8; PLAN-001 S8).
 */
import type { ColorHue, EstimateScale } from './workspace.js';

/**
 * The periods auto-archive and auto-close offer, in months (SPEC-015 §3.2). The `teams` checks
 * allow only these (migration 0014).
 */
export const AUTOMATION_MONTHS = [1, 3, 6, 9, 12] as const;
export type AutomationMonths = (typeof AUTOMATION_MONTHS)[number];

/** Turning auto-close on with no value sets this many months (SPEC-015 §3.2). */
export const DEFAULT_AUTO_CLOSE_MONTHS: AutomationMonths = 6;

/** A new team's settings: the `teams` column defaults (PLAN-001 S1; a server test keeps them so). */
export const NEW_TEAM_SETTINGS: {
  readonly color: ColorHue;
  readonly timezone: string;
  readonly private: boolean;
  readonly triageEnabled: boolean;
  readonly estimateScale: EstimateScale;
  readonly estimateExtended: boolean;
  readonly estimateAllowZero: boolean;
  readonly estimateCountUnestimatedAsOne: boolean;
  readonly cyclesEnabled: boolean;
  readonly cycleDurationWeeks: number;
  readonly cycleCooldownWeeks: number;
  readonly cycleStartWeekday: number;
  readonly cycleUpcomingCount: number;
  readonly cycleAutoAddStarted: boolean;
  readonly cycleAutoAddCompleted: boolean;
  readonly autoArchiveMonths: number;
  readonly autoCloseMonths: number | null;
  readonly autoCloseStatusId: string | null;
  readonly parentAutoComplete: boolean;
} = Object.freeze({
  color: 'gray',
  timezone: 'UTC',
  private: false,
  triageEnabled: false,
  estimateScale: 'off',
  estimateExtended: false,
  estimateAllowZero: false,
  estimateCountUnestimatedAsOne: true,
  cyclesEnabled: false,
  cycleDurationWeeks: 2,
  cycleCooldownWeeks: 0,
  cycleStartWeekday: 1,
  cycleUpcomingCount: 2,
  cycleAutoAddStarted: false,
  cycleAutoAddCompleted: false,
  autoArchiveMonths: 6,
  autoCloseMonths: null,
  autoCloseStatusId: null,
  parentAutoComplete: false,
});

/**
 * Whether a membership can end (SPEC-001 E12, D3): always on a public team, which stays and can
 * be joined; on a private team only while someone else remains, since nobody else can see it.
 */
export function canEndMembership(
  team: { readonly private: boolean },
  memberCount: number,
): boolean {
  return !team.private || memberCount > 1;
}
