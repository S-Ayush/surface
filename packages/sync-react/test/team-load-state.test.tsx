/**
 * `useTeamLoadState` (SPEC-011 §5.7, E34; PLAN-011 S4c), rendered on the server in Node like the
 * other hooks (ADR-0017). The store's states are tested in sync-client
 * (`subscriptions.test.ts`); opening the team on mount, which needs effects, in the web app's
 * jsdom test (`issue-list-team-load.test.tsx`).
 */
import type { SyncStore, TeamLoadState } from '@surface/sync-client';
import { SyncStore as RealStore } from '@surface/sync-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyncStoreProvider } from '../src/context.js';
import { useTeamLoadState } from '../src/hooks.js';

function read(store: SyncStore, teamId: string): TeamLoadState {
  let value: TeamLoadState | undefined;
  function Probe() {
    value = useTeamLoadState(teamId);
    return null;
  }
  renderToStaticMarkup(
    <SyncStoreProvider store={store}>
      <Probe />
    </SyncStoreProvider>,
  );
  if (value === undefined) throw new Error('the probe did not render');
  return value;
}

/** A store whose team states a test sets, recording the teams opened. */
function fakeStore(states: Record<string, TeamLoadState>) {
  // Each server render reads afresh, so a plain map does: nothing here re-renders.
  const box = new Map(Object.entries(states));
  const opened: string[] = [];
  const store = {
    teamLoadState: (teamId: string) => box.get(teamId) ?? 'ready',
    openTeam: (teamId: string) => opened.push(teamId),
  };
  // Only the two methods the hook calls.
  return { store: store as unknown as SyncStore, box, opened };
}

describe('useTeamLoadState', () => {
  it('is loading while the store has not started', () => {
    const store = new RealStore({
      models: [],
      workspaceId: 'ws',
      userId: 'user-1',
      clientId: '0190f4c4-0000-7000-8000-00000000c11e',
      fetch: () => Promise.reject(new Error('not used: the store is never started')),
      locks: null,
      connection: { online: { subscribe: () => () => undefined } },
    });
    expect(read(store, 'team-1')).toBe('loading');
  });

  it("reads the store's state of the team: loading, then ready once loaded", () => {
    const { store, box } = fakeStore({ 'team-3': 'loading' });
    expect(read(store, 'team-3')).toBe('loading');
    box.set('team-3', 'ready');
    expect(read(store, 'team-3')).toBe('ready');
  });

  it('is offline for a team never loaded while the connection is down (E34)', () => {
    const { store } = fakeStore({ 'team-3': 'offline' });
    expect(read(store, 'team-3')).toBe('offline');
  });

  it('opens nothing while rendering: the team is opened by an effect, after commit', () => {
    const { store, opened } = fakeStore({});
    read(store, 'team-3');
    expect(opened).toEqual([]);
  });
});
