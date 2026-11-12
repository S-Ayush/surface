/**
 * Audit events (SPEC-001 §10, PLAN-001 S9): one log line per security-relevant action, in one shape,
 * so the M7 audit log can be built on them and an operator can grep them now (`"audit":true`).
 *
 * Never the email, password, token or cookie: an email typed into the password field would land
 * in the log, and the log is not the place for credentials (CLAUDE.md rule 6). Users are named by
 * id; the request's own log line carries its id (`reqId`) for anything else.
 */
import type { FastifyBaseLogger } from 'fastify';

/** SPEC-001 §10, plus the failed reset that PLAN-001 S4 logs. */
export type AuditEvent =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.password_changed'
  | 'auth.password_reset'
  | 'auth.password_reset_failed'
  | 'user.invited'
  | 'user.joined'
  | 'user.role_changed';

export interface AuditFields {
  /** The user the event is about: who signed in or failed to, who joined, whose role changed. */
  readonly userId?: string;
  /** Who did it, when that is someone else (an Admin changing a role, inviting). */
  readonly actorId?: string;
  /** The client address as the server sees it (`request.ip`, behind a trusted proxy its client's). */
  readonly ip?: string;
  /** The session a sign-in created. An id, never the token. */
  readonly sessionId?: string;
  /** Why it failed, or how it came about: `incorrect`, `locked`, `setup`, `invite`. */
  readonly reason?: string;
  /** How someone signed in or tried to; `password_change` is a current password checked by
   * `user.changePassword`, which counts against the same lockout. */
  readonly method?: 'password' | 'magic_link' | 'password_change';
  /** Seconds until a locked-out sign-in may try again. */
  readonly retryAfter?: number;
  /** For `user.role_changed`. */
  readonly from?: string;
  readonly to?: string;
}

/** One line, as an operation's handler records it for after the commit (`ctx.audit`). */
export interface AuditLine {
  readonly event: AuditEvent;
  readonly fields: AuditFields;
  readonly message: string;
}

const FAILURES: ReadonlySet<AuditEvent> = new Set([
  'auth.login_failed',
  'auth.password_reset_failed',
]);

/** Logs `event` at `info`, or `warn` for a failure. */
export function audit(
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  event: AuditEvent,
  fields: AuditFields,
  message: string,
): void {
  const line = { audit: true, event, ...fields };
  if (FAILURES.has(event)) log.warn(line, message);
  else log.info(line, message);
}
