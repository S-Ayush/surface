import { CircleCheck, CircleExclamationPoint, X } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
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
export function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
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
      // Always open while the manager lists it; closing is the manager's call.
      open
      onOpenChange={(open) => {
        if (open || ignoreClose.current) return;
        onDismiss();
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
  return (
    <>
      {visibleToasts.map((toast) => (
        <ToastView
          key={`${toast.id}:${toast.revision}`}
          toast={toast}
          onDismiss={() => overlayManager.dismissToast(toast.id)}
        />
      ))}
      <RadixToast.Viewport className={cx(styles.viewport, className)} />
    </>
  );
}
