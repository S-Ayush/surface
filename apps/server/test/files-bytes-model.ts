// A model of what the byte protocol (`src/files/bytes.ts`) relies on in Postgres, for PLAN-014
// S3's property and clean-up tests: `READ COMMITTED` transactions (each statement sees what others
// committed, plus its own writes), row locks (`FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`, the key
// share a foreign key check takes), transaction advisory locks, savepoints, and the RESTRICT
// foreign keys of `files.preview_of`, `users.avatar_file_id` and `workspace.logo_file_id`.
// `files-bytes-pg.int.test.ts` runs the same protocol against real Postgres.
//
// `step` is called at every statement and blob operation, so a fast-check scheduler can
// interleave concurrent transactions there. A model transaction never detects a deadlock: one
// shows up as a transaction that never ends, which the property test reports.
//
// **Row lock modes are merged.** Postgres has four (`FOR KEY SHARE`, `FOR SHARE`,
// `FOR NO KEY UPDATE`, `FOR UPDATE`); the model has two: `shared` (`FOR SHARE`, and the key share
// a foreign key check takes) and `exclusive` (`FOR UPDATE`, `DELETE`, and an `UPDATE` that leaves
// keys alone, which Postgres takes as `FOR NO KEY UPDATE`). So the model makes a claim or a detach
// (`FOR NO KEY UPDATE`) wait for a foreign key check (`FOR KEY SHARE`), and the reverse, where
// Postgres lets them run together. That only adds waits, which can hide nothing a real run would
// show except a deadlock the model invents. If S4a or S4b adds such a pair where a wait matters
// (a claim against a preview insert's key share, say), give the model the four modes first.
import { memoryBlobStore, type BlobStore, type TempBlob } from '../src/files/blob-store.js';
import type {
  CleanupCandidate,
  FileDb,
  FileKeyRow,
  FileTx,
  NewFile,
  PreviewKeyRow,
} from '../src/files/bytes.js';

export interface ModelRow {
  readonly id: string;
  readonly storageKey: string;
  readonly purpose: NewFile['purpose'];
  readonly uploaderId: string;
  readonly issueId: string | null;
  readonly previewOf: string | null;
  readonly createdAt: number;
  readonly detachedAt: number | null;
}

type Op =
  | { kind: 'insert'; row: ModelRow }
  | { kind: 'delete'; id: string }
  | { kind: 'update'; id: string; patch: Partial<Pick<ModelRow, 'issueId' | 'detachedAt'>> }
  | { kind: 'release'; key: string }
  | { kind: 'forget'; key: string }
  | { kind: 'name'; id: string }
  | { kind: 'unname'; id: string };

/** A Postgres foreign key violation, as node-postgres reports it. */
export class ForeignKeyViolation extends Error {
  readonly code = '23503';
  constructor(what: string) {
    super(`foreign key violation: ${what}`);
  }
}

type Mode = 'shared' | 'exclusive';

interface LockState {
  readonly holders: Map<number, Mode>;
  readonly waiting: { tx: number; mode: Mode; grant: () => void }[];
}

/** Row and advisory locks: shared ones together, an exclusive one alone; FIFO waiting. */
class Locks {
  private readonly locks = new Map<string, LockState>();

  private state(name: string): LockState {
    let state = this.locks.get(name);
    if (state === undefined) {
      state = { holders: new Map(), waiting: [] };
      this.locks.set(name, state);
    }
    return state;
  }

  private compatible(state: LockState, tx: number, mode: Mode): boolean {
    for (const [holder, held] of state.holders) {
      if (holder === tx) continue;
      if (mode === 'exclusive' || held === 'exclusive') return false;
    }
    return true;
  }

  private grant(state: LockState, tx: number, mode: Mode): void {
    if (state.holders.get(tx) !== 'exclusive') state.holders.set(tx, mode);
  }

  /** True if `tx` already holds the lock at least as strongly. */
  private holds(state: LockState, tx: number, mode: Mode): boolean {
    const held = state.holders.get(tx);
    return held === 'exclusive' || (held === 'shared' && mode === 'shared');
  }

