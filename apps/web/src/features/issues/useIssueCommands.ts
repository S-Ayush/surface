// The `issue` scope's commands (SPEC-012 §3.6, §3.8; PLAN-012 S6): the property pickers
// (`S P A L Shift+E Shift+D`), assign to me (`I`), remove the due date, the copy keys, rename
// and delete. The issue list registers them for its focused row and the issue page for its open
// issue, each with the `subject` it acts on; the keys, the row and header menus and `Mod+K` then
// run the same handlers. A command whose subject isn't editable is unavailable, and its key shows
// the reason ("ENG-42 is archived. Restore it to edit it.").
import { type DocNodeJSON, type IssueLifecycle } from '@surface/domain';
import { User } from '@surface/domain/model';
import { toast } from '@surface/ui';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { askDelete } from './delete-flow.js';
import { planCopy, runCopy, type CopyKind } from './copy-actions.js';
import { estimatesOffMessage } from './picker-options.js';
import { readComposerWorld } from './composer-world.js';
import {
  assignToMeInput,
  lifecycleReason,
  pickerSpec,
  readIssueFacts,
  type PickerKind,
} from './issue-pickers.js';
import { openPicker } from './pickers/picker-request.js';
import { sendIssueUpdate } from './pickers/send.js';

/** The issue a command acts on: the focused row, or the open page. */
export interface IssueSubject {
  readonly id: string;
  /** `ENG-42`; null while the number is pending. */
  readonly identifier: string | null;
  readonly title: string;
  readonly teamKey: string;
  readonly lifecycle: IssueLifecycle;
  /** The replica holds it, live, and the viewer may change it (the page isn't read-only). */
  readonly editable: boolean;
  /** For "Copy issue as Markdown": the page has it once PLAN-012 S4b mounts the description. */
  readonly description?: DocNodeJSON | null;
}

export interface IssueCommandOptions {
  /** What a picker opened by key or menu anchors to: the focused row, or the panel's pill. */
  readonly anchor: (kind: PickerKind) => Element | null;
  /** After a picker or the delete dialog has closed: a list moves focus back to its row. */
  readonly onOverlayClosed?: () => void;
  /** `Shift+R`: the page focuses its title; a list opens the page with the title in edit mode. */
  readonly rename: () => void;
}

export function useIssueCommands(
  subject: () => IssueSubject | undefined,
  options: IssueCommandOptions,
): void {
  const app = useApp();
  const editable = () => subject()?.editable === true;
  const deletable = () => editable() || subject()?.lifecycle === 'archived';
  const reason = () => {
    const current = subject();
    return current === undefined
      ? undefined
      : lifecycleReason(current.identifier ?? 'This issue', current.lifecycle);
  };
  const editing = { when: editable, reason };

  const openFor = (kind: PickerKind) => {
    const current = subject();
    const store = app.readyStore;
    const me = app.session?.userId;
    if (current === undefined || store === null || me === undefined) return;
    const facts = readIssueFacts(store.pool, current.id);
    if (facts === undefined) return;
    // `Shift+E` on a team without estimates shows the hint and opens nothing (§3.5).
    if (pickerSpec(kind, readComposerWorld(store.pool, me, null, []), facts) === undefined) {
      if (kind === 'estimate') toast({ message: estimatesOffMessage(current.teamKey) });
      return;
    }
    openPicker({
      kind,
      issueId: current.id,
      anchor: options.anchor(kind),
      // A property key opens the picker in the command menu's frame; the calendar stays anchored.
      ...(kind === 'dueDate' ? {} : { frame: 'menu' as const }),
      ...(options.onOverlayClosed === undefined ? {} : { onClosed: options.onOverlayClosed }),
    });
  };
  useCommand('issue:status', () => openFor('status'), editing);
  useCommand('issue:priority', () => openFor('priority'), editing);
  useCommand('issue:assignee', () => openFor('assignee'), editing);
  useCommand('issue:labels', () => openFor('labels'), editing);
  useCommand('issue:estimate', () => openFor('estimate'), editing);
  useCommand('issue:due-date', () => openFor('dueDate'), editing);

  useCommand(
    'issue:assign-to-me',
    () => {
      const current = subject();
      const store = app.readyStore;
      const me = app.session?.userId;
      if (current === undefined || store === null || me === undefined) return;
      const facts = readIssueFacts(store.pool, current.id);
      if (facts === undefined) return;
      // Does nothing when it is already mine (§3.6).
      void sendIssueUpdate(
        store,
        assignToMeInput(readComposerWorld(store.pool, me, null, []), facts),
      );
    },
    editing,
  );
  useCommand(
    'issue:remove-due-date',
    () => {
      const current = subject();
      const store = app.readyStore;
      if (current === undefined || store === null) return;
      const facts = readIssueFacts(store.pool, current.id);
      if (facts?.dueDate == null) return;
      void sendIssueUpdate(store, { issue: facts.id, dueDate: null });
    },
    editing,
  );
  useCommand('issue:rename', options.rename, editing);

  const displayName = (): string => {
    const store = app.readyStore;
    const userId = app.session?.userId;
    if (store === null || userId === undefined) return '';
    return store.pool.get(User, userId)?.displayName ?? '';
  };
  // Copies work on any issue, archived or deleted too (§3.8).
  const copy = (kind: CopyKind) => () => {
    const current = subject();
    if (current === undefined) return;
    void runCopy(
      planCopy(kind, current, window.location.origin, displayName()),
      typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    );
  };
  const anyIssue = { when: () => subject() !== undefined };
  useCommand('issue:copy-id', copy('id'), anyIssue);
  useCommand('issue:copy-url', copy('url'), anyIssue);
  useCommand('issue:copy-title', copy('title'), anyIssue);
  useCommand('issue:copy-title-link', copy('title-link'), anyIssue);
  useCommand('issue:copy-markdown', copy('markdown'), anyIssue);
  useCommand('issue:copy-branch', copy('branch'), anyIssue);

  useCommand(
    'issue:delete',
    () => {
      const current = subject();
      if (current?.identifier == null) return;
      askDelete({
        issueId: current.id,
        identifier: current.identifier,
        title: current.title,
        ...(options.onOverlayClosed === undefined ? {} : { onClosed: options.onOverlayClosed }),
      });
    },
    // A pending issue has no number to name in the dialog. An archived issue can be deleted but
    // not edited (SPEC-015 §3.4, SPEC-012 D29); a deleted one only restored.
    {
      when: () => deletable() && subject()?.identifier != null,
      reason: () =>
        subject()?.identifier == null ? 'Wait a moment: ENG-… has no number yet.' : reason(),
    },
  );
}
