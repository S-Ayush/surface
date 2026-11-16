// @vitest-environment jsdom
// SPEC-012 §3.4 item 3, §3.7, AC-12, AC-21, E5; PLAN-012 S4b: the description on the issue page,
// wired to the store. The save rules themselves (idle, one in flight, the dropped queued save, no
// same-text save) are `issue-description-save.test.ts`; here: blur and `Mod+Enter` send
// `issue.updateDescription` with the loaded `baseVersion`, the CONFLICT banner and its two buttons,
// a remote save while typing (E5), the loading and offline states, and "Copy issue as Markdown"
// carrying the description.
import { DESCRIPTION_MESSAGES } from '@surface/domain';
import type { MutationOutcome } from '@surface/sync-client';
import { observable, runInAction } from 'mobx';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DESCRIPTION_CONFLICT_MESSAGE,
  DESCRIPTION_OFFLINE_MESSAGE,
} from '../src/features/issues/IssueDescription.js';
import { docOfText } from './comment-editor-fake.js';
import {
  FakeApp,
  inAct,
  installDomShims,
  ISSUE_A,
  issueRow,
  keydown,
  mountIssuePage,
  type Mounted,
} from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const AT = '2026-11-12T10:00:00.000Z';

/** The replica's IssueContent row, observable, so a remote save re-renders the page. */
function contentWorld(state: 'loading' | 'ready' | 'offline' = 'ready') {
  const row = observable.box({
    id: ISSUE_A,
    issueId: ISSUE_A,
    teamId: TEAM,
    description: docOfText('Steps to reproduce'),
    version: 3,
    createdAt: AT,
    updatedAt: AT,
  });
  const opened: string[] = [];
  return {
    opened,
    remote(text: string, version: number) {
      runInAction(() => {
        row.set({ ...row.get(), description: docOfText(text), version });
      });
    },
    api: {
      state: () => state,
      rows: () => (state === 'ready' ? { IssueContent: [row.get()] } : {}),
      open: (id: string) => {
        opened.push(id);
        return { release: () => undefined };
      },
      peek: () => new Promise(() => undefined),
    },
  };
}

let page: Mounted | undefined;
beforeAll(() => {
  installDomShims();
});
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

const editor = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');

function type(text: string): Promise<void> {
  return inAct(() => {
    const field = editor();
    if (field === null) throw new Error('no description editor');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function blur(): Promise<void> {
  return inAct(() => {
    editor()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const saves = (app: FakeApp) =>
  app.dispatched.filter((entry) => entry.op === 'issue.updateDescription').map((e) => e.input);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('the description on the issue page (AC-12)', () => {
  it('opens the issue’s content and shows its description in the editor', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    expect(content.opened).toContain(ISSUE_A);
    expect(editor()?.value).toBe('Steps to reproduce');
  });

  it('saves on blur with the version it was loaded from, and only when the text changed', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await blur();
    expect(saves(app)).toEqual([]);
    await type('Steps to reproduce, on Safari');
    await blur();
    expect(saves(app)).toEqual([
      {
        issue: ISSUE_A,
        baseVersion: 3,
        description: docOfText('Steps to reproduce, on Safari'),
      },
    ]);
  });

  it('saves now on Mod+Enter (the issue-page scope)', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Typed fast');
    const field = editor();
    if (field === null) throw new Error('no editor');
    await keydown(field, 'Enter', { code: 'Enter', ctrlKey: true });
    expect(saves(app)).toHaveLength(1);
  });

  it('keeps the text on CONFLICT, shows the banner, and "Discard and reload" loads the replica’s version', async () => {
    const content = contentWorld();
    const conflict: MutationOutcome = {
      status: 'rejected',
      error: { code: 'CONFLICT', message: DESCRIPTION_MESSAGES.stale },
    };
    const app = new FakeApp({
      issues: [issueRow(ISSUE_A, 42)],
      content: content.api,
      answer: () => Promise.resolve(conflict),
    });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    // Someone else saved meanwhile; the user is typing, so the text stays (E5).
    await type('My version');
    content.remote('Their version', 4);
    await settle();
    expect(editor()?.value).toBe('My version');
    await blur();
    await settle();
    expect(saves(app)).toEqual([
      { issue: ISSUE_A, baseVersion: 3, description: docOfText('My version') },
    ]);
    const banner = document.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain(DESCRIPTION_CONFLICT_MESSAGE);
    expect(editor()?.value).toBe('My version');
    // Nothing more is saved while the banner is up.
    await type('My version, longer');
    await blur();
    expect(saves(app)).toHaveLength(1);

    const discard = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Discard and reload',
    );
    await inAct(() => discard?.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(editor()?.value).toBe('Their version');
  });

  it('takes a remote save when nothing is unsaved (E5)', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    content.remote('Their version', 4);
    await settle();
    expect(editor()?.value).toBe('Their version');
    await type('Their version, mine');
    await blur();
    expect(saves(app).at(-1)).toMatchObject({ baseVersion: 4 });
  });

  it('shows a skeleton while loading and "Available when online" offline when never loaded (AC-21)', async () => {
    const loading = contentWorld('loading');
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: loading.api }),
      ref: 'ENG-42',
    });
    expect(document.querySelector('section[aria-label="Description"][aria-busy="true"]')).not.toBe(
      null,
    );
    expect(editor()).toBeNull();
    await page.unmount();

    const offline = contentWorld('offline');
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: offline.api }),
      ref: 'ENG-42',
    });
    expect(document.querySelector('section[aria-label="Description"]')?.textContent).toBe(
      DESCRIPTION_OFFLINE_MESSAGE,
    );
    expect(editor()).toBeNull();
  });

  it('puts the description in "Copy issue as Markdown" (§3.7)', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    const layout = document.querySelector<HTMLElement>('[data-shortcut-scope="issue"]');
    await keydown(layout ?? document.body, 'c', { code: 'KeyC', ctrlKey: true, altKey: true });
    await settle();
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('# ENG-42 Login page flickers');
    expect(copied).toContain('Steps to reproduce');
  });
});
