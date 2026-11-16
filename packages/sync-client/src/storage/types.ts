/**
 * Local persistence of the replica (SPEC-002 §3.1–3.2, PLAN-002 S6): base
 * rows per model, `meta`, and the pending-mutation queue. Implemented over
 * IndexedDB (run in a worker) and in memory (fallback, SPEC-002 E6).
 *
 * Several tabs of one user share the database (E5), each applying the same
 * delta stream at its own pace. Three rules keep a slower tab from corrupting
 * what a faster one wrote:
 * - **Generation fence:** each bootstrap starts a new generation. Writes name
 *   the generation they belong to and fail with `StorageFencedError` once
 *   another tab has re-bootstrapped. That tab then stops persisting.
 * - **Row versions:** a stored row records the sync id that last wrote it. A
 *   delta older than the stored version is skipped.
 * - **Tombstones:** a deleted row keeps its version, so an older upsert cannot
 *   bring it back. `meta.lastSyncId` only moves forward.
 */
import type { ModelRow } from '@surface/domain/model';
import type { SyncGroup } from '@surface/sync-protocol';

export interface StoredMeta {
  readonly schemaHash: string;
  /** Changes on every bootstrap; see the generation fence above. */
  readonly generation: string;
  /** Every delta up to this id is stored. */
  readonly lastSyncId: number;
  readonly groups: readonly SyncGroup[];
  /** `bootstrapping` until the `end` frame is stored; a warm start ignores anything else. */
  readonly state: 'bootstrapping' | 'ready';
  /**
   * Per public team: the sync id through which its Issue rows are complete (SPEC-011 §5.7,
   * PLAN-011 S4c). A tab advances it for the teams it follows as it applies deltas; a team
   * absent here must be loaded again (partial bootstrap) before its rows count as current.
   */
  readonly teamThrough?: Readonly<Record<string, number>>;
}

/** A row as stored. `row: null` is a tombstone. */
export interface StoredRecord {
  readonly id: string;
  /** The sync id of the packet (or bootstrap snapshot) that last wrote this row. */
  readonly version: number;
  readonly archived: boolean;
  readonly row: ModelRow | null;
}

/** A live row read back for a warm start. */
export interface HydratedRow {
  readonly row: ModelRow;
  readonly archived: boolean;
}

export interface RowPage {
  readonly rows: HydratedRow[];
  /** Pass to the next `readRows` call; `undefined` when there are no more rows. */
  readonly next: string | undefined;
}

/**
 * One base change from a delta packet, tagged with the packet's sync id. `archive` and
 * `unarchive` carry the row (protocol v0.7, SPEC-011 §5.5).
 */
export type StoredChange =
  | {
      readonly kind: 'upsert' | 'archive' | 'unarchive';
      readonly model: string;
      readonly version: number;
      readonly row: ModelRow;
    }
  | {
      readonly kind: 'delete';
      readonly model: string;
      readonly version: number;
      readonly id: string;
    };

/** The id of the row a change writes. */
export function changedId(change: StoredChange): string {
  return change.kind === 'delete' ? change.id : change.row.id;
}

/** A row from the bootstrap stream. */
export interface BootstrapRecord {
  readonly model: string;
  readonly row: ModelRow;
  readonly archived: boolean;
}

export interface BootstrapStart {
  readonly schemaHash: string;
  readonly lastSyncId: number;
  /** Its `team:<id>` groups are complete at `lastSyncId`: they start `teamThrough`. */
  readonly groups: readonly SyncGroup[];
}

/** A model whose rows belong to an issue, and the field naming it. */
export interface IssueChildRef {
  readonly model: string;
  readonly field: string;
}

/**
 * Where an issue's rows are (PLAN-011 S4c): the Issue model (rows with `teamId` and `groups`),
 * its eager children (sent with it by a bootstrap) and its content models (loaded per issue,
 * SPEC-011 §5.3). Plain data, so it crosses the worker RPC.
 */
export interface IssueShape {
  readonly issue: string;
  readonly children: readonly IssueChildRef[];
  readonly content: readonly IssueChildRef[];
}

