// PLAN-001 S8 web half: the team command-menu entries (SPEC-005 §4.1). "Join team" joins the
// focused team; on a team the user is already in it says so instead of doing nothing; and a change
// the store didn't take gets a toast (a server refusal is the shell's).
import { teamJoin } from '@surface/operations';
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
