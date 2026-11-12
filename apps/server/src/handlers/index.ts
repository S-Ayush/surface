import type { Handler } from '../executor/context.js';
import debugCreate from './debug/create.js';
import debugDelete from './debug/delete.js';
import debugEcho from './debug/echo.js';
import debugListItems from './debug/list-items.js';
import debugRename from './debug/rename.js';
import debugTouch from './debug/touch.js';
import userUpdatePreferences from './users/update-preferences.js';
import statusCreate from './statuses/create.js';
import statusDelete from './statuses/delete.js';
import statusList from './statuses/list.js';
import statusReorder from './statuses/reorder.js';
import statusUpdate from './statuses/update.js';
import teamAddMember from './teams/add-member.js';
import teamCreate from './teams/create.js';
import teamJoin from './teams/join.js';
import teamLeave from './teams/leave.js';
import teamRemoveMember from './teams/remove-member.js';
import teamSuggestKey from './teams/suggest-key.js';
import teamUpdate from './teams/update.js';
import userCreateResetLink from './account/create-reset-link.js';
import userGet from './members/get.js';
import userList from './members/list.js';
import userSetRole from './members/set-role.js';
import workspaceGet from './workspace/get.js';
import workspaceUpdate from './workspace/update.js';
import inviteCreate from './invites/create.js';
import inviteList from './invites/list.js';
import inviteRevoke from './invites/revoke.js';
import userMe from './users/me.js';
import userUpdateProfile from './users/update-profile.js';
import userChangePassword from './users/change-password.js';
import sessionList from './sessions/list.js';
import sessionRevoke from './sessions/revoke.js';
import sessionRevokeOthers from './sessions/revoke-others.js';

/** Every server handler, one per operation in the registry (checked at executor creation). */
export const HANDLERS: readonly Handler[] = [
  debugEcho,
  debugTouch,
  debugListItems,
  debugCreate,
  debugRename,
  debugDelete,
  teamSuggestKey,
  teamCreate,
  teamUpdate,
  teamJoin,
  teamLeave,
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
  userChangePassword,
  sessionList,
  sessionRevoke,
  sessionRevokeOthers,
  statusList,
  statusCreate,
  statusUpdate,
  statusReorder,
  statusDelete,
];
