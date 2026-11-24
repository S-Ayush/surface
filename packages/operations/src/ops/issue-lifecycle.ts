/**
 * Issue lifecycle operations (SPEC-015 §6.1; PLAN-015 S1): delete and restore, purge (S2), the
 * system-only `issue.autoArchive`/`issue.autoClose` (S3) and `issue.listDeleted` (S4). Anyone who can see an issue may delete and restore it (permissions §3.3,
 * D7), so the permission is `p.any()`: a private team's issue is `NOT_FOUND` before any
 * permission check. Delete is destructive, so an API key needs `allowDestructive`.
 *
 * Optimistic (§6.2, D17): delete removes the Issue from the overlay; restore predicts nothing,
 * because the replica holds no archived or deleted issue (PLAN-011 S4c), so the row comes back
 * with the server's `V` or `U`.
 */
import { canRestore, IssueRef, lifecycleOf, TeamRef, type LifecycleFields } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import type { StoreRow } from '../optimistic.js';
import type { UiTarget } from '../ui.js';
import { IssueOutputSchema, IssueSummarySchema } from './issue.js';
import { Timestamp } from './shared.js';

/** The `get` of the client's `SyncStore.pool`, if `store` has one (`operations` can't import it). */
function poolOf(store: unknown): ((model: string, id: string) => unknown) | undefined {
  if (typeof store !== 'object' || store === null) return undefined;
  const pool: unknown = Reflect.get(store, 'pool');
  if (typeof pool !== 'object' || pool === null) return undefined;
  const get: unknown = Reflect.get(pool, 'get');
  if (typeof get !== 'function') return undefined;
  return (model, id): unknown => {
    const row: unknown = Reflect.apply(get, pool, [model, id]);
    return row;
  };
}

/**
 * The lifecycle fields of each target issue the client holds, or undefined for one it doesn't.
 * The replica holds live issues only (SPEC-011 §5.7): an archived or deleted issue is shown from
 * the server (PLAN-015 S4 and PLAN-012 S4b feed its state), so "not held" decides nothing here.
 */
function heldIssues(target: UiTarget, store: unknown): (LifecycleFields | undefined)[] {
  const get = poolOf(store);
  return target.ids.map((id) => {
    const row: unknown = get?.('Issue', id);
    if (typeof row !== 'object' || row === null) return undefined;
    const archivedAt: unknown = Reflect.get(row, 'archivedAt');
    const deletedAt: unknown = Reflect.get(row, 'deletedAt');
    return { archivedAt, deletedAt };
  });
}

export const issueDelete = defineOperation({
  name: 'issue.delete',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Delete an issue',
  description:
    'Moves an issue to Recently deleted, where anyone who can see it can restore it for 30 days (purgeAfter); after that it is deleted for good. Works on archived issues too. Deleting a deleted issue changes nothing. Name the issue by identifier, like ENG-42, or id.',
  keywords: ['delete issue', 'remove issue', 'trash this issue', 'get rid of ENG-42'],
  input: z.object({ issue: IssueRef }),
  output: z.object({
    issue: IssueSummarySchema,
    /** When the issue stops being restorable: `deletedAt` + 720 hours (SPEC-015 §4.2). */
    purgeAfter: Timestamp,
  }),
  permission: (p) => p.any(),
  destructive: true,
  // Restore runs after it on the same seed (ALL_OPERATIONS order) and brings ENG-3 back.
  examples: [{ issue: 'ENG-3' }],
  ui: {
    title: 'Delete issue',
    icon: 'trash',
    contexts: ['issue'],
    // `Mod+Backspace` (SPEC-015 §6.1) is bound to the app command `issue:delete`, which this
    // entry opens; the hint joins now that the build reaches M1 (PLAN-012 S7b).
    shortcut: 'Mod+Backspace',
    // Hidden on a deleted issue (§7). An issue the replica doesn't hold is archived, deleted or
    // of an unsubscribed team: the server decides, and deleting a deleted one changes nothing.
    available: (target, store) =>
      heldIssues(target, store).every((issue) => !issue || lifecycleOf(issue) !== 'deleted'),
  },
  optimistic: (store, input) => {
    const issue: StoreRow | undefined = store.get('Issue', input.issue);
    const id = issue?.['id'];
    if (!issue || typeof id !== 'string') return;
    const state = lifecycleOf({ archivedAt: issue['archivedAt'], deletedAt: issue['deletedAt'] });
    // A no-op on the server; and nothing to remove.
    if (state === 'deleted') return;
    // It leaves every list at once; its children are hidden with it. A rejection rolls it back.
    store.remove('Issue', id);
  },
});