/**
 * A partial bootstrap answer for `teams` (SPEC-011 §5.7 `writePartialRows`): Issue rows and their
 * eager children at version `version` (the answer's `lastSyncId`, `C`).
 */
export interface PartialWrite {
  readonly shape: IssueShape;
  readonly teams: readonly string[];
  readonly rows: readonly BootstrapRecord[];
  readonly version: number;
  /** The writing tab's applied id: `teamThrough` of `teams` moves up to it. */
  readonly through: number;
}

/** Remove teams' Issue rows that no group of the connection keeps (an unsubscribe, §5.7). */
export interface TeamRemoval {
  readonly shape: IssueShape;
  readonly teams: readonly string[];
  /** The connection's groups after the unsubscribe: a row in one of them stays. */
  readonly keep: readonly string[];
}

/**
 * A content model (SPEC-011 §5.3, §5.4): its rows are loaded per parent, not bootstrapped. `field`
 * names the parent row of model `parent` (an Issue in production). Storage indexes the rows on it
 * and keeps a row only while its parent is in the hydrated set. Plain data, for the worker RPC.
 */
export interface ContentModelRef {
  readonly model: string;
  readonly field: string;
  readonly parent: string;
}

/**
 * A content answer (SPEC-011 §5.3 step 3): the rows of `parents`, at version `version` (the
 * answer's `lastSyncId`, `C`). A parent whose row storage doesn't hold, or holds as a tombstone,
 * is skipped with its rows (E23). The others join the hydrated set, at `openedAt` (epoch ms).
 */
export interface ContentWrite {
  readonly parents: readonly string[];
  readonly rows: readonly BootstrapRecord[];
  readonly version: number;
  readonly openedAt: number;
  /**
   * The content packets above `version` that arrived while the answer was in flight (§5.3 step
   * 3: replay above `C`). Storage dropped them then (the parent wasn't hydrated yet), so they are
   * stored here, in the same transaction, under the per-row version rules. Without that, another
   * tab could page in the parent between the answer and its replay, or a tab closing in between
   * would leave it hydrated but stale for good (`lastSyncId` is already past them).
   */
  readonly replay: readonly StoredChange[];
}

/** A stored content row with the version that wrote it. */
export interface ContentRecord {
  readonly model: string;
  readonly version: number;
  readonly archived: boolean;
  readonly row: ModelRow;
}

/** A parent's stored content (`readContent`): whether it is hydrated, and its live rows. */
export interface ContentRead {
  readonly hydrated: boolean;
  readonly records: readonly ContentRecord[];
}

