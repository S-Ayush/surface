/**
 * `invite.list` over rows in memory (SPEC-003 §7.1; PLAN-001 S5): invites are server-only and
 * few (`../memory-list.ts`).
 */
import { defineFilterFields, INVITE_STATUSES, USER_ROLES } from '@surface/domain';
import type { InviteSchema } from '@surface/operations';
import type { z } from 'zod';
import { memoryPage, type MemoryListArgs, type MemoryListModel } from '../memory-list.js';

type Invite = z.input<typeof InviteSchema>;

export const INVITE_FILTER_FIELDS = defineFilterFields({
  status: { type: 'enum', values: INVITE_STATUSES },
  email: { type: 'text' },
  role: { type: 'enum', values: USER_ROLES },
  createdAt: { type: 'instant' },
  expiresAt: { type: 'instant' },
});

const INVITE_LIST: MemoryListModel = {
  noun: 'invites',
  filterFields: INVITE_FILTER_FIELDS,
  orderFields: { createdAt: 'instant', expiresAt: 'instant', email: 'text' },
  defaultOrder: { field: 'createdAt', direction: 'desc' },
};

export type InviteListArgs = MemoryListArgs;

/** One page of `invites` (all of them, already shaped) for `args`. */
export function invitePage(
  invites: readonly Invite[],
  args: InviteListArgs,
  context: { readonly now: Date; readonly me: string | null },
) {
  return memoryPage(INVITE_LIST, invites, args, context);
}
