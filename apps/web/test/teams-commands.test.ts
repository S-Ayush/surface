// PLAN-001 S8 web half: the team command-menu entries (SPEC-005 §4.1). "Join team" joins the
// focused team; on a team the user is already in it says so instead of doing nothing; and a change
// the store didn't take gets a toast (a server refusal is the shell's). "Rename team…" opens the
// focused team's General settings, where its rename form is. "Leave team…" and "Remove member…"
// are pages: one choice to confirm, or the team's members.
import { userActor } from '@surface/domain';
import { Team, TeamMembership, User } from '@surface/domain/model';
import { teamJoin, teamLeave, teamRemoveMember, teamUpdate } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import type * as Ui from '@surface/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/command-menu/model.js';
import { TEAM_COMMANDS } from '../src/features/teams/commands.js';

const toast = vi.hoisted(() => vi.fn<(options: unknown) => void>());
vi.mock('@surface/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  toast,
}));

beforeEach(() => toast.mockReset());

function context(dispatch: () => Promise<unknown>, mine: { id: string; key: string }[] = []) {
  const store = { connection: 'online', status: 'ready', dispatch: vi.fn(dispatch) };
  const ctx: CommandContext = {
    route: '/team/ENG',
    target: { kind: 'team', ids: ['t-eng'], label: 'ENG' },
    actor: null,
    // Only what the command reads; the real store has its own tests.
    store: store as unknown as SyncStore,
    teams: () => mine.map((team) => ({ ...team, name: team.key })),
  };
  return { ctx, dispatch: store.dispatch };
}

async function runJoin(ctx: CommandContext): Promise<void> {
  const entry = TEAM_COMMANDS['team.join'];
  if (entry === undefined || !('run' in entry)) throw new Error('team.join has no run');
  await entry.run(ctx, teamJoin);
}

describe('Join team (command menu)', () => {
  it('joins the focused team', async () => {
    const { ctx, dispatch } = context(() => Promise.resolve({ status: 'confirmed' }));
    await runJoin(ctx);
    expect(dispatch).toHaveBeenCalledWith(teamJoin, { team: 't-eng' });
    expect(toast).not.toHaveBeenCalled();
  });

  it('says so, without dispatching, on a team the user is already in', async () => {
    const { ctx, dispatch } = context(
      () => Promise.resolve({ status: 'confirmed' }),
      [{ id: 't-eng', key: 'ENG' }],
    );
    await runJoin(ctx);
    expect(dispatch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ message: "You're already a member of ENG." });
  });

  it('toasts a change the store didn’t take', async () => {
    const { ctx } = context(() => {
      throw new Error(
        'Changes cannot be saved yet. Wait for the workspace to load, then try again.',
      );
    });
    await runJoin(ctx);
    expect(toast).toHaveBeenCalledOnce();
    const shown = toast.mock.calls[0]?.[0];
    expect(shown).toMatchObject({ tone: 'danger' });
    expect(String((shown as { message?: unknown } | undefined)?.message)).toMatch(
      /^Changes cannot/,
    );
  });
});

