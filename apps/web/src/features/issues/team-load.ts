// The one seam for "is this team's list loaded?" (SPEC-012 §3.3 item 10, §7.2). A team the user
// belongs to is in the replica; a public team they don't belong to is subscribed on demand by
// PLAN-011 S4c's `useTeamLoadState(teamId)` (sync-react), which is not built yet.
//
// TODO(PLAN-011 S4c): useTeamLoadState — replace the body of `useTeamLoadState` below with the
// sync-react hook. Callers (IssueListPage) read only the three states, so nothing else changes.
// Until then a non-member team shows what the replica happens to hold, and "Loading…" while it
// holds nothing, because nothing subscribes it yet.
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';

export type TeamLoadState =
  /** Render from the replica. */
  | 'loaded'
  /** A public team of which the user is not a member, being subscribed. */
  | 'loading'
  /** Offline and never loaded: "Available when online". */
  | 'offline';

/** The load state from three facts, so the rule is testable without a store. */
export function teamLoadState(facts: {
  readonly member: boolean;
  readonly online: boolean;
  readonly hasRows: boolean;
}): TeamLoadState {
  if (facts.member || facts.hasRows) return 'loaded';
  return facts.online ? 'loading' : 'offline';
}

export function useTeamLoadState(teamId: string, hasRows: boolean): TeamLoadState {
  const app = useApp();
  const member = useObserved(
    useCallback(() => app.teams().some((team) => team.id === teamId), [app, teamId]),
  );
  const online = useObserved(useCallback(() => app.online(), [app]));
  return teamLoadState({ member, online, hasRows });
}
