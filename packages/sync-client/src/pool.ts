/**
 * The object pool (SPEC-002 §5.1–5.2): `model → id → instance`, holding for
 * each row the server's base state and an optional optimistic overlay. The
 * instance always shows `overlay ?? base`.
 *
 * Only server data reaches base (`applyBase`, `loadBase`); only the overlay
 * engine (PLAN-002 S8) calls `setOverlay`. Every write runs in one MobX action,
 * so a reaction sees a whole batch at once. Rows are deep-frozen on the way in
 * (ADR-0015), and views only ever see the `ReadonlyPool` side.
 */
import type { ModelDef, ModelRow } from '@surface/domain/model';
import type { IAtom } from 'mobx';
import { createAtom, runInAction } from 'mobx';
import type { IndexKey } from './indexes.js';
import { FieldIndex, isIndexKey } from './indexes.js';
import type {
  AnyInstance,
  InstanceClass,
  InstanceOf,
  ModelInstance,
  RowState,
} from './instance.js';
import { deepFreeze, fieldOf, instanceClassFor, rowOf, updateInstance } from './instance.js';

/** A change to base state, from bootstrap, warm start, or a delta packet. */
export type BaseChange =
  | { readonly kind: 'upsert'; readonly model: string; readonly row: ModelRow }
  | {
      readonly kind: 'archive' | 'unarchive' | 'delete';
      readonly model: string;
      readonly id: string;
    };

/** A model by name, or its definition (which also types the result). */
export type ModelKey = string | ModelDef;

const nameOf = (model: ModelKey): string => (typeof model === 'string' ? model : model.name);

/**
 * What views may do with the pool: read, reactively. Writes belong to the sync
 * engine. Archived rows are included in every read (`get`, `all`, `count`,
 * `findBy`, `backRef`), because the replica keeps them; views that hide
 * archived rows filter on `$archived` (state-machines.md §2).
 */
export interface ReadonlyPool {
  readonly models: readonly ModelDef[];
  model(name: string): ModelDef;
  get<M extends ModelDef>(model: M, id: string): InstanceOf<M> | undefined;
  get(model: string, id: string): ModelInstance | undefined;
  all<M extends ModelDef>(model: M): InstanceOf<M>[];
  all(model: string): ModelInstance[];
  count(model: ModelKey): number;
  findBy<M extends ModelDef>(model: M, field: string, value: IndexKey): InstanceOf<M>[];
  findBy(model: string, field: string, value: IndexKey): ModelInstance[];
  ref(instance: AnyInstance, name: string): ModelInstance | undefined;
  backRef(instance: AnyInstance, name: string): ModelInstance[];
}

/** `undefined`: no overlay (show base). `null`: deleted by a pending mutation. */
export type OverlayState = RowState | null | undefined;

class Entry {
  base: RowState | undefined;
  overlay: OverlayState;
  instance: ModelInstance | undefined;
  /** Whether the instance is currently visible (in indexes and `all`). */
  visible = false;
  presence: IAtom | undefined;

  get view(): RowState | undefined {
    return this.overlay === undefined ? this.base : (this.overlay ?? undefined);
  }
}

class ModelTable {
  readonly entries = new Map<string, Entry>();
  readonly indexes = new Map<string, FieldIndex>();
  readonly members: IAtom;
  readonly instances: InstanceClass;
  visibleCount = 0;

  constructor(readonly def: ModelDef) {
    this.members = createAtom(`${def.name}.*`);
    this.instances = instanceClassFor(def);
  }
}

export class ObjectPool implements ReadonlyPool {
  readonly #tables = new Map<string, ModelTable>();

