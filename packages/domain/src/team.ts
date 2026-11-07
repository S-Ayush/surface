/**
 * Team rules shared by the client's optimistic team operations and the server (SPEC-001 §3.7,
 * §8; PLAN-001 S8).
 */
import type { ColorHue, EstimateScale } from './workspace.js';

/** A new team's settings: the `teams` column defaults (PLAN-001 S1; a server test keeps them so). */
export const NEW_TEAM_SETTINGS: {
  readonly color: ColorHue;
  readonly timezone: string;
  readonly private: boolean;
  readonly triageEnabled: boolean;
  readonly estimateScale: EstimateScale;
  readonly cyclesEnabled: boolean;
  readonly cycleDurationWeeks: number;
  readonly cycleCooldownWeeks: number;
  readonly cycleStartWeekday: number;
  readonly cycleUpcomingCount: number;
  readonly cycleAutoAddStarted: boolean;
  readonly cycleAutoAddCompleted: boolean;
  readonly autoArchiveMonths: number | null;
  readonly autoCloseMonths: number | null;
  readonly parentAutoComplete: boolean;
} = Object.freeze({
  color: 'gray',
  timezone: 'UTC',
  private: false,
  triageEnabled: false,
  estimateScale: 'off',
  cyclesEnabled: false,
  cycleDurationWeeks: 2,
  cycleCooldownWeeks: 0,
  cycleStartWeekday: 1,
  cycleUpcomingCount: 2,
  cycleAutoAddStarted: false,
  cycleAutoAddCompleted: false,
  autoArchiveMonths: 6,
  autoCloseMonths: null,
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