/** The on-demand teams after `touchOnDemand`: most recently opened first, and those dropped. */
export interface OnDemandTeams {
  readonly teams: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * One mutation queue (PLAN-002 S8): a `clientId` and its seq counter. Each tab
 * owns one queue at a time (SPEC-002 E5). A tab that closes or reloads leaves
 * its queue behind, and the next tab to start adopts it, so the same
 * `(clientId, seq)` pairs are resent and the server dedupes them.
 */
export interface StoredClient {
  readonly clientId: string;
  /** The seq the next dispatched mutation gets. */
  readonly nextSeq: number;
  /** A per-tab token. Writes name it and fail with `QueueFencedError` once another tab took over. */
  readonly owner: string;
  /** Epoch ms. Without Web Locks, a queue whose lease ran out may be adopted; 0 = released. */
  readonly leaseUntil: number;
}

/** A mutation waiting for the server (sync-protocol.md §5.1). */
export interface PendingRecord {
  readonly clientId: string;
  readonly seq: number;
  readonly op: string;
  /** The input as dispatched (JSON); it is parsed again for `optimistic()` and by the server. */
  readonly input: unknown;
  /** Dispatch time (ISO). `optimistic()` sees it as `now`, so a replay is deterministic. */
  readonly at: string;
  /** Set once the server committed it: confirmed when the replica reaches this id. */
  readonly lastSyncId?: number;
}

export interface QueueSnapshot {
  readonly clients: readonly StoredClient[];
  /** Ordered by clientId, then seq. */
  readonly pending: readonly PendingRecord[];
}

/** Changes to one queue, made atomically by the tab that owns it. */
export interface QueueWrite {
  readonly clientId: string;
  /** The writer's token; must still own the queue. */
  readonly owner: string;
  readonly nextSeq?: number;
  readonly leaseUntil?: number;
  readonly put?: readonly PendingRecord[];
  readonly remove?: readonly number[];
}

/**
 * Take a queue for `owner`. With `clientId`, that queue (created if missing):
 * the caller holds its Web Lock. Without (lease mode), a queue with pending
 * mutations whose lease ended before `now`, else a new one with id `fresh`,
 * else (no `fresh`) nothing. An expired queue with nothing pending is left
 * alone: its tab may only be frozen, and adopting it would gain nothing but
 * fence that tab. Empty queues that were released (lease 0) or whose lease
 * ended over a day ago are forgotten.
 */
export interface QueueClaim {
  readonly owner: string;
  readonly now: number;
  readonly leaseUntil: number;
  readonly clientId?: string;
  readonly fresh?: string;
}

/** An empty queue whose lease ended this long ago is forgotten (lease mode). */
export const FORGET_EMPTY_QUEUE_MS = 86_400_000;

/** A claimed queue and its pending mutations, in seq order. */
export interface ClaimedQueue {
  readonly client: StoredClient;
  readonly pending: readonly PendingRecord[];
}

/** Members are function properties: the worker RPC calls them detached from the object. */
export interface SyncStorage {
  /** `indexeddb` persists across reloads; `memory` does not (E6). */
  readonly kind: 'indexeddb' | 'memory';

  readonly readMeta: () => Promise<StoredMeta | undefined>;

  /**
   * Remove every row, the hydrated set and the meta, and start a new generation. Pending
   * mutations are kept (E8).
   */
  readonly beginBootstrap: (start: BootstrapStart) => Promise<string>;

  /** Store bootstrap rows (version = the snapshot's `lastSyncId`). */
  readonly writeBootstrapRows: (
    generation: string,
    rows: readonly BootstrapRecord[],
  ) => Promise<void>;

  /** Mark the generation `ready`, so a later start can hydrate from it. */
  readonly finishBootstrap: (generation: string) => Promise<void>;

  /** Page through a model's live rows in id order, for a warm start. */
  readonly readRows: (model: string, after: string | undefined, limit: number) => Promise<RowPage>;

  /**
   * Store delta changes and advance `lastSyncId` in one transaction (PLAN-002 S7),
   * so a crash never leaves `lastSyncId` ahead of the rows.
   *
   * Content (SPEC-011 §5.3 step 4, §5.4): `hydrate` (parents an `I` packet hydrated) joins the
   * hydrated set first; a content upsert is kept only when its parent is in that set, which every
   * tab shares (E18); a content delete is always stored, as a tombstone (E25). After the whole
   * batch, the content and mark of each parent the batch leaves deleted go too (a `D`+`U` pair
   * keeps them, E24).
   */
  readonly applyChanges: (
    generation: string,
    changes: readonly StoredChange[],
    lastSyncId: number,
    /** The public teams the writing tab follows and holds current: `teamThrough` moves to `lastSyncId`. */
    teams?: readonly string[],
    hydrate?: readonly string[],
  ) => Promise<void>;

  /**
   * Store a content answer, its replay above `C`, and mark its parents hydrated, in one
   * transaction (SPEC-011 §5.3 step 3, §5.4). An answer row is skipped when storage holds it at
   * `version` or newer (a tombstone included); a replayed change follows the delta rules.
   */
  readonly writeContent: (generation: string, write: ContentWrite) => Promise<void>;

  /**
   * A parent's stored content rows (by the per-parent index) and whether it is hydrated.
   * `StorageFencedError` unless `generation` is the stored one: a tab pages in only from the
   * generation it writes its own packets to, which holds all of them (PLAN-011 S5b).
   */
  readonly readContent: (generation: string, parent: string) => Promise<ContentRead>;

