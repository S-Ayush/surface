import type { Priority, StatusCategory } from '@surface/domain';
import { priorityLabel } from '@surface/domain';
import type { CSSProperties, MouseEvent } from 'react';
import { cx } from '../../internal/cx.js';
import { VisuallyHidden } from '../../visually-hidden.js';
import type { LabelHue } from '../../tokens.gen.js';
import { Avatar } from '../Avatar/Avatar.js';
import { LabelChip } from '../LabelChip/LabelChip.js';
import { PriorityIcon } from '../PriorityIcon/PriorityIcon.js';
import { PropertyPill } from '../PropertyPill/PropertyPill.js';
import { StatusIcon } from '../StatusIcon/StatusIcon.js';
import styles from './IssueRow.module.css';

export type IssueRowProperty =
  'priority' | 'status' | 'labels' | 'estimate' | 'dueDate' | 'assignee';

export type IssueRowProps = {
  /** 1-based position in the grid: `aria-rowindex`. */
  rowIndex: number;
  /** "ENG-42", or "ENG-…" for a pending issue. */
  identifier: string;
  title: string;
  priority: Priority;
  status: { name: string; category: StatusCategory; color: LabelHue };
  labels?: readonly { id: string; name: string; color: LabelHue }[];
  /** Hidden when undefined (the team doesn't use estimates); an empty value is null. */
  estimate?: { label: string; offScale?: boolean } | null;
  dueDate?: { label: string; overdue?: boolean } | null;
  assignee?: { name: string; avatarUrl?: string } | null;
  /** The short created date ("Nov 6"). Hidden when undefined. For deleted issues, the deletion day. */
  createdLabel?: string;
  /** Below 768 px: priority, identifier, title, status and assignee only. */
  compact?: boolean;
  /** Pending: the server hasn't confirmed the issue yet. */
  pending?: boolean;
  /** The row has keyboard focus (set by the list's focus model; the DOM focus follows tabIndex). */
  focused?: boolean;
  /** Roving tabindex from VirtualList. */
  tabIndex?: 0 | -1;
  /** `aria-level` in a treegrid: 2 under a group header. */
  level?: number;
  style?: CSSProperties;
  className?: string;
  /** Click on the row (not on a pill): open the issue. */
  onOpen?: () => void;
  /** Pills become buttons when this is set; absent, they are read-only text. */
  onPropertyClick?: (property: IssueRowProperty, anchor: HTMLElement) => void;
  /** Right-click or the context-menu key. */
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
};

/**
 * One issue in a list (design-system §5.3, SPEC-012 §3.3 item 5): fixed columns priority,
 * identifier, status, title, labels, estimate, due date, assignee, created. It is a `row` of a
 * `grid`; the list owns focus (roving tabindex) and the keys.
 */
export function IssueRow(props: IssueRowProps) {
  const {
    rowIndex,
    identifier,
    title,
    priority,
    status,
    labels = [],
    estimate,
    dueDate,
    assignee,
    createdLabel,
    compact = false,
    pending = false,
    focused = false,
    tabIndex = -1,
    level,
    style,
    className,
    onOpen,
    onPropertyClick,
    onContextMenu,
  } = props;

  const pill = (property: IssueRowProperty) =>
    onPropertyClick
      ? {
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onPropertyClick(property, event.currentTarget);
          },
          tabIndex: -1,
        }
      : { readOnly: true as const };

  const statusPill = (
    <PropertyPill
      property="Status"
      value={status.name}
      iconOnly
      icon={<StatusIcon category={status.category} color={status.color} />}
      {...pill('status')}
    />
  );
  const assigneePill = (
    <PropertyPill
      property="Assignee"
      value={assignee?.name ?? null}
      iconOnly
      icon={
        assignee ? (
          <Avatar name={assignee.name} src={assignee.avatarUrl} size={20} aria-hidden="true" />
        ) : (
          <span className={styles.noAssignee} aria-hidden="true" />
        )
      }
      {...pill('assignee')}
    />
  );

  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-level={level}
      tabIndex={tabIndex}
      data-focused={focused || undefined}
      data-compact={compact || undefined}
      data-pending={pending || undefined}
      className={cx(styles.root, compact && styles.compact, className)}
      style={style}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div role="gridcell" className={cx(styles.cell, styles.priority)}>
        <PropertyPill
          property="Priority"
          value={priorityLabel(priority)}
          iconOnly
          icon={<PriorityIcon priority={priority} />}
          {...pill('priority')}
        />
      </div>
      <div role="gridcell" className={cx(styles.cell, styles.identifier)}>
        {identifier}
      </div>
      {!compact && (
        <div role="gridcell" className={cx(styles.cell, styles.status)}>
          {statusPill}
        </div>
      )}
      <div role="gridcell" className={cx(styles.cell, styles.title)}>
        <span className={styles.titleText}>{title}</span>
      </div>
      {compact ? (
        <div role="gridcell" className={cx(styles.cell, styles.status)}>
          {statusPill}
        </div>
      ) : (
        <>
          <div role="gridcell" className={cx(styles.cell, styles.labels)}>
            {labels.length > 0 &&
              (onPropertyClick ? (
                <button
                  type="button"
                  className={styles.labelsButton}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPropertyClick('labels', event.currentTarget);
                  }}
                >
                  <VisuallyHidden>{`Labels: ${labels.map((label) => label.name).join(', ')}, change`}</VisuallyHidden>
                  <span aria-hidden="true" className={styles.labelsButton}>
                    {labels.map((label) => (
                      <LabelChip key={label.id} name={label.name} color={label.color} />
                    ))}
                  </span>
                </button>
              ) : (
                <span className={styles.labelsButton}>
                  {labels.map((label) => (
                    <LabelChip key={label.id} name={label.name} color={label.color} />
                  ))}
                </span>
              ))}
          </div>
          {estimate !== undefined && (
            <div role="gridcell" className={cx(styles.cell, styles.estimate)}>
              <PropertyPill
                property="Estimate"
                value={estimate?.label ?? null}
                className={estimate?.offScale ? styles.offScale : undefined}
                {...pill('estimate')}
              />
            </div>
          )}
          <div role="gridcell" className={cx(styles.cell, styles.date)}>
            {dueDate && (
              <PropertyPill
                property="Due date"
                value={dueDate.label}
                className={dueDate.overdue ? styles.overdue : undefined}
                {...pill('dueDate')}
              />
            )}
          </div>
        </>
      )}
      <div role="gridcell" className={cx(styles.cell, styles.assignee)}>
        {assigneePill}
      </div>
      {!compact && createdLabel !== undefined && (
        <div role="gridcell" className={cx(styles.cell, styles.created)}>
          {createdLabel}
        </div>
      )}
    </div>
  );
}
