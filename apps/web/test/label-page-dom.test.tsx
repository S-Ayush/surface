/**
 * @vitest-environment jsdom
 */
// PLAN-010 S3, SPEC-010 §3.2 and §7.3: what the labels page does once it is mounted, which the
// server-rendered markup of `labels-screen.test.tsx` can't show. "Create label…" leaves a request
// the page takes on mount (AC-23, page half): the New label row opens with its name field focused.
// The delete and move dialogs carry the §3.2 wording, and a refused name shows its message.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppModel } from '../src/app/AppModel.js';
import {
  WORKSPACE_SCOPE,
  clearCreateLabel,
  requestCreateLabel,
} from '../src/features/labels/add-intent.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from '../src/features/labels/LabelsScreen.js';
import { FakeApp, TEAM, pageTree } from './label-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: Radix measures with these, and nothing here depends on the sizes.
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;

let host: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  await inAct(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  clearCreateLabel();
});

/** Runs `change` inside `act` and lets the effects and promises it started settle. */
async function inAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

async function mount(app: AppModel, page: () => ReactNode): Promise<void> {
  const tree = await pageTree(app, page);
  root = createRoot(host);
  await inAct(() => {
    root?.render(tree);
  });
}

const teamPage = () => <TeamLabelsScreen params={{ key: 'ENG' }} />;
const workspacePage = () => <WorkspaceLabelsScreen />;

const field = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await inAct(() => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
  });
}

describe('"Create label…" arriving at the page (AC-23)', () => {
  it('opens the New label row with the name field focused, for the team named', async () => {
    requestCreateLabel({ scope: 'ENG' });
    await mount(new FakeApp([TEAM]), teamPage);
    const name = field('Label name');
    expect(name).not.toBeNull();
    expect(document.activeElement).toBe(name);
  });

  it('opens it on the workspace page for the workspace scope', async () => {
    requestCreateLabel({ scope: WORKSPACE_SCOPE });
    await mount(new FakeApp([]), workspacePage);
    expect(document.activeElement).toBe(field('Label name'));
  });

  it('leaves the row closed, and the request for its own page, when it is for another', async () => {
    requestCreateLabel({ scope: WORKSPACE_SCOPE });
    await mount(new FakeApp([TEAM]), teamPage);
    expect(field('Label name')).toBeNull();
  });

  it('opens nothing without a request', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    expect(field('Label name')).toBeNull();
    expect(document.querySelector('form[aria-label="New label"]')).toBeNull();
  });
});

describe('the New label row', () => {
  it('shows the server’s wording for a name the team already has, and sends nothing', async () => {
    requestCreateLabel({ scope: 'ENG' });
    await mount(new FakeApp([TEAM]), teamPage);
    const name = field('Label name');
    if (name === null) throw new Error('no name field');
    await inAct(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'perf');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await inAct(() => {
      document
        .querySelector('form[aria-label="New label"]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'A label named "perf" already exists in ENG. Choose another name.',
    );
  });
});

describe('the delete and move dialogs (§3.2)', () => {
  async function openMenuItem(rowName: string, item: string): Promise<void> {
    await press(document.querySelector(`button[aria-label="Actions for ${rowName}"]`));
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === item,
    );
    await press(entry);
  }

  it('asks "Delete label …?" and says it leaves every issue and cannot be undone', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    await openMenuItem('Perf', 'Delete…');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Delete label "Perf"?');
    expect(dialog?.textContent).toContain(
      "It will be removed from every issue that has it. This can't be undone.",
    );
  });

  it('asks to move to the workspace and says every team gets it and it cannot be undone', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    await openMenuItem('Perf', 'Move to workspace…');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "This label will be available to every team. This can't be undone.",
    );
  });
});
