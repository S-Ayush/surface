// Command-menu entries for the status operations (SPEC-010 §7.3, SPEC-005 §4.1). "Add status…"
// (`status.create`) is a page that picks the category; choosing one goes to the team's workflow
// page, where the inline add form opens in that category with the name field focused. The entry
// is a `page`, not `opens`: an operation command is exactly one of the two, and the page's choice
// is what the workflow page needs (`add-intent.ts`).
import { Team } from '@surface/domain/model';
import { STATUS_CATEGORY_TITLES, EDITABLE_STATUS_CATEGORIES } from '@surface/domain';
import type { CommandContext, CommandPage } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import { requestAddStatus } from './add-intent.js';

/** The team a command acts on: the focused team (a team page's context chip). */
const targetTeamId = ({ target }: CommandContext): string | undefined =>
  target.kind === 'team' ? target.ids[0] : undefined;

/** The focused team as the permission pre-check needs it. */
function targetTeamRefs(ctx: CommandContext) {
  const id = targetTeamId(ctx);
  return id === undefined ? {} : { team: { id } };
}

/** Where a team's workflow settings are. Its key comes from the replica, not the label. */
export function workflowPath(teamKey: string): string {
  return `/settings/teams/${encodeURIComponent(teamKey)}/workflow`;
}

function categoryPage(ctx: CommandContext): CommandPage {
  const id = targetTeamId(ctx);
  const team = id === undefined ? undefined : ctx.store?.pool.get(Team, id);
  return {
    title: 'Add status',
    placeholder: 'Choose a category…',
    empty: 'Open a team first.',
    items: () =>
      team === undefined
        ? []
        : EDITABLE_STATUS_CATEGORIES.map((category) => ({
            id: category,
            title: STATUS_CATEGORY_TITLES[category],
            keywords: ['status', 'workflow', category],
            run: () => {
              requestAddStatus({ teamKey: team.key, category });
              ctx.navigate?.(workflowPath(team.key));
            },
          })),
  };
}

export const STATUS_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'status.create': { suggest: false, refs: targetTeamRefs, page: (ctx) => categoryPage(ctx) },
};
