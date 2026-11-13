/**
 * Partial issue loading, shared rules (SPEC-011 §5.7, ADR-0020, PLAN-011 S4c): which models take
 * part, what makes an Issue leave the replica, and the partial bootstrap request.
 *
 * The engine is model-agnostic (tests run it on stand-in models), so the models are named by a
 * `PartialLoading` config. Its fields are fixed: the team model has `private`, the membership
 * model `teamId` and `userId`, the Issue model `teamId`, `groups`, `archivedAt` and `deletedAt`.
 */
import { EAGER_ISSUE_CHILDREN, type ModelDef, type ModelRow } from '@surface/domain/model';
import {
  NdjsonDecoder,
  ProtocolError,
  decodeBootstrapFrame,
  type BootstrapMeta,
} from '@surface/sync-protocol';
import type { FetchLike } from './bootstrap.js';
import { BootstrapFailedError, ClientOutdatedError, decodeRow, request } from './bootstrap.js';
import type { ObjectPool } from './pool.js';
import type { Timers } from './socket.js';
import type { BootstrapRecord, IssueChildRef, IssueShape } from './storage/types.js';

/**
 * Eager models that belong to an issue, with the field naming it (SPEC-011 §5.7 "eager children
 * leave with their issue"). They are removed with their issue, after the whole delta batch, and on
 * an unsubscribe. The list is the domain's, which the server's `issueChild` marks are checked
 * against, so a new eager child is added there once (PLAN-014 S4a: Attachment).
 */
export const ISSUE_CHILDREN: readonly IssueChildRef[] = EAGER_ISSUE_CHILDREN;

/** The models of partial issue loading, by name. */
export interface PartialLoading {
  readonly team: string;
  readonly membership: string;
  readonly issue: string;
  /** Eager children (`ISSUE_CHILDREN` in production). */
  readonly children: readonly IssueChildRef[];
}

/** Production: Team, TeamMembership, Issue. */
export const ISSUE_PARTIAL_LOADING: PartialLoading = {
  team: 'Team',
  membership: 'TeamMembership',
  issue: 'Issue',
  children: ISSUE_CHILDREN,
};

/** On-demand public teams a tab follows at most (SPEC-011 §5.7). */
export const ON_DEMAND_LIMIT = 5;

/** A `PartialLoading` checked against the store's models. */
export interface PartialRules extends PartialLoading {
  /** For storage: the Issue model, its eager children and its content models. */
  readonly shape: IssueShape;
}

/**
 * The rules for these models: `config`, or by default the production models when the store has
 * them. `null` (or no Issue model) turns partial loading off: the store then names no `teams`.
 */
export function partialRules(
  models: readonly ModelDef[],
  config: PartialLoading | null | undefined,
): PartialRules | undefined {
  if (config === null) return undefined;
  const byName = new Map(models.map((def) => [def.name, def]));
  const chosen = config ?? ISSUE_PARTIAL_LOADING;
  if (config === undefined && !byName.has(chosen.issue)) return undefined;
  const need = (model: string, fields: readonly string[]): ModelDef => {
    const def = byName.get(model);
    if (def === undefined) throw new Error(`Partial loading needs the model ${model}`);
    for (const field of fields) {
      if (def.fields[field] === undefined) {
        throw new Error(`Partial loading needs ${model}.${field}`);
      }
    }
    return def;
  };
  need(chosen.team, ['private']);
  need(chosen.membership, ['teamId', 'userId']);
  need(chosen.issue, ['teamId', 'groups', 'archivedAt', 'deletedAt']);
  for (const child of chosen.children) need(child.model, [child.field]);
  const content = models
    .filter((def) => def.parent?.model === chosen.issue)
    .map((def): IssueChildRef => ({ model: def.name, field: String(def.parent?.field) }));
  return {
    ...chosen,
    shape: { issue: chosen.issue, children: chosen.children, content },
  };
}

/**
 * An Issue row the replica must not hold (SPEC-011 §5.7, AC-29): archived or deleted. A packet
 * carrying one removes the Issue.
 */
export function isRemovedIssue(row: ModelRow): boolean {
  const archivedAt = row['archivedAt'];
  const deletedAt = row['deletedAt'];
  return (
    (archivedAt !== null && archivedAt !== undefined) ||
    (deletedAt !== null && deletedAt !== undefined)
  );
}

export interface PartialAnswer {
  /** `C`: the snapshot's sync id. */
  readonly lastSyncId: number;
  readonly rows: readonly BootstrapRecord[];
}

export interface PartialRequest {
  readonly fetch: FetchLike;
  readonly baseUrl: string;
  readonly userId: string;
  readonly schemaHash: string;
  readonly teams: readonly string[];
  readonly pool: ObjectPool;
  readonly rules: PartialRules;
  readonly signal?: AbortSignal;
  readonly timers?: Timers;
}

/**
 * `GET /sync/bootstrap?groups=team:<id>,…` (sync-protocol §4.1): the teams' live Issues and their
 * eager children, read whole (a few teams' issues, not a workspace). `ClientOutdatedError` on
 * `426` or another schema; `ProtocolError` on bad data; `BootstrapFailedError` otherwise.
 */
export async function fetchPartial(options: PartialRequest): Promise<PartialAnswer> {
  const { pool, rules } = options;
  const response = await request(options, {
    userId: options.userId,
    schemaHash: options.schemaHash,
    groups: options.teams.map((team) => `team:${team}` as const),
  });
  if (response.status === 426) {
    await response.body?.cancel();
    throw new ClientOutdatedError();
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new BootstrapFailedError(
      `Could not load the team's issues (HTTP ${response.status})`,
      response.status,
    );
  }
  const allowed = new Set([rules.issue, ...rules.children.map((c) => c.model)]);
  const decoder = new NdjsonDecoder();
  let meta: BootstrapMeta | undefined;
  let ended = false;
  let received = 0;
  const rows: BootstrapRecord[] = [];
  const handle = (value: unknown) => {
    if (ended) throw new ProtocolError('Invalid partial bootstrap: data after end');
    const frame = decodeBootstrapFrame(value);
    switch (frame.t) {
      case 'meta':
        if (meta !== undefined) throw new ProtocolError('Invalid partial bootstrap: second meta');
        if (frame.schemaHash !== options.schemaHash) throw new ClientOutdatedError();
        meta = frame;
        return;
      case 'row': {
        if (meta === undefined)
          throw new ProtocolError('Invalid partial bootstrap: row before meta');
        if (!allowed.has(frame.m)) {
          throw new ProtocolError(`Invalid partial bootstrap: unexpected model ${frame.m}`);
        }
        received += 1;
        const row = decodeRow(pool, frame.m, frame.d);
        // Never stored (AC-29): the server leaves them out; this keeps a bad answer out too.
        if (frame.m === rules.issue && isRemovedIssue(row)) return;
        rows.push({ model: frame.m, row, archived: frame.archived === true });
        return;
      }
      case 'end':
        if (meta === undefined)
          throw new ProtocolError('Invalid partial bootstrap: end before meta');
        if (frame.rows !== received || meta.rows !== received) {
          throw new ProtocolError(
            `Invalid partial bootstrap: ${received} rows received, meta announced ${meta.rows}, end announced ${frame.rows}`,
          );
        }
        ended = true;
        return;
    }
  };
  const reader = response.body.getReader();
  const { signal } = options;
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      for (const item of decoder.push(value)) handle(item);
    }
    for (const item of decoder.end()) handle(item);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (!ended || meta === undefined) {
    throw new BootstrapFailedError("The team's issues stopped arriving before they were complete.");
  }
  return { lastSyncId: meta.lastSyncId, rows };
}