describe('Rename team… (command menu)', () => {
  /** A replica holding `rows`, and the navigation the shell provides. */
  function renameContext(rows: { id: string; key: string }[], navigate = vi.fn()) {
    const store = { pool: { get: (_model: unknown, id: string) => rows.find((t) => t.id === id) } };
    const ctx: CommandContext = {
      route: '/team/ENG',
      target: { kind: 'team', ids: ['t-eng'], label: 'Engineering' },
      actor: null,
      store: store as unknown as SyncStore,
      teams: () => [],
      navigate,
    };
    return { ctx, navigate };
  }

  async function runRename(ctx: CommandContext): Promise<void> {
    const entry = TEAM_COMMANDS['team.update'];
    if (entry === undefined || !('run' in entry)) throw new Error('team.update has no run');
    await entry.run(ctx, teamUpdate);
  }

  it('opens the focused team’s General settings, found by its id in the replica', async () => {
    const { ctx, navigate } = renameContext([{ id: 't-eng', key: 'ENG' }]);
    await runRename(ctx);
    expect(navigate).toHaveBeenCalledWith('/settings/teams/ENG/general');
  });

  it('does nothing for a team the replica doesn’t have', async () => {
    const { ctx, navigate } = renameContext([]);
    await runRename(ctx);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('gives the team as refs, for the menu’s permission pre-check', () => {
    const { ctx } = renameContext([{ id: 't-eng', key: 'ENG' }]);
    expect(TEAM_COMMANDS['team.update']?.refs?.(ctx)).toEqual({ team: { id: 't-eng' } });
  });
});

describe('Leave team… and Remove member… (command menu)', () => {
  const ENG = { id: 't-eng', key: 'ENG', name: 'Engineering', private: false };
  const users = [
    { id: 'u-ada', name: 'Ada', displayName: 'ada', email: 'ada@example.com', active: true },
    { id: 'u-iris', name: 'Iris', displayName: 'iris', email: 'iris@example.com', active: true },
  ];

  /** A replica with `team` and its members, signed in as Ada. */
  function pageContext(team: typeof ENG, members: string[]) {
    const memberships = members.map((userId) => ({ id: `m-${userId}`, teamId: team.id, userId }));
    const rows = new Map<unknown, readonly object[]>([
      [Team, [team]],
      [TeamMembership, memberships],
      [User, users],
    ]);
    const store = {
      connection: 'online',
      status: 'ready',
      dispatch: vi.fn(() => Promise.resolve({ status: 'confirmed' })),
      pool: {
        get: (_model: unknown, id: string) => (id === team.id ? team : undefined),
        all: (model: unknown) => rows.get(model) ?? [],
      },
    };
    const ctx: CommandContext = {
      route: '/team/ENG',
      target: { kind: 'team', ids: [team.id], label: team.key },
      actor: userActor({ userId: 'u-ada', role: 'member', memberships: [] }),
      store: store as unknown as SyncStore,
      teams: () => [],
    };
    return { ctx, dispatch: store.dispatch };
  }

  function page(name: 'team.leave' | 'team.removeMember', ctx: CommandContext) {
    const entry = TEAM_COMMANDS[name];
    if (entry === undefined || !('page' in entry)) throw new Error(`${name} has no page`);
    return entry.page(ctx, name === 'team.leave' ? teamLeave : teamRemoveMember);
  }

  it('leaves the focused team once its one choice is picked', async () => {
    const { ctx, dispatch } = pageContext(ENG, ['u-ada', 'u-iris']);
    const items = page('team.leave', ctx).items();
    expect(items.map((item) => item.title)).toEqual(['Leave ENG']);
    await items[0]?.run();
    expect(dispatch).toHaveBeenCalledWith(teamLeave, { team: 't-eng' });
  });

  it('says what leaving a private team means, and offers nothing to its last member (E12)', () => {
    const SEC = { ...ENG, id: 't-sec', key: 'SEC', name: 'Security', private: true };
    expect(page('team.leave', pageContext(SEC, ['u-ada', 'u-iris']).ctx).items()).toMatchObject([
      { title: 'Leave SEC: only a member can add you back' },
    ]);
    const last = page('team.leave', pageContext(SEC, ['u-ada']).ctx);
    expect(last.items()).toEqual([]);
    expect(last.empty).toMatch(/^A private team needs at least one member/);
    const removeLast = page('team.removeMember', pageContext(SEC, ['u-ada']).ctx);
    expect(removeLast.items()).toEqual([]);
    expect(removeLast.empty).toMatch(/^A private team needs at least one member/);
  });

  it('offers no leave to someone not in the team', () => {
    const notMine = page('team.leave', pageContext(ENG, ['u-iris']).ctx);
    expect(notMine.items()).toEqual([]);
    expect(notMine.empty).toBe('You’re not a member of this team.');
  });

  it('lists the team’s members, and removes the one picked', async () => {
    const { ctx, dispatch } = pageContext(ENG, ['u-ada', 'u-iris']);
    const items = page('team.removeMember', ctx).items();
    expect(items.map((item) => item.title)).toEqual(['Ada', 'Iris']);
    await items[1]?.run();
    expect(dispatch).toHaveBeenCalledWith(teamRemoveMember, { team: 't-eng', user: 'u-iris' });
  });

  it('give the team as refs, for the menu’s permission pre-check', () => {
    const { ctx } = pageContext(ENG, []);
    expect(TEAM_COMMANDS['team.leave']?.refs?.(ctx)).toEqual({ team: { id: 't-eng' } });
    expect(TEAM_COMMANDS['team.removeMember']?.refs?.(ctx)).toEqual({ team: { id: 't-eng' } });
  });
});
