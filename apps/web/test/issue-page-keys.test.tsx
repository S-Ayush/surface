/**
 * @vitest-environment jsdom
 */
// PLAN-012 S4 part 1, SPEC-012 §3.4 items 1, 2 and 9, AC-13, AC-17, E4, E10: what the issue page does
// once it is mounted. The page is on a real router above the list, with the M1 keys in the
// build. Server-rendered markup (`issue-page.test.tsx`) can't show any of it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIST_SOURCE_STATE_KEY } from '../src/features/issues/focus-model.js';
import {
  FakeApp,
  ISSUE_A,
  ISSUE_B,
  ISSUE_C,
  TEAM,
  UNHELD,
  inAct,
  installDomShims,
  issueRow,
  keydown,
  mountIssuePage,
  setValue,
  type Mounted,
} from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(installDomShims);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

const rows = () => [
  issueRow(ISSUE_A, 41),
  issueRow(ISSUE_B, 42),
  issueRow(ISSUE_C, 43, { title: 'Third issue' }),
];
const list = (issueIds: string[]) => ({
  [LIST_SOURCE_STATE_KEY]: { href: '/team/ENG', routeKey: 'team:ENG', issueIds },
});
const pathname = () => mounted?.router.state.location.pathname;
const titleField = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Issue title"]');

/** `Shift+R` with focus on the title, where the `issue` scope applies. */
async function rename(): Promise<void> {
  const title = document.querySelector<HTMLButtonElement>(
    '[data-shortcut-scope="issue"] h1 button',
  );
  if (title === null) throw new Error('no title button');
  title.focus();
  await keydown(title, 'R', { shiftKey: true, code: 'KeyR' });
}

describe('J and K (AC-17, E10)', () => {
  it('step to the next and the previous issue of the source list', async () => {
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-42',
      state: list([ISSUE_A, ISSUE_B, ISSUE_C]),
    });
    await keydown(document.body, 'j');
    expect(pathname()).toBe(`/issue/${ISSUE_C}`);
    expect(document.body.textContent).toContain('Third issue');
    expect(document.body.textContent).toContain('3 / 3');
    await keydown(document.body, 'k');
    expect(pathname()).toBe(`/issue/${ISSUE_B}`);
  });

  it('do nothing at the ends of the list (E10)', async () => {
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-41',
      state: list([ISSUE_A, ISSUE_B, ISSUE_C]),
    });
    await keydown(document.body, 'k');
    expect(pathname()).toBe('/issue/ENG-41');
    await mounted.unmount();
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-43',
      state: list([ISSUE_A, ISSUE_B, ISSUE_C]),
    });
    await keydown(document.body, 'j');
    expect(pathname()).toBe('/issue/ENG-43');
  });

  it('do nothing without a source list', async () => {
    mounted = await mountIssuePage({ app: new FakeApp({ issues: rows() }), ref: 'ENG-42' });
    await keydown(document.body, 'j');
    expect(pathname()).toBe('/issue/ENG-42');
  });

  it('show the loading state, not the issue just left, while an issue the replica lacks loads', async () => {
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-42',
      state: list([ISSUE_B, UNHELD]),
    });
    expect(document.body.textContent).toContain('Login page flickers');
    await keydown(document.body, 'j');
    expect(pathname()).toBe(`/issue/${UNHELD}`);
    expect(document.body.textContent).not.toContain('Login page flickers');
    expect(document.querySelector('[aria-label="Loading issue"]')).not.toBeNull();
  });
});

describe('Esc (SPEC-012 §3.4 item 9)', () => {
  it('goes back to the list the page was opened from', async () => {
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-42',
      state: list([ISSUE_A, ISSUE_B]),
    });
    await keydown(document.body, 'Escape');
    expect(pathname()).toBe('/team/ENG');
  });

  it('goes to the issue’s team list when there is no source list', async () => {
    mounted = await mountIssuePage({ app: new FakeApp({ issues: rows() }), ref: 'ENG-42' });
    await keydown(document.body, 'Escape');
    expect(pathname()).toBe('/team/ENG');
  });

  it('cancels a title edit inside the title field without leaving the page', async () => {
    mounted = await mountIssuePage({
      app: new FakeApp({ issues: rows() }),
      ref: 'ENG-42',
      state: list([ISSUE_A, ISSUE_B]),
    });
    await rename();
    const field = titleField();
    expect(field).not.toBeNull();
    if (field === null) return;
    await setValue(field, 'Something else');
    await keydown(field, 'Escape');
    expect(titleField()).toBeNull();
    expect(pathname()).toBe('/issue/ENG-42');
    expect(document.body.textContent).toContain('Login page flickers');
  });
});

describe('the title (SPEC-012 §3.4 item 2, E4)', () => {
  it('Shift+R then Enter sends issue.update with the new title', async () => {
    const app = new FakeApp({ issues: rows() });
    mounted = await mountIssuePage({ app, ref: 'ENG-42' });
    await rename();
    const field = titleField();
    if (field === null) throw new Error('no title field');
    await setValue(field, 'Fix the flicker');
    await keydown(field, 'Enter');
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_B, title: 'Fix the flicker' } },
    ]);
    expect(titleField()).toBeNull();
  });

  it('keeps the user’s text when the title changes remotely while editing (E4)', async () => {
    const app = new FakeApp({ issues: rows() });
    mounted = await mountIssuePage({ app, ref: 'ENG-42' });
    await rename();
    const field = titleField();
    if (field === null) throw new Error('no title field');
    await setValue(field, 'My wording');
    await inAct(() => {
      app.remote(ISSUE_B, { title: 'Their wording' });
    });
    expect(titleField()?.value).toBe('My wording');
  });
});

describe('the address (AC-13)', () => {
  it('is replaced with the canonical slug, without a new history entry', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const before = window.history.length;
    mounted = await mountIssuePage({ app: new FakeApp({ issues: rows() }), ref: 'ENG-42' });
    expect(replace).toHaveBeenCalledWith(null, '', '/issue/ENG-42/login-page-flickers');
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
  });

  it('is replaced again when the title changes, and the page stays mounted', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const app = new FakeApp({ issues: rows() });
    mounted = await mountIssuePage({ app, ref: 'ENG-42' });
    const heading = document.querySelector('h1');
    await inAct(() => {
      app.remote(ISSUE_B, { title: 'Fix the flicker' });
    });
    expect(replace).toHaveBeenLastCalledWith(null, '', '/issue/ENG-42/fix-the-flicker');
    expect(document.querySelector('h1')).toBe(heading);
  });

  it('moves a pending issue to its identifier when the number arrives', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, null)] });
    mounted = await mountIssuePage({ app, ref: ISSUE_A });
    expect(replace).not.toHaveBeenCalled();
    await inAct(() => {
      app.remote(ISSUE_A, { number: 7 });
    });
    expect(replace).toHaveBeenLastCalledWith(null, '', '/issue/ENG-7/login-page-flickers');
  });
});

describe('the issue’s team (SPEC-011 §5.7)', () => {
  it('is opened on demand for an issue the replica already holds', async () => {
    const app = new FakeApp({ issues: rows() });
    mounted = await mountIssuePage({ app, ref: 'ENG-42' });
    expect(document.body.textContent).toContain('Login page flickers');
    expect(app.opened).toEqual([TEAM]);
  });
});
