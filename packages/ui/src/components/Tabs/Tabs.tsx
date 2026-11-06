import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { Badge } from '../Badge/Badge.js';
import styles from './Tabs.module.css';

/** Header view tabs and settings tabs (design-system §5.1). Radix: arrow keys move between tabs. */
export function Tabs({ className, ...props }: ComponentPropsWithRef<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={cx(styles.root, className)} {...props} />;
}

export function TabsList({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.List> & { 'aria-label': string }) {
  return <RadixTabs.List className={cx(styles.list, className)} {...props} />;
}

export function TabsTrigger({
  className,
  children,
  count,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Trigger> & { children: ReactNode; count?: number }) {
  return (
    <RadixTabs.Trigger className={cx(styles.trigger, className)} {...props}>
      {children}
      {count !== undefined && <Badge count={count} />}
    </RadixTabs.Trigger>
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx(styles.content, className)} {...props} />;
}
