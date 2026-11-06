/**
 * Fixed workflow status categories (domain-model §WorkflowStatus).
 * Teams name their own statuses, but every status belongs to one of these.
 */
export const STATUS_CATEGORIES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'duplicate',
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Categories in which an issue counts as closed. */
export const CLOSED_CATEGORIES: ReadonlySet<StatusCategory> = new Set([
  'completed',
  'canceled',
  'duplicate',
]);

export function isStatusCategory(value: unknown): value is StatusCategory {
  return typeof value === 'string' && (STATUS_CATEGORIES as readonly string[]).includes(value);
}
