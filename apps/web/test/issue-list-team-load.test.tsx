/**
 * @vitest-environment jsdom
 */
// PLAN-012 S3 follow-up after PLAN-011 S4c (SPEC-012 §3.3 item 10, §7.2; AC-27, E28): a public
// team the user isn't a member of is opened through sync-react's `useTeamLoadState` while its
// list is mounted, shows "Loading…" until the store has loaded it, then its rows; offline and
// never loaded, "Available when online". The store's side (subscribe, partial bootstrap, at most
// 5 on-demand teams with the least recently opened dropped) is tested on the fake hub in
// `packages/sync-client/test/subscriptions.test.ts`; here a fake store answers as it does.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { DES, DES_TODO, ENG } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted } from './issue-list-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  focusMemory.clear();
  localStorage.clear();
});

async function inAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

const review = issue({ teamId: DES, statusId: DES_TODO, title: 'Design review', number: 7 });

describe('a non-member team list (AC-27)', () => {
  it('opens the team, says Loading… until the store has loaded it, then shows its rows', async () => {
    const app = new IssueApp([], [ENG]);
    mounted = await mountLists(app, '/team/DES/issues');
    expect(app.opened).toEqual([DES]);
    expect(mounted.host.textContent).toContain('Loading…');
    // The partial bootstrap is applied: its rows are in the replica and the team is loaded.
    await inAct(() => {
      app.setIssues([review]);
      app.loadTeam(DES);
    });
    expect(mounted.host.textContent).not.toContain('Loading…');
    expect(mounted.host.textContent).toContain('Design review');
  });

  it('shows "Available when online" offline for a team never loaded, and loads it once online', async () => {
    const app = new IssueApp([], [ENG]);
    app.setOnline(false);
    mounted = await mountLists(app, '/team/DES/issues');
    expect(mounted.host.textContent).toContain('Available when online');
    await inAct(() => {
      app.setOnline(true);
    });
    expect(mounted.host.textContent).toContain('Loading…');
  });

  it('renders a loaded team from the replica offline too', async () => {
    const app = new IssueApp([review], [ENG]);
    app.loadTeam(DES);
    app.setOnline(false);
    mounted = await mountLists(app, '/team/DES/issues');
    expect(mounted.host.textContent).toContain('Design review');
  });

  it('opens the team again on each visit, which makes it the most recently opened (E28)', async () => {
    const app = new IssueApp([], [ENG]);
    mounted = await mountLists(app, '/team/DES/issues');
    await mounted.navigate('/team/ENG/issues');
    await mounted.navigate('/team/DES/issues');
    // A member team's open is a no-op in the store; DES is opened on both visits.
    expect(app.opened).toEqual([DES, ENG, DES]);
  });
});
