/**
 * Incremental secondary indexes (PLAN-002 S6): `field value → ids` for one
 * model field, kept up to date on every view change (base or overlay). Lookups
 * are reactive per value: a reaction reading `teamId = X` re-runs only when
 * rows enter or leave that bucket.
 */
import type { IAtom } from 'mobx';
import { createAtom } from 'mobx';

/** Index keys are scalar field values; `null` is a key like any other. */
export type IndexKey = string | number | boolean | null;

export function isIndexKey(value: unknown): value is IndexKey {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

class Bucket {
  readonly ids = new Set<string>();
  atom: IAtom | undefined;
}

export class FieldIndex {
  readonly #buckets = new Map<IndexKey, Bucket>();

  constructor(readonly name: string) {}

  /** Ids whose value is `key`. Reports the read to the running reaction. */
  lookup(key: IndexKey): ReadonlySet<string> {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = new Bucket();
      this.#buckets.set(key, bucket);
    }
    const owner = bucket;
    const created = owner.atom === undefined;
    const atom: IAtom = (owner.atom ??= createAtom(`${this.name}=${String(key)}`, undefined, () => {
      if (owner.atom === atom) owner.atom = undefined;
      this.#dropIfEmpty(key, owner);
    }));
    // Outside a reaction MobX never unobserves an atom, so release one this call created.
    // An existing atom belongs to a live reaction and must stay.
    if (!atom.reportObserved() && created) {
      owner.atom = undefined;
      this.#dropIfEmpty(key, owner);
    }
    return owner.ids;
  }

  add(key: IndexKey, id: string): void {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = new Bucket();
      this.#buckets.set(key, bucket);
    }
    bucket.ids.add(id);
    bucket.atom?.reportChanged();
  }

  remove(key: IndexKey, id: string): void {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || !bucket.ids.delete(id)) return;
    bucket.atom?.reportChanged();
    this.#dropIfEmpty(key, bucket);
  }

  /** Forget an empty, unwatched bucket, but never a newer one under the same key. */
  #dropIfEmpty(key: IndexKey, bucket: Bucket): void {
    if (this.#buckets.get(key) === bucket && bucket.ids.size === 0 && bucket.atom === undefined) {
      this.#buckets.delete(key);
    }
  }

  /** Number of distinct keys held (for tests and the inspector). */
  get size(): number {
    return this.#buckets.size;
  }
}
