import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { Kbd } from '../Kbd/Kbd.js';
import styles from './Tooltip.module.css';

/** design-system §4: tooltips show after 500 ms, then instantly while moving between triggers. */
export const TOOLTIP_DELAY_MS = 500;
const SKIP_DELAY_MS = 300;
/** Gap to the trigger and to the viewport edge in px (Radix takes numbers; both on the 4 px grid). */
const SIDE_OFFSET = 6;
const COLLISION_PADDING = 8;

/** Mount once near the app root (and in Storybook) so tooltips share the delay behaviour. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
      {children}
    </RadixTooltip.Provider>
  );
}

export type TooltipProps = {
  /** Supplementary text only: never essential information (design-system §5.1). */
  content: ReactNode;
  /** Shortcut shown as <Kbd>, e.g. "Mod+K". */
  shortcut?: string | readonly string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** A single focusable element. */
  children: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Radix Tooltip: opens on hover and keyboard focus, closes on Esc. */
export function Tooltip({ content, shortcut, side = 'top', children, ...root }: TooltipProps) {
  return (
    <RadixTooltip.Root {...root}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={styles.content}
          side={side}
          sideOffset={SIDE_OFFSET}
          collisionPadding={COLLISION_PADDING}
        >
          <span>{content}</span>
          {shortcut !== undefined && <Kbd keys={shortcut} className={styles.kbd} />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
