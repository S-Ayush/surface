// Layout helpers for stories only (not exported from the package).
import type { ReactNode } from 'react';
import styles from './helpers.module.css';

/** A labelled row of examples. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.items}>{children}</div>
    </div>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>;
}

/**
 * Wraps an example whose pseudo-state is forced by storybook-addon-pseudo-states: give the story
 * `parameters: PSEUDO_STATES` and use the ids "hover", "active" and "focus".
 */
export function StateCell({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.cell}>
      <div data-pseudo={id}>{children}</div>
      <span className={styles.caption}>{label}</span>
    </div>
  );
}

/** Pseudo-state parameters matching the ids used by <StateCell>. */
export const PSEUDO_STATES = {
  pseudo: {
    // The addon styles the matched elements themselves, so match what is inside the cell: every
    // element for hover/active (rules are scoped by class), only focusable ones for the focus ring.
    hover: ['[data-pseudo="hover"] *'],
    active: ['[data-pseudo="active"] *'],
    focusVisible: ['[data-pseudo="focus"] :is(button, input, textarea, [tabindex])'],
  },
};

/**
 * Whether `element` is what the pointer would hit at its centre, i.e. visible and not covered by
 * another layer. Testing Library's queries ignore stacking, so overlay tests check this too.
 */
export function isOnTop(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit !== null && element.contains(hit);
}
