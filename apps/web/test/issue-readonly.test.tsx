// @vitest-environment jsdom
// SPEC-012 §3.4 item 8, AC-26, E3; PLAN-012 S4b: the server-backed read-only view. An archived or
// deleted issue (or one that left the replica while open) shows the row and description from
// `issue.get` and the activity, comments and reactions from one `content.peek` answer, with no
// write control, and nothing of it is stored or opened in the replica. The page stays open in the
// deleted state after a delete (PLAN-012 S6 handoff).
import type { ContentPeek } from '@surface/sync-client';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OperationAnswer } from '../src/features/files/operation.js';
import { lastDelete } from '../src/features/issues/delete-flow.js';
import type { IssueOutput } from '../src/features/issues/issue-view.js';
import {
  FakeApp,
  inAct,
  installDomShims,
  IRIS,
  IRIS_ID,
  ISSUE_A,
  issueRow,
  mountIssuePage,
  type Mounted,
} from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

const AT = '2026-11-12T10:00:00.000Z';
const COMMENT = '0192f0c1-7e5a-7b3c-9d4e-000000000701';
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function output(extra: Partial<IssueOutput> = {}): IssueOutput {
  return {
    id: ISSUE_A,
    identifier: 'ENG-42',
    teamKey: 'ENG',
    title: 'Login page flickers',
    status: { id: ISSUE_A, name: 'Done', category: 'completed' },
    priority: 2,
    assignee: null,
    labels: [],
    estimate: null,
    dueDate: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedBy: null,
    url: 'http://x/issue/ENG-42/login-page-flickers',
    creator: { id: ISSUE_A, name: 'Iris' },
    startedAt: null,
    canceledAt: null,
    reactions: [],
    description: { markdown: 'Steps to reproduce', json: doc('Steps to reproduce') },
    version: 2,
    ...extra,
  };
}

const history = (id: number, kind: string, minutes: number) => ({
  id: `0192f0c1-7e5a-7b3c-9d4e-0000000009${String(id).padStart(2, '0')}`,
  issueId: ISSUE_A,
  teamId: TEAM,
  actorKind: 'user',
  actorId: IRIS_ID,
  apiKeyId: null,
  kind,
  changes: kind === 'created' ? { title: { to: 'Login page flickers' } } : {},
  createdAt: new Date(Date.parse(AT) + minutes * 60_000).toISOString(),
  updatedAt: new Date(Date.parse(AT) + minutes * 60_000).toISOString(),
});

const PEEKED: ContentPeek = {
  state: 'ready',
  found: true,
  rows: {
    IssueHistory: [history(1, 'created', 0), history(2, 'deleted', 30)],
    Comment: [
      {
        id: COMMENT,
        issueId: ISSUE_A,
        teamId: TEAM,
        parentCommentId: null,
        userId: IRIS_ID,
        actorKind: 'user',
        body: doc('Seen on Safari too'),
        version: 1,
        editedAt: null,
        deletedAt: null,
        resolvedAt: null,
        resolvedById: null,
        createdAt: new Date(Date.parse(AT) + 10 * 60_000).toISOString(),
        updatedAt: AT,
      },
    ],
    Reaction: [
      {
        id: '0192f0c1-7e5a-7b3c-9d4e-000000000801',
        issueId: ISSUE_A,
        teamId: TEAM,
        commentId: null,
        userId: IRIS_ID,
        emoji: '👍',
        createdAt: AT,
      },
    ],
    IssueContent: [],
  },
};

/** A store `content` that records what the page opens and peeks. */
function content(peek: (id: string) => Promise<ContentPeek> = () => Promise.resolve(PEEKED)) {
  const opened: string[] = [];
  const peeked: string[] = [];
  return {
    opened,
    peeked,
    api: {
      state: () => 'loading',
      rows: () => ({}),
      open: (id: string) => {
        opened.push(id);
        return { release: () => undefined };
      },
      peek: (id: string) => {
        peeked.push(id);
        return peek(id);
      },
    },
  };
}

/** `issue.get` answering `answer` each time, recording the refs asked. */
function issueApi(answer: () => OperationAnswer<IssueOutput>) {
  const asked: string[] = [];
  return {
    asked,
    get: (ref: string) => {
      asked.push(ref);
      return Promise.resolve(answer());
    },
  };
}