  /** Every hydrated parent. */
  readonly readHydrated: () => Promise<readonly string[]>;

  /**
   * Store a partial bootstrap answer (SPEC-011 §5.7, E30, E35) in one transaction. A row is
   * skipped when storage holds it at a version at or above `version` (a newer row, or a tombstone
   * at or above `C`). Then the sweep: the teams' stored Issue rows absent from the answer and
   * older than `version`, and the eager children of the answer's and the swept issues absent from
   * the answer and older than `version`, become tombstones at `version`, with the swept issues'
   * content. `teamThrough` of the teams
   * moves up to `through`. No new generation; `meta.lastSyncId` does not move.
   */
  readonly writePartialRows: (generation: string, write: PartialWrite) => Promise<void>;

  /**
   * After an unsubscribe (SPEC-011 §5.7): delete the teams' Issue rows whose `groups` meet none
   * of `keep`, the children and content of every Issue row of those teams (a kept row's would not
   * stay live), and the teams' `teamThrough`. Deleted outright, without tombstones, so a
   * later partial bootstrap at the same id loads them again. The caller holds the team's lock.
   */
  readonly removeTeamRows: (generation: string, removal: TeamRemoval) => Promise<void>;

  /** The on-demand teams, most recently opened first (kept across bootstraps). */
  readonly readOnDemand: () => Promise<readonly string[]>;

  /** Move `teamId` to the front of the on-demand teams, keeping at most `limit`. */
  readonly touchOnDemand: (teamId: string, limit: number) => Promise<OnDemandTeams>;

  /** Every queue and pending mutation, for a start or for adopting a queue. */
  readonly readQueue: () => Promise<QueueSnapshot>;

  /**
   * See `QueueClaim`. The claim, the owner change and reading the queue's
   * pending mutations are one transaction, so nothing the old owner wrote is missed.
   */
  readonly claimQueue: (claim: QueueClaim) => Promise<ClaimedQueue | undefined>;

  /** Apply `write` in one transaction; `QueueFencedError` if another tab owns the queue now. */
  readonly writeQueue: (write: QueueWrite) => Promise<void>;

  /** Drop all rows, the hydrated set and the meta (resync); keeps pending mutations. */
  readonly clear: () => Promise<void>;

