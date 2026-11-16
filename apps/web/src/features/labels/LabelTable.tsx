// The labels table (SPEC-010 §3.2): groups with their labels, sorted by name, as a `role="listbox"`
// of rows in the `settings-row` scope, with the inline edit form replacing the row being edited.
// The page owns the state; this renders it.
import type { LabelScopeInfo } from '@surface/domain';
import { ChevronRight } from 'lucide-react';
import { LabelForm, type LabelFormValues } from './LabelForm.js';
import { LabelRow } from './LabelRow.js';
import { usageColumns, type LabelEntry, type LabelItem, type LabelUsage } from './model.js';
import styles from './labels.module.css';

export type LabelTableProps = {
  readonly ariaLabel: string;
  readonly entries: readonly LabelEntry[];
  readonly scope: LabelScopeInfo;
  /** Every label of the scope, for the edit form's checks and group choices. */
  readonly scopeLabels: readonly LabelItem[];
  readonly expanded: ReadonlySet<string>;
  /** A name filter is on: groups with a match are shown open. */
  readonly filtering: boolean;
  readonly editing: string | undefined;
  readonly canEdit: boolean;
  readonly canMove: boolean;
  readonly tabStop: string | undefined;
  /** `label.usage` by label id; undefined until it answers, and offline ("—"). */
  readonly usage: ReadonlyMap<string, LabelUsage> | undefined;
  readonly onFocusRow: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onEdit: (id: string | undefined) => void;
  readonly onSave: (label: LabelItem, values: LabelFormValues) => Promise<string | undefined>;
  readonly onAddToGroup: (group: LabelItem) => void;
  readonly onMove: (label: LabelItem) => void;
  readonly onArchive: (label: LabelItem) => void;
  readonly onUnarchive: (label: LabelItem) => void;
  /** The collapsed "Archived" section at the end (§3.2). */
  readonly archived: readonly LabelEntry[];
  readonly archivedOpen: boolean;
  readonly onToggleArchived: () => void;
  readonly onDelete: (label: LabelItem) => void;
  readonly onDescription: (label: LabelItem, description: string) => void;
  readonly onExclusive: (label: LabelItem, exclusive: boolean) => void;
  readonly onKeyDown: React.KeyboardEventHandler<HTMLElement>;
};

/** The ids of the rows in display order: what ↑/↓ walks and what the tab stop falls back to. */
export function visibleIds(
  entries: readonly LabelEntry[],
  expanded: ReadonlySet<string>,
  filtering: boolean,
  archived: readonly LabelEntry[] = [],
  archivedOpen = false,
): string[] {
  const idsOf = (list: readonly LabelEntry[]) =>
    list.flatMap(({ label, children }) => [
      label.id,
      ...(label.isGroup && (filtering || expanded.has(label.id)) ? children.map((c) => c.id) : []),
    ]);
  return [...idsOf(entries), ...(archivedOpen ? idsOf(archived) : [])];
}

/** A label the answer doesn't list (created since it was asked): nothing carries it yet. */
const NO_USAGE: LabelUsage = { issues: 0, teams: [], lastAppliedAt: null };

function archivedCount(entries: readonly LabelEntry[]): number {
  return entries.reduce((n, e) => n + 1 + e.children.length, 0);
}

export function LabelTable(props: LabelTableProps) {
  const { entries, editing, canEdit, canMove, tabStop, filtering } = props;
  const row = (label: LabelItem, depth: 0 | 1, isExpanded?: boolean, groupArchived = false) =>
    editing === label.id ? (
      <LabelForm
        key={label.id}
        label={label}
        scope={props.scope}
        scopeLabels={props.scopeLabels}
        onSubmit={(values) => props.onSave(label, values)}
        onCancel={() => props.onEdit(undefined)}
      />
    ) : (
      <LabelRow
        key={label.id}
        label={label}
        depth={depth}
        {...(isExpanded === undefined ? {} : { expanded: isExpanded })}
        canEdit={canEdit}
        canMove={canMove && depth === 0}
        groupArchived={groupArchived}
        active={label.id === tabStop}
        usage={usageColumns(
          props.usage === undefined ? undefined : (props.usage.get(label.id) ?? NO_USAGE),
        )}
        onFocus={() => props.onFocusRow(label.id)}
        onToggle={() => props.onToggle(label.id)}
        onEdit={() => props.onEdit(label.id)}
        {...(label.isGroup ? { onAddToGroup: () => props.onAddToGroup(label) } : {})}
        onMove={() => props.onMove(label)}
        onArchive={() => props.onArchive(label)}
        onUnarchive={() => props.onUnarchive(label)}
        onDelete={() => props.onDelete(label)}
        onDescription={(text) => props.onDescription(label, text)}
        onExclusive={(exclusive) => props.onExclusive(label, exclusive)}
      />
    );
  const renderEntry = ({ label, children }: LabelEntry) => {
    const open = label.isGroup && (props.expanded.has(label.id) || filtering);
    return (
      <div key={label.id} role="presentation">
        {row(label, 0, label.isGroup ? open : undefined)}
        {open && children.map((child) => row(child, 1, undefined, label.archived))}
      </div>
    );
  };
  return (
    <>
      <div
        role="listbox"
        aria-label={props.ariaLabel}
        className={styles.list}
        onKeyDown={props.onKeyDown}
      >
        <div className={styles.header} aria-hidden="true">
          <span className={styles.headerName}>Name</span>
          <span className={styles.headerDescription}>Description</span>
          <span className={styles.column}>Used in</span>
          <span className={styles.column}>Issues</span>
          <span className={styles.column}>Last applied</span>
          <span className={styles.column}>Created</span>
        </div>
        {entries.map(renderEntry)}
      </div>
      {/* Outside the listbox, whose only children are rows; a native button, so Tab and Enter work. */}
      {props.archived.length > 0 && (
        <section aria-label="Archived labels">
          <button
            type="button"
            className={styles.archivedToggle}
            aria-expanded={props.archivedOpen}
            onClick={props.onToggleArchived}
          >
            <ChevronRight
              size={16}
              aria-hidden="true"
              data-open={props.archivedOpen || undefined}
            />
            Archived ({archivedCount(props.archived)})
          </button>
          {props.archivedOpen && (
            <div
              role="listbox"
              aria-label={`Archived ${props.ariaLabel}`}
              className={styles.list}
              onKeyDown={props.onKeyDown}
            >
              {props.archived.map(renderEntry)}
            </div>
          )}
        </section>
      )}
    </>
  );
}
