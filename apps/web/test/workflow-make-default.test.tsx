/**
 * @vitest-environment jsdom
 */
// PLAN-010 S4, SPEC-010 §3.1: "Make default" in a status row's menu. It is offered on a Backlog
// or Unstarted status that is not already the default, never on a started one, and choosing it
// dispatches `team.setDefaultStatus` with the status id.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowScreen } from '../src/features/statuses/WorkflowScreen.js';
import { ENG, EstimateApp, TODO, pageTree } from './estimate-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  root = undefined;
  host.remove();
});

async function mount(app: EstimateApp, page: () => ReactNode): Promise<void> {
  const tree = await pageTree(app, page);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
}

async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await act(async () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
    await Promise.resolve();
  });
}

const page = () => <WorkflowScreen params={{ key: 'ENG' }} />;
const menuItems = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
const openMenu = (status: string) =>
  press(document.querySelector(`button[aria-label="Actions for ${status}"]`));

describe('"Make default" in the status row menu', () => {
  it('is offered on an Unstarted status and dispatches team.setDefaultStatus', async () => {
    const app = new EstimateApp([ENG]);
    await mount(app, page);
    await openMenu('Todo');
    expect(menuItems()).toContain('Make default');
    await press(
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => el.textContent?.trim() === 'Make default',
      ),
    );
    expect(app.dispatched).toEqual([
      { op: 'team.setDefaultStatus', input: { team: 'ENG', status: TODO } },
    ]);
  });

  it('is not offered on the current default', async () => {
    await mount(new EstimateApp([ENG]), page);
    await openMenu('Backlog');
    expect(menuItems()).not.toContain('Make default');
    expect(menuItems()).toContain('Edit');
  });

  it('is not offered on a started status', async () => {
    await mount(new EstimateApp([ENG]), page);
    await openMenu('In Progress');
    expect(menuItems()).not.toContain('Make default');
  });
});
