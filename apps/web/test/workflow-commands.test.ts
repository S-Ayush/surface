// PLAN-010 S4, SPEC-010 §7.3 and AC-23: "Set default status…" passes `checkOperationCommands`;
// its sub-page lists only the team's Backlog and Unstarted statuses, marks the current default,
// and choosing one dispatches `team.setDefaultStatus` for the team in context (not for a focused
// status row); the entry is hidden from someone who may not change the team's workflow. Also the
// "Make default" rule of the status row menu.
import { userActor } from '@surface/domain';
import { registry, teamSetDefaultStatus } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import { checkOperationCommands, permits } from '../src/command-menu/sources/operations.js';
import type { CommandContext } from '../src/command-menu/model.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { ESTIMATE_COMMANDS } from '../src/features/estimates/commands.js';
import { canMakeDefault } from '../src/features/statuses/model.js';
import { BACKLOG, ENG, EstimateApp, TODO } from './estimate-fixtures.js';

function context(dispatched: unknown[], inTeam = true): CommandContext {
  const real = new EstimateApp([ENG]).store;
  const store = {
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
  const entry = ESTIMATE_COMMANDS['team.setDefaultStatus'];
  if (entry === undefined || !('page' in entry)) throw new Error('no page');
  return entry.page(ctx, teamSetDefaultStatus);
}

describe('Set default status… (command menu)', () => {
  it('passes the command checks with the other operation commands', () => {
    expect(checkOperationCommands(registry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('lists only Backlog and Unstarted statuses, and marks the current default', () => {
    expect(
      pageOf(context([]))
        .items()
        .map((item) => item.title),
    ).toEqual(['Backlog (current)', 'Todo']);
  });

  it('dispatches the chosen status for the team in context', async () => {
    const dispatched: unknown[] = [];
    await pageOf(context(dispatched))
      .items()
      .find((item) => item.id === TODO)
      ?.run();
    expect(dispatched).toEqual([
      { op: 'team.setDefaultStatus', input: { team: ENG, status: TODO } },
    ]);
  });

  it('is hidden from someone who is not a member of the team and not an Admin', () => {
    const entry = ESTIMATE_COMMANDS['team.setDefaultStatus'];
    if (entry === undefined || entry.refs === undefined) throw new Error('no refs');
    const outsider = context([], false);
    expect(permits(teamSetDefaultStatus, outsider, entry.refs(outsider))).toBe(false);
    const member = context([]);
    expect(permits(teamSetDefaultStatus, member, entry.refs(member))).toBe(true);
  });
});

describe('"Make default" in the status row menu', () => {
  it('is offered for Backlog and Unstarted statuses that are not the default', () => {
    expect(canMakeDefault({ id: TODO, category: 'unstarted' }, false)).toBe(true);
    expect(canMakeDefault({ id: BACKLOG, category: 'backlog' }, false)).toBe(true);
    expect(canMakeDefault({ id: BACKLOG, category: 'backlog' }, true)).toBe(false);
    for (const category of ['triage', 'started', 'completed', 'canceled', 'duplicate'] as const) {
      expect(canMakeDefault({ id: 'x', category }, false), category).toBe(false);
    }
  });
});