export const issueRestore = defineOperation({
  name: 'issue.restore',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Restore an archived or deleted issue',
  description:
    'Brings an archived or recently deleted issue back to the live lists, clearing both states. A deleted issue can be restored until purgeAfter (30 days after it was deleted). Restoring a live issue changes nothing. Name the issue by identifier, like ENG-42, or id.',
  keywords: ['restore issue', 'undelete issue', 'unarchive issue', 'bring back ENG-42'],
  input: z.object({ issue: IssueRef }),
  output: IssueOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ issue: 'ENG-3' }],
  ui: {
    title: 'Restore issue',
    icon: 'rotate-ccw',
    contexts: ['issue'],
    // `#` (SPEC-015 §6.1), like Delete's key: bound to `issue:restore`, hint from M1.
    shortcut: '#',
    // Only on an archived issue, or a deleted one before its purgeAfter (§7, D6). The replica
    // holds live issues only, so an issue it holds as live has nothing to restore; one it doesn't
    // hold is left to the server.
    available: (target, store) =>
      heldIssues(target, store).every((issue) => !issue || canRestore(issue, new Date())),
  },
  // Nothing to predict (§6.2, D17): the replica holds no archived or deleted issue, so there is
  // no row to patch; the row returns with the server's `V` or `U` when the team is subscribed.
  optimistic: () => undefined,
});

export const issuePurge = defineOperation({
  name: 'issue.purge',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Permanently delete a deleted issue',
  description:
    'Deletes a recently deleted issue for good, with its description, activity, comments, reactions and attachments. It cannot be undone. Only Admins can do this; the issue must be deleted first. Its number is never reused. Name the issue by identifier, like ENG-42, or id.',
  keywords: ['permanently delete issue', 'purge issue', 'delete forever', 'erase ENG-42'],
  input: z.object({ issue: IssueRef }),
  output: z.object({ purged: z.literal(true) }),
  // SPEC-015 §5.3: Admin only. A private team's issue is NOT_FOUND for an Admin outside it before
  // this runs (step 7), never FORBIDDEN (E12).
  permission: (p) => p.admin(),
  destructive: true,
  // ENG-4 is the seed's deleted issue.
  examples: [{ issue: 'ENG-4' }],
  ui: {
    // D14: a plain confirm dialog (PLAN-015 S4), no shortcut.
    title: 'Permanently delete…',
    icon: 'trash',
    contexts: ['issue'],
    shortcut: null,
    // Only on a deleted issue (§6.1). The replica holds live issues only, so an issue it holds is
    // never one; the deleted issue's page is fed by the server and S4 refines this from its row.
    available: (target, store) =>
      heldIssues(target, store).every((issue) => !issue || lifecycleOf(issue) === 'deleted'),
  },
  // Nothing to predict (§6.2): the replica holds no deleted issue. Once the server's batch arrives
  // the Issue stays absent, so any content the client held goes too (SPEC-011 §5.3).
  optimistic: () => undefined,
});

/** One issue on the Recently deleted tab (§6.1): a summary plus when it stops being restorable. */
export const DeletedIssueSchema = IssueSummarySchema.extend({
  /** `deletedAt` + 720 hours (§4.2): from then on it can't be restored and leaves this list. */
  purgeAfter: Timestamp,
});

export const issueListDeleted = defineOperation({
  name: 'issue.listDeleted',
  kind: 'query',
  domain: 'issue',
  summary: 'List recently deleted issues',
  description:
    'Lists visible issues in Recently deleted, newest deletion first, with deletedBy and purgeAfter (when it stops being restorable). An issue leaves the list once its purgeAfter has passed. Archived or not, so includeArchived changes nothing. With team, only its issues, and status and label names resolve in it. Takes the filters of issue.list.',
  keywords: ['recently deleted issues', 'deleted issues', 'trash', 'issues to restore'],
  input: z.object({ ...listInput, team: TeamRef.optional(), withTotal: z.boolean().optional() }),
  output: connectionOf(DeletedIssueSchema),
  // §5.3: anyone, on the issues they can see; a key with `read`. Visibility and the key's teams
  // are applied in SQL (`executor/list.ts`).
  permission: (p) => p.any(),
  destructive: false,
  // The seed's deleted ENG-4, before `issue.purge` takes it.
  examples: [{ team: 'ENG' }, { orderBy: { field: 'deletedAt', direction: 'asc' } }],
});

export const issueAutoArchive = defineOperation({
  name: 'issue.autoArchive',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Archive a closed issue (the auto-archive job)',
  description:
    'Archives one live issue that has been closed longer than its team’s auto-archive period. Only the auto-archive job calls it; nobody archives an issue by hand. Skips an issue that is no longer due. Name the issue by identifier, like ENG-42, or id.',
  keywords: ['auto archive issue', 'archive closed issue', 'auto-archive job'],
  input: z.object({ issue: IssueRef }),
  output: IssueOutputSchema,
  systemOnly: true,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ issue: 'ENG-3' }],
});

export const issueAutoClose = defineOperation({
  name: 'issue.autoClose',
  kind: 'mutation',
  domain: 'issue',
  summary: 'Close a stale issue (the auto-close job)',
  description:
    'Moves one live, stale issue to its team’s auto-close status, with the usual completed or canceled timestamps. Only the auto-close job calls it. Skips an issue that is no longer stale. Name the issue by identifier, like ENG-42, or id.',
  keywords: ['auto close issue', 'close stale issue', 'auto-close job'],
  input: z.object({ issue: IssueRef }),
  output: IssueOutputSchema,
  systemOnly: true,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ issue: 'ENG-3' }],
});
