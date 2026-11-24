// @vitest-environment jsdom
// SPEC-012 §3.4 item 3, §3.7, AC-12, AC-21, E5; PLAN-012 S4b: the description on the issue page,
// wired to the store. The save rules themselves (idle, one in flight, the dropped queued save, no
// same-text save) are `issue-description-save.test.ts`; here: blur and `Mod+Enter` send
// `issue.updateDescription` with the loaded `baseVersion`, the CONFLICT banner and its two buttons,
// a remote save while typing (E5), the loading and offline states, and "Copy issue as Markdown"
// carrying the description.
import { DESCRIPTION_MESSAGES } from '@surface/domain';
import type { MutationOutcome } from '@surface/sync-client';
import { overlayManager } from '@surface/ui';
import { observable, runInAction } from 'mobx';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DESCRIPTION_CONFLICT_MESSAGE,
  DESCRIPTION_OFFLINE_MESSAGE,
} from '../src/features/issues/IssueDescription.js';
import { descriptionAbandonedMessage } from '../src/features/issues/description-save.js';
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
function contentWorld(
  state: 'loading' | 'ready' | 'offline' = 'ready',
  text = 'Steps to reproduce',
  version = 3,
) {
  const row = observable.box({
    id: ISSUE_A,
    issueId: ISSUE_A,
    teamId: TEAM,
    description: docOfText(text),
    version,
    createdAt: AT,
    updatedAt: AT,
  });
  const opened: string[] = [];
  // PLAN-011 S7: a parent gone from the replica while wanted is `ready` with no rows.
  const gone = observable.box(false);
  return {
    opened,
    gone() {
      runInAction(() => {
        gone.set(true);
      });
    },
    remote(text: string, version: number) {
      runInAction(() => {
        row.set({ ...row.get(), description: docOfText(text), version });
      });
    },
    api: {
      state: () => state,
      rows: () => (state === 'ready' && !gone.get() ? { IssueContent: [row.get()] } : {}),
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

describe('a save refused because the issue was deleted meanwhile (SPEC-015 E1, PLAN-015 S4)', () => {
  afterEach(() => {
    overlayManager.clear();
  });

  it('shows exactly one toast, with Copy text, while the page is open: the shell reports nothing', async () => {
    overlayManager.clear();
    const content = contentWorld();
    const locked = 'ENG-42 was deleted. Restore it to edit it.';
    const app = new FakeApp({
      issues: [issueRow(ISSUE_A, 42)],
      content: content.api,
      answer: () =>
        Promise.resolve({ status: 'rejected', error: { code: 'CONFLICT', message: locked } }),
    });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Half a thought');
    await blur();
    await settle();
    expect(saves(app)).toHaveLength(1);
    const toasts = overlayManager.getSnapshot().visibleToasts;
    expect(toasts.map((t) => [t.tone, t.message, t.action?.label])).toEqual([
      ['danger', locked, 'Copy text'],
    ]);
    expect(app.shellReports).toEqual([]);
  });
});

describe('an earlier save of this description still unconfirmed when the page opens (SPEC-012 D31)', () => {
  // A save of "Mine" on v5 from before (an earlier visit to the page, or before a reload) is still
  // in the queue: the replica shows its predicted v6.
  function opened() {
    const content = contentWorld('ready', 'Mine', 6);
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    app.pending.push({
      seq: 1000,
      op: 'issue.updateDescription',
      input: { issue: ISSUE_A, baseVersion: 5, description: docOfText('Mine') },
    });
    return { content, app };
  }

  it('sends nothing on the predicted version, and saves on the confirmed one once it is confirmed', async () => {
    const { app } = opened();
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Mine, more');
    await blur();
    expect(saves(app)).toEqual([]);

    await inAct(() => {
      app.pending.clear();
    });
    await settle();
    expect(saves(app)).toEqual([
      { issue: ISSUE_A, baseVersion: 6, description: docOfText('Mine, more') },
    ]);
  });

  it('shows the conflict banner and sends nothing when that save was refused', async () => {
    const { app, content } = opened();
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Mine, more');
    await blur();
    // Refused with CONFLICT: the overlay is rolled back to the server's row, Bob's v6.
    await inAct(() => {
      runInAction(() => {
        content.remote('Theirs', 6);
        app.pending.clear();
      });
    });
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      DESCRIPTION_CONFLICT_MESSAGE,
    );
    expect(editor()?.value).toBe('Mine, more');
    await blur();
    expect(saves(app)).toEqual([]);
  });
});

describe('the queue and the overlay changing in separate actions (SPEC-012 D31)', () => {
  it('never pairs a predicted row with an empty queue: the refused save gives the banner, not a send', async () => {
    const content = contentWorld('ready', 'First', 3);
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    // An earlier page's save is queued (one action), then its prediction shows (another).
    await inAct(() => {
      runInAction(() => {
        app.pending.push({
          seq: 1000,
          op: 'issue.updateDescription',
          input: { issue: ISSUE_A, baseVersion: 3, description: docOfText('Queued') },
        });
      });
      content.remote('Queued', 4);
    });
    await settle();
    expect(editor()?.value).toBe('Queued');
    await type('Queued, more');
    await blur();
    expect(saves(app)).toEqual([]);

    // Refused: the store drops it from the queue (one action), then rolls the overlay back
    // (another). A read between the two would see the predicted v4 with nothing unconfirmed.
    await inAct(() => {
      app.pending.clear();
      content.remote('First', 3);
    });
    await settle();
    expect(saves(app)).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      DESCRIPTION_CONFLICT_MESSAGE,
    );
    expect(editor()?.value).toBe('Queued, more');
  });
});

describe('closing the page while a save waits', () => {
  it('sends the text after the page closed, once the earlier save is confirmed', async () => {
    const content = contentWorld('ready', 'Mine', 6);
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    app.pending.push({
      seq: 1000,
      op: 'issue.updateDescription',
      input: { issue: ISSUE_A, baseVersion: 5, description: docOfText('Mine') },
    });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Mine, then left');
    await page.unmount();
    page = undefined;
    expect(saves(app)).toEqual([]);
    await inAct(() => {
      app.pending.clear();
    });
    await settle();
    expect(saves(app)).toEqual([
      { issue: ISSUE_A, baseVersion: 6, description: docOfText('Mine, then left') },
    ]);
  });
});

describe('opening the issue again while its text is still being saved (SPEC-012 D31)', () => {
  it('takes the earlier page’s saver back: its text shows, and it is sent once', async () => {
    const content = contentWorld();
    const answers: ((outcome: MutationOutcome) => void)[] = [];
    const app = new FakeApp({
      issues: [issueRow(ISSUE_A, 42)],
      content: content.api,
      answer: () => new Promise((resolve) => answers.push(resolve)),
    });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Second');
    await blur();
    await type('Third');
    await page.unmount();
    // "Second" is in flight, "Third" waits behind it; the issue opens again.
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await settle();
    expect(editor()?.value).toBe('Third');
    await inAct(() => {
      content.remote('Second', 4);
      answers.shift()?.({ status: 'confirmed' });
    });
    await settle();
    expect(saves(app)).toEqual([
      { issue: ISSUE_A, baseVersion: 3, description: docOfText('Second') },
      { issue: ISSUE_A, baseVersion: 4, description: docOfText('Third') },
    ]);
  });
});

describe('another tab taking the queue over with a save in flight', () => {
  afterEach(() => {
    const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
    for (const toast of [...visibleToasts, ...queuedToasts]) overlayManager.dismissToast(toast.id);
  });

  it('says the latest changes may not be saved, once the page closed', async () => {
    const content = contentWorld();
    const app = new FakeApp({
      issues: [issueRow(ISSUE_A, 42)],
      content: content.api,
      // Never answered: the queue that held it is another tab's now.
      answer: () => new Promise(() => undefined),
    });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Second');
    await blur();
    await page.unmount();
    page = undefined;
    await inAct(() => {
      runInAction(() => {
        app.queueLost.set(true);
      });
    });
    await settle();
    const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
    expect([...visibleToasts, ...queuedToasts].map((toast) => toast.message)).toContain(
      descriptionAbandonedMessage('ENG-42'),
    );
  });
});

describe('the issue deleted or archived while open (E3, PLAN-011 S7)', () => {
  it('never renders the live description empty before the read-only view', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    expect(editor()?.value).toBe('Steps to reproduce');
    // Every text the page commits from here on.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(document.body.textContent ?? '');
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    // One delta: the issue leaves the replica, and its content is then marked gone (`ready`, no
    // rows), in separate actions of the same turn.
    await inAct(() => {
      app.removeIssue(ISSUE_A);
      content.gone();
    });
    await settle();
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes('No description'))).toBe(false);
    expect(document.querySelector('[aria-label="Edit title"]')).toBeNull();
    expect(editor()).toBeNull();
  });
});

describe('leaving the tab', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('saves now when the tab is hidden or the page is closed', async () => {
    const content = contentWorld();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], content: content.api });
    page = await mountIssuePage({ app, ref: 'ENG-42' });
    await type('Hidden mid-sentence');
    await inAct(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(saves(app)).toEqual([
      { issue: ISSUE_A, baseVersion: 3, description: docOfText('Hidden mid-sentence') },
    ]);
    await settle();
    await type('Closed mid-sentence');
    await inAct(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(saves(app).at(-1)).toEqual({
      issue: ISSUE_A,
      baseVersion: 4,
      description: docOfText('Closed mid-sentence'),
    });
  });
});
