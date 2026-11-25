import { useEffect, useLayoutEffect, useRef, type ReactElement, type RefObject } from 'react';
import { overlayManager, type LayerKind } from './manager.js';

// Focus restoration for overlays (SPEC-005 §6: "Overlays trap focus and restore it to the trigger
// on close"). Each open layer records where focus goes back to; a layer opened from inside an
// anchored one (a dialog from a menu item) borrows that layer's target, because the item is gone
// once its menu closes.

type FocusRecord = {
  /** The overlay's content element. Only anchored layers (menus, popovers) set it: they close when
   *  something opens from them, while a dialog stays open under a nested one. */
  container: Element | null;
  returnFocus: HTMLElement | null;
};

/** Open layers' focus records, in opening order (Map keeps insertion order). */
const records = new Map<string, FocusRecord>();

type Handle = {
  returnFocus: HTMLElement | null;
  outside: boolean;
  /** Focus already went back when the close began (exits keep the content mounted, PLAN-016 S2). */
  restored: boolean;
};

const freshHandle = (returnFocus: HTMLElement | null = null): Handle => ({
  returnFocus,
  outside: false,
  restored: false,
});

const focusable = (element: Element | null): HTMLElement | null =>
  element instanceof HTMLElement && element !== document.body ? element : null;

/** Follows `element` out of any open anchored layer it sits in, to that layer's return target. */
function resolveReturnTarget(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  // Each step leaves one layer, so this ends within records.size steps.
  for (let step = 0; step <= records.size && current !== null; step++) {
    const target = current;
    const owner = [...records.values()].reverse().find((r) => r.container?.contains(target));
    if (owner === undefined) return current;
    current = owner.returnFocus;
  }
  return current;
}

function register(kind: LayerKind, record: FocusRecord): () => void {
  const id = overlayManager.pushLayer(kind);
  records.set(id, record);
  return () => {
    records.delete(id);
    overlayManager.removeLayer(id);
  };
}

/** The element to refocus, or null when focus is not ours to move. */
function usableTarget(target: HTMLElement | null): HTMLElement | null {
  // The element is gone (its row was deleted): fall back to the main region, as after a route
  // change (SPEC-005 §6).
  const next = target?.isConnected === true ? target : document.querySelector('main');
  return next instanceof HTMLElement ? next : null;
}

const FADING = "[data-state='closed']:is([role='menu'], [role='dialog'], [role='alertdialog'])";

/**
 * Is focus still inside this layer, or inside a layer that opened from it (a submenu, a menu in a
 * dialog) or is fading with it? Nested layers are separate portals, so walk out through their
 * return targets (the same chain `resolveReturnTarget` follows). Call before the layer leaves
 * `records`.
 */
function focusIsOurs(active: Element | null, inside: (element: Element) => boolean): boolean {
  if (active === null || active === document.body) return true;
  let current: Element | null = active;
  for (let step = 0; step <= records.size + 1 && current !== null; step++) {
    if (inside(current) || current.closest(FADING) !== null) return true;
    const element: Element = current;
    const owner = [...records.values()].reverse().find((r) => r.container?.contains(element));
    if (owner === undefined) return false;
    current = owner.returnFocus;
  }
  return false;
}

/**
 * Radix Dialog hides everything outside the dialog with `aria-hidden` until the content unmounts,
 * which is after the exit. Focus returns when the close starts, so lift the hiding from the return
 * target and its ancestors first (axe aria-hidden-focus); Radix removes the rest at unmount.
 */
function revealForFocus(element: Element): void {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.getAttribute('data-aria-hidden') === 'true') {
      node.removeAttribute('aria-hidden');
      node.removeAttribute('data-aria-hidden');
    }
  }
}

/**
 * Returns focus the moment a layer starts closing, not when its exit animation ends: Radix keeps
 * the content (and its focus scope) mounted for `--dur-exit`, and `onCloseAutoFocus` only fires
 * after that. Focus that already moved on (a dialog opened from a menu item, a click elsewhere)
 * is left alone.
 */
function restoreFocusNow(handle: Handle, inside: (element: Element) => boolean): void {
  if (handle.restored || handle.outside) return;
  const target = handle.returnFocus;
  // Nothing was focused: leave it to Radix's default (the trigger) once the content unmounts.
  if (target === null) return;
  if (!focusIsOurs(document.activeElement, inside)) {
    // Focus moved on by itself; do not pull it back later either.
    handle.returnFocus = null;
    return;
  }
  const next = usableTarget(target);
  if (next === null) return;
  handle.restored = true;
  revealForFocus(next);
  next.focus({ preventScroll: true });
}

/** Pass to Radix `onCloseAutoFocus`. Radix calls it after the content unmounts. */
function restoreFocus(handle: Handle, event: Event): void {
  const target = handle.returnFocus;
  handle.returnFocus = null;
  if (handle.restored) {
    // Done at the start of the close; Radix's own default would focus the trigger a second time.
    event.preventDefault();
    return;
  }
  // Closed by a click elsewhere: focus stays where the user clicked (Radix does the same).
  if (handle.outside) return;
  // Nothing was focused (e.g. Safari does not focus clicked buttons): Radix's default focuses the
  // trigger, if there is one.
  if (target === null) return;
  const next = usableTarget(target);
  if (next === null) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
}

const setInert = (element: Element, inert: boolean) =>
  inert ? element.setAttribute('inert', '') : element.removeAttribute('inert');

