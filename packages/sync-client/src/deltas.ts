/**
 * Delta apply (SPEC-002 §3.4, E1, E2): decide what a `deltas` message means
 * for this replica, and turn its packets into pool and storage changes.
 *
 * - `prev > lastSyncId`: packets were missed (E1). Nothing is applied; the
 *   caller reconnects with `since = lastSyncId`.
 * - Otherwise, packets with `id ≤ lastSyncId` are duplicates and are skipped
 *   (E2). The rest are contiguous with what was applied, because a message
 *   covers the connection's stream from `prev` onwards.
 * - A `G` packet (sync groups changed) means a full re-bootstrap until M7.
 * - With partial issue loading (SPEC-011 §5.7, PLAN-011 S4c): an `I`, `U`, `A` or `V` whose Issue
 *   row is archived or deleted removes the Issue with a tombstone at the packet's id. After the
 *   whole batch, the eager children of every Issue the batch left absent are removed too, so a
 *   `D`+`U` group-change pair keeps them.
 * - Content (SPEC-011 §5.3 step 4, PLAN-011 S5b; `ContentRouting`): a content upsert reaches the
 *   pool only when its parent is paged in here; storage gets every content packet and keeps an
 *   upsert only for a hydrated parent. A content `D` always applies (a tombstone). An `I` of a
 *   parent hydrates it when its team is subscribed. After the whole batch, the content of every
 *   parent the batch left absent goes (a `D`+`U` pair keeps it, E24).
 *
 * Every row is validated before anything is applied, so a message is all or
 * nothing.
 */
import type { ModelRow } from '@surface/domain/model';
import type { DeltaPacket, DeltasMessage } from '@surface/sync-protocol';
import { ProtocolError } from '@surface/sync-protocol';
import { decodeRow } from './bootstrap.js';
import type { PartialRules } from './partial.js';
import { isRemovedIssue } from './partial.js';
import type { BaseChange, ObjectPool } from './pool.js';
import type { ContentModelRef, StoredChange } from './storage/types.js';

/** How this tab routes content packets (SPEC-011 §5.3 step 4); `content.ts` answers. */
export interface ContentRouting {
  /** The content models, by name. */
  readonly models: ReadonlyMap<string, ContentModelRef>;
  /** The models content hangs off (Issue in production). */
  readonly parents: ReadonlySet<string>;
  /** Whether this tab's pool takes content rows of `parent` now: paged in, and not loading. */
  inPool(parent: string): boolean;
  /** Whether the `I` of this parent row hydrates it here (its team is subscribed, step 5). */
  hydratesOnInsert(model: string, row: ModelRow): boolean;
  /** Whether a parent its `I` hydrates goes straight into the pool: it is open in this tab. */
  wanted(parent: string): boolean;
}

/** A content packet of the batch, for loads in flight (`content.ts` buffers and replays them). */
export interface ContentPacket {
  readonly version: number;
  readonly model: string;
  readonly id: string;
  /** The parent an upsert names; `undefined` for a `D`, which carries only the id. */
  readonly parent: string | undefined;
  readonly stored: StoredChange;
  /** Whether the pool took it now. */
  readonly inPool: boolean;
}

/** What an applied packet changed, without the row (the inspector, SPEC-002 §5.4). */
export interface AppliedPacket {
  readonly id: number;
  readonly action: 'I' | 'U' | 'A' | 'V' | 'D';
  readonly model: string;
  readonly rowId: string;
}

export type DeltaPlan =
  | { readonly kind: 'gap' }
  | { readonly kind: 'resync' }
  /** Nothing new: every packet was a duplicate, or the message only carries acks. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'apply';
      readonly base: readonly BaseChange[];
      readonly stored: readonly StoredChange[];
      /** The id of the last packet applied: the new `lastSyncId`. */
      readonly lastSyncId: number;
      /** In packet order. */
      readonly applied: readonly AppliedPacket[];
      /** Issue and issue-child rows this batch changed, with the sync id (partial loading). */
      readonly touched: readonly TouchedRow[];
      /** Issues the batch left absent: their children and content went with them. */
      readonly gone: readonly string[];
      /** Content parents the batch left absent: their content and marks go (§5.3 step 4). */
      readonly goneParents: readonly string[];
      /** Content packets, in order. */
      readonly content: readonly ContentPacket[];
      /** Parents an `I` packet hydrated in this tab (§5.3 step 5). */
      readonly hydrated: readonly string[];
    };

