// Shows the delete dialog and implements `Mod+Z` (SPEC-012 §3.11; PLAN-012 S6). Mounted once in
// `SHELL_HOSTS`. `Mod+Backspace`, the menus and "Delete issue" in `Mod+K` all `askDelete`; the
// dialog sends `issue.delete` only on **Delete**. PLAN-015 S4 owns `issue:restore` (`#`).
import { useSyncExternalStore } from 'react';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { DeleteIssueDialog } from './DeleteIssueDialog.js';
import { deleteIssue, deleteRequests, lastDelete, restoreLastDeleted } from './delete-flow.js';

export function IssueDeleteHost() {
  const app = useApp();
  const request = useSyncExternalStore(
    deleteRequests.subscribe,
    deleteRequests.snapshot,
    deleteRequests.snapshot,
  );

  // Not while typing: the binding says so (`whileTyping: false`), and the field undoes its text.
  // Nothing remembered: the command is unavailable (E23).
  useCommand(
    'issue:restore-last-deleted',
    () => {
      const store = app.readyStore;
      if (store !== null) void restoreLastDeleted(store);
    },
    {
      // Nor while the delete dialog is open: the dialog is modal and a restore under it confuses.
      when: () =>
        app.readyStore !== null &&
        lastDelete.get() !== undefined &&
        deleteRequests.snapshot() === undefined,
    },
  );

  if (request === undefined) return null;
  return (
    <DeleteIssueDialog
      open
      identifier={request.identifier}
      title={request.title}
      onConfirm={() => {
        const store = app.readyStore;
        deleteRequests.close();
        if (store !== null) void deleteIssue(store, request);
      }}
      onCancel={() => {
        deleteRequests.close();
      }}
    />
  );
}
