// PLAN-013 S5: the pure parts of the comment timeline (SPEC-013 §3.2, §3.3a, §3.4, §7).
import type { DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  buildThreads,
  commentIdOfHash,
  commentLink,
  commentRows,
  firstLineOf,
  hasContent,
  reactionChips,
  reactionRows,
  sameDoc,
  withChecked,
} from '../src/features/comments/model.js';
import {
  IRIS,
  ME,
  THREAD,
  REPLY,
  RESOLVED,
  body,
  commentRow,
  reactionRow,
  uuidOf,
} from './comment-harness.js';

const rows = (...list: Record<string, unknown>[]) => commentRows(list as never);

describe('threads', () => {
  it('groups replies under their root, oldest first, and orders threads by their first comment', () => {
    const threads = buildThreads(
      rows(
        commentRow(REPLY, { parentCommentId: THREAD, createdAt: '2026-11-10T12:00:00.000Z' }),
        commentRow(uuidOf(9), { parentCommentId: THREAD, createdAt: '2026-11-10T11:00:00.000Z' }),
        commentRow(RESOLVED, { createdAt: '2026-11-09T10:00:00.000Z' }),
        commentRow(THREAD, { createdAt: '2026-11-10T10:00:00.000Z' }),
      ),
    );
    expect(threads.map((t) => t.root.id)).toEqual([RESOLVED, THREAD]);
    expect(threads[1]?.replies.map((r) => r.id)).toEqual([uuidOf(9), REPLY]);
  });

  it('marks a thread resolved by its root, and keeps a reply whose root is missing as a thread of its own', () => {
    const [resolved] = buildThreads(
      rows(commentRow(RESOLVED, { resolvedAt: '2026-11-10T10:00:00.000Z' })),
    );
    expect(resolved?.resolved).toBe(true);
    const orphan = buildThreads(rows(commentRow(REPLY, { parentCommentId: THREAD })));
    expect(orphan.map((t) => t.root.id)).toEqual([REPLY]);
  });

  it('leaves out a row that is not a comment', () => {
    expect(rows({ id: 'x' })).toEqual([]);
  });
});

describe('the one-line summary and the empty check', () => {
  it('takes the first line of the first block with text', () => {
    const doc: DocNodeJSON = {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: '  Is  this\nfixed? ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
      ],
    };
    expect(firstLineOf(doc)).toBe('Is this fixed?');
  });

  it('counts text, an image or a file as content, and blank paragraphs as none (§3.1 item 3)', () => {
    expect(hasContent(body('  '))).toBe(false);
    expect(hasContent(body('x'))).toBe(true);
    expect(
      hasContent({ type: 'doc', content: [{ type: 'image', attrs: { src: '/files/x' } }] }),
    ).toBe(true);
    expect(hasContent({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false);
  });
});

describe('checklists and documents', () => {
  it('sets the checklist item at a path without touching the rest', () => {
    const doc: DocNodeJSON = {
      type: 'doc',
      content: [
        { type: 'paragraph' },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false } },
            { type: 'taskItem', attrs: { checked: false } },
          ],
        },
      ],
    };
    const next = withChecked(doc, [1, 1], true);
    expect(next.content?.[1]?.content?.map((item) => item.attrs?.['checked'])).toEqual([
      false,
      true,
    ]);
    expect(doc.content?.[1]?.content?.[1]?.attrs?.['checked']).toBe(false);
    expect(withChecked(doc, [5], true)).toEqual(doc);
    expect(sameDoc(doc, doc)).toBe(true);
    expect(sameDoc(doc, next)).toBe(false);
  });
});

describe('reaction chips', () => {
  it('names who reacted with You first, and the emoji by its label', () => {
    const chips = reactionChips(
      reactionRows([
        { ...reactionRow(uuidOf(1), '👍', IRIS, null), createdAt: '2026-11-10T10:00:00.000Z' },
        { ...reactionRow(uuidOf(2), '👍', ME, null), createdAt: '2026-11-10T10:01:00.000Z' },
        { ...reactionRow(uuidOf(3), '🎉', IRIS, null), createdAt: '2026-11-10T10:02:00.000Z' },
      ]),
      ME,
      (id) => (id === IRIS ? 'Iris' : 'Someone'),
      (emoji) => (emoji === '👍' ? 'thumbs up' : undefined),
    );
    expect(chips).toEqual([
      { emoji: '👍', count: 2, mine: true, label: 'thumbs up', people: ['You', 'Iris'] },
      { emoji: '🎉', count: 1, mine: false, people: ['Iris'] },
    ]);
  });
});

describe('comment links (§7)', () => {
  it('builds /issue/ENG-42#comment-<id> and reads the id back from a hash', () => {
    expect(commentLink('https://surface.example/', 'ENG-42', THREAD)).toBe(
      `https://surface.example/issue/ENG-42#comment-${THREAD}`,
    );
    expect(commentIdOfHash(`#comment-${THREAD.toUpperCase()}`)).toBe(THREAD);
    expect(commentIdOfHash('#description')).toBeUndefined();
    expect(commentIdOfHash('')).toBeUndefined();
  });
});
