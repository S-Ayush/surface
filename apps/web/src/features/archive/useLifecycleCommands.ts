// The commands that act on an archived or deleted issue (SPEC-015 §3.4, §7, AC-14, AC-15; PLAN-015
// S4): Restore (`#`, the menus, "Restore issue" in `Mod+K`) and Permanently delete… (Admins, no
// key). The issue page registers them for its issue and the archive list for its focused row,
// next to PLAN-012 S6's `useIssueCommands`. The operations' `ui.available` leaves an issue the
// replica doesn't hold to the server; these handlers' `when` refine it with what the page or the
// row knows, so the menu offers Restore only on an archived issue, or a deleted one before its
// `purgeAfter`.
import { canRestore, issuePath, lifecycleRefusal, type IssueLifecycle } from '@surface/domain';
import { useNavigate } from '@tanstack/react-router';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { askPurge } from './purge-flow.js';
import { RESTORE_NEEDS_NETWORK, restoreIssue, type RestoreTarget } from './restore-flow.js';

export interface LifecycleSubject {
  readonly id: string;
  /** `ENG-42`; null while the number is pending (a pending issue is live). */
  readonly identifier: string | null;
  readonly title: string;
  readonly lifecycle: IssueLifecycle;
  /** When it was deleted, if known: Restore stops at its `purgeAfter` (D6). */
  readonly deletedAt?: string | null;
}

/** Whether `subject` can be restored at `now`: archived, or deleted before its purgeAfter. */
export function restorable(subject: LifecycleSubject, now: Date = new Date()): boolean {
  if (subject.identifier === null) return false;
  switch (subject.lifecycle) {
    case 'live':
      return false;
    case 'archived':
      return true;
    case 'deleted':
      // Without the time the server decides (and refuses past purgeAfter, E4).
      return (
        subject.deletedAt == null ||
        canRestore({ archivedAt: null, deletedAt: subject.deletedAt }, now)
      );
  }
}

/**
 * The page's or row's lifecycle commands. `onOverlayClosed`: focus back to the row. `needsNetwork`:
 * the archive list, where a restore never queues (§3.3 item 7).
 */
export function useLifecycleCommands(
  subject: () => LifecycleSubject | undefined,
  options: { readonly onOverlayClosed?: () => void; readonly needsNetwork?: boolean } = {},
): void {
  const app = useApp();
  const offline = () => options.needsNetwork === true && app.readyStore?.connection !== 'online';
  const navigate = useNavigate();
  const open = (issue: RestoreTarget) => {
    void navigate({ href: issuePath(issue.identifier, '') });
  };

  useCommand(
    'issue:restore',
    () => {
      const current = subject();
      const store = app.readyStore;
      if (current?.identifier == null || store === null || !restorable(current) || offline()) {
        return;
      }
      void restoreIssue(store, { id: current.id, identifier: current.identifier }, { open });
    },
    {
      when: () => {
        const current = subject();
        return (
          app.readyStore !== null && current !== undefined && restorable(current) && !offline()
        );
      },
      reason: () => {
        const current = subject();
        if (current !== undefined && restorable(current) && offline()) return RESTORE_NEEDS_NETWORK;
        // Only a deleted issue past its purgeAfter has a reason; `#` on a live one does nothing.
        if (current?.identifier == null || current.lifecycle !== 'deleted') return undefined;
        return restorable(current) ? undefined : lifecycleRefusal(current.identifier, 'expired');
      },
    },
  );

  useCommand(
    'issue:purge',
    () => {
      const current = subject();
      if (current?.identifier == null || current.lifecycle !== 'deleted') return;
      askPurge({
        issueId: current.id,
        identifier: current.identifier,
        title: current.title,
        ...(options.onOverlayClosed === undefined ? {} : { onClosed: options.onOverlayClosed }),
      });
    },
    {
      // Admins only (SPEC-015 §5.3), on a deleted issue; the server checks both again.
      when: () => {
        const current = subject();
        return (
          app.isAdmin() === true && current?.lifecycle === 'deleted' && current.identifier !== null
        );
      },
    },
  );
}
