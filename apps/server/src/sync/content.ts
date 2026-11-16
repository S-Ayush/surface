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
 * The answer is read whole before the first frame goes out, so the snapshot's connection goes
 * back to the pool before the response is written, whatever the client's speed. It is bounded by
 * a **byte budget** (`CONTENT_ANSWER_BUDGET_BYTES`, SPEC-011 §5.2, D16): the size of each visible
 * parent's rows is measured in SQL first, and parents are taken whole, in request order, while they
 * fit; the first visible parent requested always comes, whatever its size, because a parent is
 * hydrated only by all of its rows. A parent left out is absent from `meta.parents`, like one not found: the client
 * marks it not hydrated and asks again (§5.3 step 3). A request for one parent is never cut.
 */
import { visibleGroups, type Actor } from '@surface/domain';
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

/**
 * At most this many bytes of content rows per answer (SPEC-011 §5.2, D16), measured in SQL as the
 * rows' text, beyond the first parent's (which always comes whole). 4 MiB holds 20 issues with a
 * full 200 KB description, or one issue with about 80 comments of the 50 KB maximum.
 */
export const CONTENT_ANSWER_BUDGET_BYTES = 4 * 1024 * 1024;

export interface ContentOptions {
  readonly pool: BootstrapPool;
  /** Defaults to `CONTENT_ANSWER_BUDGET_BYTES`; tests pass a small one. */
  readonly budgetBytes?: number;
  readonly registry: SyncRegistry;
  /** A signed-in user (the route refuses API keys before this runs). */
  readonly actor: Actor;
  /** Distinct, lower-cased (`decodeContentQuery`). */
  readonly parents: readonly ContentParent[];
}

/**
 * Every group `actor` may see (SPEC-011 §5.6): `visibleGroups`, so every public team's
 * `team:<id>` (the actor's `publicTeams`, read with the session) and never a socket's
 * subscriptions. The one place `/sync/content` decides visibility.
 */
export function contentGroups(actor: Actor): readonly string[] {
  return visibleGroups(actor);
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
  budgetBytes = CONTENT_ANSWER_BUDGET_BYTES,
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
    const groups = syncGroupSchema.array().parse(contentGroups(actor));
    const found = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM ${quote(parentModel.table)}
        WHERE id = ANY($1::uuid[]) AND sync_groups && $2::text[]
        ORDER BY array_position($1::uuid[], id)`,
      [parents.map(parentIssueId), groups],
    );
    const visibleIds = await withinBudget(
      client,
      models,
      groups,
      found.rows.map((row) => row.id),
      budgetBytes,
    );
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

/**
 * The parents of `ids` (in request order) whose rows fit `budget` together, taken whole, in that
 * order, while they fit (D16); the first always fits. Sizes are each parent's rows as text, summed per model in
 * the snapshot, with the same group filter as the rows read after.
 */
async function withinBudget(
  client: BootstrapClient,
  models: readonly SyncModel[],
  groups: readonly string[],
  ids: readonly string[],
  budget: number,
): Promise<string[]> {
  if (ids.length <= 1) return [...ids];
  const sizes = new Map<string, number>();
  for (const model of models) {
    const parent = quote(parentColumn(model));
    const measured = await client.query<{ parent: string; bytes: string }>(
      `SELECT t.${parent}::text AS parent, sum(octet_length(t::text))::bigint AS bytes
         FROM ${quote(model.table)} t
        WHERE t.sync_groups && $1::text[] AND t.${parent} = ANY($2::uuid[])
        GROUP BY t.${parent}`,
      [groups, ids],
    );
    for (const row of measured.rows) {
      sizes.set(row.parent, (sizes.get(row.parent) ?? 0) + Number(row.bytes));
    }
  }
  const taken: string[] = [];
  let total = 0;
  for (const id of ids) {
    const size = sizes.get(id) ?? 0;
    if (taken.length > 0 && total + size > budget) break;
    taken.push(id);
    total += size;
  }
  return taken;
}

/** The SQL column of a content model's parent field (the registry checked it exists). */
function parentColumn(model: SyncModel): string {
  const field = model.def.parent?.field;
  const column = field === undefined ? undefined : model.columns.get(field);
  if (column === undefined) throw new Error(`${model.name} has no parent column`);
  return column;
}
