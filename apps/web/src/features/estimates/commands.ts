// Command-menu entries for the team settings operations of SPEC-010 §7.3: "Change estimate
// scale…" (`team.setEstimates`) is a page that lists the scales with their values, and "Set
// default status…" (`team.setDefaultStatus`) is a page that lists the team's Backlog and
// Unstarted statuses. Choosing an item dispatches the operation for the team in context (a team
// page's context chip), not for a focused status row. The toggles are on the settings page only.
import { DEFAULT_STATUS_CATEGORIES, sortStatuses } from '@surface/domain';
import { Team, WorkflowStatus } from '@surface/domain/model';
import { teamSetDefaultStatus, teamSetEstimates } from '@surface/operations';
import type { CommandContext, CommandPage } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import { submitMutation, toastIfFailed } from '../teams/submit.js';
import { SCALE_OPTIONS } from './model.js';

/** The team a command acts on: the focused team (a team page's context chip). */
const targetTeamId = ({ target }: CommandContext): string | undefined =>
  target.kind === 'team' ? target.ids[0] : undefined;

/** The focused team as the permission pre-check needs it. */
function targetTeamRefs(ctx: CommandContext) {
  const id = targetTeamId(ctx);
  return id === undefined ? {} : { team: { id } };
}

function focusedTeam(ctx: CommandContext) {
  const id = targetTeamId(ctx);
  const store = ctx.store;
  const team = id === undefined || store === null ? undefined : store.pool.get(Team, id);
  return store === null || team === undefined ? undefined : { store, team };
}

function scalePage(ctx: CommandContext): CommandPage {
  const found = focusedTeam(ctx);
  return {
    title: 'Change estimate scale',
    placeholder: 'Choose a scale…',
    empty: 'Open a team first.',
    items: () =>
      found === undefined
        ? []
        : SCALE_OPTIONS.map((option) => ({
            id: option.scale,
            title: option.label,
            keywords: ['estimate', 'estimates', 'points', option.scale, option.title],
            run: async () => {
              toastIfFailed(
                await submitMutation(found.store, teamSetEstimates, {
                  team: found.team.id,
                  scale: option.scale,
                }),
              );
            },
          })),
  };
}

function defaultStatusPage(ctx: CommandContext): CommandPage {
  const found = focusedTeam(ctx);
  return {
    title: 'Set default status',
    placeholder: 'Choose a status…',
    empty: 'Open a team first.',
    items: () => {
      if (found === undefined) return [];
      const { store, team } = found;
      const statuses = store.pool
        .all(WorkflowStatus)
        .filter(
          (row) => row.teamId === team.id && DEFAULT_STATUS_CATEGORIES.includes(row.category),
        );
      return sortStatuses(statuses).map((status) => ({
        id: status.id,
        title: status.id === team.defaultStatusId ? `${status.name} (current)` : status.name,
        keywords: ['default', 'status', 'new issues', status.category],
        run: async () => {
          toastIfFailed(
            await submitMutation(store, teamSetDefaultStatus, {
              team: team.id,
              status: status.id,
            }),
          );
        },
      }));
    },
  };
}

export const ESTIMATE_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'team.setEstimates': { suggest: false, refs: targetTeamRefs, page: (ctx) => scalePage(ctx) },
  'team.setDefaultStatus': {
    suggest: false,
    refs: targetTeamRefs,
    page: (ctx) => defaultStatusPage(ctx),
  },
};