  acquire(name: string, tx: number, mode: Mode): Promise<void> {
    const state = this.state(name);
    if (this.holds(state, tx, mode)) return Promise.resolve();
    if (state.waiting.length === 0 && this.compatible(state, tx, mode)) {
      this.grant(state, tx, mode);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      state.waiting.push({ tx, mode, grant: resolve });
    });
  }

  /** `SKIP LOCKED`: the lock now, or false without waiting. */
  tryAcquire(name: string, tx: number, mode: Mode): boolean {
    const state = this.state(name);
    if (this.holds(state, tx, mode)) return true;
    if (state.waiting.length > 0 || !this.compatible(state, tx, mode)) return false;
    this.grant(state, tx, mode);
    return true;
  }

  releaseAll(tx: number): void {
    for (const state of this.locks.values()) {
      if (!state.holders.delete(tx)) continue;
      while (state.waiting.length > 0) {
        const next = state.waiting[0];
        if (next === undefined || !this.compatible(state, next.tx, next.mode)) break;
        state.waiting.shift();
        this.grant(state, next.tx, next.mode);
        next.grant();
      }
    }
  }
}

const HOUR = 60 * 60 * 1000;
export const MODEL_HOUR = HOUR;

/** The committed state: `files`, `blob_release`, and the file ids users and the workspace name. */
export class ModelDb implements FileDb {
  readonly rows = new Map<string, ModelRow>();
  readonly released = new Set<string>();
  /** `users.avatar_file_id` and `workspace.logo_file_id` values. */
  readonly named = new Set<string>();
  readonly locks = new Locks();
  /** Milliseconds; `created_at` and `detached_at` come from it. */
  clock = 0;
  /** Called before every statement: a scheduler interleaves transactions here. */
  step: (label: string) => Promise<void> = () => Promise.resolve();
  private transactions = 0;
  /** Transactions not yet committed or rolled back. */
  open = 0;

  async transaction<T>(fn: (tx: FileTx) => Promise<T>): Promise<T> {
    return this.modelTransaction(fn);
  }

  /** `transaction`, with the model's extra statements (claims, detaching, naming avatars). */
  async modelTransaction<T>(fn: (tx: ModelTx) => Promise<T>): Promise<T> {
    const tx = new ModelTx(this, ++this.transactions);
    this.open++;
    try {
      const result = await fn(tx);
      await this.step('commit');
      tx.commit();
      return result;
    } finally {
      this.open--;
      this.locks.releaseAll(tx.id);
    }
  }

  async releasedKeys(limit: number, after: string | undefined): Promise<string[]> {
    await this.step('releasedKeys');
    return [...this.released]
      .filter((key) => after === undefined || key > after)
      .sort()
      .slice(0, limit);
  }

  async keysInUse(keys: readonly string[]): Promise<Set<string>> {
    await this.step('keysInUse');
    const used = new Set([...this.rows.values()].map((row) => row.storageKey));
    return new Set(keys.filter((key) => used.has(key)));
  }
}

export class ModelTx implements FileTx {
  private readonly ops: Op[] = [];

  constructor(
    private readonly db: ModelDb,
    readonly id: number,
  ) {}

  /** What this transaction's next statement sees: everything committed, plus its own writes. */
  view(): {
    rows: Map<string, ModelRow>;
    released: Set<string>;
    named: Set<string>;
  } {
    const rows = new Map(this.db.rows);
    const released = new Set(this.db.released);
    const named = new Set(this.db.named);
    apply(this.ops, rows, released, named);
    return { rows, released, named };
  }

  commit(): void {
    apply(this.ops, this.db.rows, this.db.released, this.db.named);
  }

  private row(id: string) {
    return `row:${id}`;
  }

  async lockKeys(keys: readonly string[]): Promise<void> {
    // In key order, where Postgres goes in `hashtext` order: any one total order of the keys
    // avoids the same waits in a cycle, so the model needn't hash.
    for (const key of [...new Set(keys)].sort()) {
      await this.db.step(`lock ${key}`);
      await this.db.locks.acquire(`key:${key}`, this.id, 'exclusive');
    }
  }

  async lockFiles(ids: readonly string[], mode: 'update' | 'share'): Promise<FileKeyRow[]> {
    await this.db.step('lockFiles');
    const found: FileKeyRow[] = [];
    for (const id of [...new Set(ids)].sort()) {
      if (!this.view().rows.has(id)) continue;
      await this.db.locks.acquire(
        this.row(id),
        this.id,
        mode === 'update' ? 'exclusive' : 'shared',
      );
      // Postgres re-reads a row it waited for: deleted meanwhile, it is left out.
      const row = this.view().rows.get(id);
      if (row !== undefined) found.push({ id: row.id, storageKey: row.storageKey });
    }
    return found;
  }

