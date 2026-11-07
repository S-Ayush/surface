import type { Role } from '@surface/domain';

export interface InspectorGate {
  /** A development build (`import.meta.env.DEV` in the app). */
  readonly dev: boolean;
  /** The page's query string (`location.search`). */
  readonly search: string;
  /**
   * The signed-in user's workspace role.
   *
   * TODO(PLAN-001 S7): pass the user's real role once roles reach the client.
   * Until then pass `undefined`, which keeps `?debug=sync` closed in
   * production builds.
   */
  readonly role: Role | undefined;
}

/** Whether to mount the sync inspector: dev builds, or `?debug=sync` for Admins (SPEC-002 §5.4). */
export function inspectorAllowed({ dev, search, role }: InspectorGate): boolean {
  if (dev) return true;
  return role === 'admin' && new URLSearchParams(search).getAll('debug').includes('sync');
}