/** Radix focuses a menu or popover as it opens; a content that reopens mid-fade is not remounted. */
function focusInto(container: HTMLElement): void {
  const first = container.querySelector<HTMLElement>(
    '[tabindex]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), select, textarea, a[href]',
  );
  (first ?? container).focus({ preventScroll: true });
}

export type ModalLayerHandle = { onCloseAutoFocus: (event: Event) => void };

export type ModalLayerOptions = {
  /** false skips returning focus (the dialog underneath closes too). */
  shouldRestore?: () => boolean;
  /** Called once as the close starts, after focus has gone back (not after the exit). */
  onClosed?: () => void;
};

/**
 * A modal layer (Dialog). Radix returns focus only to a Radix trigger, so a dialog opened by a
 * shortcut or a menu item would drop focus on <body>. The focused element is captured in a layout
 * effect, before Radix moves focus into the dialog. When it closes, focus returns at once and the
 * fading content goes inert, so a click or key cannot reach it during the exit.
 */
export function useModalLayer(open: boolean, options: ModalLayerOptions = {}): ModalLayerHandle {
  const handle = useRef<Handle>(freshHandle());
  const latest = useRef(options);
  const isOpen = useRef(open);
  useLayoutEffect(() => {
    latest.current = options;
    isOpen.current = open;
  });
  useLayoutEffect(() => {
    if (!open) return;
    const returnFocus = resolveReturnTarget(focusable(document.activeElement));
    handle.current = freshHandle(returnFocus);
    return register('modal', { container: null, returnFocus });
  }, [open]);
  // A passive effect, so Radix's focus trap (its own passive effect, in a child) is already off
  // when focus moves out of the closing dialog.
  useEffect(() => {
    if (!open) return;
    const current = handle.current;
    return () => {
      const { shouldRestore, onClosed } = latest.current;
      if (shouldRestore?.() !== false) {
        restoreFocusNow(
          current,
          (el) => el.closest('[role="dialog"], [role="alertdialog"]') !== null,
        );
      }
      for (const node of document.querySelectorAll(FADING)) setInert(node, true);
      onClosed?.();
    };
  }, [open]);
  return {
    onCloseAutoFocus: (event) => {
      // Reopened during the exit: the old content is gone and Radix reports its close, but
      // `handle` is the new opening's. Leave focus where the new dialog put it.
      if (isOpen.current) {
        event.preventDefault();
        return;
      }
      restoreFocus(handle.current, event);
    },
  };
}

export type AnchoredLayerHandle = {
  /** Render first inside Radix `Content`, which mounts only while open. */
  marker: ReactElement;
  onCloseAutoFocus: (event: Event) => void;
  onInteractOutside: () => void;
};

/**
 * An anchored layer (Popover, Menu, ContextMenu). Focus returns to the Radix trigger, or, with no
 * trigger (a picker anchored to a row), to what was focused when it opened.
 */
export function useAnchoredLayer(kind: 'popover' | 'menu'): AnchoredLayerHandle {
  const handle = useRef<Handle>(freshHandle());
  return {
    marker: <LayerMarker kind={kind} handleRef={handle} />,
    onCloseAutoFocus: (event) => restoreFocus(handle.current, event),
    onInteractOutside: () => {
      handle.current.outside = true;
    },
  };
}

/**
 * Registers the layer while it is open. A hidden span gives it its content element (the span's
 * parent) without wrapping Radix's content. Radix keeps closing content mounted while it exits
 * (`data-state="closed"`), so the layer leaves the stack, and focus returns, at that moment rather
 * than at unmount. Submenus render one too, without restoring focus themselves (Radix returns it
 * to the submenu's item).
 */
export function LayerMarker({
  kind,
  handleRef,
}: {
  kind: 'popover' | 'menu';
  handleRef?: RefObject<Handle>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = ref.current?.parentElement ?? null;
    // Radix triggers point at their open content with aria-controls.
    const trigger =
      container !== null && container.id !== ''
        ? document.querySelector(`[aria-controls="${CSS.escape(container.id)}"]`)
        : null;
    const returnFocus = focusable(trigger) ?? focusable(document.activeElement);
    if (handleRef !== undefined) handleRef.current = freshHandle(returnFocus);
    const record = { container, returnFocus };
    let unregister: (() => void) | null = register(kind, record);
    // Radix sets data-state on the content element itself.
    const observer = new MutationObserver(() => {
      if (container === null) return;
      const closed = container.getAttribute('data-state') === 'closed';
      if (closed && unregister !== null) {
        // Before leaving the stack: submenus are found through it (focusIsOurs).
        if (handleRef !== undefined) {
          restoreFocusNow(handleRef.current, (el) => container.contains(el));
        }
        setInert(container, true);
        unregister();
        unregister = null;
      } else if (!closed && unregister === null) {
        // Reopened while it was still fading out: the node is reused, so Radix does not focus it.
        setInert(container, false);
        const refocus = handleRef?.current.restored === true;
        if (handleRef !== undefined) handleRef.current = freshHandle(returnFocus);
        unregister = register(kind, record);
        if (refocus) focusInto(container);
      }
    });
    if (container !== null) {
      observer.observe(container, { attributes: true, attributeFilter: ['data-state'] });
    }
    return () => {
      observer.disconnect();
      unregister?.();
    };
  }, [kind, handleRef]);
  return <span ref={ref} hidden />;
}
