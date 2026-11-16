// @vitest-environment jsdom
// PLAN-013 S5, SPEC-013 §3 and §7: the comment timeline and box on the issue page, against a fake
// server and an in-memory replica (`comment-harness.tsx`) and the real shortcut engine. The editor
// is a textarea here (`comment-editor-fake.tsx`); its own keys are `editor-keys.test.tsx`.
// Covers AC-19 (reply and edit keys), AC-20, AC-21 (UI), E1, E3, E15, E17, E20, E21, E26 and D10.
import { overlayManager } from '@surface/ui';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docOfText } from './comment-editor-fake.js';
import {
  IRIS,
  ME,
  MINE,
  REPLY,
  RESOLVED,
  RESOLVED_REPLY,
  THREAD,
  body,
  clearToasts,
  commentRow,
  mountComments,
  reactionRow,
  seedComments,
  toasts,
  uuidOf,
  type World,
} from './comment-harness.js';
import { commentActionsFor } from '../src/features/comments/useComments.js';
import { ISSUE_A, inAct, issueRow, keydown } from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let world: World | undefined;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  // jsdom has no layout: the router and the highlight scroll to the linked comment.
  Element.prototype.scrollIntoView = () => undefined;
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(async () => {
  await world?.unmount();
  world = undefined;
  clearToasts();
  vi.useRealTimers();
});

const host = () => {
  if (world === undefined) throw new Error('not mounted');
  return world.host;
};
const card = (id: string) => host().querySelector<HTMLElement>(`article#comment-${id}`);
const field = (label: string) =>
  host().querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
const button = (name: string, within: ParentNode = host()) =>
  [...within.querySelectorAll<HTMLElement>('button')].find(
    (el) => el.getAttribute('aria-label') === name || el.textContent.trim() === name,
  );
const server = () => {
  if (world === undefined) throw new Error('not mounted');
  return world.server;
};

