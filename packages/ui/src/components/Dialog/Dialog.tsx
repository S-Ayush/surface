import { X } from 'lucide-react';
import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { useModalLayer } from '../../overlays/layer.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import styles from './Dialog.module.css';

export type DialogSize = 'sm' | 'md' | 'lg';

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: names the dialog. Sentence case ("Create issue"). */
  title: string;
  description?: ReactNode;
  /** sm 420 · md 560 · lg 720 px (design-system §5.2). */
  size?: DialogSize;
  /**
   * The content has unsaved changes. Closing it (Esc, outside click, the close button or a
   * <DialogClose>) then asks "Discard changes?" first (design-system §5.2, shortcuts.md §3.8).
   */
  dirty?: boolean;
  /** Optional trigger. Without one (opened by a shortcut), focus returns to what was focused. */
  trigger?: ReactElement;
  /** Right-aligned actions, e.g. Cancel (<DialogClose>) and the primary button. */
  footer?: ReactNode;
  /**
   * `command`: the command menu's frame (command-menu.md §1). 640 px, no header, close button or
   * padding: the title is only announced, and the content lays itself out. `Esc` still closes it.
   */
  variant?: 'default' | 'command';
  /** Below 768 px the dialog fills the screen (the composer, SPEC-012 §7.3). */
  fullScreenOnSmall?: boolean;
  /**
   * Called once as the dialog starts to close, right after focus has been restored (the exit
   * animation does not delay it). Work that moves focus or opens another overlay belongs here,
   * not in the close handler, or focus restoration would undo it.
   */
  onClosed?: () => void;
  children?: ReactNode;
};

/** design-system §5.2: a modal with a focus trap; `Esc` closes the top-most layer only. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  dirty = false,
  trigger,
  footer,
  variant = 'default',
  fullScreenOnSmall = false,
  onClosed,
  children,
}: DialogProps) {
  const [confirming, setConfirming] = useState(false);
  // Closed by its owner while asking (e.g. the issue was deleted elsewhere): drop the question too.
  if (!open && confirming) setConfirming(false);
  const layer = useModalLayer(open, onClosed === undefined ? {} : { onClosed });
  const onCloseAutoFocus = layer.onCloseAutoFocus;
  // Reopening during the exit would reuse the fading content, whose focus scope does not run its
  // open focus again: a new key mounts it afresh (and cuts the exit short).
  const generation = useOpenGeneration(open);

  // Every way of closing goes through Radix onOpenChange, so this one guard covers them all.
  const requestOpenChange = (next: boolean) => {
    if (!next && dirty) setConfirming(true);
    else onOpenChange(next);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={requestOpenChange}>
      {trigger !== undefined && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay key={`backdrop-${generation}`} className={styles.backdrop} />
        {variant === 'command' ? (
          <RadixDialog.Content
            key={generation}
            className={cx(styles.content, styles.command)}
            onCloseAutoFocus={onCloseAutoFocus}
            {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          >
            <VisuallyHidden.Root>
              <RadixDialog.Title>{title}</RadixDialog.Title>
              {description !== undefined && (
                <RadixDialog.Description>{description}</RadixDialog.Description>
              )}
            </VisuallyHidden.Root>
            {children}
          </RadixDialog.Content>
        ) : (
          <RadixDialog.Content
            key={generation}
            className={cx(styles.content, styles[size], fullScreenOnSmall && styles.fullSmall)}
            onCloseAutoFocus={onCloseAutoFocus}
            // Without a description, opt out explicitly so Radix does not point at a missing element.
            {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          >
            <div className={styles.header}>
              <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            </div>
            {description !== undefined && (
              <RadixDialog.Description className={styles.description}>
                {description}
              </RadixDialog.Description>
            )}
            {children !== undefined && <div className={styles.body}>{children}</div>}
            {footer !== undefined && <div className={styles.footer}>{footer}</div>}
            {/* Last in the DOM (shown top-right): Radix focuses the first focusable element on open,
                which should be the first field, not "Close". */}
            <RadixDialog.Close asChild>
              <IconButton aria-label="Close" icon={<X />} size="sm" className={styles.close} />
            </RadixDialog.Close>
          </RadixDialog.Content>
        )}
      </RadixDialog.Portal>
      <DiscardConfirm
        open={confirming}
        onKeep={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false);
          onOpenChange(false);
        }}
      />
    </RadixDialog.Root>
  );
}

/** Counts openings, so each one can mount its content afresh. */
function useOpenGeneration(open: boolean): number {
  const [state, setState] = useState({ open, generation: 0 });
  if (state.open !== open) {
    setState({ open, generation: open ? state.generation + 1 : state.generation });
  }
  return state.generation;
}

/** Closes the dialog it is in (through the dirty guard). Wrap a single button. */
export function DialogClose({ children }: { children: ReactElement }) {
  return <RadixDialog.Close asChild>{children}</RadixDialog.Close>;
}

/**
 * "Discard changes?" stacked on the dialog. Its own `Esc` keeps editing; the safe choice has focus.
 */
function DiscardConfirm({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const discarding = useRef(false);
  // On discard the dialog underneath closes too and returns focus to its own trigger.
  const layer = useModalLayer(open, { shouldRestore: () => !discarding.current });
  return (
    <RadixAlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={cx(styles.backdrop, styles.instant)} />
        <RadixAlertDialog.Content
          className={cx(styles.content, styles.sm, styles.instant)}
          onCloseAutoFocus={(event) => {
            // On discard the dialog underneath closes too and restores focus itself.
            if (discarding.current) {
              discarding.current = false;
              event.preventDefault();
              return;
            }
            layer.onCloseAutoFocus(event);
          }}
        >
          <div className={styles.header}>
            <RadixAlertDialog.Title className={styles.title}>
              Discard changes?
            </RadixAlertDialog.Title>
          </div>
          <RadixAlertDialog.Description className={styles.description}>
            Your unsaved changes will be lost.
          </RadixAlertDialog.Description>
          <div className={styles.footer}>
            <RadixAlertDialog.Cancel asChild>
              <Button>Keep editing</Button>
            </RadixAlertDialog.Cancel>
            <RadixAlertDialog.Action asChild>
              <Button
                variant="danger"
                onClick={() => {
                  discarding.current = true;
                  onDiscard();
                }}
              >
                Discard
              </Button>
            </RadixAlertDialog.Action>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}
