import type { ComponentPropsWithRef } from 'react';
import { VisuallyHidden } from 'radix-ui';
import { cx } from '../../internal/cx.js';
import { keyLabels, spokenShortcut } from '../../keys.js';
import { usePlatform } from '../../platform.js';
import styles from './Kbd.module.css';

export type KbdProps = Omit<ComponentPropsWithRef<'kbd'>, 'children'> & {
  /** A chord ("Mod+K") or a sequence (["G", "I"]). `Mod` renders as ⌘ on macOS and Ctrl elsewhere. */
  keys: string | readonly string[];
};

/** A keyboard shortcut hint (design-system §5.1). Screen readers hear the spoken form ("Command K"). */
export function Kbd({ keys, className, ...props }: KbdProps) {
  const platform = usePlatform();
  const chords = typeof keys === 'string' ? [keys] : keys;
  return (
    <kbd className={cx(styles.root, className)} {...props}>
      <span className={styles.keys} aria-hidden="true">
        {chords.map((chord, i) => (
          <span key={i} className={styles.chord}>
            {i > 0 && <span className={styles.then}>then</span>}
            {keyLabels(chord, platform).map((label, j) => (
              <kbd key={j} className={styles.key}>
                {label}
              </kbd>
            ))}
          </span>
        ))}
      </span>
      <VisuallyHidden.Root>{spokenShortcut(keys, platform)}</VisuallyHidden.Root>
    </kbd>
  );
}
