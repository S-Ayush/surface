/**
 * @vitest-environment jsdom
 */
// PLAN-012 S7a (SPEC-012 §7.3, AC-20): the mounted issue page at three window widths. At 375 px the
// properties are in the text column under the title (no aside, no drawer button); at 1000 px they
// are a drawer opened from the header; from 1280 px they are beside the text. Narrowing drops an
// open drawer.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import {
  FakeApp,
  ISSUE_A,
  inAct,
  installDomShims,
  issueRow,
  mountIssuePage,
  type Mounted,
} from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(installDomShims);

const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
type Listener = () => void;
const listeners = new Set<Listener>();
let width = 1400;

/** A `matchMedia` that follows `width` and tells its listeners when it changes. */
function install(initial: number): void {
  width = initial;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      const limit = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity);
      return {
        get matches() {
          return width <= limit;
        },
        media: query,
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      };
    },
  });
}

async function resize(next: number): Promise<void> {
  width = next;
  await act(async () => {
    for (const listener of [...listeners]) listener();
    await Promise.resolve();
  });
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  listeners.clear();
  if (original !== undefined) Object.defineProperty(window, 'matchMedia', original);
});

async function open(at: number): Promise<void> {
  install(at);
  mounted = await mountIssuePage({
    app: new FakeApp({ issues: [issueRow(ISSUE_A, 41)] }),
    ref: 'ENG-41',
  });
}

const article = () => document.querySelector('article');
const aside = () => document.querySelector('aside');
const panel = () => document.querySelector('section[aria-label="Properties"]');
const drawerButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Properties"]');

describe('the issue page at 375 px', () => {
  it('puts the properties in the text column, with no aside and no drawer button', async () => {
    await open(375);
    expect(article()?.contains(panel() ?? null)).toBe(true);
    expect(aside()).toBeNull();
    expect(drawerButton()).toBeNull();
    // Still editable: the pills are buttons.
    expect(
      [...(panel()?.querySelectorAll('button') ?? [])].some((b) =>
        b.textContent.startsWith('Status:'),
      ),
    ).toBe(true);
  });
});

describe('the issue page at 1000 px', () => {
  it('has the properties in a drawer that the header button opens and closes', async () => {
    await open(1000);
    expect(panel()).toBeNull();
    expect(drawerButton()?.getAttribute('aria-expanded')).toBe('false');
    await inAct(() => drawerButton()?.click());
    expect(aside()?.contains(panel() ?? null)).toBe(true);
    expect(article()?.contains(panel() ?? null)).toBe(false);
    expect(drawerButton()?.getAttribute('aria-expanded')).toBe('true');
    await inAct(() => drawerButton()?.click());
    expect(panel()).toBeNull();
  });

  it('drops an open drawer when the window narrows, and does not bring it back when it widens', async () => {
    await open(1000);
    await inAct(() => drawerButton()?.click());
    expect(aside()).not.toBeNull();
    await resize(375);
    expect(aside()).toBeNull();
    expect(drawerButton()).toBeNull();
    expect(article()?.contains(panel() ?? null)).toBe(true);
    await resize(1000);
    expect(aside()).toBeNull();
    expect(panel()).toBeNull();
    expect(drawerButton()?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the issue page at 1400 px', () => {
  it('has the properties beside the text, with no drawer button', async () => {
    await open(1400);
    expect(aside()?.contains(panel() ?? null)).toBe(true);
    expect(drawerButton()).toBeNull();
  });
});
