import { CircleCheck, CircleExclamationPoint, X } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import {
  overlayManager,
  TOAST_DURATION_MS,
  type Toast,
  type ToastTone,
} from '../../overlays/manager.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import styles from './Toast.module.css';

const ICONS: Record<ToastTone, ReactNode> = {
  neutral: null,
  success: <CircleCheck className={styles.success} />,
  danger: <CircleExclamationPoint className={styles.danger} />,
};

/**
 * Radix's toast context. <OverlayProvider> mounts it with <ToastRegion>; use it directly only to
 * render <ToastView> outside the manager (stories).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <RadixToast.Provider duration={TOAST_DURATION_MS} label="Notification" swipeDirection="right">
      {children}
    </RadixToast.Provider>
  );
}

/**
 * One toast (design-system §5.1). Announced politely (`type="background"` is aria-live polite);
 * the timer pauses while the pointer or focus is on it.
 */
export function ToastView({
  toast,
  onDismiss,
  open = true,
  onExited,
}: {
  toast: Toast;
  onDismiss: () => void;
  /** false while the toast plays its exit (Radix keeps it mounted until the animation ends). */
  open?: boolean;
  onExited?: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const ignoreClose = useRef(false);
  return (
    <RadixToast.Root
      ref={ref}
      // Radix closes the newest toast on any Esc. Esc belongs to the page (clear selection, S5) or
      // to another toast unless it was pressed inside this one, so ignore the close that follows.
      // Not preventDefault: that would mark the page's Esc as handled. The flag lives for this
      // event only (Radix closes synchronously).
      onEscapeKeyDown={(event) => {
        if (event.target instanceof Node && ref.current?.contains(event.target)) return;
        ignoreClose.current = true;
        queueMicrotask(() => {
          ignoreClose.current = false;
        });
      }}
      type="background"
      duration={toast.duration}
      // Open while the manager lists it; closing is the manager's call.
      open={open}
      onOpenChange={(next) => {
        if (next || ignoreClose.current) return;
        onDismiss();
      }}
      onAnimationEnd={() => {
        if (!open) onExited?.();
      }}
      className={styles.toast}
    >
      {toast.tone !== 'neutral' && (
        <span className={styles.icon} aria-hidden="true">
          {ICONS[toast.tone]}
        </span>
      )}
      <RadixToast.Description className={styles.message}>{toast.message}</RadixToast.Description>
      {toast.action !== undefined && (
        <RadixToast.Action altText={toast.action.altText ?? toast.action.label} asChild>
          <Button size="sm" onClick={toast.action.onAction}>
            {toast.action.label}
          </Button>
        </RadixToast.Action>
      )}
      <RadixToast.Close asChild>
        <IconButton aria-label="Dismiss" icon={<X />} size="sm" />
      </RadixToast.Close>
    </RadixToast.Root>
  );
}

type Shown = { toast: Toast; open: boolean };

/** How long a closing toast may stay mounted if its animation never reports an end. */
const EXIT_FALLBACK_MS = 400;

/**
 * Keeps a toast the manager dropped mounted, closed, so it can play its exit (PLAN-016 S2). A
 * replaced toast (same id, new revision) swaps in place instead of fading beside its successor.
 */
function useShownToasts(visible: readonly Toast[]) {
  const [shown, setShown] = useState<readonly Shown[]>(() =>
    visible.map((toast) => ({ toast, open: true })),
  );
  const [seen, setSeen] = useState(visible);
  if (seen !== visible) {
    setSeen(visible);
    const kept = shown
      .filter((entry) => entry.open || !visible.some((t) => t.id === entry.toast.id))
      .map((entry) => {
        const current = visible.find((t) => t.id === entry.toast.id);
        return current === undefined ? { ...entry, open: false } : { toast: current, open: true };
      });
    const added = visible
      .filter((t) => !kept.some((entry) => entry.toast.id === t.id))
      .map((toast) => ({ toast, open: true }));
    setShown([...kept, ...added]);
  }
  const exited = (toast: Toast) =>
    setShown((list) => list.filter((entry) => entry.open || entry.toast !== toast));
  return { shown, exited };
}

/**
 * The manager's visible toasts (at most three; the rest wait). `F8` moves focus to the region
 * (Radix default), which is how keyboard users reach a toast's action.
 */
export function ToastRegion({ className }: { className?: string }) {
  const { visibleToasts } = useSyncExternalStore(
    overlayManager.subscribe,
    overlayManager.getSnapshot,
    overlayManager.getSnapshot,
  );
  const { shown, exited } = useShownToasts(visibleToasts);
  return (
    <>
      {shown.map(({ toast, open }) => (
        <ClosingGuard
          key={`${toast.id}:${toast.revision}`}
          open={open}
          onExited={() => exited(toast)}
        >
          <ToastView
            toast={toast}
            open={open}
            onDismiss={() => overlayManager.dismissToast(toast.id)}
            onExited={() => exited(toast)}
          />
        </ClosingGuard>
      ))}
      <RadixToast.Viewport className={cx(styles.viewport, className)} />
    </>
  );
}

/** Drops a closed toast even when no animationend arrives (no animation, hidden tab). */
function ClosingGuard({
  open,
  onExited,
  children,
}: {
  open: boolean;
  onExited: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(onExited, EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [open, onExited]);
  return children;
}
