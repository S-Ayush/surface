/**
 * Member rules shared by the server and the web (SPEC-001 §3.6, PLAN-001 S7): the server refuses
 * with these, and Settings → Members disables what they forbid, with the same words.
 */
import type { UserRole } from './workspace.js';

/** SPEC-001 E6: the answer when a role change would leave no active Admin (INV-01). */
export const LAST_ADMIN_MESSAGE =
  'Surface needs at least one Admin. Make someone else an Admin first.';

/**
 * Whether giving `userId` the role `role` leaves no active Admin (INV-01, AC-10).
 * `activeAdminIds` are the active Admins now; a promotion, or a demotion of a non-Admin, is
 * always fine.
 */
export function leavesNoAdmin(
  activeAdminIds: readonly string[],
  userId: string,
  role: UserRole,
): boolean {
  if (role === 'admin') return false;
  const remaining = new Set(activeAdminIds);
  remaining.delete(userId);
  return remaining.size === 0;
}
