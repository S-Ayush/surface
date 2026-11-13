/**
 * @vitest-environment jsdom
 */
// PLAN-012 S5 (SPEC-012 §3.1 item 1, §3.6): `C` opens the composer and `G` `D` goes to Drafts,
// through the real shortcut engine with the registry's M1 bindings (the provider drops M1 bindings
// until a slice raises BUILD_MILESTONE, so the test builds the engine itself, over the command
// registry the hosts register into, like `issue-list-keys.test.tsx`). `C` typed into a text field
// is text, and `C` with the composer open does nothing (E6). `Mod+Enter` submits through
// `dialog.submit` (an empty title says why), and `Esc` closes an open picker before the composer.
import { overlayManager } from '@surface/ui';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutEngine } from '../src/shortcuts/engine.js';
import { SHORTCUTS, inBuild } from '../src/shortcuts/registry.js';
import { TITLE_REQUIRED } from '../src/features/issues/Composer.js';
import { setValue } from './issue-fixtures.js';
import {
  ComposerApp,
  dialogNamed,
  mountComposer,
  titleInput,
  type Mounted,
} from './composer-harness.js';

let mounted: Mounted | undefined;
let engine: ShortcutEngine | undefined;
let listener: ((event: KeyboardEvent) => void) | undefined;
afterEach(() => {
  if (listener !== undefined) window.removeEventListener('keydown', listener, { capture: true });
  engine?.dispose();
  mounted?.unmount();
  mounted = undefined;
  overlayManager.clear();
  document.body.innerHTML = '';
});

function startEngine(m: Mounted): void {
  engine = new ShortcutEngine({
    platform: 'mac',
    bindings: inBuild(SHORTCUTS, 'M1'),
    commands: m.commands(),
    // The real overlay stack, so an open composer puts `dialog.submit` (modal scope) in reach.
    overlay: overlayManager,
    pageScopes: () => [],
    hints: { sequence: vi.fn(), unavailable: vi.fn(), clear: vi.fn() },
  });
  const current = engine;
  listener = (event) => {
    current.handleKeydown(event);
  };
  window.addEventListener('keydown', listener, { capture: true });
}

async function press(target: Element, key: string, code: string, metaKey = false): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code, metaKey }),
    );
    await Promise.resolve();
  });
}

const composer = () => dialogNamed('New issue');

describe('composer keys', () => {
  it('C opens the composer for the route’s team', async () => {
    mounted = await mountComposer(new ComposerApp(), '/team/DES/issues');
    startEngine(mounted);
    await press(document.body, 'c', 'KeyC');
    expect(dialogNamed('New issue')).toBeDefined();
    expect(dialogNamed('New issue')?.textContent).toContain('DES');
  });

  it('E6: C in the open composer types into the title and opens nothing more', async () => {
    mounted = await mountComposer(new ComposerApp(), '/team/ENG/issues');
    startEngine(mounted);
    await press(document.body, 'c', 'KeyC');
    await press(titleInput(), 'c', 'KeyC');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(mounted.commands().isAvailable('issue:create')).toBe(false);
  });

  it('Mod+Enter in the title creates the issue (§3.1 item 6, dialog.submit)', async () => {
    const app = new ComposerApp();
    mounted = await mountComposer(app, '/team/ENG/issues');
    startEngine(mounted);
    await press(document.body, 'c', 'KeyC');
    await setValue(titleInput(), 'Made with the keyboard');
    await press(titleInput(), 'Enter', 'Enter', true);
    expect(app.ops()).toEqual(['issue.create']);
    expect(app.dispatched[0]?.input).toMatchObject({ title: 'Made with the keyboard' });
    expect(composer()).toBeUndefined();
  });

  it('Mod+Enter with an empty title says "Title is required." and creates nothing (§3.1 item 7)', async () => {
    const app = new ComposerApp();
    mounted = await mountComposer(app, '/team/ENG/issues');
    startEngine(mounted);
    await press(document.body, 'c', 'KeyC');
    await press(titleInput(), 'Enter', 'Enter', true);
    expect(app.ops()).toEqual([]);
    expect(composer()?.textContent).toContain(TITLE_REQUIRED);
    expect(document.activeElement).toBe(titleInput());
  });

  it('Esc closes an open picker first, and the next Esc closes the composer (§3.1 item 10)', async () => {
    mounted = await mountComposer(new ComposerApp(), '/team/ENG/issues');
    startEngine(mounted);
    await press(document.body, 'c', 'KeyC');
    const priority = [...(composer()?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.startsWith('Priority:'),
    );
    if (priority === undefined) throw new Error('no priority pill');
    await act(async () => {
      priority.click();
      await Promise.resolve();
    });
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    await press(document.activeElement ?? document.body, 'Escape', 'Escape');
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(0);
    expect(composer()).toBeDefined();
    await press(document.activeElement ?? document.body, 'Escape', 'Escape');
    expect(composer()).toBeUndefined();
  });

  it('G then D goes to the Drafts page', async () => {
    mounted = await mountComposer(new ComposerApp(), '/team/ENG/issues');
    startEngine(mounted);
    await press(document.body, 'g', 'KeyG');
    await press(document.body, 'd', 'KeyD');
    expect(mounted.path()).toBe('/drafts');
  });
});
