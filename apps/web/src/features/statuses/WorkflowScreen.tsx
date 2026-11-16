// Team settings → Workflow (SPEC-010 §3.1): the team's statuses grouped by category, with inline
// add and edit, reorder (drag, or the `settings-row` keys), and delete behind a confirm dialog.
// Everything shows at once (optimistic); a refusal rolls back and says why. Readers of a public
// team see the page read-only with "Join the team to edit". Issue counts come from the server
// (`issue.groupBy`, §5, D15): the replica holds only some issues (SPEC-011 §5.7).
import {
  statusCreate,
  statusDelete,
  statusReorder,
  statusUpdate,
  teamSetDefaultStatus,
} from '@surface/operations';
import { Issue } from '@surface/domain/model';
import { Button, Dialog, DialogClose, IconButton, StatusIcon, toast } from '@surface/ui';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { useServerRead, useSettingsReads } from '../teams/settings-reads.js';
import { submitMutation, toastIfFailed, useShowsRejection } from '../teams/submit.js';
import { TeamSettingsLayout } from '../teams/TeamSettingsLayout.js';
import { clearAddStatus, subscribeAddStatus, takeAddStatus } from './add-intent.js';
import {
  countsByStatus,
  dropTarget,
  moveOne,
  replicaDeleteRefusal,
  statusIssueCount,
  workflowGroups,
  type EditableCategory,
  type StatusFormValues,
  type StatusItem,
} from './model.js';
import { rowFocusTarget, statusIdOf, statusRowHandlers } from './rowKeys.js';
import { StatusForm } from './StatusForm.js';
import { StatusRow } from './StatusRow.js';
import styles from './statuses.module.css';
import { useWorkflow } from './useWorkflow.js';

export function WorkflowScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {({ team }) => <Workflow key={team.id} teamId={team.id} teamKey={team.key} />}
    </TeamSettingsLayout>
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

