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

/**
 * Returns focus the moment a layer starts closing, not when its exit animation ends: Radix keeps
 * the content (and its focus scope) mounted for `--dur-exit`, and `onCloseAutoFocus` only fires
 * after that. Focus that already moved on (a dialog opened from a menu item, a click elsewhere)
 * is left alone.
 */
function restoreFocusNow(handle: Handle, ownsFocus: (active: Element | null) => boolean): void {
  if (handle.restored || handle.outside) return;
  const target = handle.returnFocus;
  // Nothing was focused: leave it to Radix's default (the trigger) once the content unmounts.
  if (target === null) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body && !ownsFocus(active)) {
    // Focus moved on by itself; do not pull it back later either.
    handle.returnFocus = null;
    return;
  }
  const next = usableTarget(target);
  if (next === null) return;
  handle.restored = true;
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

export type ModalLayerHandle = { onCloseAutoFocus: (event: Event) => void };

/**
 * A modal layer (Dialog). Radix returns focus only to a Radix trigger, so a dialog opened by a
 * shortcut or a menu item would drop focus on <body>. The focused element is captured in a layout
 * effect, before Radix moves focus into the dialog.
 */
export function useModalLayer(
  open: boolean,
  shouldRestore: () => boolean = () => true,
): ModalLayerHandle {
  const handle = useRef<Handle>(freshHandle());
  const restoreWanted = useRef(shouldRestore);
  useLayoutEffect(() => {
    restoreWanted.current = shouldRestore;
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
      if (!restoreWanted.current()) return;
      restoreFocusNow(
        current,
        (active) => active?.closest('[role="dialog"], [role="alertdialog"]') != null,
      );
    };
  }, [open]);
  return { onCloseAutoFocus: (event) => restoreFocus(handle.current, event) };
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
      const closed = container?.getAttribute('data-state') === 'closed';
      if (closed && unregister !== null) {
        unregister();
        unregister = null;
        if (handleRef !== undefined)
          restoreFocusNow(handleRef.current, (active) => container?.contains(active) === true);
      } else if (!closed && unregister === null) {
        // Reopened while it was still fading out.
        if (handleRef !== undefined) handleRef.current = freshHandle(returnFocus);
        unregister = register(kind, record);
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
