// What the Members screen's role menu does (SPEC-001 §3.6), apart from React so it tests without
// a browser: which choices do nothing, which ask first, and in what order demoting yourself
// leaves the page and sends the change.
import type { UserRole } from '@surface/domain';
import { userSetRole } from '@surface/operations';
import { submitMutation, type MutationStore, type Submission } from '../teams/submit.js';

export type RoleChoice =
  /** The role the person already has. */
  | 'nothing'
  /** Making yourself a Member: ask first, as you lose this page. */
  | 'confirm'
  | 'change';

export function roleChoice(
  member: { readonly role: UserRole; readonly self: boolean },
  role: UserRole,
): RoleChoice {
  if (role === member.role) return 'nothing';
  return member.self && role === 'member' ? 'confirm' : 'change';
}

/** Changes someone's role. Shown at once (optimistic); a refusal is the shell's toast. */
export function changeRole(
  store: MutationStore,
  userId: string,
  role: UserRole,
): Promise<Submission> {
  return submitMutation(store, userSetRole, { user: userId, role });
}

/**
 * Makes the signed-in Admin a Member, once they confirmed. Leaves first: the change shows at
 * once, and Members is a page for Admins only.
 */
export function demoteSelf(
  store: MutationStore,
  myId: string,
  leave: () => void,
): Promise<Submission> {
  leave();
  return changeRole(store, myId, 'member');
}
