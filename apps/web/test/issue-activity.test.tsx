// @vitest-environment jsdom
// SPEC-012 §3.4 item 4, §7.4, AC-11, D18; SPEC-013 §7; PLAN-012 S4b: the activity stream. History
// lines (SPEC-011's wording, the stored names, "via API"/"via MCP") and comment threads in one
// list, oldest first; each history item an `article` labelled with the actor and time, the full
// time in a tooltip; more than 30 items show the newest 30 below "Show N earlier".
import fc from 'fast-check';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_SHOWN,
  activityItems,
  historyRows,
  visibleActivity,
  type HistoryRow,
} from '../src/features/issues/activity-model.js';
import type { CommentRow, Thread } from '../src/features/comments/model.js';
import {
  IRIS,
  ME,
  THREAD,
  body,
  commentRow,
  mountComments,
  uuidOf,
  type World,
} from './comment-harness.js';
import { ISSUE_A, TEAM } from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

function entry(n: number, hoursAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id: uuidOf(900 + n),
    issueId: ISSUE_A,
    teamId: TEAM,
    actorKind: 'user',
    actorId: ME,
    apiKeyId: null,
    kind: 'updated',
    changes: {},
    createdAt: iso(hoursAgo),
    updatedAt: iso(hoursAgo),
    ...extra,
  };
}

const moved = (n: number, hoursAgo: number, extra: Record<string, unknown> = {}) =>
  entry(n, hoursAgo, {
    changes: {
      status: {
        from: { id: uuidOf(1), name: 'Todo', category: 'unstarted' },
        to: { id: uuidOf(2), name: 'In Progress', category: 'started' },
      },
    },
    ...extra,
  });

let world: World | undefined;
afterEach(async () => {
  await world?.unmount();
  world = undefined;
});

const activityText = () =>
  [...document.querySelectorAll('ol[aria-label="Activity"] > li')].map(
    (li) => li.textContent ?? '',
  );

describe('the activity stream (AC-11)', () => {
  it('interleaves history lines and comment threads by time, oldest first, with SPEC-011’s wording', async () => {
    world = await mountComments({
      comments: [
        commentRow(THREAD, { body: body('Does this happen on Safari?'), createdAt: iso(5) }),
      ],
      history: [
        entry(1, 6, { kind: 'created', changes: { title: { to: 'Login' } } }),
        moved(2, 4),
        entry(3, 3, {
          actorId: IRIS,
          changes: { assignee: { from: null, to: { id: IRIS, name: 'Iris' } } },
        }),
        entry(4, 2, {
          actorKind: 'api',
          changes: { assignee: { from: null, to: { id: IRIS, name: 'Iris' } } },
        }),
        entry(5, 1, { actorKind: 'system', actorId: null, kind: 'archived' }),
      ],
    });
    const items = activityText();
    expect(items).toHaveLength(6);
    expect(items[0]).toContain('Ada created the issue');
    expect(items[1]).toContain('Does this happen on Safari?');
    expect(items[2]).toContain('Ada moved from Todo to In Progress · ');
    expect(items[3]).toContain('Iris self-assigned the issue');
    expect(items[4]).toContain('Ada via API assigned the issue to Iris');
    expect(items[5]).toContain('Issue was automatically archived');
  });

  it('labels each history item with its actor and time, and puts the full time in a tooltip (§7.4)', async () => {
    const row = moved(1, 3);
    world = await mountComments({ comments: [], history: [row] });
    const article = document.querySelector('ol[aria-label="Activity"] article');
    expect(article?.getAttribute('aria-label')).toBe('Ada, 3 hours ago');
    const time = article?.querySelector('time');
    expect(time?.textContent).toBe('3h ago');
    expect(time?.getAttribute('title')).not.toBe('');
    expect(time?.getAttribute('dateTime')).toBe(row.createdAt);
  });

  it('uses the names stored in the entry, not the replica’s current ones (E16)', async () => {
    world = await mountComments({
      comments: [],
      history: [
        entry(1, 1, {
          changes: {
            status: {
              from: { id: uuidOf(1), name: 'Backlog (old name)', category: 'backlog' },
              to: { id: uuidOf(2), name: 'Doing (old name)', category: 'started' },
            },
          },
        }),
      ],
    });
    expect(activityText()[0]).toContain('Ada moved from Backlog (old name) to Doing (old name)');
  });

  it('shows the newest 30 of 35 items under "Show 5 earlier", and the rest on a click (D18)', async () => {
    const history = Array.from({ length: 35 }, (_, i) => moved(i, 100 - i));
    world = await mountComments({ comments: [], history });
    expect(activityText()).toHaveLength(ACTIVITY_SHOWN);
    const more = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show 5 earlier',
    );
    expect(more).toBeDefined();
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });
    expect(activityText()).toHaveLength(35);
    expect(document.body.textContent).not.toContain('Show 5 earlier');
  });

  it('shows no "earlier" button at 30 items or fewer', async () => {
    const history = Array.from({ length: 30 }, (_, i) => moved(i, 100 - i));
    world = await mountComments({ comments: [], history });
    expect(activityText()).toHaveLength(30);
    expect(document.body.textContent).not.toMatch(/Show \d+ earlier/);
  });
});

describe('activity model', () => {
  const thread = (id: number, at: string): Thread => {
    const root = { id: uuidOf(id), createdAt: at } as unknown as CommentRow;
    return { root, replies: [], resolved: false };
  };

  it('drops rows that aren’t history entries', () => {
    expect(historyRows([moved(1, 1), { id: 'junk' }])).toHaveLength(1);
  });

  it('orders by time, history before a comment at the same time; the order is total', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }),
        (historyHours, threadHours) => {
          const history = historyRows(historyHours.map((h, i) => moved(i, h)));
          const threads = threadHours.map((h, i) => thread(500 + i, iso(h)));
          const forward = activityItems(history, threads);
          const backward = activityItems([...history].reverse(), [...threads].reverse());
          expect(backward.map((item) => item.id)).toEqual(forward.map((item) => item.id));
          for (let i = 1; i < forward.length; i += 1) {
            const before = forward[i - 1];
            const after = forward[i];
            if (before === undefined || after === undefined) continue;
            expect(Date.parse(before.at)).toBeLessThanOrEqual(Date.parse(after.at));
          }
        },
      ),
      { seed: 20261116 },
    );
  });

  it('shows everything at 30 or fewer, the newest 30 above that, and everything when expanded', () => {
    const items = activityItems(
      historyRows(Array.from({ length: 31 }, (_, i) => moved(i, 100 - i))),
      [],
    );
    expect(visibleActivity(items.slice(0, 30), false)).toEqual({
      earlier: 0,
      shown: items.slice(0, 30),
    });
    const cut = visibleActivity(items, false);
    expect(cut.earlier).toBe(1);
    expect(cut.shown).toEqual(items.slice(1));
    expect(visibleActivity(items, true).shown).toHaveLength(31);
  });

  it('keeps history rows typed for the stream', () => {
    const [row] = historyRows([moved(1, 1)]);
    const typed: HistoryRow | undefined = row;
    expect(typed?.kind).toBe('updated');
  });
});
