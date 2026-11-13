// Pieces both list pages show: the delayed skeleton and the Create issue button.
import { Button, Skeleton, VisuallyHidden } from '@surface/ui';
import { useCallback, useEffect, useState } from 'react';
import { useObserved } from '../../app/context.js';
import { useCommandRegistry } from '../../shortcuts/ShortcutProvider.js';
import styles from './IssueList.module.css';

/** Shows a skeleton only if the wait outlasts `ms` (design-system §4: nothing flashes). */
export function useAfter(ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setElapsed(true);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [ms]);
  return elapsed;
}

export function ListSkeleton() {
  const show = useAfter(150);
  return (
    <div className={styles.skeleton}>
      <VisuallyHidden>
        <p role="status">Loading…</p>
      </VisuallyHidden>
      {show &&
        [0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} shape="text" width="100%" aria-hidden="true" />
        ))}
    </div>
  );
}

/**
 * "Create issue" opens the composer (`issue:create`), prefilled from the route's team like `C`;
 * hidden while the command has no handler.
 */
export function CreateIssueButton() {
  const commands = useCommandRegistry();
  const available = useObserved(
    useCallback(() => commands.isAvailable('issue:create'), [commands]),
  );
  if (!available) return undefined;
  return (
    <Button
      variant="primary"
      onClick={() => {
        commands.run('issue:create');
      }}
    >
      Create issue
    </Button>
  );
}
