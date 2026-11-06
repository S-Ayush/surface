import { CircleExclamationPoint, Info, TriangleExclamationPoint, X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { overlayManager, type BannerAction, type BannerTone } from '../../overlays/manager.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import styles from './Banner.module.css';

const ICONS: Record<BannerTone, ReactNode> = {
  info: <Info />,
  warning: <TriangleExclamationPoint />,
  danger: <CircleExclamationPoint />,
};

export type BannerProps = {
  tone: BannerTone;
  /** One sentence that says what is wrong and what happens next (SPEC-005 §8). */
  children: ReactNode;
  action?: BannerAction;
  /** Shows a dismiss button. Leave it out for persistent banners. */
  onDismiss?: () => void;
  /** `false` inside an existing live region (<BannerRegion>), which announces it instead. */
  live?: boolean;
  className?: string;
};

/**
 * design-system §5.1: system state across the top of the app. `danger` is an alert (announced
 * at once); info and warning are a polite status.
 */
export function Banner({ tone, children, action, onDismiss, live = true, className }: BannerProps) {
  return (
    <div
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
      className={cx(styles.root, styles[tone], className)}
    >
      <span className={styles.icon} aria-hidden="true">
        {ICONS[tone]}
      </span>
      <p className={styles.message}>{children}</p>
      {action !== undefined && (
        <Button size="sm" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
      {onDismiss !== undefined && (
        <IconButton aria-label="Dismiss" icon={<X />} size="sm" onClick={onDismiss} />
      )}
    </div>
  );
}

/**
 * The manager's current banner: the highest priority, then the oldest; the rest wait behind it.
 * The shell (S4) places this above the main content.
 *
 * Both live regions stay mounted and only their content changes: screen readers often stay
 * silent for a live region inserted together with its text.
 */
export function BannerRegion({ className }: { className?: string }) {
  const { banner } = useSyncExternalStore(
    overlayManager.subscribe,
    overlayManager.getSnapshot,
    overlayManager.getSnapshot,
  );
  const view = (tone: 'danger' | 'other') =>
    banner !== undefined && (banner.tone === 'danger') === (tone === 'danger') ? (
      <Banner
        key={banner.id}
        tone={banner.tone}
        action={banner.action}
        live={false}
        onDismiss={banner.dismissible ? () => dismiss(banner.id) : undefined}
        className={className}
      >
        {banner.message}
      </Banner>
    ) : null;
  return (
    <>
      <div role="status">{view('other')}</div>
      <div role="alert">{view('danger')}</div>
    </>
  );
}

/** The Dismiss button goes with its banner, so focus moves to the main region, not <body>. */
function dismiss(id: string): void {
  const focusWasInBanner = document.activeElement?.closest('[role="status"], [role="alert"]');
  overlayManager.hideBanner(id);
  if (focusWasInBanner) document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
}
