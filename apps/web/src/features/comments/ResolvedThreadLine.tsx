// A resolved thread as one line (SPEC-013 §3.3a): the first line of the root's text, "Resolved by
// Ada · 2h ago", a **Reopen** button and a chevron that expands the thread. Presentational.
import { Button, IconButton } from '@surface/ui';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { agoText } from '../issues/issue-view.js';
import { absoluteTime, commentDomId } from './model.js';
import styles from './comments.module.css';

export interface ResolvedThreadLineProps {
  /** The root comment's id: a comment link to it lands here while the thread is collapsed. */
  readonly id: string;
  /** The first line of the root's text; empty for a placeholder root. */
  readonly text: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly now: Date;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Absent on an archived or deleted issue (D10). */
  readonly onReopen?: () => void;
}

export function ResolvedThreadLine({
  id,
  text,
  resolvedBy,
  resolvedAt,
  now,
  expanded,
  onToggle,
  onReopen,
}: ResolvedThreadLineProps) {
  return (
    <div className={styles.resolved} id={expanded ? undefined : commentDomId(id)}>
      <IconButton
        aria-label={expanded ? 'Collapse resolved thread' : 'Expand resolved thread'}
        aria-expanded={expanded}
        icon={expanded ? <ChevronDown /> : <ChevronRight />}
        size="sm"
        onClick={onToggle}
      />
      <CheckCircle2 size={16} aria-hidden="true" />
      <span className={styles.resolvedText}>{text === '' ? 'Deleted comment' : text}</span>
      <span title={absoluteTime(resolvedAt)}>
        Resolved by {resolvedBy} · {agoText(resolvedAt, now)}
      </span>
      {onReopen !== undefined && (
        <Button variant="secondary" size="sm" onClick={onReopen}>
          Reopen
        </Button>
      )}
    </div>
  );
}
