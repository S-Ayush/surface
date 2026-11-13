// @vitest-environment jsdom
// PLAN-013 S2: the editor against the real shortcut engine (SPEC-013 §3.5 "Enter", AC-19, AC-24,
// E23, E24). It lives in apps/web because the engine does, and `editor` may not import `web`.
import type { DocNodeJSON } from '@surface/domain';
import { RichTextEditor } from '@surface/editor';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutEngine } from './shortcuts/engine.js';
import { SHORTCUTS } from './shortcuts/registry.js';
import type { CommandId } from './commands/catalog.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/** jsdom does no layout: ProseMirror's scrollIntoView and coordinate lookups need these. */
function stubLayout(): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  const empty = (): DOMRect => ({ ...rect, toJSON: () => rect });
  const none = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = empty;
  Element.prototype.getClientRects = () => none;
}
stubLayout();

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (value?: string): DocNodeJSON =>
  value === undefined ? { type: 'paragraph' } : { type: 'paragraph', content: [text(value)] };
const doc = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });

const TASK = doc({
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph('todo')] }],
});
const BULLETS = doc({
  type: 'bulletList',
  content: [{ type: 'listItem', content: [paragraph('item')] }],
});
const CODE = doc({ type: 'codeBlock', content: [text('x')] });

interface Mounted {
  readonly box: HTMLElement;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly changes: DocNodeJSON[];
  /** `defaultPrevented` of each Mod+Enter / Enter as the engine saw it. */
  readonly seen: boolean[];
  readonly ran: CommandId[];
  readonly content: HTMLElement;
}

let root: Root | null = null;
let disposers: (() => void)[] = [];

beforeEach(() => {
  disposers = [];
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  for (const dispose of disposers) dispose();
});

async function mount(
  mode: 'comment' | 'description',
  value: DocNodeJSON,
  scope: 'comment' | 'issue-page',
  autofocus: 'start' | 'end' = 'start',
): Promise<Mounted> {
  const box = document.createElement('div');
  // The scope a comment box or the issue page sets (SPEC-012 §3.6).
  box.setAttribute('data-shortcut-scope', scope);
  document.body.append(box);
  disposers.push(() => {
    box.remove();
  });
  const submit = vi.fn();
  const changes: DocNodeJSON[] = [];
  const seen: boolean[] = [];
  const ran: CommandId[] = [];

  const engine = new ShortcutEngine({
    platform: 'other',
    bindings: SHORTCUTS,
    commands: {
      isAvailable: () => true,
      run: (id) => {
        ran.push(id);
        return true;
      },
    },
    overlay: { topLayer: () => undefined, isOverlayEscape: () => false },
    pageScopes: () => ['issue-page'],
    hints: { sequence: () => undefined, unavailable: () => undefined, clear: () => undefined },
  });
  // Registered first: records what the engine will see.
  const record = (event: KeyboardEvent) => {
    if (event.key === 'Enter') seen.push(event.defaultPrevented);
  };
  const onKey = (event: KeyboardEvent) => engine.handleKeydown(event);
  document.addEventListener('keydown', record);
  document.addEventListener('keydown', onKey);
  disposers.push(() => {
    document.removeEventListener('keydown', record);
    document.removeEventListener('keydown', onKey);
  });

  root = createRoot(box);
  await act(async () => {
    root?.render(
      createElement(RichTextEditor, {
        mode,
        value,
        autofocus,
        onSubmit: submit,
        onChange: (next) => changes.push(next),
      }),
    );
    await Promise.resolve();
  });
  const content = box.querySelector<HTMLElement>('[role="textbox"]');
  if (content === null) throw new Error('the editor did not render');
  return { box, submit, changes, seen, ran, content };
}

async function press(
  target: HTMLElement,
  init: KeyboardEventInit & { key: string },
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('Mod+Enter reaches the shortcut engine (AC-19)', () => {
  it('in comment mode, outside a checklist: defaultPrevented stays false and the engine sends', async () => {
    const m = await mount('comment', doc(paragraph('hi')), 'comment');
    await press(m.content, { key: 'Enter', ctrlKey: true });
    expect(m.seen).toEqual([false]);
    expect(m.ran).toEqual(['comment:send']);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('in description mode, outside a checklist: the engine saves the description', async () => {
    const m = await mount('description', doc(paragraph('hi')), 'issue-page');
    await press(m.content, { key: 'Enter', ctrlKey: true });
    expect(m.seen).toEqual([false]);
    expect(m.ran).toEqual(['issue-page:save-description']);
  });

  it.each([
    ['a list', BULLETS],
    ['a code block', CODE],
  ])('inside %s: the engine still gets it, so it sends (E23)', async (_name, value) => {
    const m = await mount('comment', value, 'comment');
    await press(m.content, { key: 'Enter', ctrlKey: true });
    expect(m.seen).toEqual([false]);
    expect(m.ran).toEqual(['comment:send']);
  });

  it('in a checklist item: the editor toggles the item and the engine never sees it', async () => {
    const m = await mount('comment', TASK, 'comment');
    const event = await press(m.content, { key: 'Enter', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(m.seen).toEqual([true]);
    expect(m.ran).toEqual([]);
    expect(m.changes.at(-1)?.content?.[0]?.content?.[0]?.attrs).toEqual({ checked: true });
  });
});

describe('Enter in a comment box (AC-24)', () => {
  it('sends on a plain Enter', async () => {
    const m = await mount('comment', doc(paragraph('hi')), 'comment');
    await press(m.content, { key: 'Enter' });
    expect(m.submit).toHaveBeenCalledOnce();
    expect(m.ran).toEqual([]);
  });

  it('does not send while an IME composition is open (E24)', async () => {
    const m = await mount('comment', doc(paragraph('hi')), 'comment');
    await act(async () => {
      m.content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      await Promise.resolve();
    });
    await press(m.content, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(m.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['a list', BULLETS],
    ['a checklist', TASK],
    ['a code block', CODE],
    ['a block quote', doc({ type: 'blockquote', content: [paragraph('q')] })],
  ])('keeps its editing meaning inside %s', async (_name, value) => {
    const m = await mount('comment', value, 'comment');
    await press(m.content, { key: 'Enter' });
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('picks the emoji instead of sending while the emoji list is open', async () => {
    const m = await mount('comment', doc(paragraph(':thum')), 'comment', 'end');
    const deadline = Date.now() + 5000;
    while (m.box.querySelector('[role="listbox"]') === null) {
      if (Date.now() > deadline) throw new Error('the emoji list never opened');
      await act(async () => {
        await Promise.resolve();
      });
    }
    await press(m.content, { key: 'Enter' });
    expect(m.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(m.changes.at(-1))).toContain('👍');
  });

  it('breaks the line on Shift+Enter', async () => {
    const m = await mount('comment', doc(paragraph('hi')), 'comment');
    await press(m.content, { key: 'Enter', shiftKey: true });
    expect(m.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(m.changes.at(-1))).toContain('hardBreak');
  });
});

describe('Enter in a description', () => {
  it('starts a new paragraph and never sends', async () => {
    const m = await mount('description', doc(paragraph('hi')), 'issue-page');
    await press(m.content, { key: 'Enter' });
    expect(m.submit).not.toHaveBeenCalled();
    expect(m.changes.at(-1)?.content).toHaveLength(2);
  });
});
