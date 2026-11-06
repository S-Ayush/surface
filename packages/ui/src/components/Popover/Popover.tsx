import { Popover as RadixPopover } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { useAnchoredLayer } from '../../overlays/layer.js';
import styles from './Popover.module.css';

/** Gap to the anchor and to the viewport edge in px (Radix takes numbers; both on the 4 px grid). */
export const OVERLAY_SIDE_OFFSET = 4;
export const OVERLAY_COLLISION_PADDING = 8;

export type PopoverProps = {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * design-system §5.2: anchored, flips on collision, closes on `Esc` and outside click, and returns
 * focus to the trigger. Compose with <PopoverTrigger> (or <PopoverAnchor>) and <PopoverContent>.
 */
export function Popover(props: PopoverProps) {
  return <RadixPopover.Root {...props} />;
}

/** A single focusable element that toggles the popover. */
export function PopoverTrigger({ children }: { children: ReactElement }) {
  return <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>;
}

/** Positions the popover against something other than the trigger (e.g. a row, for pickers). */
export function PopoverAnchor({ children }: { children: ReactElement }) {
  return <RadixPopover.Anchor asChild>{children}</RadixPopover.Anchor>;
}

/** The content is a dialog, so it needs a name: a visible heading's id, or a label. */
type PopoverNaming = { 'aria-label': string } | { 'aria-labelledby': string };

export type PopoverContentProps = PopoverNaming & {
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
};

export function PopoverContent({
  children,
  side = 'bottom',
  align = 'start',
  className,
  ...naming
}: PopoverContentProps) {
  const layer = useAnchoredLayer('popover');
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        className={cx(styles.content, className)}
        side={side}
        align={align}
        sideOffset={OVERLAY_SIDE_OFFSET}
        collisionPadding={OVERLAY_COLLISION_PADDING}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onInteractOutside={layer.onInteractOutside}
        {...naming}
      >
        {layer.marker}
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
