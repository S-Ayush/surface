// Opening an issue the replica doesn't hold (SPEC-012 §3.4 item 11, E27, AC-28): a link, a pasted
// identifier, `Mod+K`, an issue of a team the user isn't in. The page asks the server with
// `issue.get` and shows what comes back. The parts that need later slices sit behind two seams
// (`IssueLoaderDeps`), so this file doesn't change when they land.
import { parseIssueRef } from '@surface/domain';
import type { ReadonlyPool } from '@surface/sync-client';
import type { OperationAnswer } from '../files/operation.js';
import { issueViewFromOutput, type IssueOutput, type IssueView } from './issue-view.js';

export type IssueLoadResult =
  /** The ref isn't an identifier or id, or the server answered `NOT_FOUND`: one page for both (AC-15). */
  | { readonly kind: 'not-found' }
  /** Offline, or the server couldn't be reached: "Available when online". */
  | { readonly kind: 'offline' }
  /** Any other refusal or failure: not "not found", so the page offers to try again. */
  | { readonly kind: 'error' }
  /** Shown read-only from the server's answer; nothing of it is stored. */
  | { readonly kind: 'remote'; readonly view: IssueView }
  /** The team was subscribed and the row is now in the replica: read it from there. */
  | { readonly kind: 'in-replica' };

export interface IssueLoaderDeps {
  /** `issue.get` over HTTP. */
  readonly get: (ref: string) => Promise<OperationAnswer<IssueOutput>>;
  /** Whether the store's connection is up. */
  readonly online: () => boolean;
  /** The replica, for the team's id and estimate settings when it holds the team. */
  readonly pool?: ReadonlyPool | undefined;
  /**
   * Subscribes the issue's (public) team on demand and resolves when the row is in the replica
   * ('local'), or 'unavailable' when it can't be done.
   *
   * TODO(PLAN-011 S4c): the team subscription and `useTeamLoadState` aren't built. Until they are,
   * a live issue the replica doesn't hold is shown read-only from the `issue.get` answer.
   */
  readonly subscribeTeam: (teamKey: string, issueId: string) => Promise<'local' | 'unavailable'>;
}

/** Until PLAN-011 S4c: no subscription, so the answer is shown read-only. */
export const NO_TEAM_SUBSCRIPTION: IssueLoaderDeps['subscribeTeam'] = () =>
  Promise.resolve('unavailable');

export async function loadMissingIssue(
  ref: string,
  deps: IssueLoaderDeps,
): Promise<IssueLoadResult> {
  // Nothing to ask the server about a ref that names no issue; it is as not found as an unknown one.
  if (parseIssueRef(ref) === undefined) return { kind: 'not-found' };
  if (!deps.online()) return { kind: 'offline' };
  const answer = await deps.get(ref);
  if (!answer.ok) {
    // Only `NOT_FOUND` says the issue doesn't exist or isn't visible (an invisible issue is
    // `NOT_FOUND`, never `FORBIDDEN`, CLAUDE.md rule 4). A 5xx, `RATE_LIMITED` or
    // `UNAUTHENTICATED` says nothing about the issue, so it must not read as "doesn't exist".
    if (answer.code === 'NOT_FOUND') return { kind: 'not-found' };
    return answer.code === 'UNREACHABLE' ? { kind: 'offline' } : { kind: 'error' };
  }
  const issue = answer.result;
  if (issue.archivedAt === null && issue.deletedAt === null) {
    if ((await deps.subscribeTeam(issue.teamKey, issue.id)) === 'local') {
      return { kind: 'in-replica' };
    }
  }
  // TODO(PLAN-011 S5a/S4c): server-backed read-only view. The row, description, attachments and
  // reactions come from this answer and the activity from `content.peek`; for now the row alone.
  return { kind: 'remote', view: issueViewFromOutput(issue, deps.pool) };
}

/**
 * A pending issue whose create the server rejected (E9): the store keeps the last 20 rejections
 * in memory, so the page can say why. Undefined after a reload, when it is just not found.
 */
export function heldRejection(
  rejections: readonly { readonly op: string; readonly input: unknown; readonly message: string }[],
  issueId: string,
): string | undefined {
  for (let i = rejections.length - 1; i >= 0; i--) {
    const rejection = rejections[i];
    if (rejection?.op !== 'issue.create') continue;
    const input = rejection.input;
    if (typeof input === 'object' && input !== null && Reflect.get(input, 'id') === issueId) {
      return rejection.message;
    }
  }
  return undefined;
}

/** What the page renders for a ref. */
export type IssueSource =
  /** An issue to show. `readOnly` when it isn't the replica's live row. */
  | { readonly kind: 'view'; readonly view: IssueView; readonly readOnly: boolean }
  /** Waiting for the replica or the server (the skeleton shows after 150 ms). */
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'offline' }
  /** The server failed or refused for a reason that says nothing about the issue: try again. */
  | { readonly kind: 'error' }
  /** E9: a pending issue whose create was rejected. */
  | { readonly kind: 'create-rejected'; readonly message: string };

export type IssueSourceInputs = {
  /** The issue as the replica holds it now. */
  readonly replica: IssueView | undefined;
  /** The reason a held rejection gives, when the ref is a pending issue whose create failed. */
  readonly rejected: string | undefined;
  /** The last row the replica had for this page (E3: it left the replica while open). */
  readonly last: IssueView | undefined;
  /** The server's answer, once the loader has one; undefined while it hasn't asked or waits. */
  readonly loaded: IssueLoadResult | undefined;
};

/**
 * One decision from the replica, the held rejection and the loader (SPEC-012 §3.4 items 7 to 11).
 * The replica wins: a row that arrives replaces any server answer. An issue that left the replica
 * while open keeps showing its last row, read-only, until the server answers (E3).
 */
export function chooseIssueSource(inputs: IssueSourceInputs): IssueSource {
  const { replica, rejected, last, loaded } = inputs;
  if (replica !== undefined) {
    return { kind: 'view', view: replica, readOnly: replica.lifecycle !== 'live' };
  }
  if (rejected !== undefined) return { kind: 'create-rejected', message: rejected };
  if (loaded?.kind === 'remote') return { kind: 'view', view: loaded.view, readOnly: true };
  if (loaded?.kind === 'not-found') return { kind: 'not-found' };
  if (loaded?.kind === 'offline' || loaded?.kind === 'error') {
    if (last !== undefined) return { kind: 'view', view: last, readOnly: true };
    return loaded.kind === 'offline' ? { kind: 'offline' } : { kind: 'error' };
  }
  return last === undefined ? { kind: 'loading' } : { kind: 'view', view: last, readOnly: true };
}
