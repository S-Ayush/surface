/**
 * Issue field rules (SPEC-011 §4.1). Pure functions, shared by the client's `optimistic` and the
 * server's handlers (PLAN-011 S4), so both refuse the same things with the same words.
 */
import { PRIORITIES, type Priority } from './priority.js';

export const ISSUE_TITLE_MAX_LENGTH = 255;

/** Line breaks of every kind (CRLF first, so it becomes one space, not two). */
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;

/**
 * The title as stored: line breaks replaced by spaces (Q5), surrounding spaces trimmed. Spaces
 * inside are kept as typed.
 */
export function normalizeTitle(title: string): string {
  return title.replace(LINE_BREAKS, ' ').trim();
}

/**
 * Why `title` can't be an issue title, or undefined if it can: 1–255 characters after
 * `normalizeTitle`, counted as the user sees them (code points). SPEC-011 §6.4 wording.
 */
export function issueTitleProblem(title: string): string | undefined {
  const normalized = normalizeTitle(title);
  if (normalized.length === 0) return 'Title is required.';
  if ([...normalized].length > ISSUE_TITLE_MAX_LENGTH) {
    return `Title must be ${ISSUE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  return undefined;
}

/** Whether `value` is an issue priority: `0` none, `1` urgent … `4` low (`PRIORITIES`). */
export function isPriority(value: unknown): value is Priority {
  return PRIORITIES.some((priority) => priority.value === value);
}

/** An issue's identifier, `ENG-42` (SPEC-011 §4.1): derived from the team key, never stored. */
export function issueIdentifier(teamKey: string, number: number): string {
  return `${teamKey}-${number}`;
}

/** Who wrote a history entry (SPEC-011 §4.4): the operation's actor kind. */
export const HISTORY_ACTOR_KINDS = ['user', 'api', 'mcp', 'system'] as const;
export type HistoryActorKind = (typeof HISTORY_ACTOR_KINDS)[number];

/** The kinds of history entry in M1 (SPEC-011 §4.4). Later milestones add theirs. */
export const ISSUE_HISTORY_KINDS = [
  'created',
  'updated',
  'deleted',
  'restored',
  'archived',
] as const;
export type IssueHistoryKind = (typeof ISSUE_HISTORY_KINDS)[number];
