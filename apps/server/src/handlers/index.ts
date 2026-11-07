import type { Handler } from '../executor/context.js';
import debugCreate from './debug/create.js';
import debugDelete from './debug/delete.js';
import debugEcho from './debug/echo.js';
import debugListItems from './debug/list-items.js';
import debugRename from './debug/rename.js';
import debugTouch from './debug/touch.js';
import userUpdatePreferences from './users/update-preferences.js';
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
];