  async lockPreviews(sourceIds: readonly string[]): Promise<PreviewKeyRow[]> {
    await this.db.step('lockPreviews');
    const sources = new Set(sourceIds);
    const candidates = [...this.view().rows.values()]
      .filter((row) => row.previewOf !== null && sources.has(row.previewOf))
      .map((row) => row.id)
      .sort();
    const found: PreviewKeyRow[] = [];
    for (const id of candidates) {
      await this.db.locks.acquire(this.row(id), this.id, 'exclusive');
      const row = this.view().rows.get(id);
      if (row?.previewOf != null && sources.has(row.previewOf)) {
        found.push({ id: row.id, storageKey: row.storageKey, previewOf: row.previewOf });
      }
    }
    return found;
  }

  async insertFile(file: NewFile): Promise<void> {
    await this.db.step('insertFile');
    const previewOf = file.previewOf ?? null;
    if (previewOf !== null) {
      // The foreign key check: a key share lock on the source, then it must exist.
      await this.db.locks.acquire(this.row(previewOf), this.id, 'shared');
      if (!this.view().rows.has(previewOf)) throw new ForeignKeyViolation('preview_of');
    }
    this.ops.push({
      kind: 'insert',
      row: {
        id: file.id,
        storageKey: file.storageKey,
        purpose: file.purpose,
        uploaderId: file.uploaderId,
        issueId: file.issueId ?? null,
        previewOf,
        createdAt: this.db.clock,
        detachedAt: null,
      },
    });
    // Its own new row is locked by the inserting transaction.
    await this.db.locks.acquire(this.row(file.id), this.id, 'exclusive');
  }

  async deleteFiles(ids: readonly string[]): Promise<void> {
    await this.db.step('deleteFiles');
    const { rows, named } = this.view();
    const deleting = new Set(ids);
    for (const id of deleting) {
      if (!rows.has(id)) continue;
      // DELETE locks each row; the protocol already holds them.
      await this.db.locks.acquire(this.row(id), this.id, 'exclusive');
      if (named.has(id)) throw new ForeignKeyViolation('avatar_file_id or logo_file_id');
      for (const row of rows.values()) {
        if (row.previewOf === id && !deleting.has(row.id)) {
          throw new ForeignKeyViolation('preview_of');
        }
      }
    }
    for (const id of deleting) if (rows.has(id)) this.ops.push({ kind: 'delete', id });
  }

  async releaseKeys(keys: readonly string[]): Promise<void> {
    await this.db.step('releaseKeys');
    for (const key of keys) this.ops.push({ kind: 'release', key });
  }

  async keyInUse(key: string): Promise<boolean> {
    await this.db.step('keyInUse');
    return [...this.view().rows.values()].some((row) => row.storageKey === key);
  }

  async forgetKey(key: string): Promise<boolean> {
    await this.db.step('forgetKey');
    if (!this.view().released.has(key)) return false;
    this.ops.push({ kind: 'forget', key });
    return true;
  }

  async cleanupCandidates(
    cutoff: Date,
    after: string | undefined,
    limit: number,
  ): Promise<CleanupCandidate[]> {
    await this.db.step('cleanupCandidates');
    const before = cutoff.getTime();
    const { rows, named } = this.view();
    const found: CleanupCandidate[] = [];
    for (const row of [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (found.length >= limit) break;
      if (after !== undefined && row.id <= after) continue;
      const reason = cleanupReasonOf(row, before, named);
      if (reason === undefined) continue;
      if (!this.db.locks.tryAcquire(this.row(row.id), this.id, 'exclusive')) continue;
      found.push({ id: row.id, reason });
    }
    return found;
  }

  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const mark = this.ops.length;
    try {
      return await fn();
    } catch (error) {
      this.ops.length = mark;
      throw error;
    }
  }

  // The model's other statements: what S4a and S4b's handlers will do in SQL.

  /** The ids of an issue's files (purge, PLAN-015 S2). */
  async filesOfIssue(issueId: string): Promise<string[]> {
    await this.db.step('filesOfIssue');
    return [...this.view().rows.values()]
      .filter((row) => row.issueId === issueId)
      .map((row) => row.id);
  }

