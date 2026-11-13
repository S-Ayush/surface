/**
 * The optimistic overlay (SPEC-002 §5.2, sync-protocol.md §5.2): base state
 * plus the effect of every pending mutation, applied in seq order by running
 * each operation's `optimistic(store, input)` against a **draft**.
 *
 * - The draft holds only rows the mutations wrote; everything else reads
 *   through to base. Its rows become the pool's overlays, so views show
 *   `overlay ?? base`.
 * - Each mutation runs in its own layer. If `optimistic()` throws, or leaves a
 *   row its model rejects, that layer is dropped: the mutation shows no effect
 *   until the server answers, and the other mutations are unaffected.
 * - A new mutation is applied on top of the current draft (`push`), so the
 *   overlay changes in the same MobX batch as the dispatch (AC-5).
 * - `rebuild` starts again from base. The store calls it when the mutation
 *   list changes (confirmed, rejected) or when a delta touches a row some
 *   mutation read or wrote (`dependsOn`); deltas elsewhere cost nothing.
 */
import type { RefEntity, RefType } from '@surface/domain';
import { isUuid } from '@surface/domain';
import type { ModelRow } from '@surface/domain/model';
import type { AnyOperation, OptimisticStore, StoreRow } from '@surface/operations';
import { runInAction } from 'mobx';
import { decodeRow } from './bootstrap.js';
import type { ObjectPool, OverlayState } from './pool.js';
import type { RefSource } from './refs.js';
import { REF_MODELS, createClientRefResolver } from './refs.js';

/** A pending mutation as the overlay runs it. */
export interface OverlayMutation {
  /** Unique within the queue, e.g. `<clientId>:<seq>`. */
  readonly key: string;
  readonly op: AnyOperation;
  /** The parsed input (`z.output`), as `optimistic()` expects it. */
  readonly input: unknown;
  /** The dispatch time, so a replay computes the same rows. */
  readonly now: Date;
}

/** `null`: deleted by a pending mutation. */
type DraftRow = { readonly row: ModelRow; readonly archived: boolean } | null;

/** Which reference format `store.get(model, ref)` accepts besides an id. */
const REF_TYPE_OF: ReadonlyMap<string, RefType> = new Map<string, RefType>([
  [REF_MODELS.TeamRef, 'TeamRef'],
  [REF_MODELS.UserRef, 'UserRef'],
  [REF_MODELS.StatusRef, 'StatusRef'],
  [REF_MODELS.LabelRef, 'LabelRef'],
  [REF_MODELS.IssueRef, 'IssueRef'],
]);

const rowKey = (model: string, id: string) => `${model}\u0000${id}`;

/** What a delta can change the overlay through: rows read or written, models searched by name. */
interface Dependencies {
  readonly rows: Set<string>;
  readonly models: Set<string>;
}

const noDependencies = (): Dependencies => ({ rows: new Set(), models: new Set() });

function splitKey(key: string): [model: string, id: string] {
  const at = key.indexOf('\u0000');
  return [key.slice(0, at), key.slice(at + 1)];
}

export class OverlayEngine {
  readonly #pool: ObjectPool;
  /** The signed-in user's id, for `me` references. */
  readonly #me: () => string | undefined;
  readonly #onError: (mutation: OverlayMutation, error: unknown) => void;
  /** Rows written by pending mutations, as they now stand. */
  #draft = new Map<string, DraftRow>();
  /** A delta to one of these means `rebuild`. */
  #dependsOn = noDependencies();

  constructor(
    pool: ObjectPool,
    me: () => string | undefined,
    onError: (mutation: OverlayMutation, error: unknown) => void = () => undefined,
  ) {
    this.#pool = pool;
    this.#me = me;
    this.#onError = onError;
  }

  /** Whether a change to this row can change the overlay. */
  dependsOn(model: string, id: string): boolean {
    return this.#dependsOn.models.has(model) || this.#dependsOn.rows.has(rowKey(model, id));
  }

  /** Apply one more mutation on top of the current overlay. */
  push(mutation: OverlayMutation): void {
    const layer = this.#run(this.#draft, this.#dependsOn, mutation);
    if (layer === undefined) return;
    for (const [key, row] of layer) this.#draft.set(key, row);
    runInAction(() => {
      for (const [key, row] of layer) this.#show(key, row);
    });
  }

  /** Recompute the overlay from base for these mutations, in order. */
  rebuild(mutations: readonly OverlayMutation[]): void {
    const draft = new Map<string, DraftRow>();
    const dependsOn = noDependencies();
    for (const mutation of mutations) {
      const layer = this.#run(draft, dependsOn, mutation);
      if (layer) for (const [key, row] of layer) draft.set(key, row);
    }
    const before = this.#draft;
    this.#draft = draft;
    this.#dependsOn = dependsOn;
    runInAction(() => {
      for (const key of before.keys()) if (!draft.has(key)) this.#show(key, undefined);
      for (const [key, row] of draft) this.#show(key, row);
    });
  }

