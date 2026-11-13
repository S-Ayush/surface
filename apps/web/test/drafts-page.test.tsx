/**
 * @vitest-environment jsdom
 */
// PLAN-012 S5 (SPEC-012 §3.2, AC-3, E7, E18): the Drafts page lists composer drafts and unsent
// comments, opens them, and deletes them from the row menu; a comment draft whose issue the
// replica doesn't hold is asked about with `issue.get` while online (live shows; archived, deleted
// or not found hides) and shows as "Issue not loaded" offline.
import { overlayManager } from '@surface/ui';
import { afterEach, describe, expect, it } from 'vitest';
import type { IssueApi } from '../src/features/issues/issue-api.js';
import {
  buttonNamed,
  ComposerApp,
  dialogNamed,
  draftRow,
  ENG,
  id,
  mountComposer,
  titleInput,
  type Mounted,
} from './composer-harness.js';
import { inAct } from './issue-fixtures.js';

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  overlayManager.clear();
  document.body.innerHTML = '';
});

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const LIVE = id(501);
const GONE = id(502);
const REMOTE_LIVE = id(503);
const REMOTE_ARCHIVED = id(504);
const REMOTE_MISSING = id(505);
const HIDDEN_TEAM = id(506);
const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function issueRow(issueId: string, number: number, title: string, gone = false) {
  return {
    id: issueId,
    teamId: ENG,
    number,
    title,
    archivedAt: gone ? recent(10) : null,
    deletedAt: null,
  };
}

const answer = (identifier: string, title: string, archived: boolean) => ({
  ok: true as const,
  result: {
    identifier,
    title,
    archivedAt: archived ? recent(5) : null,
    deletedAt: null,
  },
});

function fakeApi(asked: string[]): IssueApi {
  return {
    get: (ref) => {
      asked.push(ref);
      if (ref === REMOTE_LIVE)
        return Promise.resolve(answer('OPS-7', 'Rotate the keys', false) as never);
      if (ref === REMOTE_ARCHIVED) return Promise.resolve(answer('OPS-8', 'Old', true) as never);
      return Promise.resolve({ ok: false, code: 'NOT_FOUND', message: 'No such issue.' });
    },
  };
}

const rows = () =>
  [...document.querySelectorAll('[aria-label="Drafts"] li')].map((li) => li.textContent);

async function settle(): Promise<void> {
  await inAct(() => undefined);
  await inAct(() => undefined);
}

describe('the Drafts page', () => {
  it('shows the empty state with how to keep one', async () => {
    mounted = await mountComposer(new ComposerApp(), '/drafts');
    expect(document.body.textContent).toContain('No drafts');
    expect(document.body.textContent).toContain('Close the composer with Save to keep one here.');
  });

  it('lists composer drafts with their team and comment drafts with their issue and first line', async () => {
    const app = new ComposerApp({
      drafts: [
        draftRow({ teamId: ENG, data: { title: 'Plan the launch' }, updatedAt: recent(60) }),
        draftRow({
          kind: 'comment',
          teamId: null,
          issueId: LIVE,
          data: { text: doc('Looks good to me') },
          updatedAt: recent(1),
        }),
        draftRow({
          kind: 'comment',
          teamId: null,
          issueId: GONE,
          data: { text: doc('Never sent') },
        }),
      ],
      issues: [issueRow(LIVE, 42, 'Fix login'), issueRow(GONE, 43, 'Archived one', true)],
    });
    mounted = await mountComposer(app, '/drafts');
    expect(rows()).toEqual([
      expect.stringContaining('ENG-42 Fix login'),
      expect.stringContaining('Plan the launch'),
    ]);
    expect(rows()[0]).toContain('Looks good to me');
    expect(rows()[1]).toContain('ENG');
    expect(document.body.textContent).not.toContain('Never sent');
  });

  it('E18: online, asks issue.get about issues it doesn’t hold; live shows, the rest hide', async () => {
    const asked: string[] = [];
    const app = new ComposerApp({
      drafts: [REMOTE_LIVE, REMOTE_ARCHIVED, REMOTE_MISSING].map((issueId, i) =>
        draftRow({
          kind: 'comment',
          teamId: null,
          issueId,
          data: { text: doc(`text ${String(i)}`) },
        }),
      ),
    });
    mounted = await mountComposer(app, '/drafts', fakeApi(asked));
    await settle();
    expect(asked.sort()).toEqual([REMOTE_LIVE, REMOTE_ARCHIVED, REMOTE_MISSING].sort());
    expect(rows()).toEqual([expect.stringContaining('OPS-7 Rotate the keys')]);
  });

  it('E18: offline, such a draft shows as "Issue not loaded" and nothing is asked', async () => {
    const asked: string[] = [];
    const app = new ComposerApp({
      drafts: [
        draftRow({
          kind: 'comment',
          teamId: null,
          issueId: REMOTE_LIVE,
          data: { text: doc('Hi') },
        }),
      ],
    });
    app.setOnline(false);
    mounted = await mountComposer(app, '/drafts', fakeApi(asked));
    await settle();
    expect(asked).toEqual([]);
    expect(rows()).toEqual([expect.stringContaining('Issue not loaded')]);
  });

  it('opening a composer draft opens the composer with it; a hidden team’s opens in the default team (E7)', async () => {
    const app = new ComposerApp({
      drafts: [draftRow({ teamId: HIDDEN_TEAM, data: { title: 'From a private team' } })],
    });
    mounted = await mountComposer(app, '/drafts');
    expect(rows()[0]).toContain('A team you can no longer see');
    await inAct(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Drafts"] li button')?.click();
    });
    expect(dialogNamed('New issue')).toBeDefined();
    expect(titleInput().value).toBe('From a private team');
    expect(dialogNamed('New issue')?.textContent).toContain(
      'Dropped: its team, which you can no longer see.',
    );
  });

  it('opening an unsent comment goes to its issue', async () => {
    const app = new ComposerApp({
      drafts: [
        draftRow({ kind: 'comment', teamId: null, issueId: LIVE, data: { text: doc('Hi') } }),
      ],
      issues: [issueRow(LIVE, 42, 'Fix login')],
    });
    mounted = await mountComposer(app, '/drafts');
    const row = document.querySelector<HTMLButtonElement>('[aria-label="Drafts"] li button');
    await inAct(() => {
      row?.click();
    });
    expect(mounted.path()).toBe('/issue/ENG-42/fix-login');
  });

  it('the row menu’s Delete draft sends draft.discard for it', async () => {
    const app = new ComposerApp({ drafts: [draftRow({ teamId: ENG, data: { title: 'Bye' } })] });
    mounted = await mountComposer(app, '/drafts');
    const trigger = buttonNamed('Actions for Bye');
    await inAct(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'Delete draft',
    );
    if (item === undefined) throw new Error('no Delete draft item');
    await inAct(() => {
      (item as HTMLElement).click();
    });
    expect(app.ops()).toEqual(['draft.discard']);
    expect(app.dispatched[0]?.input).toEqual({ kind: 'composer', teamId: ENG });
  });
});
