import type { AnyOperation } from '../define.js';
import { createRegistry } from '../registry.js';
import {
  debugCreate,
  debugDelete,
  debugEcho,
  debugListItems,
  debugRename,
  debugTouch,
} from './debug.js';
import { userUpdatePreferences } from './preferences.js';
import {
  teamAddMember,
  teamCreate,
  teamJoin,
  teamLeave,
  teamRemoveMember,
  teamSuggestKey,
  teamUpdate,
} from './team.js';
import { userCreateResetLink } from './account.js';
import { userGet, userList, userSetRole } from './member.js';
import { workspaceGet, workspaceUpdate } from './workspace.js';
import { inviteCreate, inviteList, inviteRevoke } from './invite.js';

export * from './debug.js';
export * from './preferences.js';
export * from './team.js';
export * from './account.js';
export * from './member.js';
export * from './workspace.js';
export * from './invite.js';

/**
 * Every operation, listed explicitly (no filesystem globbing) so the client bundle can
 * tree-shake (PLAN-003 S1). Define each operation in `ops/<domain>.ts` (or a folder per
 * domain once it grows), export it from this file, and add it here.
 */
export const ALL_OPERATIONS: readonly AnyOperation[] = [
  debugEcho,
  debugTouch,
  debugListItems,
  debugCreate,
  debugRename,
  debugDelete,
  teamSuggestKey,
  teamCreate,
  teamUpdate,
  // Leave before join: the examples run in this order (registry contract test) and leave the
  // seed's actor a member of ENG again.
  teamLeave,
  teamJoin,
  teamAddMember,
  teamRemoveMember,
  userUpdatePreferences,
  userCreateResetLink,
  workspaceGet,
  workspaceUpdate,
  userList,
  userGet,
  userSetRole,
  inviteCreate,
  inviteList,
  inviteRevoke,
];

/** The registry the executor, the HTTP surfaces and the client dispatch read from. */
export const registry = createRegistry(ALL_OPERATIONS);
