import type { AnyOperation } from '../define.js';
import { createRegistry } from '../registry.js';
import {
  debugArchive,
  debugUnarchive,
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
  teamSetDefaultStatus,
  teamSetEstimates,
} from './team.js';
import { userCreateResetLink } from './account.js';
import { userGet, userList, userSetRole } from './member.js';
import { workspaceGet, workspaceUpdate } from './workspace.js';
import { inviteCreate, inviteList, inviteRevoke } from './invite.js';
import { userChangePassword, userMe, userUpdateProfile } from './profile.js';
import { sessionList, sessionRevoke, sessionRevokeOthers } from './session.js';
import {
  labelArchive,
  labelCreate,
  labelDelete,
  labelList,
  labelMoveToWorkspace,
  labelUnarchive,
  labelUpdate,
} from './label.js';
import { statusCreate, statusDelete, statusList, statusReorder, statusUpdate } from './status.js';
import {
  issueCount,
  issueCreate,
  issueGet,
  issueGroupBy,
  issueList,
  issueUpdate,
} from './issue.js';
import { issueDelete, issueRestore } from './issue-lifecycle.js';
import { draftDiscard, draftSave } from './draft.js';

export * from './debug.js';
export * from './preferences.js';
export * from './team.js';
export * from './account.js';
export * from './member.js';
export * from './workspace.js';
export * from './invite.js';
export * from './profile.js';
export * from './session.js';
export * from './status.js';
export * from './label.js';
export * from './issue.js';
export * from './issue-lifecycle.js';
export * from './draft.js';

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
  debugArchive,
  debugUnarchive,
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
  userMe,
  userUpdateProfile,
  // Revoke one, then the others, then change the password (which ends the others too): the
  // examples run in this order on one seed, and each needs the seed's second session first.
  sessionList,
  sessionRevoke,
  sessionRevokeOthers,
  userChangePassword,
  // Create before update, reorder and delete: the examples run in this order on one seed, and
  // each acts on the status the one before it made (SPEC-010 §6).
  statusList,
  statusCreate,
  statusUpdate,
  statusReorder,
  statusDelete,
  // Create, edit, archive, unarchive, move, then delete: the examples run in this order on one
  // seed, and each acts on the label the one before it made (SPEC-010 §6).
  labelList,
  labelCreate,
  labelUpdate,
  // Archive then unarchive the same label, before the move and the delete take it away.
  labelArchive,
  labelUnarchive,
  labelMoveToWorkspace,
  labelDelete,
  // Settings of the team the seed's actor belongs to; run after the statuses above (SPEC-010 §6).
  teamSetDefaultStatus,
  teamSetEstimates,
  // Reads first, then create and update: the examples run in this order on one seed, which holds
  // ENG-1 to ENG-3 (SPEC-011 §6.1); `issue.update` edits ENG-1.
  issueList,
  issueCount,
  issueGroupBy,
  issueGet,
  issueCreate,
  issueUpdate,
  // Delete, then restore, the same issue (ENG-3): the seed ends as it started (SPEC-015 §6.1).
  issueDelete,
  issueRestore,
  // The actor's own drafts (SPEC-012 §4.3): save, then discard what was saved.
  draftSave,
  draftDiscard,
];

/** The registry the executor, the HTTP surfaces and the client dispatch read from. */
export const registry = createRegistry(ALL_OPERATIONS);
