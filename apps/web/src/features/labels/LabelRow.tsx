// One label or group on the labels page (SPEC-010 §3.2): a color dot, the name, the description
// (editable in place), the usage columns ("—" until PLAN-010 S5), the created day and a "…" menu.
// It is an option of the page's listbox in the `settings-row` scope: its keys are the registry's
// (rowKeys.ts), not handlers here. A group row also has the group type select and an expand toggle.
import { Menu } from '@surface/ui';
import { ChevronRight, MoreHorizontal, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { LABEL_ROW_ATTRIBUTE } from './rowKeys.js';
import { dayText, type LabelItem } from './model.js';
import styles from './labels.module.css';

export type LabelRowProps = {
  readonly label: LabelItem;
  /** 0 for a top-level label or group, 1 for a label inside a group. */
  readonly depth: 0 | 1;
  readonly expanded?: boolean;
  readonly canEdit: boolean;
  /** "Move to workspace…" is offered (a team label or group that sits in no group). */
  readonly canMove: boolean;
  /** The row the listbox's roving tab stop is on. */
  readonly active: boolean;
  readonly onFocus: () => void;
  readonly onToggle?: () => void;
  readonly onEdit: () => void;
  readonly onAddToGroup?: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
  readonly onDescription: (description: string) => void;
  readonly onExclusive: (exclusive: boolean) => void;
};

export function LabelRow({
  label,
  depth,
  expanded,
  canEdit,
  canMove,
  active,
  onFocus,
  onToggle,
  onEdit,
  onAddToGroup,
  onMove,
  onDelete,
  onDescription,
  onExclusive,
}: LabelRowProps) {
  const [draft, setDraft] = useState<string>();
  const saved = label.description ?? '';
  const commit = () => {
    if (draft !== undefined && draft.trim() !== saved) onDescription(draft.trim());
    setDraft(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setDraft(undefined);
      event.currentTarget.blur();
    }
  };
  const items = [
    {
      type: 'item' as const,
      label: 'Edit label name',
      icon: <Pencil size={16} />,
      onSelect: onEdit,
    },
    ...(label.isGroup && onAddToGroup !== undefined
      ? [
          {
            type: 'item' as const,
            label: 'Add label to group',
            icon: <Plus size={16} />,
            onSelect: onAddToGroup,
          },
        ]
      : []),
    ...(canMove
      ? [
          {
            type: 'item' as const,
            label: 'Move to workspace…',
            icon: <Upload size={16} />,
            onSelect: onMove,
          },
        ]
      : []),
    { type: 'item' as const, label: 'Delete…', icon: <Trash2 size={16} />, onSelect: onDelete },
  ];
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-shortcut-scope="settings-row"
      {...{ [LABEL_ROW_ATTRIBUTE]: label.id }}
      data-depth={depth}
      className={styles.row}
      onFocus={onFocus}
    >
      {label.isGroup ? (
        <button
          type="button"
          className={styles.toggle}
          aria-label={`${expanded === true ? 'Collapse' : 'Expand'} ${label.name}`}
          aria-expanded={expanded === true}
          // The row's keys cover this; Tab goes row to row.
          tabIndex={-1}
          onClick={onToggle}
        >
          <ChevronRight size={16} aria-hidden="true" data-open={expanded === true || undefined} />
        </button>
      ) : (
        <span className={styles.toggle} aria-hidden="true" />
      )}
      <span
        className={styles.dot}
        aria-hidden="true"
        style={{ backgroundColor: `var(--label-${label.color})` }}
      />
      <span className={styles.name}>{label.name}</span>
      {label.isGroup && canEdit ? (
        <select
          className={styles.select}
          aria-label={`Group type of ${label.name}`}
          value={label.exclusive ? 'single' : 'multiple'}
          tabIndex={-1}
          onChange={(event) => onExclusive(event.target.value === 'single')}
        >
          <option value="single">Group type: Single</option>
          <option value="multiple">Group type: Multiple</option>
        </select>
      ) : label.isGroup ? (
        <span className={styles.meta}>{label.exclusive ? 'Single' : 'Multiple'}</span>
      ) : null}
      {canEdit ? (
        <input
          className={styles.description}
          aria-label={`Description of ${label.name}`}
          placeholder="Add description…"
          value={draft ?? saved}
          tabIndex={-1}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      ) : (
        <span className={styles.descriptionText}>{saved}</span>
      )}
      <span className={styles.column} title="Usage arrives with issues">
        —
      </span>
      <span className={styles.column}>—</span>
      <span className={styles.column}>—</span>
      <span className={styles.column}>{dayText(label.createdAt)}</span>
      {canEdit ? (
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              className={styles.menuButton}
              aria-label={`Actions for ${label.name}`}
              // The row's keys cover these; Tab goes row to row (settings-row keys).
              tabIndex={-1}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          }
          items={items}
        />
      ) : (
        <span className={styles.menuSpace} />
      )}
    </div>
  );
}