  /** `attachment.createFile` or a saved document claiming an unclaimed upload (§4.3). */
  async claim(id: string, issueId: string): Promise<boolean> {
    await this.db.step('claim');
    if (!this.view().rows.has(id)) return false;
    await this.db.locks.acquire(this.row(id), this.id, 'exclusive');
    const row = this.view().rows.get(id);
    if (row === undefined || row.issueId !== null || row.purpose === 'preview') return false;
    if (row.purpose !== 'attachment' && row.purpose !== 'inline') return false;
    this.ops.push({ kind: 'update', id, patch: { issueId } });
    return true;
  }

  async claimInline(id: string, issueId: string, uploaderId: string): Promise<boolean> {
    await this.db.step('claimInline');
    if (!this.view().rows.has(id)) return false;
    // An `UPDATE`'s row lock (exclusive here, see the note on modes), then the condition again.
    await this.db.locks.acquire(this.row(id), this.id, 'exclusive');
    const row = this.view().rows.get(id);
    if (row?.purpose !== 'inline' || row.issueId !== null || row.uploaderId !== uploaderId) {
      return false;
    }
    this.ops.push({ kind: 'update', id, patch: { issueId } });
    return true;
  }

  /** `attachment.delete`: sets `detached_at` on a claimed attachment. */
  async detach(id: string): Promise<boolean> {
    await this.db.step('detach');
    if (!this.view().rows.has(id)) return false;
    await this.db.locks.acquire(this.row(id), this.id, 'exclusive');
    const row = this.view().rows.get(id);
    if (row?.purpose !== 'attachment' || row.issueId === null) return false;
    this.ops.push({ kind: 'update', id, patch: { detachedAt: this.db.clock } });
    return true;
  }

  /** `user.updateProfile` naming an avatar: the foreign key's key share lock, then existence. */
  async name(id: string): Promise<void> {
    await this.db.step('name');
    await this.db.locks.acquire(this.row(id), this.id, 'shared');
    if (!this.view().rows.has(id)) throw new ForeignKeyViolation('avatar_file_id');
    this.ops.push({ kind: 'name', id });
  }

  async unname(id: string): Promise<void> {
    await this.db.step('unname');
    this.ops.push({ kind: 'unname', id });
  }
}

function cleanupReasonOf(
  row: ModelRow,
  before: number,
  named: ReadonlySet<string>,
): CleanupCandidate['reason'] | undefined {
  if ((row.purpose === 'attachment' || row.purpose === 'inline') && row.issueId === null) {
    return row.createdAt < before ? 'unclaimed' : undefined;
  }
  if (row.purpose === 'attachment' && row.detachedAt !== null && row.detachedAt < before) {
    return 'detached';
  }
  if ((row.purpose === 'avatar' || row.purpose === 'logo') && row.createdAt < before) {
    return named.has(row.id) ? undefined : 'unused';
  }
  return undefined;
}

function apply(
  ops: readonly Op[],
  rows: Map<string, ModelRow>,
  released: Set<string>,
  named: Set<string>,
): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'insert':
        rows.set(op.row.id, op.row);
        break;
      case 'delete':
        rows.delete(op.id);
        break;
      case 'update': {
        const row = rows.get(op.id);
        if (row !== undefined) rows.set(op.id, { ...row, ...op.patch });
        break;
      }
      case 'release':
        released.add(op.key);
        break;
      case 'forget':
        released.delete(op.key);
        break;
      case 'name':
        named.add(op.id);
        break;
      case 'unname':
        named.delete(op.id);
        break;
    }
  }
}

/** The in-memory BlobStore with a `step` before each operation, on the model's clock. */
export function modelBlobStore(db: ModelDb): BlobStore & {
  readonly keys: () => string[];
  readonly temps: () => string[];
} {
  const inner = memoryBlobStore({ now: () => new Date(db.clock) });
  return {
    ...inner,
    async putStream(source, finish) {
      await db.step('putStream');
      return inner.putStream(source, finish);
    },
    async commit(tempPath, key) {
      await db.step('commit rename');
      return inner.commit(tempPath, key);
    },
    async discard(tempPath) {
      await db.step('discard');
      return inner.discard(tempPath);
    },
    async delete(key) {
      await db.step('unlink');
      return inner.delete(key);
    },
    async stat(key) {
      await db.step('stat');
      return inner.stat(key);
    },
  };
}

/** Bytes as an upload body. */
export async function* body(content: string): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(Buffer.from(content));
}

export type { TempBlob };
