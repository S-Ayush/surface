/**
 * @vitest-environment jsdom
 */
// PLAN-016 S2: every overlay plays an exit. Radix Presence keeps the content mounted, with
// `data-state="closed"`, while the content has a running animation; jsdom loads no CSS Modules, so a
// stylesheet below gives closed content an animation, and `animationend` ends it.
// The keyframes themselves are checked in `keyframes-motion.test.ts`.
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  // The discard question has none (`.instant`), so it unmounts at once.
  style.textContent =
    "[data-state='closed']:not([role='alertdialog']) { animation-name: exit; animation-duration: 80ms; }";
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
  // The manager is a singleton: drop what a test left on screen or queued.
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  for (const toast of [...visibleToasts, ...queuedToasts]) overlayManager.dismissToast(toast.id);
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
  it('dialog sets the closing state and unmounts on animationend', async () => {
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

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent === text);

const press = (element: Element | null | undefined, key: string) =>
  run(() => {
    element?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

/** True when `element` or an ancestor is hidden from assistive technology. */
const hiddenFromAT = (element: Element | null) =>
  element?.closest("[aria-hidden='true'], [inert]") != null;

describe('focus with exits running', () => {
  it('a dialog opened from a menu item returns focus to the menu trigger', async () => {
    function Screen() {
      const [dialog, setDialog] = useState(false);
      return (
        <>
          <Menu
            trigger={<button type="button">More</button>}
            items={[{ type: 'item', label: 'Rename', onSelect: () => setDialog(true) }]}
          />
          <Dialog open={dialog} onOpenChange={setDialog} title="Rename issue">
            <input aria-label="Title" />
          </Dialog>
        </>
      );
    }
    await render(<Screen />);
    const trigger = byText('button', 'More');
    trigger?.focus();
    await run(() => {
      trigger?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
      );
    });
    const item = document.querySelector<HTMLElement>("[role='menuitem']");
    item?.focus();
    await run(() => item?.click());
    expect(document.querySelector("[role='dialog'][data-state='open']")).not.toBeNull();
    await press(document.activeElement, 'Escape');
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(trigger);
  });

  it('a dirty dialog: Keep editing stays open, Discard closes with focus on the trigger', async () => {
    await render(
      <Harness open={false}>
        {({ open, setOpen }) => (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="New issue"
            dirty
            trigger={<button type="button">Open dialog</button>}
          >
            <input aria-label="Title" />
          </Dialog>
        )}
      </Harness>,
    );
    const trigger = byText('button', 'Open dialog');
    trigger?.focus();
    await run(() => trigger?.click());
    await press(document.activeElement, 'Escape');
    expect(document.querySelector("[role='alertdialog']")).not.toBeNull();
    // Keep editing: the question goes at once (no fade to click through), the dialog stays.
    await run(() => byText('button', 'Keep editing')?.click());
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('open');
    await press(document.activeElement, 'Escape');
    await run(() => byText('button', 'Discard')?.click());
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(trigger);
  });

  it('no ancestor of the focused trigger is aria-hidden once a dialog starts to close', async () => {
    await render(
      <Harness open={false}>
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
    const trigger = byText('button', 'Open dialog');
    trigger?.focus();
    await run(() => trigger?.click());
    // Radix hides everything outside the open dialog.
    expect(hiddenFromAT(trigger ?? null)).toBe(true);
    await press(document.activeElement, 'Escape');
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(trigger);
    expect(hiddenFromAT(document.activeElement)).toBe(false);
  });

  it('a fading dialog ignores clicks and keys: it is inert', async () => {
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Dialog open={open} onOpenChange={setOpen} title="Rename">
            body
          </Dialog>
        )}
      </Harness>,
    );
    await run(() => document.getElementById('outside')?.click());
    expect(document.querySelector("[role='dialog']")?.hasAttribute('inert')).toBe(true);
  });

  it('reopening a dialog while it fades focuses the new one', async () => {
    await render(
      <Harness open={false}>
        {({ open, setOpen }) => (
          <Dialog open={open} onOpenChange={setOpen} title="Rename">
            <input aria-label="Title" />
          </Dialog>
        )}
      </Harness>,
    );
    vi.useFakeTimers();
    const outside = document.getElementById('outside');
    outside?.focus();
    await run(() => outside?.click());
    await run(() => outside?.click());
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(outside);
    await run(() => outside?.click());
    // Radix reports the old content's close from a timer once it unmounts.
    await run(() => vi.advanceTimersByTime(50));
    vi.useRealTimers();
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.getAttribute('data-state')).toBe('open');
    expect(dialog?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.closest("[role='dialog']")).toBe(dialog);
    expect(document.activeElement).not.toBe(outside);
    // The new opening kept its own return target, so its close still returns focus at once.
    await run(() => outside?.click());
    expect(document.querySelector("[role='dialog']")?.getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(outside);
  });

  it('reopening a menu while it fades keeps focus inside it', async () => {
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
    await run(() => document.getElementById('outside')?.click());
    expect(document.querySelector("[role='menu']")?.getAttribute('data-state')).toBe('closed');
    await run(() => document.getElementById('outside')?.click());
    const menu = document.querySelector("[role='menu']");
    expect(menu?.getAttribute('data-state')).toBe('open');
    expect(menu?.hasAttribute('inert')).toBe(false);
    expect(menu?.contains(document.activeElement)).toBe(true);
    expect(overlayManager.topLayer()?.kind).toBe('menu');
  });

  it('choosing a submenu item returns focus to the trigger, never to the page body', async () => {
    await render(
      <Harness open>
        {({ open, setOpen }) => (
          <Menu
            open={open}
            onOpenChange={setOpen}
            trigger={<button type="button">More</button>}
            items={[
              {
                type: 'submenu',
                label: 'Copy',
                items: [{ type: 'item', label: 'Copy ID', onSelect: () => {} }],
              },
            ]}
          />
        )}
      </Harness>,
    );
    const trigger = byText('button', 'More');
    const subTrigger = document.querySelector<HTMLElement>("[role='menuitem']");
    subTrigger?.focus();
    await press(subTrigger, 'ArrowRight');
    const sub = byText("[role='menuitem']", 'Copy ID');
    expect(sub).toBeDefined();
    sub?.focus();
    await run(() => sub?.click());
    await run(() => undefined);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('toast exits', () => {
  it('a dismissed toast goes after 400 ms even if no animationend arrives', async () => {
    vi.useFakeTimers();
    try {
      await render(<OverlayProvider>{null}</OverlayProvider>);
      let id = '';
      await run(() => {
        id = overlayManager.toast({ message: 'Issue moved', duration: Infinity });
      });
      await run(() => overlayManager.dismissToast(id));
      expect(document.querySelector("li[data-state='closed']")).not.toBeNull();
      // Another manager update must not restart the timer.
      await run(() => vi.advanceTimersByTime(300));
      await run(() => {
        overlayManager.toast({ message: 'Other', duration: Infinity });
      });
      await run(() => vi.advanceTimersByTime(150));
      expect(document.querySelector("li[data-state='closed']")).toBeNull();
      expect(document.querySelector("li[data-state='open']")?.textContent).toContain('Other');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a toast replaced under the same id swaps in place instead of fading beside its successor', async () => {
    await render(<OverlayProvider>{null}</OverlayProvider>);
    await run(() => {
      overlayManager.toast({ message: 'Syncing 1 change', id: 'sync', duration: Infinity });
    });
    await run(() => {
      overlayManager.toast({ message: 'Syncing 2 changes', id: 'sync', duration: Infinity });
    });
    const toasts = document.querySelectorAll('li');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toContain('Syncing 2 changes');
    expect(document.querySelector("li[data-state='closed']")).toBeNull();
  });
});
