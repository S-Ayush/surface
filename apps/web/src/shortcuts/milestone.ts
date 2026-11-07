// Shortcuts ship with their feature (shortcuts.md §3, "M" column). The help overlay and the engine
// only see bindings whose milestone this build has reached (SPEC-005 §5, AC-8).
export const MILESTONES = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
export type Milestone = (typeof MILESTONES)[number];

/** The milestone this build delivers. Raise it when a milestone's features land. */
export const BUILD_MILESTONE: Milestone = 'M0';

export function isInBuild(milestone: Milestone, build: Milestone = BUILD_MILESTONE): boolean {
  return MILESTONES.indexOf(milestone) <= MILESTONES.indexOf(build);
}
