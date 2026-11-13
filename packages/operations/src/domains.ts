/**
 * Operation domains (SPEC-003 §3.1: "one of the domain list in domain-model §7").
 * An operation's name prefix is not always its domain: `reaction.toggle` belongs to
 * `comment`, `projectUpdate.list` to `update`, `apiKey.create` to `platform`.
 */
export const OPERATION_DOMAINS = [
  'workspace',
  'user',
  'invite',
  'team',
  'status',
  'label',
  'issue',
  'relation',
  'comment',
  'attachment',
  'triage',
  'cycle',
  'project',
  'milestone',
  'update',
  'initiative',
  'document',
  'template',
  'view',
  'personal',
  // SPEC-003 §3.1 (M1 gate): `draft.save`, `draft.discard` (SPEC-012 §4.3).
  'draft',
  'platform',
  'io',
  // Internal test fixtures only (`debug.echo`, `debug.touch`, PLAN-002 `DebugItem` ops).
  'debug',
] as const;

export type OperationDomain = (typeof OPERATION_DOMAINS)[number];

export function isOperationDomain(value: unknown): value is OperationDomain {
  return typeof value === 'string' && (OPERATION_DOMAINS as readonly string[]).includes(value);
}
