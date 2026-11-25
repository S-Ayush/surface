// The issue page's properties panel (SPEC-012 §3.4 item 5): one PropertyPill per property, then
// "Created by" and "Updated". The pills open the bound pickers (PLAN-012 S6) unless the issue is
// read-only (archived, deleted, or not in the replica).
import { formatDueDate, formatEstimate, priorityLabel } from '@surface/domain';
import type { MouseEvent } from 'react';
import { Avatar, PriorityIcon, PropertyPill, StatusIcon } from '@surface/ui';
import type { PickerKind } from './issue-pickers.js';
import { agoText, estimateRow, shortDate, type IssueView } from './issue-view.js';
import styles from './issue-page.module.css';

function todayYmd(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function PropertiesPanel({
  view,
  now,
  onPick,
  stacked = false,
}: {
  view: IssueView;
  now: Date;
  /** Opens the picker for a property, anchored to its pill. Absent: the pills are read-only. */
  onPick?: (kind: PickerKind, anchor: HTMLElement) => void;
  /** Below 768 px (SPEC-012 §7.3): the properties wrap as a row of pills under the title. */
  stacked?: boolean;
}) {
  /** The pill's props: a button that opens its picker, or read-only text. */
  const pill = (kind: PickerKind) =>
    onPick === undefined
      ? { readOnly: true as const }
      : {
          'data-property': kind,
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            onPick(kind, event.currentTarget);
          },
        };
  const estimate = estimateRow(view);
  const estimateText =
    estimate.shown && estimate.value !== null
      ? view.estimateConfig === null
        ? String(estimate.value)
        : formatEstimate(view.estimateConfig, estimate.value)
      : null;
  const labelNames = view.labels.map((label) => label.name);
  return (
    <section
      className={stacked ? `${styles.panel} ${styles.stacked}` : styles.panel}
      aria-label="Properties"
    >
      <p className={styles.sectionLabel} aria-hidden="true">
        Properties
      </p>
      <dl className={styles.properties}>
        <div className={styles.property}>
          <dt>Status</dt>
          <dd>
            <PropertyPill
              variant="panel"
              {...pill('status')}
              property="Status"
              value={view.status.name}
              icon={<StatusIcon category={view.status.category} color={view.status.color} />}
            />
          </dd>
        </div>
        <div className={styles.property}>
          <dt>Priority</dt>
          <dd>
            <PropertyPill
              variant="panel"
              {...pill('priority')}
              property="Priority"
              value={priorityLabel(view.priority)}
              icon={<PriorityIcon priority={view.priority} />}
            />
          </dd>
        </div>
        <div className={styles.property}>
          <dt>Assignee</dt>
          <dd>
            <PropertyPill
              variant="panel"
              {...pill('assignee')}
              property="Assignee"
              value={view.assignee?.name ?? null}
              icon={
                view.assignee === null ? undefined : <Avatar name={view.assignee.name} size={16} />
              }
            />
          </dd>
        </div>
        <div className={styles.property}>
          <dt>Labels</dt>
          <dd>
            <PropertyPill
              variant="panel"
              {...pill('labels')}
              property="Labels"
              value={labelNames.length === 0 ? null : labelNames.join(', ')}
            />
          </dd>
        </div>
        {estimate.shown && (
          <div className={styles.property}>
            <dt>Estimate</dt>
            <dd>
              <PropertyPill
                variant="panel"
                {...pill('estimate')}
                property="Estimate"
                value={estimateText}
              />
              {estimate.offScale && <span className={styles.hint}>Off scale</span>}
            </dd>
          </div>
        )}
        <div className={styles.property}>
          <dt>Due date</dt>
          <dd>
            <PropertyPill
              variant="panel"
              {...pill('dueDate')}
              property="Due date"
              value={view.dueDate === null ? null : formatDueDate(view.dueDate, todayYmd(now))}
            />
          </dd>
        </div>
      </dl>
      <p className={styles.meta}>
        {`Created${view.creatorName === null ? '' : ` by ${view.creatorName}`} · ${shortDate(new Date(view.createdAt), now)}`}
      </p>
      <p className={styles.meta}>{`Updated ${agoText(view.updatedAt, now)}`}</p>
    </section>
  );
}
