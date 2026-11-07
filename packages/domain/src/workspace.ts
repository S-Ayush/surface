/**
 * Workspace, team and workflow rules shared by the client and the server (domain-model §4.1–4.5,
 * SPEC-001 §4). The database enforces what it can (PLAN-001 S1); handlers use these for the rest
 * and to word errors before a constraint fires.
 */
import type { StatusCategory } from './status-category.js';

/** The 12 palette hues for labels, teams and projects (design-system §2.2). No free hex in v1. */
export const COLOR_HUES = [
  'gray',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'violet',
  'pink',
] as const;
export type ColorHue = (typeof COLOR_HUES)[number];

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SIGNUP_POLICIES = ['invite_only', 'domain'] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

export const ESTIMATE_SCALES = ['off', 'linear', 'exponential', 'fibonacci', 'tshirt'] as const;
export type EstimateScale = (typeof ESTIMATE_SCALES)[number];

/** Team keys prefix issue identifiers (`ENG-123`): 2–5 capital letters (INV-03). */
export const TEAM_KEY_PATTERN = /^[A-Z]{2,5}$/;
/** Keys that would clash with routes or tools (SPEC-001 §4). */
export const RESERVED_TEAM_KEYS: readonly string[] = ['NEW', 'API', 'MCP', 'SYNC', 'AUTH'];

/** Why `key` can't be a team key, or undefined if it can (uniqueness is checked elsewhere). */
export function teamKeyProblem(key: string): string | undefined {
  if (!TEAM_KEY_PATTERN.test(key)) return 'Team key must be 2–5 capital letters, like ENG';
  if (RESERVED_TEAM_KEYS.includes(key)) {
    return `${key} is reserved; choose another team key`;
  }
  return undefined;
}

/** `UTC`, or `Area/Location` with optional deeper parts (`America/Argentina/Buenos_Aires`). */
const IANA_ZONE_NAME = /^(?:utc|[a-z]+(?:\/[a-z0-9_+-]+)+)$/i;

/**
 * Why `timeZone` isn't an IANA time zone this runtime knows, or undefined if it is. Teams and
 * users store one (domain-model §4.2, §4.3). Only `UTC` and `Area/Location` names: ICU also
 * accepts legacy ids like `PST` or `EST5EDT`, and offsets like `+05:00`, which are not zones.
 * Store `canonicalTimeZone(timeZone)`, not the input.
 */
export function timeZoneProblem(timeZone: string): string | undefined {
  if (timeZone === '') return 'Time zone is required, like Europe/Berlin';
  const problem = `"${timeZone.slice(0, 64)}" is not a time zone. Use an IANA name, like Europe/Berlin or UTC`;
  if (timeZone.length > 64 || !IANA_ZONE_NAME.test(timeZone)) return problem;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return undefined;
  } catch {
    return problem;
  }
}

/**
 * The runtime's canonical name for a valid zone (`europe/berlin` → `Europe/Berlin`,
 * `US/Pacific` → `America/Los_Angeles`), so equal zones compare equal. Returns anything else
 * unchanged: check it with `timeZoneProblem` first.
 */
export function canonicalTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return timeZone;
  }
}

export interface WorkflowStatusSeed {
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: ColorHue;
}

/** The statuses every new team starts with (SPEC-001 §4), in display order. */
export const DEFAULT_TEAM_WORKFLOW: readonly WorkflowStatusSeed[] = [
  { name: 'Triage', category: 'triage', color: 'orange' },
  { name: 'Backlog', category: 'backlog', color: 'gray' },
  { name: 'Todo', category: 'unstarted', color: 'gray' },
  { name: 'In Progress', category: 'started', color: 'yellow' },
  { name: 'In Review', category: 'started', color: 'green' },
  { name: 'Done', category: 'completed', color: 'blue' },
  { name: 'Canceled', category: 'canceled', color: 'gray' },
  { name: 'Duplicate', category: 'duplicate', color: 'gray' },
];

/** The status a new team's issues start in (SPEC-001 §4: Backlog is the default). */
export const DEFAULT_STATUS_NAME = 'Backlog';

/** The workspace labels created at setup (SPEC-001 §4). */
export const DEFAULT_WORKSPACE_LABELS: readonly {
  readonly name: string;
  readonly color: ColorHue;
}[] = [
  { name: 'Bug', color: 'red' },
  { name: 'Feature', color: 'violet' },
  { name: 'Improvement', color: 'blue' },
];

/** Categories a team needs at least one status in (INV-04). */
const REQUIRED_CATEGORIES: readonly StatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];
/** Categories a team has exactly one status in (INV-04). */
const SINGLE_CATEGORIES: readonly StatusCategory[] = ['triage', 'duplicate'];
/** Categories the default status may be in (INV-05). */
export const DEFAULT_STATUS_CATEGORIES: readonly StatusCategory[] = ['backlog', 'unstarted'];

/**
 * Problems with a team's statuses and default status (INV-04, INV-05), as sentences. Empty when
 * the workflow is valid. `statuses` are the team's statuses that aren't archived.
 */
export function workflowProblems(
  statuses: readonly { readonly id: string; readonly category: StatusCategory }[],
  defaultStatusId: string,
): string[] {
  const problems: string[] = [];
  const count = (category: StatusCategory) =>
    statuses.filter((s) => s.category === category).length;
  for (const category of REQUIRED_CATEGORIES) {
    if (count(category) === 0) problems.push(`A team needs at least one ${category} status`);
  }
  for (const category of SINGLE_CATEGORIES) {
    const n = count(category);
    if (n !== 1) problems.push(`A team needs exactly one ${category} status (has ${n})`);
  }
  const defaultStatus = statuses.find((s) => s.id === defaultStatusId);
  if (!defaultStatus) {
    problems.push("The default status must be one of the team's statuses");
  } else if (!DEFAULT_STATUS_CATEGORIES.includes(defaultStatus.category)) {
    problems.push('The default status must be in the Backlog or Unstarted category');
  }
  return problems;
}
