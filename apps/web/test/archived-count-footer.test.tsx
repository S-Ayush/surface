/**
 * @vitest-environment jsdom
 */
// PLAN-015 S4 (SPEC-012 §3.3 item 6, AC-30, E31; SPEC-015 §3.3): the team list ends with "N
// archived issues", counted by `issue.count` and linking to the archive page; hidden offline,
// until the count answers and while there are none.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { IssueApp, mountLists, type Mounted } from './issue-list-harness.js';

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

/** Lets the answers the page asked for land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('"N archived issues" at the end of the team list (§3.3)', () => {
  it('counts the archived issues with issue.count and links to the archive page', async () => {
    const app = new IssueApp([]);
    app.api.archivedCount = 12;
    mounted = await mountLists(app, '/team/ENG/issues');
    await settle();
    expect(app.api.calls).toContainEqual({
      op: 'issue.count',
      input: {
        team: 'ENG',
        includeArchived: true,
        filter: { field: 'archivedAt', op: 'exists', value: true },
      },
    });
    const link = [...mounted.host.querySelectorAll('a')].find((a) =>
      a.textContent.includes('archived issues'),
    );
    expect(link?.textContent).toBe('12 archived issues');
    expect(link?.getAttribute('href')).toBe('/team/ENG/archive');
  });

  it('is hidden offline, until the count answers, and while there are none', async () => {
    const app = new IssueApp([]);
    app.api.archivedCount = 0;
    mounted = await mountLists(app, '/team/ENG/issues');
    await settle();
    expect(mounted.host.textContent).not.toContain('archived issue');
    await mounted.unmount();
    const offline = new IssueApp([]);
    offline.api.archivedCount = 3;
    offline.setOnline(false);
    mounted = await mountLists(offline, '/team/ENG/issues');
    await settle();
    expect(mounted.host.textContent).not.toContain('archived issue');
    expect(offline.api.calls).toEqual([]);
  });

  it('counts again on window focus', async () => {
    const app = new IssueApp([]);
    app.api.archivedCount = 1;
    mounted = await mountLists(app, '/team/ENG/issues');
    await settle();
    expect(mounted.host.textContent).toContain('1 archived issue');
    app.api.archivedCount = 2;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await settle();
    expect(mounted.host.textContent).toContain('2 archived issues');
  });
});
