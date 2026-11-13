// The one seam for "is this team's list loaded?" (SPEC-012 §3.3 item 10, §7.2). A team the user
// belongs to is in the replica; a public team they don't belong to is subscribed on demand while
// its list is open, through sync-react's `useTeamLoadState` (SPEC-011 §5.7, PLAN-011 S4c).
import type { TeamLoadState as StoreTeamLoadState } from '@surface/sync-client';
import { useTeamLoadState as useStoreTeamLoadState } from '@surface/sync-react';

export type TeamLoadState =
  /** Render from the replica. */
  | 'loaded'
  /** A public team of which the user is not a member, being subscribed. */
  | 'loading'
  /** Offline and never loaded: "Available when online". */
  | 'offline';

/** The list's state from the store's (`ready` is a list it can render). */
export function listLoadState(state: StoreTeamLoadState): TeamLoadState {
  return state === 'ready' ? 'loaded' : state;
}

/** Opens the team while the list is mounted (subscribing it if it's public and not the user's). */
export function useTeamLoadState(teamId: string): TeamLoadState {
  return listLoadState(useStoreTeamLoadState(teamId));
}
