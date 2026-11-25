/**
 * @vitest-environment jsdom
 */
// PLAN-016 S2: every overlay plays an exit. Radix Presence keeps the content mounted, with
// `data-state="closed"`, while the content has a running animation; jsdom loads no CSS Modules, so a
// stylesheet below gives closed content an animation, and `animationend` ends it.
// The keyframes themselves are checked in `keyframes-motion.test.ts`.
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Dialog } from '../src/components/Dialog/Dialog.js';
import { Menu } from '../src/components/Menu/Menu.js';
import { Popover, PopoverContent, PopoverTrigger } from '../src/components/Popover/Popover.js';
import { Tooltip, TooltipProvider } from '../src/components/Tooltip/Tooltip.js';
import { OverlayProvider } from '../src/overlays/OverlayProvider.js';
import { overlayManager } from '../src/overlays/manager.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.ResizeObserver ??= NoResize;
  const style = document.createElement('style');
  // What the module CSS does for `[data-state='closed']`.
  style.textContent = "[data-state='closed'] { animation-name: exit; animation-duration: 80ms; }";
  document.head.append(style);
});

/** Runs `fn` in act and lets microtasks (Radix's, the layer observer) settle. */
const run = (fn: () => void) =>
  act(async () => {
    fn();
    await Promise.resolve();
  });

let root: Root | undefined;
let host: HTMLElement | undefined;

async function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await run(() => root?.render(node));
}

afterEach(async () => {
  await run(() => root?.unmount());
  host?.remove();
  document.body.replaceChildren();
  root = undefined;
  host = undefined;
});

const endAnimation = (element: Element) =>
  run(() => {
    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 'exit' });
    element.dispatchEvent(event);
  });

function Harness({
  open,
  children,
}: {
  open: boolean;
  children: (props: { open: boolean; setOpen: (open: boolean) => void }) => ReactNode;
}) {
  const [state, setOpen] = useState(open);
  return (
    <>
      <button id="outside" type="button" onClick={() => setOpen(!state)}>
        toggle
      </button>
      {children({ open: state, setOpen })}
    </>
  );
}

describe('overlay exits', () => {
  it('dialog, menu, popover, tooltip and toast set the closing state', async () => {
    // Dialog
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Rename"
            trigger={<button type="button">Open dialog</button>}
          >
            body
          </Dialog>
        )}
      </Harness>,
    );
    expect(document.querySelector("[role='dialog'][data-state='open']")).not.toBeNull();
    await run(() => document.getElementById('outside')?.click());
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.getAttribute('data-state')).toBe('closed');
    // The backdrop leaves with it.
    expect(document.querySelectorAll("[data-state='closed']").length).toBeGreaterThanOrEqual(2);
    if (dialog !== null) await endAnimation(dialog);
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it('menu keeps its content mounted, closed, until the exit ends', async () => {
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Menu
            open={open}
            onOpenChange={setOpen}
            trigger={<button type="button">More</button>}
            items={[{ type: 'item', label: 'Copy link', onSelect: () => {} }]}
          />
        )}
      </Harness>,
    );
    expect(document.querySelector("[role='menu']")?.getAttribute('data-state')).toBe('open');
    await run(() => document.getElementById('outside')?.click());
    const menu = document.querySelector("[role='menu']");
    expect(menu?.getAttribute('data-state')).toBe('closed');
    if (menu !== null) await endAnimation(menu);
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it('popover keeps its content mounted, closed, until the exit ends', async () => {
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger>
              <button type="button">Filters</button>
            </PopoverTrigger>
            <PopoverContent aria-label="Filters">content</PopoverContent>
          </Popover>
        )}
      </Harness>,
    );
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('open');
    await run(() => document.getElementById('outside')?.click());
    const popover = document.querySelector("[role='dialog']");
    expect(popover?.getAttribute('data-state')).toBe('closed');
    if (popover !== null) await endAnimation(popover);
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it('tooltip keeps its content mounted, closed, until the exit ends', async () => {
    await render(
      <TooltipProvider>
        <Harness open>
          {({ open, setOpen }) => (
            <Tooltip content="Create issue" open={open} onOpenChange={setOpen}>
              <button type="button">New</button>
            </Tooltip>
          )}
        </Harness>
      </TooltipProvider>,
    );
    expect(
      document.querySelector("[data-state='delayed-open'], [data-state='instant-open']"),
    ).not.toBeNull();
    await run(() => document.getElementById('outside')?.click());
    const tooltip = document.querySelector("[data-state='closed']:not(button)");
    expect(tooltip).not.toBeNull();
    if (tooltip !== null) await endAnimation(tooltip);
    expect(document.querySelector("[data-state='closed']:not(button)")).toBeNull();
  });

  it('toast stays mounted, closed, after it is dismissed, until the exit ends', async () => {
    await render(<OverlayProvider>{null}</OverlayProvider>);
    let id = '';
    await run(() => {
      id = overlayManager.toast({ message: 'Issue moved', duration: Infinity });
    });
    expect(document.querySelector("li[data-state='open']")?.textContent).toContain('Issue moved');
    await run(() => overlayManager.dismissToast(id));
    const toast = document.querySelector("li[data-state='closed']");
    expect(toast?.textContent).toContain('Issue moved');
    if (toast !== null) await endAnimation(toast);
    expect(document.querySelector('li')).toBeNull();
  });
});

describe('focus on close', () => {
  it('focus returns to the dialog trigger before the exit animation ends', async () => {
    await render(
      <Harness open={false}>
        {({ open, setOpen }) => (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Rename"
            trigger={<button type="button">Open dialog</button>}
            footer={<button type="button">Save</button>}
          >
            <input aria-label="Name" />
          </Dialog>
        )}
      </Harness>,
    );
    const trigger = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open dialog',
    );
    if (trigger === undefined) throw new Error('missing trigger');
    trigger.focus();
    await run(() => trigger.click());
    expect(document.activeElement?.closest("[role='dialog']")).not.toBeNull();
    await run(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Still fading out, and focus is already back.
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(trigger);
  });

  it('focus returns to the menu trigger before the exit animation ends', async () => {
    await render(
      <Harness open={false}>
        {({ open, setOpen }) => (
          <Menu
            open={open}
            onOpenChange={setOpen}
            trigger={<button type="button">More</button>}
            items={[{ type: 'item', label: 'Copy link', onSelect: () => {} }]}
          />
        )}
      </Harness>,
    );
    const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent === 'More');
    if (trigger === undefined) throw new Error('missing trigger');
    trigger.focus();
    await run(() => document.getElementById('outside')?.click());
    const item = document.querySelector<HTMLElement>("[role='menuitem']");
    await run(() => item?.focus());
    expect(document.activeElement).toBe(item);
    await run(() => {
      item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector("[role='menu']")?.getAttribute('data-state')).toBe('closed');
    // The observer that reacts to the closing state runs in a microtask.
    await run(() => undefined);
    expect(document.activeElement).toBe(trigger);
  });

  it('a layer that is fading out no longer counts as open', async () => {
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Menu
            open={open}
            onOpenChange={setOpen}
            trigger={<button type="button">More</button>}
            items={[{ type: 'item', label: 'Copy link', onSelect: () => {} }]}
          />
        )}
      </Harness>,
    );
    expect(overlayManager.topLayer()?.kind).toBe('menu');
    await run(() => document.getElementById('outside')?.click());
    await run(() => undefined);
    expect(document.querySelector("[role='menu']")?.getAttribute('data-state')).toBe('closed');
    expect(overlayManager.topLayer()).toBeUndefined();
  });
});