/** Lets the loader's and the peek's promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const text = () => document.body.textContent ?? '';
let page: Mounted | undefined;

beforeAll(() => {
  installDomShims();
});
afterEach(async () => {
  await page?.unmount();
  page = undefined;
  lastDelete.take();
});

describe('an archived or deleted issue opens read-only from the server (AC-26)', () => {
  it('shows a deleted issue with its badge and crumb, its description and the server’s activity, and nothing to write with', async () => {
    const store = content();
    const app = new FakeApp({ issues: [], users: [IRIS], content: store.api });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();

    expect(text()).toContain('Deleted');
    expect(text()).toContain('Recently deleted issues');
    expect(text()).toContain('Steps to reproduce');
    // The activity: history lines and the comment, oldest first.
    const activity = document.querySelector('ol[aria-label="Activity"]')?.textContent ?? '';
    expect(activity.indexOf('Iris created the issue')).toBeGreaterThanOrEqual(0);
    expect(activity.indexOf('Seen on Safari too')).toBeGreaterThan(
      activity.indexOf('Iris created the issue'),
    );
    expect(activity.indexOf('Iris deleted the issue')).toBeGreaterThan(
      activity.indexOf('Seen on Safari too'),
    );
    // No comment box, no reply, no reaction button, no description editor, no title edit.
    expect(document.querySelector('[aria-label="Comment"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Reply"]')).toBeNull();
    expect(document.querySelector('[aria-label="Add reaction"]')).toBeNull();
    expect(document.querySelector('textarea[aria-label="Description"]')).toBeNull();
    // Read with one peek; nothing opened (hydrated) in the replica, nothing sent.
    expect(store.peeked).toEqual([ISSUE_A]);
    expect(store.opened).toEqual([]);
    expect(app.dispatched).toEqual([]);
  });

  it('shows an archived issue with the Archived badge and the Archived issues crumb', async () => {
    const store = content();
    const app = new FakeApp({ issues: [], users: [IRIS], content: store.api });
    const api = issueApi(() => ({ ok: true, result: output({ archivedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(text()).toContain('Archived');
    expect(text()).toContain('Archived issues');
    expect(text()).not.toContain('Recently deleted issues');
    expect(store.opened).toEqual([]);
  });

  it('says the activity is available when online when the peek is offline', async () => {
    const store = content(() => Promise.resolve({ state: 'offline' }));
    const app = new FakeApp({ issues: [], users: [IRIS], content: store.api });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(text()).toContain("Comments are available when you're back online.");
    // The description came with `issue.get`.
    expect(text()).toContain('Steps to reproduce');
  });

  it('asks the server again when the window regains focus', async () => {
    const store = content();
    const app = new FakeApp({ issues: [], users: [IRIS], content: store.api });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(api.asked).toEqual(['ENG-42']);
    await inAct(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(api.asked).toEqual(['ENG-42', 'ENG-42']);
    expect(store.peeked).toEqual([ISSUE_A, ISSUE_A]);
    // Still shown while asking again.
    expect(text()).toContain('Seen on Safari too');
  });
});

describe('an open issue that leaves the replica (E3)', () => {
  it('switches to the read-only deleted state without navigating, showing its last row until the server answers', async () => {
    const store = content();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], users: [IRIS], content: store.api });
    let answer: (value: OperationAnswer<IssueOutput>) => void = () => undefined;
    const asked: string[] = [];
    const api = {
      get: (ref: string) => {
        asked.push(ref);
        return new Promise<OperationAnswer<IssueOutput>>((resolve) => {
          answer = resolve;
        });
      },
    };
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    expect(document.querySelector('button[aria-label="More actions"]')).not.toBeNull();
    const path = page.router.state.location.pathname;

    // The delete packet removes it from the replica.
    app.removeIssue(ISSUE_A);
    await settle();
    expect(asked).toEqual(['ENG-42']);
    // Its last row, read-only: the title is no longer an edit button.
    expect(text()).toContain('Login page flickers');
    expect(document.querySelector('[aria-label="Edit title"]')).toBeNull();

    await act(async () => {
      answer({ ok: true, result: output({ deletedAt: AT }) });
      await Promise.resolve();
    });
    await settle();
    expect(text()).toContain('Deleted');
    expect(text()).toContain('Recently deleted issues');
    expect(text()).toContain('Iris deleted the issue');
    expect(page.router.state.location.pathname).toBe(path);
  });

  it('stays open in the deleted state after a delete from this page, and asks once the delete is confirmed', async () => {
    const store = content();
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)], users: [IRIS], content: store.api });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });

    // What `deleteIssue` does: remember it, then the optimistic delete removes the row; the
    // mutation waits for its confirmation.
    lastDelete.set({ id: ISSUE_A, identifier: 'ENG-42' });
    await inAct(() => {
      app.pending.push({ op: 'issue.delete' });
    });
    app.removeIssue(ISSUE_A);
    await settle();
    expect(text()).toContain('Deleted');
    expect(text()).toContain('Recently deleted issues');
    // The server isn't asked before the delete is confirmed: its answer could predate it.
    expect(api.asked).toEqual([]);

    await inAct(() => {
      app.pending.clear();
    });
    await settle();
    expect(api.asked).toEqual(['ENG-42']);
    expect(text()).toContain('Deleted');
    expect(text()).toContain('Iris deleted the issue');
  });
});