  readonly close: () => Promise<void>;
}

/** Another tab re-bootstrapped the shared database; this tab must stop writing to it. */
export class StorageFencedError extends Error {
  override readonly name = 'StorageFencedError';
  constructor() {
    // Handled by `Persistence`, never shown: the other tab keeps the replica saved.
    super('Another tab replaced the local replica.');
  }
}

/** Another tab adopted this tab's mutation queue (its lease ran out); this tab must stop using it. */
export class QueueFencedError extends Error {
  override readonly name = 'QueueFencedError';
  constructor() {
    super('Another tab took over the changes waiting to be sent. Reload this tab.');
  }
}

/** The queue a claim picks from `clients`; `undefined` means create `claim.fresh`. */
/**
 * What a claim does (`QueueClaim`): the queue to write (`undefined`: none),
 * and the ids of empty queues to forget. Shared by the storage backends.
 */
export function planClaim(
  clients: readonly StoredClient[],
  claim: QueueClaim,
  hasPending: (clientId: string) => boolean,
): { readonly client: StoredClient | undefined; readonly forget: readonly string[] } {
  if (claim.clientId !== undefined) {
    const picked = clients.find((c) => c.clientId === claim.clientId);
    return { client: claimed(picked, claim.clientId, claim), forget: [] };
  }
  const forget = clients
    .filter(
      (c) =>
        !hasPending(c.clientId) &&
        (c.leaseUntil === 0 || c.leaseUntil < claim.now - FORGET_EMPTY_QUEUE_MS),
    )
    .map((c) => c.clientId);
  // By id, so tabs agree on the order.
  const picked = clients
    .filter((c) => c.leaseUntil <= claim.now && hasPending(c.clientId))
    .sort((a, b) => (a.clientId < b.clientId ? -1 : 1))
    .at(0);
  const clientId = picked?.clientId ?? claim.fresh;
  return {
    client: clientId === undefined ? undefined : claimed(picked, clientId, claim),
    forget,
  };
}

function claimed(
  picked: StoredClient | undefined,
  clientId: string,
  claim: QueueClaim,
): StoredClient {
  return {
    clientId,
    nextSeq: picked?.nextSeq ?? 1,
    owner: claim.owner,
    leaseUntil: claim.leaseUntil,
  };
}

/** This tab's connection to the replica is gone; `message` says why and how to recover. */
export class StorageClosedError extends Error {
  override readonly name = 'StorageClosedError';
}

export const META_KEY = 'meta';

/** Whether `change` may overwrite `existing` (older or equal versions are skipped). */
export function isNewer(
  change: { readonly version: number },
  existing: StoredRecord | undefined,
): boolean {
  return existing === undefined || change.version > existing.version;
}

/** The record a change produces, or `undefined` when it leaves the stored row as it is. */
export function recordFor(
  change: StoredChange,
  existing: StoredRecord | undefined,
): StoredRecord | undefined {
  if (!isNewer(change, existing)) return undefined;
  switch (change.kind) {
    case 'upsert':
      return {
        id: change.row.id,
        version: change.version,
        archived: existing?.row ? existing.archived : false,
        row: change.row,
      };
    case 'archive':
    case 'unarchive':
      // An upsert plus the flag: one for a row this replica doesn't hold (never had, or a
      // tombstone with an older version) inserts it (SPEC-011 §5.5). The pool derives `$archived`
      // from `archivedAt` again when it loads the row, for models that declare it.
      return {
        id: change.row.id,
        version: change.version,
        archived: change.kind === 'archive',
        row: change.row,
      };
    case 'delete':
      return { id: change.id, version: change.version, archived: false, row: null };
  }
}

/** The `teamThrough` a bootstrap starts with: its team groups, complete at its snapshot. */
export function startingTeamThrough(start: BootstrapStart): Record<string, number> {
  const through: Record<string, number> = {};
  for (const group of start.groups) {
    if (group.startsWith('team:')) through[group.slice('team:'.length)] = start.lastSyncId;
  }
  return through;
}

/** `teamThrough` with `teams` moved up to `id`. */
export function advanceTeamThrough(
  current: Readonly<Record<string, number>> | undefined,
  teams: readonly string[] | undefined,
  id: number,
): Readonly<Record<string, number>> | undefined {
  if (teams === undefined || teams.length === 0) return current;
  const next: Record<string, number> = { ...current };
  for (const team of teams) next[team] = Math.max(next[team] ?? 0, id);
  return next;
}

/** `teamThrough` without `teams`. */
export function dropTeamThrough(
  current: Readonly<Record<string, number>> | undefined,
  teams: readonly string[],
): Readonly<Record<string, number>> {
  const next: Record<string, number> = { ...current };
  for (const team of teams) Reflect.deleteProperty(next, team);
  return next;
}

/** A row's `teamId`, when it is a string. */
export function teamOf(row: ModelRow): string | undefined {
  const team = row['teamId'];
  return typeof team === 'string' ? team : undefined;
}

/** Whether one of a row's `groups` is in `keep`. */
export function meetsGroups(row: ModelRow, keep: ReadonlySet<string>): boolean {
  const groups = row['groups'];
  return (
    Array.isArray(groups) && groups.some((group) => typeof group === 'string' && keep.has(group))
  );
}

/** The on-demand list after opening `teamId`: it goes first, at most `limit` are kept. */
export function touchedOnDemand(
  current: readonly string[],
  teamId: string,
  limit: number,
): OnDemandTeams {
  const next = [teamId, ...current.filter((team) => team !== teamId)];
  return { teams: next.slice(0, limit), dropped: next.slice(limit) };
}

/** A fresh generation id. Uniqueness, not secrecy, is what matters. */
export function newGeneration(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
