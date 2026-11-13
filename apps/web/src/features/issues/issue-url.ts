// Issue addresses (SPEC-011 §4.1, D6, Q14, E27). `/issue/ENG-42/<slug>` is canonical; the slug is
// cosmetic, so any slug or none resolves, and the page replaces the address with the canonical one
// without a new history entry. A pending issue (no number yet) is `/issue/<id>` until the number
// arrives. Resolution reads the replica only: an issue it doesn't hold is not found, like one the
// user can't see (E13). PLAN-012 S4 reuses `canonicalIssuePath` for the replace on a title change
// and when a pending issue's number arrives (`addressReplacement`, `replaceAddress`).
import { issueIdentifier, issuePath, parseIssueRef } from '@surface/domain';
import { Issue, Team } from '@surface/domain/model';
import type { ReadonlyPool } from '@surface/sync-client';
import { teamByKey } from '../../app/workspace.js';

/** What resolution reads of an issue. */
export type IssueAddressRow = {
  readonly id: string;
  readonly teamId: string;
  readonly number: number | null;
  readonly title: string;
};

/** What resolution reads of a team: live teams only (an archived team's issues aren't open). */
export type IssueAddressTeam = { readonly id: string; readonly key: string };

/** The replica as resolution needs it. */
export interface IssueAddressLookup {
  teamByKey(key: string): IssueAddressTeam | undefined;
  teamById(id: string): IssueAddressTeam | undefined;
  issueById(id: string): IssueAddressRow | undefined;
  issueByNumber(teamId: string, number: number): IssueAddressRow | undefined;
}

export type ResolvedIssueAddress =
  | {
      readonly kind: 'found';
      readonly issue: IssueAddressRow;
      /** `ENG-42`, or null while the issue is pending. */
      readonly identifier: string | null;
      /** Where the page belongs: replace the address with it when it differs. */
      readonly canonical: string;
    }
  | { readonly kind: 'not-found' };

/** `/issue/ENG-42/<slug>`, or `/issue/<id>` while the number is pending (Q14). */
export function canonicalIssuePath(
  issue: Pick<IssueAddressRow, 'id' | 'number' | 'title'>,
  teamKey: string,
): string {
  return issue.number === null
    ? `/issue/${issue.id}`
    : issuePath(issueIdentifier(teamKey, issue.number), issue.title);
}

/**
 * The issue `ref` names (the first path segment after `/issue/`: an identifier in any case, or an
 * id), whatever the slug. Not found when the replica has no such issue or its team isn't live.
 */
export function resolveIssueAddress(ref: string, lookup: IssueAddressLookup): ResolvedIssueAddress {
  const parsed = parseIssueRef(ref);
  let issue: IssueAddressRow | undefined;
  let team: IssueAddressTeam | undefined;
  if (parsed?.by === 'id') {
    issue = lookup.issueById(parsed.id);
    team = issue === undefined ? undefined : lookup.teamById(issue.teamId);
  } else if (parsed?.by === 'identifier') {
    team = lookup.teamByKey(parsed.key);
    issue = team === undefined ? undefined : lookup.issueByNumber(team.id, parsed.number);
  }
  if (issue === undefined || team === undefined) return { kind: 'not-found' };
  return {
    kind: 'found',
    issue,
    identifier: issue.number === null ? null : issueIdentifier(team.key, issue.number),
    canonical: canonicalIssuePath(issue, team.key),
  };
}

/** `ENG-87` typed in the command menu (command-menu §3.1): the identifier, upper case. */
export function typedIdentifier(query: string): string | undefined {
  const match = /^\s*([A-Za-z]{2,5})-(\d+)\s*$/.exec(query);
  if (!match?.[1] || !match[2]) return undefined;
  const parsed = parseIssueRef(`${match[1]}-${match[2]}`);
  return parsed?.by === 'identifier' ? issueIdentifier(parsed.key, parsed.number) : undefined;
}

/** The replica's rows as resolution reads them. Archived issues resolve: their page says so. */
export function poolIssueLookup(pool: ReadonlyPool): IssueAddressLookup {
  return {
    teamByKey: (key) => teamByKey(pool.all(Team), key),
    teamById: (id) => {
      const team = pool.get(Team, id);
      return team === undefined || team.$archived === true ? undefined : team;
    },
    issueById: (id) => pool.get(Issue, id),
    issueByNumber: (teamId, number) =>
      pool.findBy(Issue, 'number', number).find((issue) => issue.teamId === teamId),
  };
}

/**
 * The address the page should replace the current one with, or undefined when it is already right
 * (SPEC-012 §3.4 items 1 and 6, AC-13): a pending issue's `/issue/<id>` becomes
 * `/issue/ENG-42/<slug>` when its number arrives, and a title change gives a new slug.
 */
export function addressReplacement(
  currentPath: string,
  issue: Pick<IssueAddressRow, 'id' | 'number' | 'title'>,
  teamKey: string,
): string | undefined {
  const canonical = canonicalIssuePath(issue, teamKey);
  return canonical === currentPath ? undefined : canonical;
}

/** The part of `window.history` the replace needs. */
export interface HistoryLike {
  readonly state: unknown;
  replaceState(state: unknown, unused: string, url: string): void;
}

/**
 * Replaces the address without a history entry and without a navigation, so the page keeps its
 * focus and scroll (AC-13). The router's own location stays the one the page was opened at, which
 * keeps the route, and so the page, mounted.
 */
export function replaceAddress(history: HistoryLike, path: string): void {
  history.replaceState(history.state, '', path);
}
