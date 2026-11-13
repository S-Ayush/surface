// Settings → Labels (SPEC-010 §3.2): one page for a team's labels (`/settings/teams/:key/labels`)
// and one for the workspace's (`/settings/labels`, open to every member, D9). A table of labels and
// groups with a filter, inline new label, new group and edit rows, a description edited in place,
// and Move to workspace and Delete behind dialogs with the §3.2 wording. Everything shows at once
// (optimistic); a refusal rolls back and says why. Readers of a public team see the team page
// read-only with "Join the team to edit". The usage columns are "—" until PLAN-010 S5.
import { uuidv7 } from '@surface/domain';
import {
  labelArchive,
  labelCreate,
  labelDelete,
  labelMoveToWorkspace,
  labelUnarchive,
  labelUpdate,
  type InputOf,
} from '@surface/operations';
import { Button, Dialog, DialogClose, EmptyState, Input } from '@surface/ui';
import { Tag } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { rowFocusTarget } from '../statuses/rowKeys.js';
import { submitMutation, toastIfFailed, useShowsRejection } from '../teams/submit.js';
import { TeamSettingsLayout } from '../teams/TeamSettingsLayout.js';
import {
  WORKSPACE_SCOPE,
  clearCreateLabel,
  subscribeCreateLabel,
  takeCreateLabel,
} from './add-intent.js';
import type { LabelFormValues } from './LabelForm.js';
import { LabelTable, visibleIds } from './LabelTable.js';
import {
  allInScope,
  archivedEntries,
  inheritedCount,
  inheritedText,
  labelEntries,
  planNewGroup,
  planNewLabel,
  scopeInfo,
  scopeLabels,
  type LabelItem,
  type LabelsScope,
} from './model.js';
import { NewLabelRow, type NewLabelValues } from './NewLabelRow.js';
import { labelIdOf, labelRowHandlers } from './rowKeys.js';
import { useLabels } from './useLabels.js';
import styles from './labels.module.css';

export function TeamLabelsScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {({ team }) => (
        <Labels key={team.id} scope={{ kind: 'team', teamId: team.id, teamKey: team.key }} />
      )}
    </TeamSettingsLayout>
  );
}

export function WorkspaceLabelsScreen() {
  return (
    <div className={styles.screen}>
      <Labels scope={{ kind: 'workspace' }} />
    </div>
  );
}

/** Plain ↑/↓ (and Home/End) move focus between rows, as in any listbox (see `rowFocusTarget`). */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  const at = rows.findIndex((row) => row === event.target);
  const index = rowFocusTarget({ ...event, onRow: at >= 0 }, at, rows.length);
  const target = index === undefined ? undefined : rows[index];
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
}

type NewRow = { readonly kind: 'label' | 'group'; readonly initialText?: string };

