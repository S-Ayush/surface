// PLAN-010 S4, SPEC-010 §7.3 and AC-23: "Change estimate scale…" passes `checkOperationCommands`
// against the real registry; its sub-page lists the five scales with their values; choosing one
// dispatches `team.setEstimates { scale }` for the team in context; and the entry is hidden from
// someone who may not change the team's settings.
import { userActor } from '@surface/domain';
import { teamSetEstimates, registry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import { checkOperationCommands, permits } from '../src/command-menu/sources/operations.js';
import type { CommandContext } from '../src/command-menu/model.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { ESTIMATE_COMMANDS } from '../src/features/estimates/commands.js';
import { EstimateApp } from './estimate-fixtures.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';

function context(dispatched: unknown[], inTeam = true): CommandContext {
  const app = new EstimateApp([ENG]);
  const real = app.store;
  const store = {
    ...real,
    pool: real?.pool,
    connection: 'online',
    dispatch: (op: { name: string }, input: unknown) => {
      dispatched.push({ op: op.name, input });
      return Promise.resolve({ status: 'confirmed' as const });
    },
  } as unknown as SyncStore;
  return {
    route: '/team/ENG',
    target: { kind: 'team', ids: [ENG], label: 'ENG' },
    actor: userActor({
      userId: 'u1',
      role: 'member',
      memberships: inTeam ? [{ teamId: ENG, private: false }] : [],
    }),
    store,
    navigate: () => undefined,
    teams: () => [],
  };
}

function pageOf(ctx: CommandContext) {
  const entry = ESTIMATE_COMMANDS['team.setEstimates'];
  if (entry === undefined || !('page' in entry)) throw new Error('team.setEstimates has no page');
  return entry.page(ctx, teamSetEstimates);
}

describe('Change estimate scale… (command menu)', () => {
  it('passes the command checks with the other operation commands', () => {
    expect(checkOperationCommands(registry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('lists the scales with their values', () => {
    expect(
      pageOf(context([]))
        .items()
        .map((item) => item.title),
    ).toEqual([
      'Not in use',
      'Exponential (1, 2, 4, 8, 16 Points)',
      'Fibonacci (1, 2, 3, 5, 8 Points)',
      'Linear (1, 2, 3, 4, 5 Points)',
      'T-Shirt (XS, S, M, L, XL)',
    ]);
  });

  it('dispatches the chosen scale for the team in context', async () => {
    const dispatched: unknown[] = [];
    await pageOf(context(dispatched))
      .items()
      .find((item) => item.id === 'fibonacci')
      ?.run();
    expect(dispatched).toEqual([
      { op: 'team.setEstimates', input: { team: ENG, scale: 'fibonacci' } },
    ]);
  });

  it('is hidden from someone who is not a member of the team and not an Admin', () => {
    const entry = ESTIMATE_COMMANDS['team.setEstimates'];
    if (entry === undefined || entry.refs === undefined) throw new Error('no refs');
    const outsider = context([], false);
    expect(permits(teamSetEstimates, outsider, entry.refs(outsider))).toBe(false);
    const member = context([]);
    expect(permits(teamSetEstimates, member, entry.refs(member))).toBe(true);
  });
});
