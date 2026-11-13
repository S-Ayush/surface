// Command-menu entries for the label operations (SPEC-010 §7.3, SPEC-005 §4.1). "Create label…"
// (`label.create`) is a page that picks the scope (the team in context, or the workspace); choosing
// one goes to that labels page, where the inline "New label" row opens with the name field focused.
// In the global context the only scope is the workspace. It is a `page`, not `opens`, like "Add
// status…": an operation command is exactly one of `run`, `page` or `opens` (SPEC-010 D27), and
// the page's choice is what the labels page needs (`add-intent.ts`).
import { Team } from '@surface/domain/model';
import { labelCreate } from '@surface/operations';
import type { CommandContext, CommandPage } from '../../command-menu/model.js';
import { permits, type OperationCommand } from '../../command-menu/sources/operations.js';
import { WORKSPACE_SCOPE, requestCreateLabel } from './add-intent.js';

/** The team a command acts on: the focused team (a team page's context chip). */
const targetTeamId = ({ target }: CommandContext): string | undefined =>
  target.kind === 'team' ? target.ids[0] : undefined;

/**
 * The pre-check runs without a team: the entry is for creating a workspace label at least, which
 * any member may do (D9), so a non-member of the focused team still sees it. The page then offers
 * the team only to someone who may create labels there.
 */
const workspaceRefs = (): Record<string, never> => ({});

/** Where a team's label settings, or the workspace's, are. */
export function labelsPath(teamKey?: string): string {
  return teamKey === undefined
    ? '/settings/labels'
    : `/settings/teams/${encodeURIComponent(teamKey)}/labels`;
}

function scopePage(ctx: CommandContext): CommandPage {
  const id = targetTeamId(ctx);
  const found = id === undefined ? undefined : ctx.store?.pool.get(Team, id);
  const team =
    found !== undefined && permits(labelCreate, ctx, { team: { id: found.id } })
      ? found
      : undefined;
  const choose = (scope: string, path: string) => () => {
    requestCreateLabel({ scope });
    ctx.navigate?.(path);
  };
  return {
    title: 'Create label',
    placeholder: 'Choose where the label goes…',
    items: () => [
      ...(team === undefined
        ? []
        : [
            {
              id: team.key,
              title: team.key,
              keywords: ['label', 'team', team.name],
              run: choose(team.key, labelsPath(team.key)),
            },
          ]),
      {
        id: WORKSPACE_SCOPE,
        title: 'Workspace',
        keywords: ['label', 'workspace', 'every team'],
        run: choose(WORKSPACE_SCOPE, labelsPath()),
      },
    ],
  };
}

export const LABEL_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'label.create': { refs: workspaceRefs, page: (ctx) => scopePage(ctx) },
};