export interface TouchedRow {
  readonly model: string;
  readonly id: string;
  readonly version: number;
}

/** Throws `ProtocolError` when a row does not match its model. */
export function planDeltas(
  pool: ObjectPool,
  message: DeltasMessage,
  lastSyncId: number,
  rules?: PartialRules,
  routing?: ContentRouting,
): DeltaPlan {
  if (message.prev > lastSyncId) return { kind: 'gap' };
  const fresh = message.packets.filter((packet) => packet.id > lastSyncId);
  const last = fresh.at(-1);
  if (last === undefined) return { kind: 'none' };
  if (fresh.some((packet) => packet.a === 'G')) return { kind: 'resync' };

  const base: BaseChange[] = [];
  const stored: StoredChange[] = [];
  const applied: AppliedPacket[] = [];
  const touched: TouchedRow[] = [];
  const content: ContentPacket[] = [];
  const hydrated: string[] = [];
  /** Parents hydrated by their `I` in this batch and open here: their content goes to the pool. */
  const pagedNow = new Set<string>();
  const issueModels = new Set(
    rules ? [rules.issue, ...rules.shape.children, ...rules.shape.content].map(modelOf) : [],
  );
  for (const packet of fresh) {
    const change = toChange(pool, packet, rules);
    if (change === undefined) continue;
    stored.push(change.stored);
    applied.push(change.applied);
    if (issueModels.has(change.applied.model)) {
      touched.push({ model: change.applied.model, id: change.applied.rowId, version: packet.id });
    }
    const ref = routing?.models.get(change.applied.model);
    if (routing !== undefined && ref !== undefined) {
      const parent = change.base.kind === 'delete' ? undefined : String(change.base.row[ref.field]);
      const inPool = parent === undefined || routing.inPool(parent) || pagedNow.has(parent);
      if (inPool) base.push(change.base);
      content.push({
        version: packet.id,
        model: change.applied.model,
        id: change.applied.rowId,
        parent,
        stored: change.stored,
        inPool,
      });
      continue;
    }
    base.push(change.base);
    const inserted = change.base.kind === 'delete' ? undefined : change.base.row;
    if (
      routing !== undefined &&
      packet.a === 'I' &&
      inserted !== undefined &&
      routing.parents.has(change.applied.model) &&
      routing.hydratesOnInsert(change.applied.model, inserted)
    ) {
      hydrated.push(inserted.id);
      if (routing.wanted(inserted.id)) pagedNow.add(inserted.id);
    }
  }
  const children = rules && [
    ...rules.shape.children,
    ...(routing === undefined ? rules.shape.content : []),
  ];
  const gone =
    rules && children ? removeChildren(pool, rules, children, base, stored, touched, last.id) : [];
  const goneParents = routing ? removeContent(pool, routing, base, stored, touched, last.id) : [];
  return {
    kind: 'apply',
    base,
    stored,
    lastSyncId: last.id,
    applied,
    touched,
    gone,
    goneParents,
    content,
    hydrated,
  };
}

const modelOf = (model: string | { readonly model: string }): string =>
  typeof model === 'string' ? model : model.model;

/** The rows of `models` (by id) whose last change in `base` deletes them. */
function deletedBy(base: readonly BaseChange[], models: ReadonlySet<string>): Set<string> {
  const present = new Map<string, boolean>();
  for (const change of base) {
    if (!models.has(change.model)) continue;
    present.set(change.kind === 'delete' ? change.id : change.row.id, change.kind !== 'delete');
  }
  return new Set([...present].filter(([, here]) => !here).map(([id]) => id));
}

/**
 * SPEC-011 §5.3 step 4 "content is dropped when its parent is gone": once the whole batch is
 * planned, the parents it leaves absent take their pool content with them, at the batch's last
 * id. Storage does the same for the rows it holds (`applyChanges`). Returns those parents.
 */
