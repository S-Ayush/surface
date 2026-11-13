// Command-menu entries for the issue operations (SPEC-011 §6.1, SPEC-005 §4.1). "Create issue…"
// (`issue.create`) opens the composer through the `issue:create` command, the one `C` triggers
// (SPEC-012 §3.6). The composer is PLAN-012 S5, which registers that command's handler; until then
// the command is unavailable, so the menu doesn't offer the entry (`commands.isAvailable`).
// `issue.update` has no `ui`: its commands are SPEC-012 property commands (PLAN-012 S6).
// "Delete issue" and "Restore issue" (SPEC-015 §6.1) open the app commands `issue:delete` (the
// confirm dialog, PLAN-012 S6) and `issue:restore` (the restore flow, PLAN-015 S4), the ones
// `Mod+Backspace` and `#` trigger; until those slices register them, the menu doesn't offer them.
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';

/** The focused team, for the permission pre-check (any member may create an issue in it). */
function targetTeamRefs({ target }: CommandContext) {
  const id = target.kind === 'team' ? target.ids[0] : undefined;
  return id === undefined ? {} : { team: { id } };
}

/** The focused issue (anyone who can see an issue may delete or restore it). */
function targetIssueRefs({ target }: CommandContext) {
  const id = target.kind === 'issue' ? target.ids[0] : undefined;
  return id === undefined ? {} : { issue: { id } };
}

export const ISSUE_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'issue.create': { opens: 'issue:create', refs: targetTeamRefs },
  'issue.delete': { opens: 'issue:delete', refs: targetIssueRefs },
  'issue.restore': { opens: 'issue:restore', refs: targetIssueRefs },
};
