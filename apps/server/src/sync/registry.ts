/**
 * The sync registry (PLAN-002 S3): which models sync, how a server row becomes the row the
 * client holds, and the schema hash. Built from the shared model definitions in
 * `@surface/domain/model`, the same ones the client store uses, so the two can't drift: the
 * server's `schemaHash` is `computeSchemaHash` over the same definitions (sync-protocol §8).
 */
import type { ModelDef } from '@surface/domain/model';
import { computeSchemaHash } from '@surface/sync-protocol';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { toSnakeCase } from 'drizzle-orm/casing';
import { isModelName, SYNCED_MODELS, type ModelName } from './models.js';

/**
 * The client field a row's sync groups travel in. They go out cut to the groups of the
 * connection receiving them (SPEC-002 Q6), so a client never sees the id of a private team it
 * isn't in. A model that doesn't declare the field gets no groups.
 */
export const GROUPS_FIELD = 'groups';

export interface SyncModel {
  readonly name: ModelName;
  readonly def: ModelDef;
  /** The SQL table name. */
  readonly table: string;
  /** Client field → SQL column, for every declared field except `groups`. */
  readonly columns: ReadonlyMap<string, string>;
  /** Whether the table has `archived_at`; archived rows go out with `archived: true`. */
  readonly archivable: boolean;
}

export interface SyncRegistry {
  readonly models: readonly SyncModel[];
  /** Models in the bootstrap (sync-protocol §2). */
  readonly eager: readonly SyncModel[];
  readonly schemaHash: string;
}

export interface RegistryOptions {
  /** Include engine fixtures (`DebugItem`): only for sync-engine tests (SPEC-002 Q8). */
  readonly includeFixtures: boolean;
}

/** Builds the registry and checks every declared field has a column. Throws naming the model. */
export function syncRegistry({ includeFixtures }: RegistryOptions): SyncRegistry {
  const models: SyncModel[] = [];
  for (const name of Object.keys(SYNCED_MODELS)) {
    if (!isModelName(name)) continue;
    const entry = SYNCED_MODELS[name];
    if (entry.fixture && !includeFixtures) continue;
    models.push(syncModel(name, entry.def, entry.table));
  }
  return {
    models,
    eager: models.filter((m) => m.def.load === 'eager'),
    schemaHash: computeSchemaHash(models.map((m) => m.def)),
  };
}

/**
 * The models a server syncs: the production ones, plus the engine fixtures only when a test asks
 * (`startServer`'s `syncFixtures`), in every `NODE_ENV`; the web app syncs the production models
 * only (SPEC-002 Q8).
 */
export function serverSyncRegistry(options: { readonly syncFixtures?: boolean }): SyncRegistry {
  return syncRegistry({ includeFixtures: options.syncFixtures ?? false });
}

/** One model's registry entry. Exported for tests. */
export function syncModel(
  name: ModelName,
  def: ModelDef,
  table: (typeof SYNCED_MODELS)[ModelName]['table'],
): SyncModel {
  if (def.name !== name) {
    throw new Error(`Synced model ${name} has the definition of ${def.name}.`);
  }
  const tableColumns: Record<string, { name: string; keyAsName: boolean }> = getTableColumns(table);
  const columns = new Map<string, string>();
  for (const field of Object.keys(def.fields)) {
    if (field === GROUPS_FIELD) continue;
    const column = tableColumns[field];
    if (!column) {
      throw new Error(
        `${name}.${field} is declared in @surface/domain/model but ${getTableName(table)} has no such column.`,
      );
    }
    // Columns declared without a name are named by `casing: 'snake_case'` when Drizzle builds
    // SQL (drizzle.config.ts, the executor); `column.name` is then still the camelCase key.
    columns.set(field, column.keyAsName ? toSnakeCase(column.name) : column.name);
  }
  return {
    name,
    def,
    table: getTableName(table),
    columns,
    archivable: Object.hasOwn(tableColumns, 'archivedAt'),
  };
}

/**
 * The row a client receives, from values keyed by client field (as `bootstrap.ts` selects them,
 * or a `sync_log.data` row) and the row's sync groups. Declared fields only; instants as ISO
 * strings with milliseconds; `groups` = `rowGroups` cut to `visible`.
 */
export function clientRow(
  model: SyncModel,
  row: Readonly<Record<string, unknown>>,
  rowGroups: unknown,
  visible: ReadonlySet<string>,
): { readonly id: string; readonly [field: string]: unknown } {
  const id = row['id'];
  if (typeof id !== 'string') throw new Error(`${model.name} row without an id`);
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(model.def.fields)) {
    if (field === GROUPS_FIELD) {
      out[field] = Array.isArray(rowGroups) ? rowGroups.filter((g) => visible.has(String(g))) : [];
    } else {
      const value = row[field];
      out[field] = value instanceof Date ? value.toISOString() : value;
    }
  }
  return { ...out, id };
}
