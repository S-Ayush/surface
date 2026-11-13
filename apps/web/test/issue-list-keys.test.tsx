/**
 * @vitest-environment jsdom
 */
// PLAN-012 S3 (SPEC-012 §3.6, AC-4 keys): the real shortcut engine with the registry's M1 bindings
// drives the mounted list: `J`/`K`, `T`, `Alt+T` act in the `list` scope and never fire while
// focus is in a text field. (The provider drops M1 bindings until a slice raises BUILD_MILESTONE,
// so the test builds the engine itself, over the same command registry the page registers into.)
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutEngine } from '../src/shortcuts/engine.js';
import { SHORTCUTS } from '../src/shortcuts/registry.js';
import { ENG_DOING, ENG_TODO } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted } from './issue-list-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

let mounted: Mounted | undefined;
let engine: ShortcutEngine | undefined;
let listener: ((event: KeyboardEvent) => void) | undefined;
afterEach(async () => {
  if (listener !== undefined) document.removeEventListener('keydown', listener);
  engine?.dispose();
  await mounted?.unmount();
  mounted = undefined;
  localStorage.clear();
});

function startEngine(m: Mounted): void {
  engine = new ShortcutEngine({
    platform: 'mac',
    bindings: SHORTCUTS,
    commands: m.commands(),
    overlay: { topLayer: () => undefined, isOverlayEscape: () => false },
    pageScopes: () => [],
    hints: { sequence: vi.fn(), unavailable: vi.fn(), clear: vi.fn() },
  });
  const current = engine;
  listener = (event) => {
    current.handleKeydown(event);
  };
  document.addEventListener('keydown', listener);
}

async function inAct(change: () => unknown): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

async function press(
  target: Element,
  init: { key: string; code: string; altKey?: boolean },
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

const a = issue({ title: 'Alpha', number: 1, statusId: ENG_TODO, priority: 1 });
const b = issue({ title: 'Bravo', number: 2, statusId: ENG_TODO, priority: 2 });
const d = issue({ title: 'Delta', number: 3, statusId: ENG_DOING });

describe('list keys through the engine', () => {
  it('J and K move focus, and T collapses the focused group header', async () => {
    mounted = await mountLists(new IssueApp([a, b, d]), '/team/ENG/issues');
    startEngine(mounted);
    const header = mounted.host.querySelector<HTMLElement>('[role="row"]');
    await inAct(() => header?.focus());
    await press(document.activeElement ?? document.body, { key: 'j', code: 'KeyJ' });
    expect(document.activeElement?.textContent).toContain('Alpha');
    await press(document.activeElement ?? document.body, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Bravo');
    await press(document.activeElement ?? document.body, { key: 'k', code: 'KeyK' });
    expect(document.activeElement?.textContent).toContain('Alpha');
    await press(document.activeElement ?? document.body, { key: 'k', code: 'KeyK' });
    await press(document.activeElement ?? document.body, { key: 't', code: 'KeyT' });
    expect(mounted.host.textContent).not.toContain('Alpha');
  });

  it('Alt+T collapses every group', async () => {
    mounted = await mountLists(new IssueApp([a, d]), '/team/ENG/issues');
    startEngine(mounted);
    await inAct(() => mounted?.host.querySelector<HTMLElement>('[role="row"]')?.focus());
    await press(document.activeElement ?? document.body, { key: 't', code: 'KeyT', altKey: true });
    expect(mounted.host.textContent).not.toContain('Alpha');
    expect(mounted.host.textContent).not.toContain('Delta');
  });

  it('does not fire J, K or T while focus is in a text field', async () => {
    mounted = await mountLists(new IssueApp([a, b]), '/team/ENG/issues');
    startEngine(mounted);
    // A text field inside the list's scope (a future inline editor, a picker's search).
    const grid = mounted.host.querySelector('[data-shortcut-scope="list"]');
    const input = document.createElement('input');
    grid?.append(input);
    await inAct(() => mounted?.host.querySelector<HTMLElement>('[role="row"]')?.focus());
    await inAct(() => input.focus());
    await press(input, { key: 'j', code: 'KeyJ' });
    await press(input, { key: 't', code: 'KeyT' });
    expect(document.activeElement).toBe(input);
    expect(mounted.host.textContent).toContain('Alpha');
  });
});

describe('navigation keys (G E, G M, Ctrl+Shift+n)', () => {
  const here = (m: Mounted) =>
    m.host.querySelector('[role="treegrid"]')?.getAttribute('aria-label');

  it('G E opens the first team’s issues from a page with no team, then stays on the route’s team', async () => {
    mounted = await mountLists(new IssueApp([a]), '/my-issues');
    await inAct(() => mounted?.commands().run('nav:team-issues'));
    // Teams sort by name, so Design is first; it has no issues here.
    expect(mounted.host.textContent).toContain('No issues in DES yet');
    await mounted.navigate('/team/ENG/issues');
    await inAct(() => mounted?.commands().run('nav:team-issues'));
    expect(here(mounted)).toBe('Issues in ENG');
  });

  it('Ctrl+Shift+2 opens the second team in the sidebar and does nothing past the last', async () => {
    mounted = await mountLists(new IssueApp([a, d]), '/my-issues');
    const registry = mounted.commands();
    expect(registry.isAvailable('nav:team-9')).toBe(false);
    expect(registry.isAvailable('nav:team-2')).toBe(true);
    await inAct(() => registry.run('nav:team-2'));
    // Teams sort by name: Design, Engineering.
    expect(here(mounted)).toBe('Issues in ENG');
  });

  it('G M opens the My issues tab used last', async () => {
    mounted = await mountLists(new IssueApp([a]), '/my-issues/created');
    await mounted.navigate('/team/ENG/issues');
    await inAct(() => mounted?.commands().run('nav:my-issues'));
    expect(
      mounted.host.querySelector('nav[aria-label="My issues views"] [aria-current="page"]')
        ?.textContent,
    ).toBe('Created');
    await mounted.navigate('/my-issues');
    await mounted.navigate('/team/ENG/issues');
    await inAct(() => mounted?.commands().run('nav:my-issues'));
    expect(
      mounted.host.querySelector('nav[aria-label="My issues views"] [aria-current="page"]')
        ?.textContent,
    ).toBe('Assigned');
  });
});
