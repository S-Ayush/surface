// Command-menu entry for the invite operations (SPEC-005 §4.1; PLAN-001 S5). "Invite member…"
// (`invite.create`) opens Settings → Members with its invite dialog: the menu's pages are lists,
// with no text field for the email.
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import { INVITE_REQUESTS, type InviteRequests } from './requests.js';

export const MEMBERS_PATH = '/settings/members';

export function openInvite(ctx: CommandContext, requests: InviteRequests = INVITE_REQUESTS): void {
  requests.request();
  ctx.navigate?.(MEMBERS_PATH);
}

export const INVITE_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'invite.create': { run: (ctx) => openInvite(ctx) },
};
