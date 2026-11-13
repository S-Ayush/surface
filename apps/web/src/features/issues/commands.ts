// Command-menu entries for the issue operations (SPEC-011 §6.1, SPEC-005 §4.1). "Create issue…"
// (`issue.create`) opens the composer through the `issue:create` command, the one `C` triggers
// (SPEC-012 §3.6). The composer is PLAN-012 S5, which registers that command's handler; until then
// the command is unavailable, so the menu doesn't offer the entry (`commands.isAvailable`).
// `issue.update` has no `ui`: its commands are SPEC-012 property commands (PLAN-012 S6).
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';

/** The focused team, for the permission pre-check (any member may create an issue in it). */
function targetTeamRefs({ target }: CommandContext) {
  const id = target.kind === 'team' ? target.ids[0] : undefined;
  return id === undefined ? {} : { team: { id } };
}

export const ISSUE_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'issue.create': { opens: 'issue:create', refs: targetTeamRefs },
};
