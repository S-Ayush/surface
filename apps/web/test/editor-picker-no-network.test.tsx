// @vitest-environment jsdom
// PLAN-013 S4: the comment editor and the reaction row's EmojiPicker, wired to the editor's real
// lazy emoji data (`loadEmoji` from `@surface/editor`, the bundled `emojibase-data` JSON) as the
// app mounts them, make no cross-origin request (SPEC-013 AC-16, combined check; CLAUDE.md rule
// 5). `apps/web` may import both packages; `ui` and `editor` may not import each other. The
// picker alone, with fake data, is `packages/ui/test/emoji-picker-no-network.test.tsx`.
import type { DocNodeJSON } from '@surface/domain';
import { loadEmoji, RichTextEditor } from '@surface/editor';
import { ReactionRow, TooltipProvider } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/** jsdom does no layout: ProseMirror's scrolling and coordinate lookups need these. */
const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
const noRects = Object.assign([], { item: () => null });
Range.prototype.getClientRects = () => noRects;
Range.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect });
Element.prototype.getClientRects = () => noRects;

const DOC: DocNodeJSON = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it :rock' }] }],
};

const calls: string[] = [];
const added: string[] = [];
let observer: MutationObserver | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  calls.length = 0;
  added.length = 0;
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push(`${name}(${args.map(String).join(', ')})`);
      return Promise.reject(new Error('no network in tests'));
    });
  vi.stubGlobal('fetch', record('fetch'));
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      open(...args: unknown[]) {
        calls.push(`XMLHttpRequest.open(${args.map(String).join(', ')})`);
      }
      send() {
        calls.push('XMLHttpRequest.send');
      }
    },
  );
  vi.stubGlobal('WebSocket', record('WebSocket'));
  vi.stubGlobal('EventSource', record('EventSource'));
  Object.defineProperty(navigator, 'sendBeacon', {
    value: record('sendBeacon'),
    configurable: true,
  });
  observer = new MutationObserver((records) => {
    for (const mutation of records) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLElement &&
          /^(LINK|SCRIPT|IFRAME|OBJECT|EMBED|SOURCE|IMG)$/.test(node.tagName)
        ) {
          added.push(node.outerHTML);
        }
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  observer?.disconnect();
  vi.unstubAllGlobals();
});

/** Every URL the page points at that is not on this origin. */
function crossOriginTargets(): string[] {
  return [...document.querySelectorAll('[src], [href], [srcset], [data], [poster]')]
    .flatMap((element) =>
      ['src', 'href', 'poster', 'data'].map((name) => element.getAttribute(name) ?? ''),
    )
    .filter((value) => value !== '' && new URL(value, document.baseURI).origin !== location.origin);
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('the editor and the EmojiPicker on the real emoji data make no request (AC-16)', () => {
  it('renders both, opens the picker, searches and picks, without a request', async () => {
    const onReact = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <RichTextEditor mode="comment" value={DOC} autofocus="end" />
          <ReactionRow
            reactions={[{ emoji: '👍', count: 1, mine: false, label: 'thumbs up' }]}
            onReact={onReact}
            loadEmoji={loadEmoji}
            pickerOpen
          />
        </TooltipProvider>,
      );
      await Promise.resolve();
    });
    // The picker's grid fills from the bundled data, not from a URL.
    await until(
      () => document.querySelector('[role="dialog"] [role="option"]') !== null,
      'the emoji grid',
    );
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (field === null) throw new Error('no picker search field');
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', 'rocket', field);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onReact).toHaveBeenCalledWith('🚀', true);
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
    expect(crossOriginTargets()).toEqual([]);
  });
});
