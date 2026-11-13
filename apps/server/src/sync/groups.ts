/**
 * The two kinds of sync groups (SPEC-011 §5.6, §5.7, ADR-0020; permissions.md §2):
 *
 * - **Visible groups** (`visibleGroups`, `@surface/domain`): every group an actor may see, including every public
 *   team's `team:<id>`. Every read path filters with them: queries, refs, `lockIssueForWrite`,
 *   `/sync/content` (PLAN-011 S5a) and `GET /files/:id` (PLAN-014). Never a socket's groups, so an
 *   unsubscribed public team stays readable.
 * - **A connection's groups**: the home groups (`workspace`, `user:<id>`, each private team the
 *   user is a member of) plus `team:<id>` of each public team its client subscribes to. Bootstrap,
 *   catch-up, live deltas and the confirm point of a no-op mutation (`visibleHead`) use these.
 */
import { teamGroup, type Actor } from '@surface/domain';

/** Who decides which teams a client may subscribe to: the database, read at each request. */
export interface TeamQueryable {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * The teams of `teamIds` that `userId` may subscribe to (SPEC-011 §5.7): a public team, or a
 * private team the user is a member of. Anything else, an unknown id or a private team the user
 * isn't in, is dropped the same way, so the answer reveals nothing (E32). Read fresh each time:
 * a team created after the socket opened can be subscribed, and a team that turned private can't
 * be subscribed again (the M7 privacy flip re-checks at connect). In the order asked, without
 * repeats.
 */
export async function acceptedTeams(
  db: TeamQueryable,
  userId: string,
  teamIds: readonly string[],
): Promise<string[]> {
  const asked = [...new Set(teamIds)];
  if (asked.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id::text AS id FROM teams t
      WHERE t.id = ANY($1::uuid[])
        AND (NOT t.private
             OR EXISTS (SELECT 1 FROM team_memberships m
                         WHERE m.team_id = t.id AND m.user_id = $2::uuid))`,
    [asked, userId],
  );
  const accepted = new Set(rows.map((row) => row.id));
  return asked.filter((id) => accepted.has(id));
}

/** Which of `teamIds` a user may subscribe to: `acceptedTeams` bound to a database. */
export type TeamAccess = (userId: string, teamIds: readonly string[]) => Promise<string[]>;

/**
 * The groups of the full bootstrap, and of a connection whose client names no `teams`: the home
 * groups plus every team the user is a member of, public ones included (SPEC-011 §5.7: "Full
 * bootstrap without `groups` covers … the member teams, public and private").
 */
export function memberGroups(actor: Pick<Actor, 'groups' | 'memberOf'>): readonly string[] {
  return union(actor.groups, actor.memberOf.map(teamGroup));
}

/** The groups of a connection: the home groups plus each subscribed team's. */
export function connectionGroups(
  actor: Pick<Actor, 'groups'>,
  subscribed: readonly string[],
): readonly string[] {
  return union(actor.groups, subscribed.map(teamGroup));
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}