  constructor(models: Iterable<ModelDef>) {
    for (const def of models) {
      if (this.#tables.has(def.name)) throw new Error(`Model ${def.name} is registered twice`);
      this.#tables.set(def.name, new ModelTable(def));
    }
    for (const table of this.#tables.values()) {
      for (const field of table.def.indexes) this.#addIndex(table, field);
    }
    // Refs are checked once every model is known; a backRef implies an index on the target.
    for (const table of this.#tables.values()) {
      for (const [name, refDef] of Object.entries(table.def.refs)) {
        const target = this.#tables.get(refDef.model);
        const where = `${table.def.name}.${name}`;
        if (target === undefined)
          throw new Error(`${where} refers to unknown model ${refDef.model}`);
        if (refDef.kind === 'backRef') {
          if (target.def.fields[refDef.field]?.kind !== 'uuid') {
            throw new Error(`${where} needs a uuid field ${refDef.model}.${refDef.field}`);
          }
          this.#addIndex(target, refDef.field);
        }
      }
    }
  }

  get models(): readonly ModelDef[] {
    return [...this.#tables.values()].map((table) => table.def);
  }

  model(name: string): ModelDef {
    return this.#table(name).def;
  }

  // -------------------------------------------------------------------------
  // Reads (reactive)

  /** The visible instance with this id, or `undefined`. */
  get<M extends ModelDef>(model: M, id: string): InstanceOf<M> | undefined;
  get(model: string, id: string): ModelInstance | undefined;
  get(model: ModelKey, id: string): ModelInstance | undefined {
    const table = this.#table(nameOf(model));
    let entry = table.entries.get(id);
    if (entry === undefined) {
      entry = new Entry();
      table.entries.set(id, entry);
    }
    const owner = entry;
    const created = owner.presence === undefined;
    const presence: IAtom = (owner.presence ??= createAtom(
      `${table.def.name}.${id}?`,
      undefined,
      () => {
        if (owner.presence === presence) owner.presence = undefined;
        this.#dropIfUnused(table, id, owner);
      },
    ));
    const instance = owner.visible ? owner.instance : undefined;
    // Outside a reaction MobX never unobserves an atom, so release one this call created.
    // An existing atom belongs to a live reaction and must stay.
    if (!presence.reportObserved() && created) {
      owner.presence = undefined;
      this.#dropIfUnused(table, id, owner);
    }
    return instance;
  }

  /** Every visible instance of a model. O(n): prefer `findBy` in views. */
  all<M extends ModelDef>(model: M): InstanceOf<M>[];
  all(model: string): ModelInstance[];
  all(model: ModelKey): ModelInstance[] {
    const table = this.#table(nameOf(model));
    table.members.reportObserved();
    const result: ModelInstance[] = [];
    for (const entry of table.entries.values()) {
      if (entry.visible && entry.instance) result.push(entry.instance);
    }
    return result;
  }

  count(model: ModelKey): number {
    const table = this.#table(nameOf(model));
    table.members.reportObserved();
    return table.visibleCount;
  }

  /** Visible instances whose indexed `field` equals `value`. */
  findBy<M extends ModelDef>(model: M, field: string, value: IndexKey): InstanceOf<M>[];
  findBy(model: string, field: string, value: IndexKey): ModelInstance[];
  findBy(model: ModelKey, field: string, value: IndexKey): ModelInstance[] {
    const table = this.#table(nameOf(model));
    const index = table.indexes.get(field);
    if (index === undefined) {
      throw new Error(`${table.def.name}.${field} has no index; declare it in the model`);
    }
    const result: ModelInstance[] = [];
    for (const id of index.lookup(value)) {
      const instance = table.entries.get(id)?.instance;
      if (instance) result.push(instance);
    }
    return result;
  }

  /** Follow a `ref`: the row whose id is in this instance's ref field. */
  ref(instance: AnyInstance, name: string): ModelInstance | undefined {
    const refDef = this.#refDef(instance, name, 'ref');
    const id = fieldOf(instance, refDef.field);
    return typeof id === 'string' ? this.get(refDef.model, id) : undefined;
  }

  /** Follow a `backRef`: the rows whose ref field holds this instance's id. */
  backRef(instance: AnyInstance, name: string): ModelInstance[] {
    const refDef = this.#refDef(instance, name, 'backRef');
    return this.findBy(refDef.model, refDef.field, instance.id);
  }

  /** Every base (server) row of a model, untracked. For the overlay engine. */
  baseRows(model: string): RowState[] {
    const rows: RowState[] = [];
    for (const entry of this.#table(model).entries.values()) if (entry.base) rows.push(entry.base);
    return rows;
  }

  /** Whether the pool holds this model. */
  has(model: string): boolean {
    return this.#tables.has(model);
  }

  /** The base (server) state of a row, untracked. For the overlay engine and tests. */
  baseOf(model: string, id: string): RowState | undefined {
    return this.#table(model).entries.get(id)?.base;
  }

  // -------------------------------------------------------------------------
  // Writes

  /** Apply server changes to base state, in order, as one batch. */
  applyBase(changes: Iterable<BaseChange>): void {
    runInAction(() => {
      for (const change of changes) {
        const table = this.#table(change.model);
        if (change.kind === 'upsert') {
          const entry = this.#entry(table, change.row.id);
          entry.base = { row: deepFreeze(change.row), archived: entry.base?.archived ?? false };
          this.#refresh(table, change.row.id, entry);
          continue;
        }
        const entry = table.entries.get(change.id);
        if (entry?.base === undefined) continue;
        if (change.kind === 'delete') entry.base = undefined;
        else entry.base = { row: entry.base.row, archived: change.kind === 'archive' };
        this.#refresh(table, change.id, entry);
      }
    });
  }

  /** Load rows into base (bootstrap chunks, warm start), as one batch. */
  loadBase(model: string, rows: Iterable<RowState>): void {
    const table = this.#table(model);
    runInAction(() => {
      for (const state of rows) {
        const entry = this.#entry(table, state.row.id);
        entry.base = { row: deepFreeze(state.row), archived: state.archived };
        this.#refresh(table, state.row.id, entry);
      }
    });
  }

  /**
   * Drop base rows that `keep` rejects (after a re-bootstrap, rows the server no
   * longer sends). Overlays are left alone.
   */
  sweepBase(keep: (model: string, id: string) => boolean): void {
    runInAction(() => {
      for (const table of this.#tables.values()) {
        for (const [id, entry] of table.entries) {
          if (entry.base === undefined || keep(table.def.name, id)) continue;
          entry.base = undefined;
          this.#refresh(table, id, entry);
        }
      }
    });
  }

  /** Set or clear the optimistic overlay of a row (PLAN-002 S8). */
  setOverlay(model: string, id: string, overlay: OverlayState): void {
    const table = this.#table(model);
    runInAction(() => {
      const entry = this.#entry(table, id);
      entry.overlay = overlay && { row: deepFreeze(overlay.row), archived: overlay.archived };
      this.#refresh(table, id, entry);
    });
  }

  // -------------------------------------------------------------------------
  // Internals

  #table(model: string): ModelTable {
    const table = this.#tables.get(model);
    if (table === undefined) throw new Error(`Unknown model ${model}`);
    return table;
  }

  #entry(table: ModelTable, id: string): Entry {
    let entry = table.entries.get(id);
    if (entry === undefined) {
      entry = new Entry();
      table.entries.set(id, entry);
    }
    return entry;
  }

  #addIndex(table: ModelTable, field: string): void {
    if (table.indexes.has(field)) return;
    if (!table.def.fields[field]?.indexable) {
      throw new Error(`${table.def.name}.${field} cannot be indexed; it is not a scalar field`);
    }
    table.indexes.set(field, new FieldIndex(`${table.def.name}.${field}`));
  }

