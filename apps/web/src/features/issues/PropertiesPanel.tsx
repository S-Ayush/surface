// The issue page's properties panel (SPEC-012 §3.4 item 5): one PropertyPill per property, then
// "Created by" and "Updated". The pills are read-only until PLAN-012 S6 binds the pickers.
import { formatDueDate, formatEstimate, priorityLabel } from '@surface/domain';
import { Avatar, PriorityIcon, PropertyPill, StatusIcon } from '@surface/ui';
import { agoText, estimateRow, shortDate, type IssueView } from './issue-view.js';
import styles from './issue-page.module.css';

function todayYmd(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function PropertiesPanel({ view, now }: { view: IssueView; now: Date }) {
  const estimate = estimateRow(view);
  const estimateText =
    estimate.shown && estimate.value !== null
      ? view.estimateConfig === null
        ? String(estimate.value)
        : formatEstimate(view.estimateConfig, estimate.value)
      : null;
  const labelNames = view.labels.map((label) => label.name);
  return (
    <section className={styles.panel} aria-label="Properties">
      <dl className={styles.properties}>
        <div className={styles.property}>
          <dt>Status</dt>
          <dd>
            <PropertyPill
              readOnly
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
              readOnly
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
              readOnly
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
              readOnly
              property="Labels"
              value={labelNames.length === 0 ? null : labelNames.join(', ')}
            />
          </dd>
        </div>
        {estimate.shown && (
          <div className={styles.property}>
            <dt>Estimate</dt>
            <dd>
              <PropertyPill readOnly property="Estimate" value={estimateText} />
              {estimate.offScale && <span className={styles.hint}>Off scale</span>}
            </dd>
          </div>
        )}
        <div className={styles.property}>
          <dt>Due date</dt>
          <dd>
            <PropertyPill
              readOnly
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