function removeContent(
  pool: ObjectPool,
  routing: ContentRouting,
  base: BaseChange[],
  stored: StoredChange[],
  touched: TouchedRow[],
  version: number,
): string[] {
  const gone = deletedBy(base, routing.parents);
  if (gone.size === 0) return [];
  const planned = [...base];
  for (const [model, ref] of routing.models) {
    const ids = new Set<string>();
    for (const { row } of pool.baseRows(model)) {
      if (gone.has(String(row[ref.field]))) ids.add(row.id);
    }
    for (const change of planned) {
      if (change.model !== model || change.kind === 'delete') continue;
      if (gone.has(String(change.row[ref.field]))) ids.add(change.row.id);
    }
    for (const id of ids) {
      base.push({ kind: 'delete', model, id });
      stored.push({ kind: 'delete', model, version, id });
      touched.push({ model, id, version });
    }
  }
  return [...gone];
}

/**
 * SPEC-011 §5.7 "eager children leave with their issue": once the whole batch is planned, the
 * Issues it leaves absent take their eager children with them, at the batch's last id (their
 * content goes by `removeContent`; without content routing, by this). Returns those Issues.
 */
function removeChildren(
  pool: ObjectPool,
  rules: PartialRules,
  children: readonly { readonly model: string; readonly field: string }[],
  base: BaseChange[],
  stored: StoredChange[],
  touched: TouchedRow[],
  version: number,
): string[] {
  const goneSet = deletedBy(base, new Set([rules.issue]));
  const gone = [...goneSet];
  if (gone.length === 0) return gone;
  const planned = [...base];
  for (const child of children) {
    const ids = new Set<string>();
    for (const { row } of pool.baseRows(child.model)) {
      if (goneSet.has(String(row[child.field]))) ids.add(row.id);
    }
    for (const change of planned) {
      if (change.model !== child.model || change.kind === 'delete') continue;
      if (goneSet.has(String(change.row[child.field]))) ids.add(change.row.id);
    }
    for (const id of ids) {
      base.push({ kind: 'delete', model: child.model, id });
      stored.push({ kind: 'delete', model: child.model, version, id });
      touched.push({ model: child.model, id, version });
    }
  }
  return gone;
}

function toChange(
  pool: ObjectPool,
  packet: DeltaPacket,
  rules: PartialRules | undefined,
): { base: BaseChange; stored: StoredChange; applied: AppliedPacket } | undefined {
  const version = packet.id;
  switch (packet.a) {
    case 'I':
    case 'U':
    case 'A':
    case 'V': {
      // A and V carry the full row (v0.7, SPEC-011 §5.5): an upsert plus the flag.
      const kind = packet.a === 'A' ? 'archive' : packet.a === 'V' ? 'unarchive' : 'upsert';
      const row = decodeRow(pool, packet.m, packet.d);
      if (packet.m === rules?.issue && isRemovedIssue(row)) {
        // AC-29: an archived or deleted Issue is never stored. A later live `V` or `U` (restore)
        // is newer than this tombstone, so it inserts the row again.
        return {
          base: { kind: 'delete', model: packet.m, id: row.id },
          stored: { kind: 'delete', model: packet.m, version, id: row.id },
          applied: { id: packet.id, action: packet.a, model: packet.m, rowId: row.id },
        };
      }
      return {
        base: { kind, model: packet.m, row },
        stored: { kind, model: packet.m, version, row },
        applied: { id: packet.id, action: packet.a, model: packet.m, rowId: row.id },
      };
    }
    case 'D': {
      if (!pool.models.some((def) => def.name === packet.m)) {
        throw new ProtocolError(`Invalid packet: unknown model ${packet.m}`);
      }
      return {
        base: { kind: 'delete', model: packet.m, id: packet.mid },
        stored: { kind: 'delete', model: packet.m, version, id: packet.mid },
        applied: { id: packet.id, action: packet.a, model: packet.m, rowId: packet.mid },
      };
    }
    case 'G':
      return undefined;
  }
}
