/**
 * In-memory storage: the fallback when IndexedDB is unavailable or full
 * (SPEC-002 E6). Same contract as the IndexedDB storage; nothing survives a
 * reload.
 */
import type {
  BootstrapRecord,
  BootstrapStart,
  ContentMark,
  ContentModelRef,
  ContentRead,
  ContentRecord,
  ContentWrite,
  OnDemandTeams,
  PartialWrite,
  PendingRecord,
  ClaimedQueue,
  QueueClaim,
  QueueSnapshot,
  QueueWrite,
  RowPage,
  StoredChange,
  StoredClient,
  StoredMeta,
  StoredRecord,
  SyncStorage,
  TeamRemoval,
} from './types.js';
import {
  contentByModel,
  contentRowIsNewer,
  replayed,
  goneParents,
  sweptIssues,
  teamIssues,
  upsertParent,
} from './content-plan.js';
import { planPartialWrite, planTeamRemoval } from './partial-plan.js';
import {
  QueueFencedError,
  StorageFencedError,
  advanceTeamThrough,
  changedId,
  dropTeamThrough,
  newGeneration,
  planClaim,
  recordFor,
  startingTeamThrough,
  touchedOnDemand,
} from './types.js';

/** Like an async function: a throw becomes a rejected promise, as with IndexedDB. */
const settle = <T>(operation: () => T): Promise<T> =>
  new Promise((resolve) => resolve(operation()));

export class MemoryStorage implements SyncStorage {
  readonly kind = 'memory';
  #meta: StoredMeta | undefined;
  readonly #rows = new Map<string, Map<string, StoredRecord>>();
  readonly #clients = new Map<string, StoredClient>();
  /** By clientId, then seq. */
  readonly #pending = new Map<string, Map<number, PendingRecord>>();
  /** On-demand teams, most recently opened first; kept across bootstraps. */
  #onDemand: readonly string[] = [];
  readonly #content: readonly ContentModelRef[];
  readonly #contentByModel: ReadonlyMap<string, ContentModelRef>;
  /** The hydrated set (SPEC-011 §5.4): parent id → last opened (epoch ms). */
  readonly #hydrated = new Map<string, number>();

  constructor(models: Iterable<string>, content: readonly ContentModelRef[] = []) {
    for (const model of models) this.#rows.set(model, new Map());
    this.#content = content;
    this.#contentByModel = contentByModel(content);
  }

