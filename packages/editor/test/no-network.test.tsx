// @vitest-environment jsdom
// PLAN-013 S2: the editor and DocView make no outbound request (SPEC-013 AC-16, first half; rule 5).
// The picker is S4's, in packages/ui. The lint ban on CDN emoji libraries is `emoji-lint.test.ts`.
import type { DocNodeJSON } from '@surface/domain';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocView } from '../src/DocView.js';
import { RichTextEditor } from '../src/RichTextEditor.js';
import './support/layout.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const FILE = '/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
});

const DOC: DocNodeJSON = {
  type: 'doc',
  content: [
    { type: 'image', attrs: { src: FILE, alt: 'shot' } },
    { type: 'paragraph', content: [{ type: 'file', attrs: { src: FILE, name: 'spec.pdf' } }] },
    { type: 'codeBlock', attrs: { language: 'typescript' }, content: [text('const a = 1;')] },
    {
      type: 'paragraph',
      content: [
        text('docs', [{ type: 'link', attrs: { href: 'https://example.com/docs' } }]),
        text(' and :thum'),
      ],
    },
  ],
};

const calls: string[] = [];
const added: string[] = [];
let root: Root | null = null;
let observer: MutationObserver | null = null;
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
          /^(LINK|SCRIPT|IFRAME|OBJECT|EMBED|SOURCE)$/.test(node.tagName)
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

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
  return container;
}

describe('the editor and DocView make no outbound request (AC-16)', () => {
  it('renders DocView with images, files, links and code without a request', async () => {
    await mount(createElement(DocView, { doc: DOC, onToggle: vi.fn() }));
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
    // The only cross-origin thing is the link the user can click: never loaded by the page.
    expect(crossOriginTargets()).toEqual(['https://example.com/docs']);
  });

  it('runs the editor through typing, the emoji list, a link and an external image paste', async () => {
    const view = await mount(
      createElement(RichTextEditor, { mode: 'description', value: DOC, autofocus: 'end' }),
    );
    // The emoji data loads lazily from the bundle, not from a URL.
    const deadline = Date.now() + 5000;
    while (view.querySelector('[role="listbox"]') === null) {
      if (Date.now() > deadline) throw new Error('the emoji list never opened');
      await act(async () => {
        await Promise.resolve();
      });
    }
    const content = view.querySelector('[role="textbox"]');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    const html =
      '<img src="https://tracker.example/pixel.gif" alt="logo"><script src="https://evil.example/x.js"></script><link rel="stylesheet" href="https://cdn.example/x.css">';
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/html' ? html : ''), files: [] },
    });
    await act(async () => {
      content?.dispatchEvent(paste);
      await Promise.resolve();
    });
    expect(calls).toEqual([]);
    expect(added).toEqual([]);
    expect(document.querySelector('img[src^="https://tracker"]')).toBeNull();
    // A pasted external image became a link (not loaded); only links point off this origin.
    expect(crossOriginTargets().every((target) => view.querySelector(`a[href="${target}"]`))).toBe(
      true,
    );
  });

  it('adds no stylesheet or style element of its own (injectCSS is off, so the CSP holds)', async () => {
    const before = document.querySelectorAll('style, link[rel="stylesheet"]').length;
    await mount(createElement(RichTextEditor, { mode: 'comment', value: DOC }));
    expect(document.querySelectorAll('style, link[rel="stylesheet"]').length).toBe(before);
  });
});