function Workflow({ teamId, teamKey }: { readonly teamId: string; readonly teamKey: string }) {
  const app = useApp();
  const workflow = useWorkflow(teamId);
  const showsRejection = useShowsRejection();
  const [adding, setAdding] = useState<EditableCategory>();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<StatusItem>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const current = workflow?.statuses;
  const canEdit = workflow?.access.edit === true;
  const formOpen = adding !== undefined || editing !== undefined;
  const counts = useStatusCounts(teamKey);

  // Delete (§3.1 item 6): when the replica already shows an issue on the status, the refusal is a
  // toast and no dialog opens (the prediction would refuse it too, so nothing is sent).
  const askDelete = (status: StatusItem) => {
    const store = app.store;
    if (store === null || workflow === null) return;
    const refusal = replicaDeleteRefusal(
      workflow.statuses,
      status.id,
      workflow.defaultStatusId,
      store.pool.findBy(Issue, 'statusId', status.id),
    );
    if (refusal !== undefined) toast({ tone: 'danger', message: refusal });
    else setDeleting(status);
  };

  // "Add status…" from the command menu (§7.3): open the form in the chosen category.
  useEffect(() => {
    const take = () => {
      const request = takeAddStatus(teamKey);
      if (request === undefined) return;
      setEditing(undefined);
      setAdding(request.category);
    };
    take();
    const stop = subscribeAddStatus(take);
    return () => {
      stop();
      clearAddStatus(teamKey);
    };
  }, [teamKey]);

  const reorder = useCallback(
    async (statusId: string, to: { before: string } | { after: string }) => {
      const store = app.store;
      if (store === null) return;
      toastIfFailed(
        await submitMutation(store, statusReorder, { team: teamKey, status: statusId, ...to }),
      );
    },
    [app, teamKey],
  );

  // The `settings-row` keys, through the engine (rowKeys.ts): Enter, Alt+↑/↓, Mod+Backspace.
  const handlers = statusRowHandlers(
    () => statusIdOf(document.activeElement),
    () => canEdit && !formOpen && deleting === undefined,
    {
      edit: (id) => {
        setAdding(undefined);
        setEditing(id);
      },
      move: (id, direction) => {
        const to = moveOne(current ?? [], id, direction);
        if (to !== undefined) void reorder(id, to).then(() => focusRow(id));
      },
      remove: (id) => {
        const status = current?.find((s) => s.id === id);
        if (status !== undefined) askDelete(status);
      },
    },
  );
  useCommand('settings-row:edit', () => handlers['settings-row:edit']?.run(), {
    when: () => handlers['settings-row:edit']?.when?.() ?? false,
  });
  useCommand('settings-row:move-up', () => handlers['settings-row:move-up']?.run(), {
    when: () => handlers['settings-row:move-up']?.when?.() ?? false,
  });
  useCommand('settings-row:move-down', () => handlers['settings-row:move-down']?.run(), {
    when: () => handlers['settings-row:move-down']?.when?.() ?? false,
  });
  useCommand('settings-row:delete', () => handlers['settings-row:delete']?.run(), {
    when: () => handlers['settings-row:delete']?.when?.() ?? false,
  });
  // Esc closes an open form first; otherwise the shell's own Esc step runs (SPEC-012 §4.2).
  useCommand(
    'ui:escape',
    () => {
      setAdding(undefined);
      setEditing(undefined);
    },
    { level: 'page', when: () => formOpen },
  );

  // Drag with the pointer; one `status.reorder` on drop (§3.1).
  useEffect(() => {
    if (dragId === undefined) return;
    const up = (event: PointerEvent) => {
      const over = statusIdOf(document.elementFromPoint(event.clientX, event.clientY));
      const to = over === undefined ? undefined : dropTarget(current ?? [], dragId, over);
      setDragId(undefined);
      if (to !== undefined) void reorder(dragId, to);
    };
    const cancel = () => setDragId(undefined);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragId, reorder, current]);

  if (workflow === null) return null;
  const { statuses, defaultStatusId } = workflow;
  const groups = workflowGroups(statuses);
  const firstId = groups.flatMap((g) => g.statuses).at(0)?.id;
  const tabStop =
    activeId !== undefined && statuses.some((s) => s.id === activeId) ? activeId : firstId;

  const create = async (category: EditableCategory, values: StatusFormValues) => {
    const store = app.store;
    if (store === null) return undefined;
    const result = await submitMutation(
      store,
      statusCreate,
      {
        team: teamKey,
        category,
        name: values.name,
        color: values.color,
        ...(values.description.trim() === '' ? {} : { description: values.description.trim() }),
      },
      { showsRejection },
    );
    if (result.kind === 'rejected' || result.kind === 'failed') return result.message;
    setAdding(undefined);
    return undefined;
  };

  const save = async (status: StatusItem, values: StatusFormValues) => {
    const store = app.store;
    if (store === null) return undefined;
    const result = await submitMutation(
      store,
      statusUpdate,
      {
        team: teamKey,
        status: status.id,
        name: values.name,
        color: values.color,
        description: values.description.trim(),
      },
      { showsRejection },
    );
    if (result.kind === 'rejected' || result.kind === 'failed') return result.message;
    setEditing(undefined);
    focusRow(status.id);
    return undefined;
  };

  // "Make default" (§3.1): the Default badge moves at once (optimistic); a refusal is a toast.
  const makeDefault = async (statusId: string) => {
    const store = app.store;
    if (store === null) return;
    toastIfFailed(
      await submitMutation(store, teamSetDefaultStatus, { team: teamKey, status: statusId }),
    );
  };

  // The row goes at once (optimistic). A refusal, the server's included (E8: issues the replica
  // doesn't hold), puts it back and is a toast (§3.1 item 6): the shell's for a server refusal.
  const confirmDelete = async (status: StatusItem) => {
    const store = app.store;
    if (store === null || deleteBusy) return;
    setDeleteBusy(true);
    const result = await submitMutation(store, statusDelete, { team: teamKey, status: status.id });
    setDeleteBusy(false);
    setDeleting(undefined);
    toastIfFailed(result);
  };

  return (
    <>
      {!canEdit && <p className={styles.note}>Join the team to edit</p>}
      <div
        role="listbox"
        aria-label={`${teamKey} workflow statuses`}
        className={styles.list}
        onKeyDown={moveFocus}
      >
        {groups.map((group) => (
          <section
            key={group.category}
            role="group"
            aria-label={group.title}
            className={styles.group}
          >
            <header className={styles.groupHeader}>
              <StatusIcon category={group.category} />
              <h3 className={styles.groupTitle}>{group.title}</h3>
              {canEdit && group.canAdd && (
                <IconButton
                  aria-label={`Add ${group.title} status`}
                  size="sm"
                  icon={<Plus size={16} />}
                  disabled={formOpen}
                  onClick={() => {
                    setEditing(undefined);
                    setAdding(group.category as EditableCategory);
                  }}
                />
              )}
            </header>
            {group.statuses.map((status) =>
              editing === status.id ? (
                <StatusForm
                  key={status.id}
                  category={status.category}
                  status={status}
                  others={statuses.filter((s) => s.id !== status.id)}
                  count={statuses.length}
                  onSubmit={(values) => save(status, values)}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <StatusRow
                  key={status.id}
                  status={status}
                  isDefault={status.id === defaultStatusId}
                  issueCount={statusIssueCount(counts, status.id)}
                  canEdit={canEdit}
                  active={status.id === tabStop}
                  dragging={status.id === dragId}
                  onFocus={() => setActiveId(status.id)}
                  onEdit={() => {
                    setAdding(undefined);
                    setEditing(status.id);
                  }}
                  onMakeDefault={() => void makeDefault(status.id)}
                  onDelete={() => askDelete(status)}
                  onDragStart={() => setDragId(status.id)}
                />
              ),
            )}
            {adding === group.category && (
              <StatusForm
                category={group.category}
                others={statuses}
                count={statuses.length}
                onSubmit={(values) => create(group.category as EditableCategory, values)}
                onCancel={() => setAdding(undefined)}
              />
            )}
          </section>
        ))}
      </div>
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={`Delete the "${deleting?.name ?? ''}" status?`}
        description="This can't be undone."
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost" disabled={deleteBusy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={deleteBusy}
              onClick={() => {
                if (deleting !== undefined) void confirmDelete(deleting);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}

/** Puts focus back on a row once it has re-rendered, so a keyboard user keeps their place. */
function focusRow(statusId: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-status-id="${statusId}"]`)?.focus();
  });
}

/**
 * The team's issue count per status, from the server (§5, D15): live and archived issues the
 * actor can see, asked on open and when the window regains focus. Undefined until it answers and
 * offline, so the rows show "—".
 */
function useStatusCounts(teamKey: string): ReadonlyMap<string, number> | undefined {
  const app = useApp();
  const reads = useSettingsReads();
  const online = useObserved(useCallback(() => app.store?.connection === 'online', [app]));
  const answer = useServerRead(
    () => reads.issueGroupBy({ team: teamKey, by: 'status', includeArchived: true }),
    teamKey,
    online,
  );
  return useMemo(
    () => (answer === undefined ? undefined : countsByStatus(answer.groups)),
    [answer],
  );
}
