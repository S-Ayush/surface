// One status on the workflow page (SPEC-010 §3.1): the category icon in the status color, the
// name, a "Default" badge, "·" and the description, the issue count ("—" until the server's count
// is wired, PLAN-010 S5), and a "…" menu. It is an option of the page's listbox in the
// `settings-row` scope: its keys are the registry's (rowKeys.ts), not handlers here.
import { Badge, Menu, StatusIcon } from '@surface/ui';
import { CircleCheck, GripVertical, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import styles from './statuses.module.css';
import { STATUS_ROW_ATTRIBUTE } from './rowKeys.js';
import { canMakeDefault, descriptionText, isSystemStatus, type StatusItem } from './model.js';

export type StatusRowProps = {
  readonly status: StatusItem;
  readonly isDefault: boolean;
  readonly canEdit: boolean;
  /** The row the listbox's roving tab stop is on. */
  readonly active: boolean;
  readonly dragging: boolean;
  readonly onFocus: () => void;
  readonly onEdit: () => void;
  /** `team.setDefaultStatus` for this status ("Make default", Backlog and Unstarted only). */
  readonly onMakeDefault: () => void;
  readonly onDelete: () => void;
  readonly onDragStart: (pointerId: number) => void;
};

export function StatusRow({
  status,
  isDefault,
  canEdit,
  active,
  dragging,
  onFocus,
  onEdit,
  onMakeDefault,
  onDelete,
  onDragStart,
}: StatusRowProps) {
  const system = isSystemStatus(status);
  const description = descriptionText(status);
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-shortcut-scope="settings-row"
      {...{ [STATUS_ROW_ATTRIBUTE]: status.id }}
      data-dragging={dragging || undefined}
      className={styles.row}
      onFocus={onFocus}
    >
      {canEdit && !system ? (
        <span
          className={styles.grip}
          aria-hidden="true"
          onPointerDown={(event) => onDragStart(event.pointerId)}
        >
          <GripVertical size={16} />
        </span>
      ) : (
        <span className={styles.grip} aria-hidden="true" />
      )}
      <StatusIcon category={status.category} color={status.color} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{status.name}</span>
        {isDefault && <Badge variant="accent">Default</Badge>}
        {system && <Badge>System</Badge>}
        {description !== undefined && <span className={styles.rowMeta}>· {description}</span>}
      </span>
      <span className={styles.count} title="Issue counts arrive with issues">
        <span aria-label="Issue count not available">—</span>
      </span>
      {canEdit && !system ? (
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              className={styles.menuButton}
              aria-label={`Actions for ${status.name}`}
              // The row's keys cover these; Tab goes row to row (settings-row keys).
              tabIndex={-1}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          }
          items={[
            { type: 'item', label: 'Edit', icon: <Pencil size={16} />, onSelect: onEdit },
            ...(canMakeDefault(status, isDefault)
              ? [
                  {
                    type: 'item' as const,
                    label: 'Make default',
                    icon: <CircleCheck size={16} />,
                    onSelect: onMakeDefault,
                  },
                ]
              : []),
            { type: 'item', label: 'Delete…', icon: <Trash2 size={16} />, onSelect: onDelete },
          ]}
        />
      ) : (
        <span className={styles.menuSpace} />
      )}
    </div>
  );
}
