/**
 * How long the names people type may be: the workspace's comes from domain-model §4.1, the team's
 * matches `team.create` (`TEAM_NAME_MAX`, PLAN-001 S8), and a person's was set with first-run
 * setup (PLAN-001 S2). Shared so the forms say what is wrong before the server does.
 */
export const NAME_MAX_LENGTH = { workspace: 64, team: 80, person: 80 } as const;

/**
 * Why `name` can't be used for `field` ("Team name"), or undefined if it can. Surrounding spaces
 * are ignored, and length counts characters as the user sees them.
 */
export function nameProblem(field: string, name: string, max: number): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return `${field} is required`;
  if ([...trimmed].length > max) return `${field} must be at most ${max} characters long`;
  return undefined;
}