function typeInto(textarea: HTMLTextAreaElement | null, text: string): Promise<void> {
  if (textarea === null) throw new Error('no such box');
  return inAct(() => {
    // The writer has focus in the box, which is where the comment keys apply.
    textarea.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Focuses a comment, as the keyboard or a click would, so it is the `comment` scope and target. */
function focusCard(id: string): Promise<void> {
  const element = card(id);
  if (element === null) throw new Error(`comment ${id} is not shown`);
  return inAct(() => {
    element.focus();
  });
}

const modEnter = (target: Element) => keydown(target, 'Enter', { ctrlKey: true });

async function invoke(id: Parameters<NonNullable<World['registry']>['invoke']>[0]): Promise<void> {
  await act(async () => {
    void world?.registry?.invoke(id);
    await Promise.resolve();
  });
}

async function mount(options: Parameters<typeof mountComments>[0] = {}): Promise<World> {
  world = await mountComments(options);
  return world;
}

const order = () =>
  [...host().querySelectorAll('article[id^="comment-"]')].map((el) =>
    el.id.slice('comment-'.length),
  );

describe('the timeline (SPEC-013 §3.2, §7)', () => {
  it('lists threads oldest first with replies under their comment, each an article named by author and age', async () => {
    await mount();
    // The resolved thread is one line, so its comments aren't cards until it is expanded; it
    // comes first, being the oldest.
    expect(order()).toEqual([THREAD, REPLY, MINE]);
    const all = [...host().querySelectorAll('[id^="comment-"]')].map((el) => el.id);
    expect(all[0]).toBe(`comment-${RESOLVED}`);
    expect(card(THREAD)?.getAttribute('aria-label')).toBe('Comment by Iris, 5 hours ago');
    expect(card(REPLY)?.getAttribute('aria-label')).toBe('Comment by Ada, 4 hours ago');
    expect(card(THREAD)?.tagName).toBe('ARTICLE');
    expect(card(REPLY)?.closest('ul[aria-label="Replies"]')).not.toBeNull();
  });

  it('labels a comment written through the API', async () => {
    await mount({ comments: [commentRow(THREAD, { actorKind: 'api' })] });
    expect(card(THREAD)?.textContent).toContain('via API');
  });

  it('shows a deleted comment that still has replies as a placeholder', async () => {
    await mount({
      comments: [
        commentRow(THREAD, { deletedAt: '2026-11-15T10:00:00.000Z', body: body('') }),
        commentRow(REPLY, { parentCommentId: THREAD, body: body('Still here') }),
      ],
    });
    expect(card(THREAD)?.textContent).toContain('This comment was deleted.');
    expect(card(REPLY)?.textContent).toContain('Still here');
  });
});

describe('when the comments can be shown (SPEC-013 §3.1 item 4, E20)', () => {
  it('shows "Comments are available when you\'re back online." and no box when the content was never fetched', async () => {
    await mount({ state: 'offline' });
    expect(host().textContent).toContain("Comments are available when you're back online.");
    expect(field('Comment')).toBeNull();
  });

  it('shows no box while the content loads', async () => {
    await mount({ state: 'loading' });
    expect(field('Comment')).toBeNull();
    expect(host().querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('hides every control that writes on an archived issue (D10)', async () => {
    await mount({
      issue: issueRow(ISSUE_A, 42, { archivedAt: '2026-11-10T10:00:00.000Z' }),
      reactions: [reactionRow(uuidOf(10), '👍', IRIS, null)],
    });
    expect(card(THREAD)).not.toBeNull();
    expect(field('Comment')).toBeNull();
    expect(button('Leave a reply…')).toBeUndefined();
    expect(button('Reply')).toBeUndefined();
    expect(button('Add reaction')).toBeUndefined();
    expect(button('Comment options')).toBeUndefined();
    // The chips stay, and don't toggle.
    const chip = button('Thumbs up, 1 reaction');
    expect(chip?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('sending a comment (AC-20, §3.1)', () => {
  it('empties the box, discards the draft and sends the text; nothing waiting is saved afterwards', async () => {
    await mount();
    await typeInto(field('Comment'), 'Ship it');
    expect(button('Send')?.hasAttribute('disabled')).toBe(false);
    await modEnter(field('Comment') as Element);

    const [sent] = server().of('comment.create');
    expect(sent).toMatchObject({ issue: ISSUE_A, body: docOfText('Ship it') });
    expect(sent?.['parent']).toBeUndefined();
    expect(server().of('draft.discard')).toEqual([{ kind: 'comment', issueId: ISSUE_A }]);
    expect(field('Comment')?.value).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(server().of('draft.save')).toEqual([]);
  });

  it('cannot send an empty comment (§3.1 item 3)', async () => {
    await mount();
    expect(button('Send')?.hasAttribute('disabled')).toBe(true);
    await typeInto(field('Comment'), '   ');
    expect(button('Send')?.hasAttribute('disabled')).toBe(true);
    await modEnter(field('Comment') as Element);
    expect(server().of('comment.create')).toEqual([]);
  });

  it('shows the comment with a pending marker until the server confirms it', async () => {
    await mount();
    server().holding = true;
    await typeInto(field('Comment'), 'Waiting');
    await modEnter(field('Comment') as Element);
    const sent = server().of('comment.create')[0];
    const pending = card(String(sent?.['id']));
    expect(pending?.textContent).toContain('Sending…');
    expect(pending?.getAttribute('data-pending')).toBe('true');
    await act(async () => {
      server().release();
      await Promise.resolve();
    });
    expect(card(String(sent?.['id']))?.textContent).not.toContain('Sending…');
  });

  it('discards the draft when the click on Send blurred the editor first and saved it', async () => {
    await mount();
    const box = field('Comment');
    await typeInto(box, 'Clicked away');
    // A mousedown on the button moves focus out of the editor: its blur saves the waiting text.
    await inAct(() => {
      box?.blur();
    });
    expect(server().of('draft.save')).toMatchObject([
      { data: { text: docOfText('Clicked away') } },
    ]);
    await inAct(() => button('Send')?.click());

    expect(server().of('comment.create')).toMatchObject([{ body: docOfText('Clicked away') }]);
    expect(server().drafts).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(server().of('draft.save')).toHaveLength(1);
    expect(server().drafts).toHaveLength(0);
  });

  it('sends with the Send button too', async () => {
    await mount();
    await typeInto(field('Comment'), 'Clicked');
    await inAct(() => button('Send')?.click());
    expect(server().of('comment.create')).toHaveLength(1);
  });
});

describe('a refused comment (E1, E15, E17, E21)', () => {
  it.each([
    ['E1: the server refuses it', 'Comment is too long. Split it into two, or attach a file.'],
    ['E15: the issue was archived meanwhile', 'ENG-42 is archived. Restore it to edit it.'],
    ['E17: the issue was deleted while offline', 'ENG-42 was deleted. Restore it to edit it.'],
  ])(
    '%s: removes it, saves the text as the draft and shows it in the box',
    async (_name, message) => {
      await mount();
      server().refusals.set('comment.create', message);
      await typeInto(field('Comment'), 'Lost text');
      await modEnter(field('Comment') as Element);

      expect(order()).not.toContain(String(server().of('comment.create')[0]?.['id']));
      expect(server().of('draft.save')).toMatchObject([
        { kind: 'comment', issueId: ISSUE_A, data: { text: docOfText('Lost text') } },
      ]);
      expect(field('Comment')?.value).toBe('Lost text');
      expect(toasts()).toContain(message);
    },
  );

  it('keeps what was typed meanwhile and offers Copy text for the rejected comment (E21)', async () => {
    await mount();
    server().holding = true;
    server().refusals.set('comment.create', 'ENG-42 is archived. Restore it to edit it.');
    await typeInto(field('Comment'), 'First');
    await modEnter(field('Comment') as Element);
    await typeInto(field('Comment'), 'Second');
    await act(async () => {
      server().release();
      await Promise.resolve();
    });

    // The newer text stays, and the rejected one isn't written over it.
    expect(field('Comment')?.value).toBe('Second');
    expect(
      server()
        .of('draft.save')
        .map((input) => JSON.stringify(input['data'])),
    ).not.toContain(JSON.stringify({ text: docOfText('First') }));
    const toast = overlayManager
      .getSnapshot()
      .visibleToasts.find((t) => t.message === 'ENG-42 is archived. Restore it to edit it.');
    expect(toast?.action?.label).toBe('Copy text');
    await act(async () => {
      toast?.action?.onAction();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('First');
  });
});

describe('a refusal that arrives after a reload (SPEC-013 §3.1 item 2; PLAN-013 S5 review)', () => {
  // The shell hands such a rejection to the store's actions (`ShellRoute`): no dispatch promise
  // is waiting for it, because the page that sent the comment is gone.
  const message = 'ENG-42 is archived. Restore it to edit it.';
  const queued = (op: string, text: string) => ({
    op,
    input: { id: uuidOf(900), issue: ISSUE_A, body: docOfText(text) },
    message,
  });
  const actions = () => commentActionsFor(server().asStore());

  it('puts the text of a comment into the issue draft when the draft is empty', async () => {
    await mount();
    expect(actions().reportQueuedRejection(queued('comment.create', 'Sent offline'))).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(server().of('draft.save')).toMatchObject([
      { kind: 'comment', issueId: ISSUE_A, data: { text: docOfText('Sent offline') } },
    ]);
    expect(field('Comment')?.value).toBe('Sent offline');
    expect(toasts()).toContain(message);
  });

  it('offers Copy text when the draft holds something else, and leaves the draft alone', async () => {
    await mount();
    await typeInto(field('Comment'), 'Newer text');
    expect(actions().reportQueuedRejection(queued('comment.create', 'Sent offline'))).toBe(true);
    expect(server().of('draft.save')).toEqual([]);
    expect(field('Comment')?.value).toBe('Newer text');
    const toast = overlayManager.getSnapshot().visibleToasts.find((t) => t.message === message);
    expect(toast?.action?.label).toBe('Copy text');
    await act(async () => {
      toast?.action?.onAction();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('Sent offline');
  });

  it('treats a refused reply like a comment: its text goes to the issue draft', async () => {
    await mount();
    const reply = {
      ...queued('comment.create', 'A reply'),
      input: { ...queued('comment.create', 'A reply').input, parent: THREAD },
    };
    expect(actions().reportQueuedRejection(reply)).toBe(true);
    expect(server().of('draft.save')).toMatchObject([{ data: { text: docOfText('A reply') } }]);
  });

  it('offers Copy text for a refused edit', async () => {
    await mount();
    const edit = {
      op: 'comment.update',
      input: { comment: MINE, baseVersion: 3, body: docOfText('Edited offline') },
      message,
    };
    expect(actions().reportQueuedRejection(edit)).toBe(true);
    const toast = overlayManager.getSnapshot().visibleToasts.find((t) => t.message === message);
    expect(toast?.action?.label).toBe('Copy text');
    await act(async () => {
      toast?.action?.onAction();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('Edited offline');
  });

  it('leaves every other refusal to the shell', async () => {
    await mount();
    expect(
      actions().reportQueuedRejection({ op: 'comment.resolve', input: { comment: MINE }, message }),
    ).toBe(false);
    expect(
      actions().reportQueuedRejection({ op: 'comment.create', input: { issue: ISSUE_A }, message }),
    ).toBe(false);
    expect(toasts()).not.toContain(message);
  });
});

describe('drafts (SPEC-013 §3.1 item 6, SPEC-012 §3.2)', () => {
  const draft = (text: string) => ({
    id: '0192f0c1-7e5a-7b3c-9d4e-0000000000d1',
    userId: ME,
    kind: 'comment',
    teamId: null,
    issueId: ISSUE_A,
    data: { text: body(text) },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it("shows the issue's saved draft in the box", async () => {
    await mount({ drafts: [draft('Half written')] });
    expect(field('Comment')?.value).toBe('Half written');
  });

  it('saves the text 500 ms after the last change', async () => {
    await mount();
    await typeInto(field('Comment'), 'Draft text');
    expect(server().of('draft.save')).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(server().of('draft.save')).toMatchObject([
      { kind: 'comment', issueId: ISSUE_A, data: { text: docOfText('Draft text') } },
    ]);
  });

  it('saves the waiting text when the user leaves the page', async () => {
    await mount();
    await typeInto(field('Comment'), 'Leaving');
    expect(server().of('draft.save')).toEqual([]);
    await world?.unmount();
    expect(server().of('draft.save')).toMatchObject([{ data: { text: docOfText('Leaving') } }]);
    world = undefined;
  });

  it('saves the waiting text when the page closes', async () => {
    await mount();
    await typeInto(field('Comment'), 'Closing');
    await inAct(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(server().of('draft.save')).toHaveLength(1);
  });

  it('discards a draft older than 30 days from an effect, never by reading it', async () => {
    const old = { ...draft('Ancient'), updatedAt: '2026-01-01T00:00:00.000Z' };
    await mount({ drafts: [old] });
    expect(field('Comment')?.value).toBe('');
    expect(server().of('draft.discard')).toEqual([{ kind: 'comment', issueId: ISSUE_A }]);
  });
});

describe('reply (AC-19, §3.2)', () => {
  it("opens the thread's reply box with R and sends with Mod+Enter, with no draft row", async () => {
    await mount();
    await focusCard(THREAD);
    await keydown(card(THREAD) as Element, 'r', { code: 'KeyR' });
    const box = field('Reply');
    expect(box).not.toBeNull();

    await typeInto(box, 'Thanks');
    await modEnter(box as Element);
    expect(server().of('comment.create')).toMatchObject([
      { issue: ISSUE_A, parent: THREAD, body: docOfText('Thanks') },
    ]);
    expect(
      server()
        .dispatched.map((entry) => entry.op)
        .filter((op) => op.startsWith('draft.')),
    ).toEqual([]);
    // The reply box folds back to one line.
    expect(field('Reply')).toBeNull();
  });

  it('opens from the reply button, and from a reply replies to its thread (INV-19)', async () => {
    await mount();
    await inAct(() => button('Reply', card(REPLY) as ParentNode)?.click());
    await typeInto(field('Reply'), 'Same thread');
    await inAct(() =>
      button('Reply', host().querySelector('[data-testid="composer-box"]') as ParentNode)?.click(),
    );
    expect(server().of('comment.create')).toMatchObject([{ parent: THREAD }]);
  });

  it('sends with Enter, as the editor does in comment mode', async () => {
    await mount();
    await inAct(() => button('Leave a reply…')?.click());
    await typeInto(field('Reply'), 'Enter sends');
    await keydown(field('Reply') as Element, 'Enter');
    expect(server().of('comment.create')).toHaveLength(1);
  });

  it('puts a refused reply back in its box (E2, E15, E17)', async () => {
    await mount();
    server().refusals.set(
      'comment.create',
      'That comment was deleted. Comment on the issue instead.',
    );
    await focusCard(THREAD);
    await keydown(card(THREAD) as Element, 'r', { code: 'KeyR' });
    await typeInto(field('Reply'), 'Too late');
    await modEnter(field('Reply') as Element);
    expect(field('Reply')?.value).toBe('Too late');
    expect(toasts()).toContain('That comment was deleted. Comment on the issue instead.');
  });
});

const CHECKLIST = {
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] },
      ],
    },
  ],
};

describe('edit (AC-19, E3, E22)', () => {
  it('edits in place, disables Save while unchanged and saves with Mod+Enter from the version it started from', async () => {
    await mount();
    await focusCard(MINE);
    await invoke('comment:edit');
    const box = field('Edit comment');
    expect(box?.value).toBe('My own comment');
    expect(button('Save')?.hasAttribute('disabled')).toBe(true);

    await typeInto(box, 'My own comment, edited');
    expect(button('Save')?.hasAttribute('disabled')).toBe(false);
    await modEnter(box as Element);
    expect(server().of('comment.update')).toMatchObject([
      { comment: MINE, baseVersion: 3, body: docOfText('My own comment, edited') },
    ]);
    expect(field('Edit comment')).toBeNull();
    expect(card(MINE)?.textContent).toContain('edited');
  });

  it('keeps the text in the editor and shows the message when the comment changed meanwhile (E3)', async () => {
    await mount();
    const message =
      'This comment changed since you started editing. Copy your text, then edit it again.';
    server().refusals.set('comment.update', message);
    await focusCard(MINE);
    await invoke('comment:edit');
    await typeInto(field('Edit comment'), 'My text');
    await modEnter(field('Edit comment') as Element);

    expect(field('Edit comment')?.value).toBe('My text');
    expect(card(MINE)?.querySelector('[role="alert"]')?.textContent).toBe(message);
    // Once: the card shows it, so there is no toast as well.
    expect(toasts()).not.toContain(message);
  });

  it('offers Copy text in a toast when the card is gone by the time the edit is refused', async () => {
    await mount();
    const message = 'ENG-42 is archived. Restore it to edit it.';
    server().refusals.set('comment.update', message);
    await focusCard(MINE);
    await invoke('comment:edit');
    await typeInto(field('Edit comment'), 'Text I must not lose');
    server().holding = true;
    await modEnter(field('Edit comment') as Element);
    // The thread is resolved while the edit is on its way: the card collapses.
    await focusCard(MINE);
    await invoke('comment:resolve');
    expect(card(MINE)).toBeNull();
    await act(async () => {
      server().release();
      await Promise.resolve();
    });

    expect(field('Edit comment')).toBeNull();
    const toast = overlayManager.getSnapshot().visibleToasts.find((t) => t.message === message);
    expect(toast?.action?.label).toBe('Copy text');
    await act(async () => {
      toast?.action?.onAction();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('Text I must not lose');
  });

  it('returns focus to the comment when the edit is saved or cancelled', async () => {
    await mount();
    await focusCard(MINE);
    await invoke('comment:edit');
    await typeInto(field('Edit comment'), 'Changed');
    await modEnter(field('Edit comment') as Element);
    expect(document.activeElement).toBe(card(MINE));

    await invoke('comment:edit');
    expect(field('Edit comment')).not.toBeNull();
    await inAct(() => button('Cancel', card(MINE) as HTMLElement)?.click());
    expect(field('Edit comment')).toBeNull();
    expect(document.activeElement).toBe(card(MINE));
  });

  it("leaves somebody else's checklist unticked (§4.4: the author's rule)", async () => {
    await mount({ comments: [commentRow(THREAD, { userId: IRIS, body: CHECKLIST })] });
    expect(
      host().querySelector<HTMLInputElement>('input[aria-label="Checklist item 0.0"]')?.disabled,
    ).toBe(true);
  });

  it('saves a checklist toggle of the author as an edit from the version it showed', async () => {
    const list = CHECKLIST;
    await mount({ comments: [commentRow(MINE, { userId: ME, body: list, version: 3 })] });
    const second = host().querySelector<HTMLInputElement>('input[aria-label="Checklist item 0.1"]');
    await inAct(() => second?.click());
    expect(server().of('comment.update')).toMatchObject([
      {
        comment: MINE,
        baseVersion: 3,
        body: {
          content: [
            {
              type: 'taskList',
              content: [{ attrs: { checked: false } }, { attrs: { checked: true } }],
            },
          ],
        },
      },
    ]);
  });

  it('cancels an unchanged edit with Esc, and asks before throwing a change away', async () => {
    await mount();
    await focusCard(MINE);
    await invoke('comment:edit');
    await keydown(field('Edit comment') as Element, 'Escape');
    expect(field('Edit comment')).toBeNull();

    await invoke('comment:edit');
    await typeInto(field('Edit comment'), 'Changed');
    await keydown(field('Edit comment') as Element, 'Escape');
    expect(document.body.textContent).toContain('Discard changes?');
    expect(field('Edit comment')?.value).toBe('Changed');
  });

  it('only the author can edit; an Admin or the author can delete (§5.2)', async () => {
    await mount();
    await focusCard(THREAD);
    expect(world?.registry?.isAvailable('comment:edit')).toBe(false);
    expect(world?.registry?.isAvailable('comment:delete')).toBe(false);
    await focusCard(MINE);
    expect(world?.registry?.isAvailable('comment:edit')).toBe(true);
    expect(world?.registry?.isAvailable('comment:delete')).toBe(true);
  });

  it('asks before deleting, and deletes on confirm', async () => {
    await mount();
    await focusCard(MINE);
    await invoke('comment:delete');
    expect(document.body.textContent).toContain("Delete this comment? This can't be undone.");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    await inAct(() => button('Delete', dialog as ParentNode)?.click());
    expect(server().of('comment.delete')).toEqual([{ comment: MINE }]);
    expect(card(MINE)).toBeNull();
  });
});

describe('resolve and collapse (AC-21, §3.3a, E26)', () => {
  it('shows a resolved thread as one line with the first line of its text, who resolved it and Reopen', async () => {
    await mount();
    expect(card(RESOLVED)).toBeNull();
    const text = host().textContent;
    expect(text).toContain('Old question about caching');
    expect(text).toContain('Resolved by Ada');
    expect(button('Reopen')).toBeDefined();
  });

  it('expands with the chevron to the replies and the reply box, and collapses again', async () => {
    await mount();
    await inAct(() => button('Expand resolved thread')?.click());
    expect(card(RESOLVED)).not.toBeNull();
    expect(card(RESOLVED_REPLY)).not.toBeNull();
    expect(button('Leave a reply…')).toBeDefined();
    await inAct(() => button('Collapse resolved thread')?.click());
    expect(card(RESOLVED)).toBeNull();
  });

  it('reopens from the line', async () => {
    await mount();
    await inAct(() => button('Reopen')?.click());
    expect(server().of('comment.reopen')).toEqual([{ comment: RESOLVED }]);
    expect(card(RESOLVED)).not.toBeNull();
    expect(button('Reopen')).toBeUndefined();
  });

  it('resolves the whole thread from a reply, and the thread collapses', async () => {
    await mount();
    await focusCard(REPLY);
    await invoke('comment:resolve');
    expect(server().of('comment.resolve')).toEqual([{ comment: THREAD }]);
    expect(card(THREAD)).toBeNull();
    expect(host().textContent).toContain('Does this happen on Safari?');
  });

  it('reopening is offered for a resolved thread, resolving for an open one', async () => {
    await mount();
    await focusCard(THREAD);
    expect(world?.registry?.isAvailable('comment:resolve')).toBe(true);
    expect(world?.registry?.isAvailable('comment:reopen')).toBe(false);
    await inAct(() => button('Expand resolved thread')?.click());
    await focusCard(RESOLVED);
    expect(world?.registry?.isAvailable('comment:resolve')).toBe(false);
    expect(world?.registry?.isAvailable('comment:reopen')).toBe(true);
  });

  it("copies only the comment's own text as Markdown from a resolved thread (E26)", async () => {
    await mount();
    await inAct(() => button('Expand resolved thread')?.click());
    await focusCard(RESOLVED);
    await invoke('comment:copy-markdown');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('Old question about caching');
  });
});

describe('comment links and the command target (§7)', () => {
  it('copies /issue/ENG-42#comment-<id>', async () => {
    await mount();
    await focusCard(THREAD);
    await invoke('comment:copy-link');
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/issue/ENG-42#comment-${THREAD}`,
    );
  });

  it('highlights the linked comment for 2 s', async () => {
    await mount({ hash: `comment-${MINE}` });
    expect(card(MINE)?.getAttribute('data-highlight')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(card(MINE)?.getAttribute('data-highlight')).toBe('false');
  });

  it('opens a collapsed thread that a link points into', async () => {
    await mount({ hash: `comment-${RESOLVED_REPLY}` });
    expect(card(RESOLVED_REPLY)?.getAttribute('data-highlight')).toBe('true');
  });

  it('just shows the issue for a link to a comment that is gone', async () => {
    await mount({ hash: 'comment-0192f0c1-7e5a-7b3c-9d4e-0000000009ff' });
    expect(host().querySelector('[data-highlight="true"]')).toBeNull();
  });

  it('makes a focused comment the command target, and lets it go when focus leaves', async () => {
    await mount();
    await focusCard(THREAD);
    expect(world?.targets.current()).toMatchObject({ kind: 'comment', ids: [THREAD] });
    await inAct(() => {
      card(THREAD)?.blur();
    });
    expect(world?.targets.current().kind).toBe('global');
  });
});

describe('reactions (SPEC-013 §3.4, S4 hand-off)', () => {
  const reactions = [
    reactionRow(uuidOf(11), '👍', IRIS, null),
    reactionRow(uuidOf(12), '🎉', IRIS, THREAD),
    reactionRow(uuidOf(13), '🎉', ME, THREAD),
  ];

  it("shows the issue's chips and toggles the viewer's reaction on it", async () => {
    await mount({ reactions });
    const chip = button('Thumbs up, 1 reaction');
    expect(chip?.getAttribute('aria-pressed')).toBe('false');
    await inAct(() => chip?.click());
    expect(server().of('reaction.set')).toEqual([{ issue: ISSUE_A, emoji: '👍', reacted: true }]);
    expect(button('Thumbs up, 2 reactions, including you')).toBeDefined();
  });

  it("shows a comment's chips, pressed when they include the viewer, and clears the reaction", async () => {
    await mount({ reactions });
    const chip = button('Party popper, 2 reactions, including you', card(THREAD) as ParentNode);
    expect(chip?.getAttribute('aria-pressed')).toBe('true');
    await inAct(() => chip?.click());
    expect(server().of('reaction.set')).toEqual([{ comment: THREAD, emoji: '🎉', reacted: false }]);
  });

  it('rolls a refused reaction back and says why (the 20-emoji cap)', async () => {
    await mount({ reactions });
    const message = 'You can add at most 20 different reactions here.';
    server().refusals.set('reaction.set', message);
    await inAct(() => button('Thumbs up, 1 reaction')?.click());
    expect(toasts()).toContain(message);
    expect(button('Thumbs up, 1 reaction')).toBeDefined();
  });

  it('opens the issue\'s picker for "Add reaction…" with the issue as the target', async () => {
    await mount();
    const handle = world?.targets.push({ kind: 'issue', ids: [ISSUE_A], label: 'ENG-42' }, 'page');
    await invoke('reaction:add');
    expect(document.querySelector('[aria-label="Add reaction"][role="dialog"]')).not.toBeNull();
    handle?.remove();
  });

  it('opens the focused comment\'s picker for "Add reaction…" with a comment as the target', async () => {
    await mount();
    await focusCard(THREAD);
    await invoke('reaction:add');
    expect(document.querySelectorAll('[aria-label="Add reaction"][role="dialog"]')).toHaveLength(1);
  });
});

describe('attachments (SPEC-013 §3.1, PLAN-014 S5)', () => {
  it('says "Attachments are not available yet." until uploads exist', async () => {
    await mount();
    await inAct(() => button('Attach file')?.click());
    expect(toasts()).toContain('Attachments are not available yet.');
  });
});

describe('the seed', () => {
  it('has the rows the tests rely on', () => {
    expect(seedComments().map((row) => row['id'])).toEqual([
      THREAD,
      REPLY,
      RESOLVED,
      RESOLVED_REPLY,
      MINE,
    ]);
  });
});
