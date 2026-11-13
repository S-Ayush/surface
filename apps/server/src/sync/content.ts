/**
 * `GET /sync/content` (SPEC-011 §5.2, sync-protocol §4.2, PLAN-011 S5a): the content rows of up to
 * 50 issues. Everything is read in one `REPEATABLE READ READ ONLY` snapshot that includes
 * `lastSyncId` (`C`), so the answer is exactly the state at `C`: the client stores the rows at
 * version `C` and replays its buffered packets above it (§5.3).
 *
 * Parents are filtered with **every group the actor may see**, never with a socket's
 * subscriptions, so an unsubscribed public team's issue is still readable (§5.6). Unknown and
 * invisible parents are left out, never an error, so the answer can't tell them apart
 * (permissions.md §5). Content of an archived or deleted issue the actor can see is returned too
 * (its read-only page, SPEC-015 §3.4).
 *
 * The answer is read whole before the first frame goes out: with at most 50 parents it is small
 * (a description is at most 200 KB), and the snapshot's connection goes back to the pool before
 * the response is written, whatever the client's speed.
 */
import { teamGroup, type Actor } from '@surface/domain';
import {
  parentIssueId,
  syncGroupSchema,
  type ContentFrame,
  type ContentParent,
} from '@surface/sync-protocol';
import {
  GROUPS_ALIAS,
  quote,
  selectRows,
  type BootstrapClient,
  type BootstrapPool,
} from './bootstrap.js';
import { clientRow, type SyncModel, type SyncRegistry } from './registry.js';

/** The one parent model of v0.7 (`issue:<id>`). */
const PARENT_MODEL = 'Issue';

export interface ContentOptions {
  readonly pool: BootstrapPool;
  readonly registry: SyncRegistry;
  /** A signed-in user (the route refuses API keys before this runs). */
  readonly actor: Actor;
  /** Distinct, lower-cased (`decodeContentQuery`). */
  readonly parents: readonly ContentParent[];
}

/**
 * Every group `actor` may see, read in the answer's snapshot (SPEC-011 §5.6). The one place
 * `/sync/content` decides visibility, so S4b's swap is one line.
 *
 * Until S4b, an actor's groups are `workspace`, `user:<id>` and their private teams' groups
 * (`syncGroupsFor`); public teams' issues are in `workspace`, but an issue child's only group is
 * `team:<teamId>` (S3), public team or not. So every public team's `team:<id>` is added here, as
 * `visibleGroups` will (every user may see a public team). A private team's group comes only from
 * the actor's own membership.
 */
// TODO(S4b): visibleGroups — replace the body with `visibleGroups(actor)` from `sync/groups.ts`.
export async function contentGroups(actor: Actor, client: BootstrapClient): Promise<string[]> {
  const publicTeams = await client.query<{ id: string }>(
    'SELECT id::text AS id FROM teams WHERE NOT private ORDER BY id',
  );
  return [...new Set([...actor.groups, ...publicTeams.rows.map((team) => teamGroup(team.id))])];
}

/**
 * The frames of one content answer: `meta`, a `row` per content row of the visible parents, `end`.
 * Holds a pool client only while reading, and always ends the transaction before releasing it.
 */
export async function contentFrames({
  pool,
  registry,
  actor,
  parents,
}: ContentOptions): Promise<ContentFrame[]> {
  const parentModel = registry.models.find((m) => m.name === PARENT_MODEL);
  if (parentModel === undefined) throw new Error(`${PARENT_MODEL} is not a synced model`);
  const models = registry.content.filter((m) => m.def.parent?.model === PARENT_MODEL);
  const client = await pool.connect();
  let healthy = false;
  try {
    // The snapshot is taken at the first statement; everything below reads that one snapshot.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // `sync_state` moves with `sync_log` in every writing transaction (bootstrap.ts).
    const head = await client.query<{ last: string }>(
      'SELECT last_sync_id AS last FROM sync_state WHERE id = 1',
    );
    const lastSyncId = Number(head.rows[0]?.last ?? 0);
    // Only well-formed groups reach SQL (and `clientRow`), like bootstrap's `meta.groups`.
    const groups = syncGroupSchema.array().parse(await contentGroups(actor, client));
    const found = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM ${quote(parentModel.table)}
        WHERE id = ANY($1::uuid[]) AND sync_groups && $2::text[] ORDER BY id`,
      [parents.map(parentIssueId), groups],
    );
    const visibleIds = found.rows.map((row) => row.id);
    const visible = new Set<string>(groups);
    const rows: ContentFrame[] = [];
    if (visibleIds.length > 0) {
      for (const model of models) {
        const selected = await client.query<Record<string, unknown>>(
          `${selectRows(model)} AND ${quote(parentColumn(model))} = ANY($2::uuid[]) ORDER BY id`,
          [groups, visibleIds],
        );
        for (const row of selected.rows) {
          rows.push({
            t: 'row',
            m: model.name,
            d: clientRow(model, row, row[GROUPS_ALIAS], visible),
          });
        }
      }
    }
    await client.query('COMMIT');
    healthy = true;
    return [
      {
        t: 'meta',
        lastSyncId,
        parents: visibleIds.map((id): ContentParent => `issue:${id}`),
        rows: rows.length,
      },
      ...rows,
      { t: 'end', rows: rows.length },
    ];
  } finally {
    if (!healthy) {
      healthy = await client.query('ROLLBACK').then(
        () => true,
        () => false,
      );
    }
    client.release(!healthy);
  }
}

/** The SQL column of a content model's parent field (the registry checked it exists). */
function parentColumn(model: SyncModel): string {
  const field = model.def.parent?.field;
  const column = field === undefined ? undefined : model.columns.get(field);
  if (column === undefined) throw new Error(`${model.name} has no parent column`);
  return column;
}
