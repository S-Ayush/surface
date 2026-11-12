// How the command menu runs each operation with `ui` metadata (SPEC-005 §4.1), gathered from the
// features that own the operations. A feature keeps its entries in its own folder
// (`features/teams/commands.ts` exporting `TEAM_COMMANDS`) and adds one spread line here.
// Shared registry file, append-only for every session (sessions README §7): add your own line
// only, and on a rebase conflict keep both sides. test/command-operations.test.ts fails while an
// operation with `ui` metadata has no entry, or an entry names no operation.
import type { OperationCommand } from '../command-menu/sources/operations.js';
import type { PropertyCommand } from '../command-menu/sources/properties.js';
import { INVITE_COMMANDS } from './invites/commands.js';
import { STATUS_COMMANDS } from './statuses/commands.js';
import { TEAM_COMMANDS } from './teams/commands.js';

export const OPERATION_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  ...TEAM_COMMANDS,
  ...INVITE_COMMANDS,
  ...STATUS_COMMANDS,
};

/**
 * Property commands (SPEC-012 §3.8), from `features/issues/commands.ts` when PLAN-012 S6 adds it.
 * Shared registry file, append-only: spread your own list here.
 */
export const PROPERTY_COMMANDS: readonly PropertyCommand[] = [];