  readMeta(): Promise<StoredMeta | undefined> {
    return settle(() => this.#meta);
  }

  beginBootstrap(start: BootstrapStart): Promise<string> {
    return settle(() => {
      for (const rows of this.#rows.values()) rows.clear();
      this.#hydrated.clear();
      const generation = newGeneration();
      this.#meta = {
        ...start,
        generation,
        state: 'bootstrapping',
        teamThrough: startingTeamThrough(start),
      };
      return generation;
    });
  }

  writeBootstrapRows(generation: string, rows: readonly BootstrapRecord[]): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      for (const { model, row, archived } of rows) {
        const record = { id: row.id, version: meta.lastSyncId, archived, row };
        this.#table(model).set(row.id, record);
      }
    });
  }

  finishBootstrap(generation: string): Promise<void> {
    return settle(() => {
      this.#meta = { ...this.#check(generation), state: 'ready' };
    });
  }

  readRows(model: string, after: string | undefined, limit: number): Promise<RowPage> {
    return settle(() => {
      const table = this.#table(model);
      const ids = [...table.keys()].sort();
      const start = after === undefined ? 0 : ids.findIndex((id) => id > after);
      const page = start === -1 ? [] : ids.slice(start, start + limit);
      const rows = page.flatMap((id) => {
        const record = table.get(id);
        return record?.row ? [{ row: record.row, archived: record.archived }] : [];
      });
      return { rows, next: page.length === limit ? page.at(-1) : undefined };
    });
  }

  applyChanges(
    generation: string,
    changes: readonly StoredChange[],
    lastSyncId: number,
    teams?: readonly string[],
    hydrate?: readonly string[],
  ): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      // All or nothing, like the IndexedDB transaction: check every model first.
      for (const change of changes) this.#table(change.model);
      for (const parent of hydrate ?? []) {
        if (!this.#hydrated.has(parent)) this.#hydrated.set(parent, 0);
      }
      for (const change of changes) {
        // SPEC-011 §5.3 step 4: content of a parent no tab hydrated would be partial.
        const parent = upsertParent(change, this.#contentByModel);
        if (parent !== undefined && !this.#hydrated.has(parent)) continue;
        const table = this.#table(change.model);
        const id = changedId(change);
        const record = recordFor(change, table.get(id));
        if (record) table.set(id, record);
      }
      this.#dropContent(goneParents(changes, this.#content), lastSyncId);
      const teamThrough = advanceTeamThrough(meta.teamThrough, teams, lastSyncId);
      this.#meta = {
        ...meta,
        lastSyncId: Math.max(meta.lastSyncId, lastSyncId),
        ...(teamThrough === undefined ? {} : { teamThrough }),
      };
    });
  }

  writeContent(generation: string, write: ContentWrite): Promise<void> {
    return settle(() => {
      this.#check(generation);
      const parents = new Set(write.parents.filter((parent) => this.#parentLive(parent)));
      for (const { model, row, archived } of write.rows) {
        const ref = this.#contentByModel.get(model);
        if (ref === undefined || !parents.has(String(row[ref.field]))) continue;
        const table = this.#table(model);
        if (!contentRowIsNewer(write.version, table.get(row.id))) continue;
        table.set(row.id, { id: row.id, version: write.version, archived, row });
      }
      for (const change of replayed(write.replay, parents, this.#contentByModel)) {
        const table = this.#table(change.model);
        const id = changedId(change);
        const record = recordFor(change, table.get(id));
        if (record) table.set(id, record);
      }
      for (const parent of parents) this.#hydrated.set(parent, write.openedAt);
    });
  }

  readContent(generation: string, parent: string): Promise<ContentRead> {
    return settle(() => {
      this.#check(generation);
      const records: ContentRecord[] = [];
      for (const ref of this.#content) {
        for (const record of this.#table(ref.model).values()) {
          if (record.row === null || record.row[ref.field] !== parent) continue;
          const { version, archived, row } = record;
          records.push({ model: ref.model, version, archived, row });
        }
      }
      return { hydrated: this.#hydrated.has(parent), records };
    });
  }

  readHydrated(): Promise<readonly string[]> {
    return settle(() => [...this.#hydrated.keys()]);
  }

  readContentMarks(): Promise<readonly ContentMark[]> {
    return settle(() =>
      [...this.#hydrated].map(([parent, openedAt]): ContentMark => ({ parent, openedAt })),
    );
  }

  touchContent(generation: string, parents: readonly string[], openedAt: number): Promise<void> {
    return settle(() => {
      this.#check(generation);
      for (const parent of parents) {
        const before = this.#hydrated.get(parent);
        if (before !== undefined && before < openedAt) this.#hydrated.set(parent, openedAt);
      }
    });
  }

  evictContent(generation: string, marks: readonly ContentMark[]): Promise<readonly string[]> {
    return settle(() => {
      this.#check(generation);
      const evicted = marks
        .filter(({ parent, openedAt }) => {
          const stored = this.#hydrated.get(parent);
          return stored !== undefined && stored <= openedAt;
        })
        .map(({ parent }) => parent);
      const gone = new Set(evicted);
      for (const parent of gone) this.#hydrated.delete(parent);
      for (const ref of this.#content) {
        const table = this.#table(ref.model);
        for (const record of [...table.values()]) {
          if (record.row !== null && gone.has(String(record.row[ref.field]))) {
            table.delete(record.id);
          }
        }
      }
      return evicted;
    });
  }

  writePartialRows(generation: string, write: PartialWrite): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      const puts = planPartialWrite(write, (model) => [...this.#table(model).values()]);
      for (const { model, record } of puts) this.#table(model).set(record.id, record);
      for (const issue of sweptIssues(write, puts)) this.#hydrated.delete(issue);
      this.#meta = {
        ...meta,
        teamThrough: advanceTeamThrough(meta.teamThrough, write.teams, write.through) ?? {},
      };
    });
  }

  removeTeamRows(generation: string, removal: TeamRemoval): Promise<void> {
    return settle(() => {
      const meta = this.#check(generation);
      const read = (model: string) => [...this.#table(model).values()];
      for (const issue of teamIssues(removal.shape.issue, removal.teams, read)) {
        this.#hydrated.delete(issue);
      }
      const deletes = planTeamRemoval(removal, read);
      for (const { model, id } of deletes) this.#table(model).delete(id);
      this.#meta = { ...meta, teamThrough: dropTeamThrough(meta.teamThrough, removal.teams) };
    });
  }

  readOnDemand(): Promise<readonly string[]> {
    return settle(() => this.#onDemand);
  }

  touchOnDemand(teamId: string, limit: number): Promise<OnDemandTeams> {
    return settle(() => {
      const result = touchedOnDemand(this.#onDemand, teamId, limit);
      this.#onDemand = result.teams;
      return result;
    });
  }

  readQueue(): Promise<QueueSnapshot> {
    return settle(() => {
      const ids = [...this.#clients.keys()].sort();
      const pending = ids.flatMap((id) =>
        [...(this.#pending.get(id)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
      );
      return { clients: ids.flatMap((id) => this.#clients.get(id) ?? []), pending };
    });
  }

  claimQueue(claim: QueueClaim): Promise<ClaimedQueue | undefined> {
    return settle(() => {
      const records = (clientId: string) => [...(this.#pending.get(clientId)?.values() ?? [])];
      const plan = planClaim(
        [...this.#clients.values()],
        claim,
        (clientId) => records(clientId).length > 0,
      );
      for (const clientId of plan.forget) {
        this.#clients.delete(clientId);
        this.#pending.delete(clientId);
      }
      const { client } = plan;
      if (client === undefined) return undefined;
      this.#clients.set(client.clientId, client);
      return { client, pending: records(client.clientId).sort((a, b) => a.seq - b.seq) };
    });
  }

  writeQueue(write: QueueWrite): Promise<void> {
    return settle(() => {
      const client = this.#clients.get(write.clientId);
      if (client?.owner !== write.owner) throw new QueueFencedError();
      this.#clients.set(client.clientId, {
        ...client,
        nextSeq: write.nextSeq ?? client.nextSeq,
        leaseUntil: write.leaseUntil ?? client.leaseUntil,
      });
      let records = this.#pending.get(client.clientId);
      if (records === undefined) {
        records = new Map<number, PendingRecord>();
        this.#pending.set(client.clientId, records);
      }
      for (const seq of write.remove ?? []) records.delete(seq);
      for (const record of write.put ?? []) records.set(record.seq, record);
    });
  }

  clear(): Promise<void> {
    return settle(() => {
      for (const rows of this.#rows.values()) rows.clear();
      this.#hydrated.clear();
      this.#meta = undefined;
    });
  }

  close(): Promise<void> {
    return settle(() => undefined);
  }

  /** Whether a content parent's row is stored live (in any parent model). */
  #parentLive(parent: string): boolean {
    return this.#content.some((ref) => {
      const record = this.#rows.get(ref.parent)?.get(parent);
      return record !== undefined && record.row !== null;
    });
  }

  /** The content and marks of parents a batch deleted, as tombstones at `version` (§5.3 step 4). */
  #dropContent(parents: ReadonlySet<string>, version: number): void {
    if (parents.size === 0) return;
    for (const parent of parents) this.#hydrated.delete(parent);
    for (const ref of this.#content) {
      const table = this.#table(ref.model);
      for (const record of table.values()) {
        if (record.row === null || !parents.has(String(record.row[ref.field]))) continue;
        if (record.version >= version) continue;
        table.set(record.id, { id: record.id, version, archived: false, row: null });
      }
    }
  }

  #check(generation: string): StoredMeta {
    if (this.#meta?.generation !== generation) throw new StorageFencedError();
    return this.#meta;
  }

  #table(model: string): Map<string, StoredRecord> {
    const table = this.#rows.get(model);
    if (table === undefined) throw new Error(`Unknown model ${model}`);
    return table;
  }
}
