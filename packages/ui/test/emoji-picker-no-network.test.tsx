// @vitest-environment jsdom
// PLAN-013 S4: the EmojiPicker and the reaction row make no request at all (SPEC-013 AC-16 for the
// picker; CLAUDE.md rule 5): rendered open with a fake `loadEmoji`, searched, browsed and used to
// pick, with `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` and new `link`,
// `script`, `img` and the like instrumented, as the editor's `no-network.test.tsx` does. The
// combined check with the real bundled data is `apps/web/test/editor-picker-no-network.test.tsx`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from '../src/components/EmojiPicker/EmojiPicker.js';
import type { PickerEmoji } from '../src/components/EmojiPicker/model.js';
import { ReactionBar } from '../src/components/ReactionChips/ReactionChips.js';
import { TooltipProvider } from '../src/components/Tooltip/Tooltip.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const DATA: readonly PickerEmoji[] = [
  { unicode: '👍', label: 'thumbs up', shortcodes: ['thumbsup'], group: 1 },
  { unicode: '🎉', label: 'party popper', shortcodes: ['tada'], group: 6 },
  { unicode: '🇫🇷', label: 'flag: France', shortcodes: ['flag_fr'], group: 9 },
];

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
          /^(LINK|SCRIPT|IFRAME|OBJECT|EMBED|SOURCE|IMG|VIDEO|AUDIO)$/.test(node.tagName)
        ) {
          added.push(node.outerHTML);
        }
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  observer?.disconnect();
  vi.unstubAllGlobals();
});

/** Every URL the page points at, of any origin: the picker has no reason to name one. */
function urls(): string[] {
  return [...document.querySelectorAll('[src], [href], [srcset], [data], [poster]')].map(
    (element) => element.outerHTML,
  );
}

async function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TooltipProvider>{element}</TooltipProvider>);
    await Promise.resolve();
  });
}

function key(name: string) {
  const input = document.querySelector('input');
  act(() => {
    input?.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

describe('the EmojiPicker makes no request (AC-16)', () => {
  it('renders, browses, searches and picks without one', async () => {
    const loadEmoji = vi.fn(() => Promise.resolve(DATA));
    const onSelect = vi.fn();
    await mount(<EmojiPicker loadEmoji={loadEmoji} onSelect={onSelect} />);
    key('ArrowDown');
    key('ArrowRight');
    const input = document.querySelector('input');
    act(() => {
      if (input !== null) Reflect.set(HTMLInputElement.prototype, 'value', 'tada', input);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith('🎉');
    expect(loadEmoji).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
    expect(urls()).toEqual([]);
  });

  it('renders the reaction row with its picker open without one', async () => {
    await mount(
      <ReactionBar
        reactions={[
          { emoji: '👍', count: 2, mine: true, label: 'thumbs up', people: ['You', 'Ada'] },
        ]}
        onReact={vi.fn()}
        loadEmoji={() => Promise.resolve(DATA)}
        pickerOpen
      />,
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
    expect(urls()).toEqual([]);
  });
});
