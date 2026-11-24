// @vitest-environment jsdom
// PLAN-015 S4 (SPEC-015 §3.4, §7, AC-14, AC-15, E5, E9): an archived or deleted issue's page.
// Restore (`#`) on an archived issue and on a deleted one until its purgeAfter, Delete on an
// archived one, Permanently delete… for Admins on a deleted one; a restore re-reads the page
// without waiting for a packet; a purge while the page is open switches it to "This issue was
// deleted permanently.", while a fresh open after the purge reads like any unknown identifier.
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { purgeRequests } from '../src/features/archive/purge-flow.js';
import type { OperationAnswer } from '../src/features/files/operation.js';
import { PURGED_TITLE } from '../src/features/issues/IssueNotFound.js';
import type { IssueOutput } from '../src/features/issues/issue-view.js';
import {
  FakeApp,
  installDomShims,
  ISSUE_A,
  mountIssuePage,
  type Mounted,
} from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

const DAY = 86_400_000;
const AT = '2026-11-12T10:00:00.000Z';

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
    attachments: [],
    description: { markdown: '', json: { type: 'doc', content: [] } },
    version: 1,
    ...extra,
  };
}

/** `issue.get` answering what `answer` says now, recording the refs asked. */
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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The ⋯ menu's item labels, opened by keyboard. */
async function menuItems(): Promise<string[]> {
  const trigger = document.querySelector<HTMLElement>('button[aria-label="More actions"]');
  if (trigger === null) throw new Error('no ⋯ menu');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
}

const text = () => document.body.textContent;
const recent = () => new Date(Date.now() - DAY).toISOString();
let page: Mounted | undefined;

beforeAll(() => {
  installDomShims();
});
afterEach(async () => {
  await page?.unmount();
  page = undefined;
  purgeRequests.close();
});

describe('a deleted issue’s page (§3.4)', () => {
  it('offers Restore to a Member, but not Delete or Permanently delete…', async () => {
    const app = new FakeApp({ issues: [] });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: recent() }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    const registry = page.registry();
    expect(registry?.isAvailable('issue:restore')).toBe(true);
    expect(registry?.isAvailable('issue:purge')).toBe(false);
    expect(registry?.isAvailable('issue:delete')).toBe(false);
    const items = await menuItems();
    expect(items).toContain('Restore');
    expect(items).not.toContain('Delete');
    expect(items).not.toContain('Permanently delete…');
  });

  it('offers Permanently delete… to an Admin, which opens the confirm dialog (AC-15)', async () => {
    const app = new FakeApp({ issues: [], role: 'admin' });
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: recent() }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(await menuItems()).toContain('Permanently delete…');
    await act(async () => {
      page?.registry()?.run('issue:purge');
      await Promise.resolve();
    });
    expect(purgeRequests.snapshot()).toMatchObject({ issueId: ISSUE_A, identifier: 'ENG-42' });
  });

  it('hides Restore once now ≥ purgeAfter, and says why', async () => {
    const app = new FakeApp({ issues: [] });
    const old = new Date(Date.now() - 31 * DAY).toISOString();
    const api = issueApi(() => ({ ok: true, result: output({ deletedAt: old }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    const registry = page.registry();
    expect(registry?.isAvailable('issue:restore')).toBe(false);
    expect(registry?.reason('issue:restore')).toBe(
      "ENG-42 was deleted more than 30 days ago and can't be restored.",
    );
    expect(await menuItems()).not.toContain('Restore');
  });

  it('restores with # and reads the issue again once confirmed, never waiting for a packet (AC-14)', async () => {
    const app = new FakeApp({ issues: [] });
    let current = output({ deletedAt: recent() });
    const api = issueApi(() => ({ ok: true, result: current }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(text()).toContain('Deleted');
    current = output();
    await act(async () => {
      page?.registry()?.run('issue:restore');
      await Promise.resolve();
    });
    await settle();
    expect(app.dispatched).toEqual([{ op: 'issue.restore', input: { issue: ISSUE_A } }]);
    expect(api.asked.length).toBeGreaterThanOrEqual(2);
    expect(text()).not.toContain('Recently deleted issues');
  });
});

describe('an archived issue’s page (§3.4)', () => {
  it('offers Restore and Delete, but not Permanently delete…', async () => {
    const app = new FakeApp({ issues: [], role: 'admin' });
    const api = issueApi(() => ({ ok: true, result: output({ archivedAt: AT }) }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    const registry = page.registry();
    expect(registry?.isAvailable('issue:restore')).toBe(true);
    expect(registry?.isAvailable('issue:purge')).toBe(false);
    const items = await menuItems();
    expect(items).toContain('Restore');
    expect(items).toContain('Delete');
    expect(items).not.toContain('Permanently delete…');
  });
});

describe('after a purge', () => {
  it('switches an open deleted page to "This issue was deleted permanently." on the Issue D (E5)', async () => {
    const app = new FakeApp({ issues: [] });
    let purged = false;
    const api = issueApi(() =>
      purged
        ? { ok: false, code: 'NOT_FOUND', message: 'not found' }
        : { ok: true, result: output({ deletedAt: recent() }) },
    );
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(text()).toContain('Deleted');
    purged = true;
    await act(async () => {
      app.packets.unshift({ id: 9, action: 'D', model: 'Issue', rowId: ISSUE_A, appliedAt: 0 });
      await Promise.resolve();
    });
    await settle();
    expect(text()).toContain(PURGED_TITLE);
  });

  it('opened afresh, reads like an identifier that never existed (E9)', async () => {
    const app = new FakeApp({ issues: [] });
    const api = issueApi(() => ({ ok: false, code: 'NOT_FOUND', message: 'not found' }));
    page = await mountIssuePage({ app, ref: 'ENG-42', api });
    await settle();
    expect(text()).toContain("ENG-42 doesn't exist, or you don't have access to it.");
    expect(text()).not.toContain(PURGED_TITLE);
  });
});