  /** Run one mutation against `draft`; its writes, or `undefined` if it failed. */
  #run(
    draft: ReadonlyMap<string, DraftRow>,
    dependsOn: Dependencies,
    mutation: OverlayMutation,
  ): Map<string, DraftRow> | undefined {
    const layer = new Map<string, DraftRow>();
    const touched = new Set<string>();
    const searched = new Set<string>();
    const read = (model: string, id: string): DraftRow | undefined => {
      const key = rowKey(model, id);
      touched.add(key);
      if (layer.has(key)) return layer.get(key);
      if (draft.has(key)) return draft.get(key);
      return this.#pool.baseOf(model, id);
    };
    /** Every row of `model` as this mutation sees it; a delta to any of them means `rebuild`. */
    const rowsOf = (model: string): ModelRow[] => {
      if (!this.#pool.has(model)) return [];
      searched.add(model);
      const rows = new Map<string, ModelRow>();
      for (const { row } of this.#pool.baseRows(model)) rows.set(row.id, row);
      for (const changes of [draft, layer]) {
        for (const [key, state] of changes) {
          const [rowModel, id] = splitKey(key);
          if (rowModel !== model) continue;
          if (state === null) rows.delete(id);
          else rows.set(id, state.row);
        }
      }
      return [...rows.values()];
    };
    // References see base plus the mutations so far, never the screen (review m3).
    const view: RefSource = {
      row: (model, id) => (this.#pool.has(model) ? read(model, id)?.row : undefined),
      rows: (model): RefEntity[] => rowsOf(model),
    };
    const resolver = createClientRefResolver(view, this.#me);
    const idOf = (model: string, ref: string): string | undefined => {
      if (isUuid(ref)) return ref.toLowerCase();
      const type = REF_TYPE_OF.get(model);
      const found = type === undefined ? undefined : resolver.resolve(type, ref);
      return found?.status === 'found' ? found.entity.id : undefined;
    };
    const live = (model: string, ref: string) => {
      const id = idOf(model, ref);
      const current = id === undefined ? undefined : read(model, id);
      return id === undefined || !current ? undefined : { id, current };
    };
    const declaresArchivedAt = (model: string) =>
      this.#pool.model(model).fields['archivedAt'] !== undefined;
    const write = (model: string, data: unknown, archived: boolean) => {
      const row = decodeRow(this.#pool, model, data);
      layer.set(rowKey(model, row.id), { row, archived });
      touched.add(rowKey(model, row.id));
    };

    const store: OptimisticStore = {
      now: mutation.now,
      get: (model, ref) => live(model, ref)?.current.row,
      find: (model, fields) => {
        const wanted = Object.entries(fields);
        // Ordered by id, so a replay finds the same rows in the same order (SPEC-011 §6.3, AC-7).
        // Sorted after filtering: the matches are few, the model's rows may be many.
        return rowsOf(model)
          .filter((row) => wanted.every(([field, value]) => row[field] === value))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },
      patch: (model, ref, changes: StoreRow) => {
        const found = live(model, ref);
        if (found === undefined) return;
        write(model, { ...found.current.row, ...changes, id: found.id }, found.current.archived);
      },
      insert: (model, row) => write(model, row, false),
      // SPEC-011 §6.3: the flag and, for a model that declares it, `archivedAt` move together.
      archive: (model, ref) => {
        const found = live(model, ref);
        if (found === undefined) return;
        if (!declaresArchivedAt(model)) {
          layer.set(rowKey(model, found.id), { ...found.current, archived: true });
          return;
        }
        const archivedAt = mutation.now.toISOString();
        write(model, { ...found.current.row, archivedAt, id: found.id }, true);
      },
      unarchive: (model, ref) => {
        const found = live(model, ref);
        if (found === undefined) return;
        if (!declaresArchivedAt(model)) {
          layer.set(rowKey(model, found.id), { ...found.current, archived: false });
          return;
        }
        write(model, { ...found.current.row, archivedAt: null, id: found.id }, false);
      },
      remove: (model, ref) => {
        const found = live(model, ref);
        if (found) layer.set(rowKey(model, found.id), null);
      },
    };

    try {
      mutation.op.optimistic?.(store, mutation.input);
    } catch (error) {
      this.#onError(mutation, error);
      return undefined;
    } finally {
      // A failed mutation still read these rows: a delta to them may change nothing, but
      // tracking them costs one rebuild at most.
      for (const key of touched) dependsOn.rows.add(key);
      for (const model of searched) dependsOn.models.add(model);
    }
    return layer;
  }

  #show(key: string, row: DraftRow | undefined): void {
    const [model, id] = splitKey(key);
    const state: OverlayState = row === undefined ? undefined : row;
    this.#pool.setOverlay(model, id, state);
  }
}