function Labels({ scope }: { readonly scope: LabelsScope }) {
  const app = useApp();
  const data = useLabels(scope);
  const showsRejection = useShowsRejection();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [newRow, setNewRow] = useState<NewRow>();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<LabelItem>();
  const [moving, setMoving] = useState<LabelItem>();
  const [archiving, setArchiving] = useState<LabelItem>();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const canEdit = data?.access.edit === true;
  const formOpen = newRow !== undefined || editing !== undefined;
  const scopeKey = scope.kind === 'team' ? scope.teamKey : WORKSPACE_SCOPE;
  const teamArg = scope.kind === 'team' ? { team: scope.teamKey } : {};

  // "Create label…" from the command menu (§7.3): open the New label row, name field focused.
  useEffect(() => {
    const take = () => {
      if (takeCreateLabel(scopeKey)) {
        setEditing(undefined);
        setNewRow({ kind: 'label' });
      }
    };
    take();
    const stop = subscribeCreateLabel(take);
    return () => {
      stop();
      clearCreateLabel(scopeKey);
    };
  }, [scopeKey]);

  const own = data === null ? [] : scopeLabels(data.all, scope);
  const entries = labelEntries(own, filter);
  const filtering = filter.trim() !== '';
  const archived = data === null ? [] : archivedEntries(allInScope(data.all, scope), filter);
  const ids = visibleIds(entries, expanded, filtering, archived, archivedOpen || filtering);
  const tabStop = activeId !== undefined && ids.includes(activeId) ? activeId : ids[0];

  // The `settings-row` keys, through the engine (rowKeys.ts): Enter, E, Mod+Backspace.
  const handlers = labelRowHandlers(
    () => labelIdOf(document.activeElement),
    () =>
      canEdit &&
      !formOpen &&
      deleting === undefined &&
      moving === undefined &&
      archiving === undefined,
    {
      edit: (id) => openEdit(id),
      editName: (id) => openEdit(id),
      remove: (id) => {
        const label = own.find((l) => l.id === id);
        if (label !== undefined) askDelete(label);
      },
    },
  );
  useCommand('settings-row:edit', () => handlers['settings-row:edit']?.run(), {
    when: () => handlers['settings-row:edit']?.when?.() ?? false,
  });
  useCommand('settings-row:edit-name', () => handlers['settings-row:edit-name']?.run(), {
    when: () => handlers['settings-row:edit-name']?.when?.() ?? false,
  });
  useCommand('settings-row:delete', () => handlers['settings-row:delete']?.run(), {
    when: () => handlers['settings-row:delete']?.when?.() ?? false,
  });
  // Esc closes an open row first; otherwise the shell's own Esc step runs (SPEC-012 §4.2).
  useCommand(
    'ui:escape',
    () => {
      setNewRow(undefined);
      setEditing(undefined);
    },
    { level: 'page', when: () => formOpen },
  );

  function openEdit(id: string) {
    setNewRow(undefined);
    setEditing(id);
  }

  function askDelete(label: LabelItem) {
    setDialogError(undefined);
    setDeleting(label);
  }

  if (data === null) return null;
  const store = app.store;
  const everyLabel = allInScope(data.all, scope);
  const inherited = scope.kind === 'team' ? inheritedCount(data.all) : undefined;

  /** Runs one operation, answering the refusal to show, or undefined when it worked or queued. */
  const run = async <
    Op extends
      | typeof labelCreate
      | typeof labelUpdate
      | typeof labelDelete
      | typeof labelMoveToWorkspace
      | typeof labelArchive
      | typeof labelUnarchive,
  >(
    op: Op,
    input: InputOf<Op>,
  ): Promise<string | undefined> => {
    if (store === null) return undefined;
    const result = await submitMutation(store, op, input, { showsRejection });
    return result.kind === 'rejected' || result.kind === 'failed' ? result.message : undefined;
  };

  const create = async (
    { color, description }: NewLabelValues,
    steps: readonly NewLabelStepLike[],
  ) => {
    for (const [index, step] of steps.entries()) {
      const last = index === steps.length - 1;
      const refusal = await run(labelCreate, {
        id: step.id,
        ...teamArg,
        name: step.name,
        ...(step.isGroup ? { isGroup: true } : {}),
        ...(step.group === undefined ? {} : { group: step.group }),
        // The color and description are the typed label's; a group made on the way keeps the defaults.
        ...(last ? { color } : {}),
        ...(last && description.trim() !== '' ? { description: description.trim() } : {}),
      });
      if (refusal !== undefined) return refusal;
    }
    setNewRow(undefined);
    return undefined;
  };

  const save = async (label: LabelItem, values: LabelFormValues) => {
    const refusal = await run(labelUpdate, {
      label: label.id,
      ...teamArg,
      name: values.name,
      color: values.color,
      ...(label.isGroup || values.groupId === label.parentId ? {} : { group: values.groupId }),
    });
    if (refusal === undefined) {
      setEditing(undefined);
      focusRow(label.id);
    }
    return refusal;
  };

  const describe = (label: LabelItem, description: string) =>
    void run(labelUpdate, { label: label.id, ...teamArg, description }).then((refusal) => {
      if (refusal !== undefined) toastIfFailed({ kind: 'failed', message: refusal });
    });

  const setExclusive = (label: LabelItem, exclusive: boolean) =>
    void run(labelUpdate, { label: label.id, ...teamArg, exclusive });

  const confirm = async (action: () => Promise<string | undefined>, close: () => void) => {
    if (busy) return;
    setBusy(true);
    const refusal = await action();
    setBusy(false);
    if (refusal === undefined) close();
    else setDialogError(refusal);
  };

  const newIds = () => uuidv7();
  const row = newRow;
  const empty = own.length === 0 && archived.length === 0 && row === undefined;

  return (
    <>
      {scope.kind === 'team' && !canEdit && <p className={styles.note}>Join the team to edit</p>}
      <div className={styles.toolbar}>
        <Input
          aria-label="Filter by name"
          placeholder="Filter by name…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {canEdit && (
          <>
            <Button
              variant="secondary"
              disabled={formOpen}
              onClick={() => {
                setEditing(undefined);
                setNewRow({ kind: 'group' });
              }}
            >
              New group
            </Button>
            <Button
              disabled={formOpen}
              onClick={() => {
                setEditing(undefined);
                setNewRow({ kind: 'label' });
              }}
            >
              New label
            </Button>
          </>
        )}
      </div>
      {row !== undefined && (
        <NewLabelRow
          key={`${row.kind}:${row.initialText ?? ''}`}
          kind={row.kind}
          {...(row.initialText === undefined ? {} : { initialText: row.initialText })}
          plan={(text) =>
            row.kind === 'group'
              ? planNewGroup(text, everyLabel, scope, newIds)
              : planNewLabel(text, everyLabel, scope, newIds)
          }
          onSubmit={(values, plan) =>
            plan.ok ? create(values, plan.steps) : Promise.resolve(undefined)
          }
          onCancel={() => setNewRow(undefined)}
        />
      )}
      {empty ? (
        <EmptyState
          icon={<Tag size={20} />}
          title={
            scope.kind === 'team'
              ? 'No team labels yet. Workspace labels are available to every team.'
              : 'No workspace labels yet'
          }
        />
      ) : (
        <LabelTable
          ariaLabel={scope.kind === 'team' ? `${scope.teamKey} labels` : 'Workspace labels'}
          entries={entries}
          scope={scopeInfo(scope)}
          scopeLabels={everyLabel}
          expanded={expanded}
          filtering={filtering}
          editing={editing}
          canEdit={canEdit}
          canMove={data.access.move}
          tabStop={tabStop}
          onFocusRow={setActiveId}
          onToggle={(id) =>
            setExpanded((open) => {
              const next = new Set(open);
              if (!next.delete(id)) next.add(id);
              return next;
            })
          }
          onEdit={(id) => (id === undefined ? setEditing(undefined) : openEdit(id))}
          onSave={save}
          onAddToGroup={(group) => {
            setEditing(undefined);
            setExpanded((open) => new Set(open).add(group.id));
            setNewRow({ kind: 'label', initialText: `${group.name}/` });
          }}
          onMove={(label) => {
            setDialogError(undefined);
            setMoving(label);
          }}
          onArchive={(label) => {
            setDialogError(undefined);
            setArchiving(label);
          }}
          onUnarchive={(label) =>
            void run(labelUnarchive, { label: label.id, ...teamArg }).then((refusal) => {
              if (refusal !== undefined) toastIfFailed({ kind: 'failed', message: refusal });
            })
          }
          archived={archived}
          archivedOpen={archivedOpen || filtering}
          onToggleArchived={() => setArchivedOpen((open) => !open)}
          onDelete={askDelete}
          onDescription={describe}
          onExclusive={setExclusive}
          onKeyDown={moveFocus}
        />
      )}
      {inherited !== undefined && (
        <p className={styles.footer}>
          <Link to="/settings/labels">{inheritedText(inherited)}</Link>
        </p>
      )}
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={`Delete label "${deleting?.name ?? ''}"?`}
        description="It will be removed from every issue that has it. This can't be undone."
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                if (deleting === undefined) return;
                void confirm(
                  () => run(labelDelete, { label: deleting.id, ...teamArg }),
                  () => setDeleting(undefined),
                );
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        {dialogError !== undefined && deleting !== undefined && (
          <p role="alert" className={styles.formError}>
            {dialogError}
          </p>
        )}
      </Dialog>
      <Dialog
        open={archiving !== undefined}
        onOpenChange={(open) => {
          if (!open) setArchiving(undefined);
        }}
        title={`Archive label "${archiving?.name ?? ''}"?`}
        description={`This label will no longer be available to apply to issues. Issues with the label already applied will remain unchanged.${archiving?.isGroup === true ? ' Its labels are archived too.' : ''}`}
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              loading={busy}
              onClick={() => {
                if (archiving === undefined) return;
                void confirm(
                  () => run(labelArchive, { label: archiving.id, ...teamArg }),
                  () => setArchiving(undefined),
                );
              }}
            >
              Archive
            </Button>
          </>
        }
      >
        {dialogError !== undefined && archiving !== undefined && (
          <p role="alert" className={styles.formError}>
            {dialogError}
          </p>
        )}
      </Dialog>
      <Dialog
        open={moving !== undefined}
        onOpenChange={(open) => {
          if (!open) setMoving(undefined);
        }}
        title={`Move "${moving?.name ?? ''}" to the workspace?`}
        description="This label will be available to every team. This can't be undone."
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              loading={busy}
              onClick={() => {
                if (moving === undefined || scope.kind !== 'team') return;
                void confirm(
                  () => run(labelMoveToWorkspace, { label: moving.id, team: scope.teamKey }),
                  () => setMoving(undefined),
                );
              }}
            >
              Move to workspace
            </Button>
          </>
        }
      >
        {dialogError !== undefined && moving !== undefined && (
          <p role="alert" className={styles.formError}>
            {dialogError}
          </p>
        )}
      </Dialog>
    </>
  );
}

type NewLabelStepLike = {
  readonly id: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly group?: string;
};

/** Puts focus back on a row once it has re-rendered, so a keyboard user keeps their place. */
function focusRow(labelId: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-label-id="${labelId}"]`)?.focus();
  });
}
