import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './Skeleton.module.css';

export type SkeletonProps = Omit<ComponentPropsWithRef<'span'>, 'children'> & {
  /** `text` is one line of body text; `row` is a list row; `block` fills its container. */
  shape?: 'text' | 'row' | 'circle' | 'block';
  /** CSS width, e.g. "60%" or a token. Defaults to the full width. */
  width?: string;
};

/**
 * A placeholder for lazily loaded content. It fades in only after 150 ms, so fast loads never flash
 * (design-system §4 "Loading"). Decorative: the region that loads sets aria-busy.
 */
export function Skeleton({ shape = 'text', width, className, style, ...props }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.root, styles[shape], className)}
      style={width === undefined ? style : { ...style, width }}
      {...props}
    />
  );
}
