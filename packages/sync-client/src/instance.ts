/**
 * Model instances (ADR-0003, ADR-0015): one object per row, with one prototype getter per
 * field. Each field is backed by a MobX atom created on first read and dropped
 * when no longer observed, so reactivity is per field and 150k mostly
 * unobserved rows cost one plain object each. MobX 7 observable objects are
 * always Proxy-backed; prototype getters avoid a proxy trap on every read.
 *
 * Instances are frozen and have no setters, and their rows are deep-frozen
 * (`deepFreeze`): the only way to change one is through the pool (ADR-0015).
 */
import type { ModelDef, ModelRow, RowOfModel } from '@surface/domain/model';
import type { IAtom } from 'mobx';
import { createAtom } from 'mobx';

/** Fields every instance has besides the model's own. */
export interface InstanceMeta {
  /** The model name. */
  readonly $model: string;
  /**
   * True once the server archived the row or an optimistic archive is pending. For a model that
   * declares `archivedAt`, it is `archivedAt !== null` (SPEC-011 §5.5); otherwise the `A`/`V`
   * packets and the bootstrap frame's flag set it.
   */
  readonly $archived: boolean;
}

export type ModelInstance<Row extends ModelRow = ModelRow> = Readonly<Row> & InstanceMeta;

/** Any instance, typed or not: what functions taking an instance accept. */
export type AnyInstance = InstanceMeta & { readonly id: string };

/** The instance type of a model definition, e.g. `InstanceOf<typeof DebugItem>`. */
export type InstanceOf<M> = ModelInstance<RowOfModel<M>>;

/** The view of a row: overlay if any, else base (SPEC-002 §5.2). */
export interface RowState {
  readonly row: ModelRow;
  readonly archived: boolean;
}

const ARCHIVED = '$archived';

/** Internal state, kept off the public surface behind a module-private symbol. */
const STATE = Symbol('surface.instance');

class InstanceState {
  #atoms: Map<string, IAtom> | undefined;

  constructor(
    readonly model: string,
    public row: ModelRow,
    public archived: boolean,
  ) {}

  /** Mark `key` as read by the running reaction, if any. */
  observe(key: string): void {
    const atoms = (this.#atoms ??= new Map<string, IAtom>());
    const existing = atoms.get(key);
    const atom: IAtom =
      existing ??
      createAtom(`${this.model}.${String(this.row.id)}.${key}`, undefined, () => {
        if (atoms.get(key) === atom) atoms.delete(key);
      });
    if (existing === undefined) atoms.set(key, atom);
    // Outside a reaction MobX never unobserves an atom, so drop one this call created
    // (a sort over 150k rows in an event handler must not leave 150k atoms behind).
    if (!atom.reportObserved() && existing === undefined) atoms.delete(key);
  }

  get trackedCount(): number {
    return this.#atoms?.size ?? 0;
  }

  changed(key: string): void {
    this.#atoms?.get(key)?.reportChanged();
  }
}

interface WithState {
  readonly [STATE]: InstanceState;
}

function stateOf(instance: object): InstanceState {
  const state: unknown = STATE in instance ? instance[STATE] : undefined;
  if (!(state instanceof InstanceState)) throw new Error('Not a model instance');
  return state;
}

export interface InstanceClass {
  create(view: RowState): ModelInstance;
}

/** Build the instance class for one model: a getter per field on a shared prototype. */
export function instanceClassFor(model: ModelDef): InstanceClass {
  // `Object.create` returns `any`; these casts are confined to building the class.
  const prototype = Object.create(Object.prototype, {
    $model: { value: model.name, enumerable: false },
    $archived: {
      enumerable: false,
      get(this: WithState) {
        const state = this[STATE];
        state.observe(ARCHIVED);
        return state.archived;
      },
    },
    toJSON: {
      enumerable: false,
      value(this: WithState) {
        return this[STATE].row;
      },
    },
  }) as object;
  for (const field of Object.keys(model.fields)) {
    Object.defineProperty(prototype, field, {
      enumerable: true,
      get(this: WithState) {
        const state = this[STATE];
        // `id` never changes, so it needs no atom.
        if (field !== 'id') state.observe(field);
        return state.row[field];
      },
    });
  }
  return {
    create(view) {
      return Object.freeze(
        Object.create(prototype, {
          [STATE]: { value: new InstanceState(model.name, view.row, view.archived) },
        }),
      ) as ModelInstance;
    },
  };
}

/**
 * Point an instance at a new view and notify the fields that changed. Must run
 * inside a MobX action (the pool batches every write).
 */
export function updateInstance(instance: AnyInstance, model: ModelDef, view: RowState): void {
  const state = stateOf(instance);
  const previous = state.row;
  state.row = view.row;
  for (const [field, def] of Object.entries(model.fields)) {
    if (field === 'id') continue;
    const before = previous[field];
    const after = view.row[field];
    if (
      !(before === undefined || after === undefined ? before === after : def.equals(before, after))
    ) {
      state.changed(field);
    }
  }
  if (state.archived !== view.archived) {
    state.archived = view.archived;
    state.changed(ARCHIVED);
  }
}

/**
 * Freeze a row and every object or array inside it (json and array fields).
 * Parts that are already frozen are skipped: rows are fresh from validation,
 * so a frozen part was frozen here.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The plain, frozen row an instance currently shows. */
export function rowOf(instance: AnyInstance): ModelRow {
  return stateOf(instance).row;
}

/** Read a field by name, reporting the read to MobX like the getter does. */
export function fieldOf(instance: AnyInstance, field: string): unknown {
  const state = stateOf(instance);
  if (field !== 'id') state.observe(field);
  return state.row[field];
}

/** Number of fields with a live tracker (tests and the inspector). */
export function trackedFieldCount(instance: AnyInstance): number {
  return stateOf(instance).trackedCount;
}