  #refDef(instance: AnyInstance, name: string, kind: 'ref' | 'backRef') {
    const refDef = this.#table(instance.$model).def.refs[name];
    if (refDef?.kind !== kind) throw new Error(`${instance.$model}.${name} is not a ${kind}`);
    return refDef;
  }

  /** Bring an entry's instance, indexes and atoms in line with its current view. */
  #refresh(table: ModelTable, id: string, entry: Entry): void {
    const view = entry.view;
    if (view === undefined) {
      if (entry.visible && entry.instance) {
        this.#unindex(table, id, entry.instance);
        entry.visible = false;
        table.visibleCount -= 1;
        table.members.reportChanged();
        entry.presence?.reportChanged();
      }
      this.#dropIfUnused(table, id, entry);
      return;
    }
    if (entry.instance === undefined) {
      // A row that left and came back keeps its instance, so object identity is stable.
      entry.instance = table.instances.create(view);
    } else if (entry.visible) {
      this.#reindex(table, id, entry.instance, view.row);
      updateInstance(entry.instance, table.def, view);
      return;
    } else {
      updateInstance(entry.instance, table.def, view);
    }
    entry.visible = true;
    table.visibleCount += 1;
    this.#index(table, id, view.row);
    table.members.reportChanged();
    entry.presence?.reportChanged();
  }

  #index(table: ModelTable, id: string, row: ModelRow): void {
    for (const [field, index] of table.indexes) {
      const key = row[field];
      if (isIndexKey(key)) index.add(key, id);
    }
  }

  #unindex(table: ModelTable, id: string, instance: ModelInstance): void {
    for (const [field, index] of table.indexes) {
      const key = rowField(instance, field);
      if (isIndexKey(key)) index.remove(key, id);
    }
  }

  /** Move `id` between buckets for indexed fields whose value changes. Reads the old row untracked. */
  #reindex(table: ModelTable, id: string, instance: ModelInstance, next: ModelRow): void {
    for (const [field, index] of table.indexes) {
      const before = rowField(instance, field);
      const after = next[field];
      if (Object.is(before, after)) continue;
      if (isIndexKey(before)) index.remove(before, id);
      if (isIndexKey(after)) index.add(after, id);
    }
  }

  /** Forget an entry that has no state and nobody watching it. Instances of deleted rows are kept only while observed. */
  #dropIfUnused(table: ModelTable, id: string, entry: Entry): void {
    // Only drop this very entry: a stale callback must not delete a newer one under the same id.
    if (table.entries.get(id) !== entry) return;
    if (entry.base === undefined && entry.overlay === undefined && entry.presence === undefined) {
      table.entries.delete(id);
    }
  }
}

/** Read a field without reporting it to MobX (index maintenance must not subscribe). */
function rowField(instance: AnyInstance, field: string): unknown {
  return rowOf(instance)[field];
}
