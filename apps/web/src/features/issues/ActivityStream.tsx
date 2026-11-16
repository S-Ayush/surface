// The issue page's activity stream (SPEC-012 §3.4 item 4, §7.4, D18; SPEC-013 §7; PLAN-012 S4b):
// history lines and comment threads in one list, oldest first, the newest 30 with "Show N earlier"
// above them. Presentational: the caller hands the items, the actor names and how a thread renders
// (`ThreadView`, which reads the comments' context).
import { activityActor, activityLines } from '@surface/domain';
import { Button } from '@surface/ui';
import { Fragment, useState, type ReactNode } from 'react';
import { absoluteTime, agoLong } from '../comments/model.js';
import type { Thread } from '../comments/model.js';
import {
  showEarlierLabel,
  visibleActivity,
  type ActivityItem,
  type HistoryRow,
} from './activity-model.js';
import { agoText } from './issue-view.js';
import styles from './activity.module.css';

export interface ActivityStreamProps {
  readonly items: readonly ActivityItem[];
  /** The actor's name for an entry (from the replica by `actorId`; the stored names are in it). */
  readonly actorName: (entry: HistoryRow) => string;
  readonly now: Date;
  /** One thread as a list item (`ThreadView` renders an `li`). */
  readonly renderThread: (thread: Thread) => ReactNode;
}

export function ActivityStream({ items, actorName, now, renderThread }: ActivityStreamProps) {
  const [expanded, setExpanded] = useState(false);
  const { earlier, shown } = visibleActivity(items, expanded);
  if (items.length === 0) return null;
  return (
    <div className={styles.stream} data-slot="activity">
      {earlier > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.earlier}
          onClick={() => {
            setExpanded(true);
          }}
        >
          {showEarlierLabel(earlier)}
        </Button>
      )}
      <ol className={styles.list} aria-label="Activity">
        {shown.map((item) =>
          item.kind === 'history' ? (
            <HistoryItem key={item.id} entry={item.entry} name={actorName(item.entry)} now={now} />
          ) : (
            <Fragment key={item.id}>{renderThread(item.thread)}</Fragment>
          ),
        )}
      </ol>
    </div>
  );
}

/**
 * One history entry: its lines as text (§7.4: never colour alone), the relative time with the full
 * one in a tooltip, and an `article` labelled with the actor and the time.
 */
export function HistoryItem({ entry, name, now }: { entry: HistoryRow; name: string; now: Date }) {
  const lines = activityLines(entry, name);
  const who = entry.actorKind === 'system' ? 'Surface' : activityActor(name, entry.actorKind);
  const at = entry.createdAt;
  return (
    <li className={styles.item}>
      <article className={styles.history} aria-label={`${who}, ${agoLong(at, now)}`}>
        {lines.map((line, index) => (
          <p key={index} className={styles.line}>
            {line}
            {index === lines.length - 1 && (
              <>
                {' · '}
                <time className={styles.time} dateTime={at} title={absoluteTime(at)}>
                  {agoText(at, now)}
                </time>
              </>
            )}
          </p>
        ))}
      </article>
    </li>
  );
}
