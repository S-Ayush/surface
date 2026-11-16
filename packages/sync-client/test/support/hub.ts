/**
 * An in-process fake of the server side of sync (PLAN-002 S3/S4), speaking
 * the S1 protocol: a `sync_log` of `DebugItem` changes, a bootstrap from the
 * same state, and WebSocket connections with catch-up, live delivery, `prev`,
 * `resync` and close codes. Faults are injected per connection.
 *
 * PLAN-011 S5a: `GET /sync/content` for the `Note` content model (parent `DebugItem` by
 * `itemId`), answered from one snapshot at the current head, with faults (a failed request, an
 * error status, a cut-off stream, an answer held while more packets commit).
 *
 * PLAN-011 S4c (after `withTeams()`): partial issue loading on the stand-in models (`Squad`,
 * `SquadMember`, `Task`, `TaskPart`, `TaskNote`). Packets carry sync groups and reach a connection
 * only through one of its groups, with a Task's `groups` cut to the connection's; `teams=` on the
 * URL, `subscribe`/`unsubscribe` with their acks queued in order with the deltas; the full and the
 * partial bootstrap (`?groups=team:<id>`); `user:` groups on public tasks, and the `D`+`U` pair
 * when they change.
 */
import type { ModelRow } from '@surface/domain/model';
import type {
  Ack,
  BootstrapFrame,
  ContentFrame,
  ContentParent,
  ContentQuery,
  ClientMessage,
  DeltaPacket,
  MutateRequest,
  MutationResult,
  ServerMessage,
  SyncGroup,
} from '@surface/sync-protocol';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_INVALID,
  CONTENT_PATH,
  CloseCode,
  MAX_MUTATION_BATCH_BYTES,
  MUTATE_PATH,
  MissingUserIdError,
  ProtocolError,
  SESSION_PATH,
  computeSchemaHash,
  decodeBootstrapQuery,
  decodeClientMessage,
  decodeContentQuery,
  decodeMutateRequest,
  decodeSocketConnectParams,
  encodeSocketMessage,
  parentIssueId,
} from '@surface/sync-protocol';
import type { FetchLike } from '../../src/bootstrap.js';
import type { SocketConnection, SocketFactory, SocketHandlers } from '../../src/socket.js';
import type { ConnectionOptions } from '../../src/store.js';
import { PARTIAL_TEST_MODELS, USER_ID, debugRow, id, noteRow } from './models.js';
import { TEST_SCHEMA_HASH, bootstrapFrames, ndjsonResponse } from './server.js';
import { ManualTimers } from './timers.js';

/** A connection that never opens, with timers that never fire: for tests that leave sync alone. */
export function quietConnection(): ConnectionOptions {
  return {
    socket: () => ({ send: () => undefined, close: () => undefined }),
    timers: new ManualTimers(),
  };
}

interface ServerRow {
  row: ModelRow;
  archived: boolean;
}

/** A whole-request error in the SPEC-003 shape. */
function errorResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message: `Refused: ${code}`, correlationId: 'c' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** The SPEC-003 code the server sends with each status `contentStatus` can be set to. */
const CONTENT_ERROR_CODES: Partial<Record<number, string>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  426: 'CLIENT_OUTDATED',
  503: 'UNAVAILABLE',
};

export class FakeHub {
  readonly rows = new Map<string, ServerRow>();
  readonly log: DeltaPacket[] = [];
  readonly connections: HubConnection[] = [];
  head: number;
  /** A `since` below this is outside retention: `resync(too_old)`. */
  retainedFrom = 0;
  schemaHash = TEST_SCHEMA_HASH;
  /** Packets per `deltas` message during catch-up. */
  pageSize = 500;
  bootstraps = 0;
  /** The `(clientId, seq)` behind each sync id a client's own mutation wrote. */
  readonly acks = new Map<number, Ack>();
  /** Per client: the last seq processed and every stored result (`client_mutations`). */
  readonly clients = new Map<string, { lastSeq: number; results: Map<number, MutationResult> }>();
  /** Every mutate request received, in order. */
  readonly mutateRequests: MutateRequest[] = [];
  /** Faults: fail the next N requests before processing, or lose the next N responses after. */
  failRequests = 0;
  loseResponses = 0;
  /** The body limit (Fastify's `bodyLimit`): a larger request gets a 413. */
  maxBodyBytes = MAX_MUTATION_BATCH_BYTES;
  /** Batches containing one of these ops are refused as a whole (400 `INVALID_INPUT`). */
  readonly invalidOps = new Set<string>();
  /** Held requests the client aborted. */
  aborted = 0;
  /** The UTF-8 size of every mutate request body, in order. */
  readonly bodySizes: number[] = [];
  /** Hold mutate responses until `release()`; requests are processed at once. */
  holdResponses = false;
  readonly #held: (() => void)[] = [];
  #acking: Ack | undefined;
  /**
   * CSRF as the server checks it (SPEC-001 §6.1): when set, a mutate request
   * must carry this token in `X-CSRF-Token`, or gets `403 CSRF_INVALID`.
   */
  csrfToken: string | undefined;
  /** The browser's cookie jar: `GET /auth/session` sets `surface_csrf` in it. */
  readonly cookies = new Map<string, string>();
  /** `GET /auth/session` requests, and mutate requests refused for CSRF. */
  sessionRequests = 0;
  csrfRefusals = 0;
  /** What `GET /auth/session` answers: `401` when the session is gone. */
  sessionStatus = 200;
  /**
   * No session for this browser's cookie, or one of another user (SPEC-002 E14):
   * mutate answers `401`, and a new socket opens and is closed with `4001` before
   * any message, as the real hub accepts the upgrade first (sync-protocol §4.3).
   */
  signedOut = false;
  /** Refuse every mutate request with `403 FORBIDDEN` (not a CSRF refusal). */
  forbidMutate = false;
  /**
   * Refuse a rename or touch of an archived row with `CONFLICT`, as the server refuses an edit
   * of an archived issue (SPEC-011 §6.1, E26). Off by default: debug items stay editable.
   */
  refuseArchivedEdits = false;
  /** The `userId` each request named, in order (SPEC-002 E14). */
  readonly users: { bootstrap: string[]; mutate: string[]; socket: string[]; content: string[] } = {
    bootstrap: [],
    mutate: [],
    socket: [],
    content: [],
  };
  /** The headers of every mutate request, in order. */
  readonly mutateHeaders: Headers[] = [];

  // GET /sync/content (PLAN-011 S5a, SPEC-011 §5.2)

  /** `Note` rows by id: the content of debug items, parent `itemId`. */
  readonly notes = new Map<string, ModelRow>();
  /** Items the user can't see: left out of a content answer exactly like unknown ones. */
  readonly hiddenParents = new Set<string>();
  /** The parents of every content request answered with frames, in order. */
  readonly contentRequests: ContentParent[][] = [];
  /** Fail the next N content requests before they reach the server (a network error). */
  failContent = 0;
  /** Answer content requests with this status and a SPEC-003 error body, when not 200. */
  contentStatus = 200;
  /** Cut the answer before its `end` frame, as a dropped connection would. */
  truncateContent = false;
  /**
   * The size budget (SPEC-011 D16), in parents: a multi-parent answer takes at most this many
   * visible parents, in request order, and leaves the rest out of `parents`. Unset: no budget.
   */
  contentBudget: number | undefined = undefined;
  /**
   * Take the snapshot at once but hold the answer until `releaseContent()`, so packets above
   * its `lastSyncId` can commit and be delivered first (SPEC-011 §5.3 buffering, E17).
   */
  holdContent = false;
  readonly #heldContent: (() => void)[] = [];

  // Partial issue loading (PLAN-011 S4c), on after `withTeams()`

  teamsOn = false;
  /** Squad rows by id. */
  readonly squads = new Map<string, ModelRow>();
  /** SquadMember rows by id. */
  readonly members = new Map<string, ModelRow>();
  /** Task rows by id, archived and deleted ones included (the server's table). */
  readonly tasks = new Map<string, ModelRow>();
  readonly parts = new Map<string, ModelRow>();
  readonly taskNotes = new Map<string, ModelRow>();
  /** The sync groups of each logged packet; a packet without is for everyone (DebugItem). */
  readonly packetGroups = new Map<number, readonly string[]>();
  /** The teams of every partial bootstrap answered, in order. */
  readonly partialRequests: string[][] = [];
  /** Fail the next N partial bootstraps before they reach the server (a network error). */
  failPartial = 0;
  /** Snapshot partial bootstraps at once but answer them on `releasePartial()`. */
  holdPartial = false;
  /**
   * Leave `subscribe`/`unsubscribe` unhandled until `releaseAcks()`, so their acks reach the
   * client after whatever it does next (a real server answers them a network trip later).
   * Packets keep flowing meanwhile.
   */
  holdAcks = false;
  readonly #heldPartial: (() => void)[] = [];

  constructor(head = 100) {
    this.head = head;
  }

  /** Turn on the stand-in team world, with the schema hash of `PARTIAL_TEST_MODELS`. */
  withTeams(): this {
    this.teamsOn = true;
    this.schemaHash = computeSchemaHash(PARTIAL_TEST_MODELS);
    return this;
  }

  releaseAcks(): void {
    this.holdAcks = false;
    for (const connection of this.live) connection.deliver();
  }

  releasePartial(): void {
    for (const send of this.#heldPartial.splice(0)) send();
  }

  /** Squad `n` (id `id(n)`): a public team unless `private`. */
  addSquad(n: number, options: { private?: boolean } = {}): string {
    const row = { id: id(n), name: `Squad ${n}`, private: options.private ?? false };
    this.squads.set(row.id, row);
    this.#commit({ id: this.head + 1, a: 'I', m: 'Squad', d: { ...row } });
    return row.id;
  }

  /** Make `userId` a member of squad `n`; the membership row's id is `id(n * 1000 + k)`. */
  join(userId: string, n: number): string {
    const rowId = id(5_000_000 + this.members.size + 1);
    const row = { id: rowId, teamId: id(n), userId };
    this.members.set(rowId, row);
    this.#commit({ id: this.head + 1, a: 'I', m: 'SquadMember', d: { ...row } });
    return rowId;
  }

  /** Remove `userId` from squad `n`. A private squad's change resyncs its member (§6). */
  leave(userId: string, n: number): void {
    for (const [rowId, row] of this.members) {
      if (row['userId'] !== userId || row['teamId'] !== id(n)) continue;
      this.members.delete(rowId);
      this.#commit({ id: this.head + 1, a: 'D', m: 'SquadMember', mid: rowId });
    }
  }

  isMember(userId: string, teamId: string): boolean {
    return [...this.members.values()].some((m) => m['userId'] === userId && m['teamId'] === teamId);
  }

  isPrivate(teamId: string): boolean {
    return this.squads.get(teamId)?.['private'] === true;
  }

  /** A user's home groups: workspace, `user:<id>` and the private squads they are in. */
  homeGroups(userId: string): SyncGroup[] {
    const teams = [...this.squads.keys()].filter(
      (t) => this.isPrivate(t) && this.isMember(userId, t),
    );
    return ['workspace', `user:${userId}`, ...teams.map((t): SyncGroup => `team:${t}`)];
  }

  /** The full bootstrap's groups: home groups plus every squad the user is in (§4.1). */
  memberGroups(userId: string): SyncGroup[] {
    const teams = [...this.squads.keys()].filter(
      (t) => !this.isPrivate(t) && this.isMember(userId, t),
    );
    return [...this.homeGroups(userId), ...teams.map((t): SyncGroup => `team:${t}`)];
  }

  /** Of `teams`, those `userId` may follow: public, or private and a member (E32). */
  accept(userId: string, teams: readonly string[]): string[] {
    return [...new Set(teams)].filter(
      (t) => this.squads.has(t) && (!this.isPrivate(t) || this.isMember(userId, t)),
    );
  }

  /** A task's groups (SPEC-011 §5.7): the team's, plus creator and assignee for a public team. */
  taskGroups(row: ModelRow): string[] {
    const team = String(row['teamId']);
    if (this.isPrivate(team)) return [`team:${team}`];
    const users = [row['creatorId'], row['assigneeId']].filter(
      (u): u is string => typeof u === 'string',
    );
    return [`team:${team}`, ...new Set(users.map((u) => `user:${u}`))];
  }

  /**
   * Insert or update task `n` of squad `squad`. A change of its groups (a new assignee) logs `D`
   * with the old groups, then `U` with the new ones, as the repo does (sync-protocol §6).
   */
  putTask(
    n: number,
    squad: number,
    fields: { title?: string; creatorId?: string; assigneeId?: string | null } = {},
  ): void {
    const existing = this.tasks.get(id(n));
    const base: ModelRow = existing ?? {
      id: id(n),
      teamId: id(squad),
      title: `Task ${n}`,
      creatorId: USER_ID,
      assigneeId: null,
      groups: [],
      archivedAt: null,
      deletedAt: null,
    };
    // An existing task named with another squad moves there (its groups change: D+U).
    const next: ModelRow = { ...base, teamId: id(squad), ...fields };
    const row = { ...next, groups: this.taskGroups(next) };
    this.tasks.set(row.id, row);
    const before = existing === undefined ? undefined : this.taskGroups(existing);
    if (before !== undefined && before.join() !== row.groups.join()) {
      this.#commit({ id: this.head + 1, a: 'D', m: 'Task', mid: row.id }, before, false);
      this.#commit({ id: this.head + 1, a: 'U', m: 'Task', d: { ...row } }, row.groups);
      return;
    }
    this.#commit(
      { id: this.head + 1, a: existing ? 'U' : 'I', m: 'Task', d: { ...row } },
      row.groups,
    );
  }

  /** Archive task `n` (an `A`), as the auto-archive job does. */
  archiveTask(n: number): void {
    this.#lifecycle(n, 'A', { archivedAt: new Date(Date.now()).toISOString() });
  }

  /** Delete task `n`: a `U` with `deletedAt` set (SPEC-015). */
  deleteTask(n: number): void {
    this.#lifecycle(n, 'U', { deletedAt: new Date(Date.now()).toISOString() });
  }

  /** Restore task `n`: a `V` (or, with `as: 'U'`, a `U`) with both cleared. */
  restoreTask(n: number, as: 'V' | 'U' = 'V'): void {
    this.#lifecycle(n, as, { archivedAt: null, deletedAt: null });
    // `issue.restore` logs the issue's eager children again, after it (SPEC-011 §5.7).
    for (const part of this.parts.values()) {
      if (part['issueId'] !== id(n)) continue;
      this.#commit({ id: this.head + 1, a: 'U', m: 'TaskPart', d: { ...part } }, [
        `team:${String(part['teamId'])}`,
      ]);
    }
  }

  /** Purge task `n`: its `D`; its parts' and notes' deletes are not logged (ADR-0022). */
  purgeTask(n: number): void {
    const row = this.tasks.get(id(n));
    if (row === undefined) return;
    this.tasks.delete(row.id);
    for (const [k, part] of this.parts) if (part['issueId'] === row.id) this.parts.delete(k);
    for (const [k, note] of this.taskNotes)
      if (note['issueId'] === row.id) this.taskNotes.delete(k);
    this.#commit({ id: this.head + 1, a: 'D', m: 'Task', mid: row.id }, this.taskGroups(row));
  }

  #lifecycle(n: number, a: 'A' | 'U' | 'V', fields: Record<string, string | null>): void {
    const existing = this.tasks.get(id(n));
    if (existing === undefined) return;
    const row = { ...existing, ...fields };
    this.tasks.set(row.id, row);
    this.#commit({ id: this.head + 1, a, m: 'Task', d: { ...row } }, this.taskGroups(row));
  }

  /** Insert or update part `n` of task `task` (an eager child, in its team's group only). */
  putPart(n: number, task: number, body = `Part ${n}`): void {
    const parent = this.tasks.get(id(task));
    if (parent === undefined) throw new Error(`no task ${task}`);
    const existing = this.parts.get(id(n));
    const row = { id: id(n), issueId: parent.id, teamId: String(parent['teamId']), body };
    this.parts.set(row.id, row);
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'TaskPart', d: { ...row } }, [
      `team:${row.teamId}`,
    ]);
  }

  /** Insert note `n` of task `task` (content, in its team's group only). */
  putTaskNote(n: number, task: number, body = `Note ${n}`): void {
    const parent = this.tasks.get(id(task));
    if (parent === undefined) throw new Error(`no task ${task}`);
    const existing = this.taskNotes.get(id(n));
    const row = { id: id(n), issueId: parent.id, body };
    this.taskNotes.set(row.id, row);
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'TaskNote', d: { ...row } }, [
      `team:${String(parent['teamId'])}`,
    ]);
  }

  /** A row's `groups` cut to `groups` (SPEC-002 Q6), for models that declare them. */
  cut(model: string, row: ModelRow, groups: ReadonlySet<string>): ModelRow {
    if (model !== 'Task') return row;
    const own = Array.isArray(row['groups']) ? row['groups'] : [];
    return { ...row, groups: own.filter((g) => typeof g === 'string' && groups.has(g)) };
  }

  #live(row: ModelRow): boolean {
    return row['archivedAt'] === null && row['deletedAt'] === null;
  }

  /** The full bootstrap of `userId` (with the team world on): its member groups' rows. */
  #fullSnapshot(userId: string): BootstrapFrame[] {
    const groups = this.memberGroups(userId);
    const visible = new Set<string>(groups);
    const sorted = <T extends { row: ModelRow }>(rows: T[]) =>
      rows.sort((a, b) => (a.row.id < b.row.id ? -1 : 1));
    const tasks = [...this.tasks.values()].filter(
      (row) => this.#live(row) && this.taskGroups(row).some((g) => visible.has(g)),
    );
    const followed = new Set(groups);
    const parts = [...this.parts.values()].filter((part) => {
      const task = this.tasks.get(String(part['issueId']));
      return (
        task !== undefined && this.#live(task) && followed.has(`team:${String(part['teamId'])}`)
      );
    });
    const rows = [
      ...sorted(
        [...this.rows.values()].map(({ row, archived }) => ({ model: 'DebugItem', row, archived })),
      ),
      ...[...this.squads.values()].map((row) => ({ model: 'Squad', row, archived: false })),
      ...[...this.members.values()].map((row) => ({ model: 'SquadMember', row, archived: false })),
      ...sorted(
        tasks.map((row) => ({
          model: 'Task',
          row: this.cut('Task', row, visible),
          archived: false,
        })),
      ),
      ...sorted(parts.map((row) => ({ model: 'TaskPart', row, archived: false }))),
    ];
    return bootstrapFrames(rows, { lastSyncId: this.head, schemaHash: this.schemaHash, groups });
  }

  /** `?groups=team:<id>,…`: the accepted teams' live tasks and their parts (§4.1, AC-28). */
  #partialSnapshot(userId: string, teams: readonly string[]): BootstrapFrame[] {
    const accepted = this.accept(userId, teams);
    const cutTo = new Set<string>([
      ...this.homeGroups(userId),
      ...accepted.map((t) => `team:${t}`),
    ]);
    const tasks = [...this.tasks.values()]
      .filter((row) => this.#live(row) && accepted.includes(String(row['teamId'])))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const ids = new Set(tasks.map((row) => row.id));
    const parts = [...this.parts.values()]
      .filter((row) => ids.has(String(row['issueId'])))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const rows = [
      ...tasks.map((row) => ({
        model: 'Task',
        row: this.cut('Task', row, cutTo),
        archived: false,
      })),
      ...parts.map((row) => ({ model: 'TaskPart', row, archived: false })),
    ];
    return bootstrapFrames(rows, {
      lastSyncId: this.head,
      schemaHash: this.schemaHash,
      groups: accepted.map((t): SyncGroup => `team:${t}`),
    });
  }

  /** `GET /sync/bootstrap`, full or partial, with the server's answers before the first frame. */
  #bootstrap(url: string): Promise<Response> {
    let query;
    try {
      query = decodeBootstrapQuery(Object.fromEntries(new URL(url).searchParams));
    } catch (error) {
      if (error instanceof MissingUserIdError)
        return Promise.resolve(errorResponse(426, 'CLIENT_OUTDATED'));
      if (error instanceof ProtocolError)
        return Promise.resolve(errorResponse(400, 'INVALID_INPUT'));
      throw error;
    }
    this.users.bootstrap.push(query.userId);
    if (query.schemaHash !== undefined && query.schemaHash !== this.schemaHash) {
      return Promise.resolve(errorResponse(426, 'CLIENT_OUTDATED'));
    }
    if (query.groups === undefined) {
      this.bootstraps += 1;
      const frames = this.teamsOn ? this.#fullSnapshot(query.userId) : this.snapshot();
      return Promise.resolve(ndjsonResponse(frames));
    }
    if (this.failPartial > 0) {
      this.failPartial -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const teams = query.groups.map((group) => group.slice('team:'.length));
    this.partialRequests.push(teams);
    const frames = this.#partialSnapshot(query.userId, teams);
    if (!this.holdPartial) return Promise.resolve(ndjsonResponse(frames));
    return new Promise((resolve) => this.#heldPartial.push(() => resolve(ndjsonResponse(frames))));
  }

  /** `GET /sync/bootstrap` from the current state, `POST /sync/mutate`, or `GET /auth/session`. */
  readonly fetch: FetchLike = (url, init) => {
    if (url.endsWith(MUTATE_PATH)) return this.#mutate(init);
    if (new URL(url).pathname === CONTENT_PATH) return this.#content(url, init.signal ?? undefined);
    if (url.endsWith(SESSION_PATH)) {
      this.sessionRequests += 1;
      if (this.sessionStatus !== 200) {
        this.cookies.delete(CSRF_COOKIE);
        return Promise.resolve(errorResponse(this.sessionStatus, 'UNAUTHENTICATED'));
      }
      if (this.csrfToken !== undefined) this.cookies.set(CSRF_COOKIE, this.csrfToken);
      return Promise.resolve(
        new Response(JSON.stringify({ userId: USER_ID, workspaceId: 'ws' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return this.#bootstrap(url);
  };

  /** Let held content answers through, in order. */
  releaseContent(): void {
    for (const send of this.#heldContent.splice(0)) send();
  }

  /** The content answer for `parents` at the current head: visible items and their notes. */
  contentSnapshot(parents: readonly ContentParent[]): ContentFrame[] {
    // In request order, as the server's `ORDER BY array_position` (PLAN-011 S6), cut to the
    // budget: whole parents while they fit, the first always.
    // With the team world on, a task is a parent too (as an Issue is, PLAN-011 S5b): visible
    // when its squad is public or the user is a member. Archived and deleted tasks are answered
    // too, as the server answers archived and deleted issues (PLAN-011 S5a; `content.peek`).
    const visibleTask = (taskId: string) => {
      const task = this.tasks.get(taskId);
      if (task === undefined) return false;
      const team = String(task['teamId']);
      return !this.isPrivate(team) || this.isMember(USER_ID, team);
    };
    const found = parents
      .filter((parent) => {
        const itemId = parentIssueId(parent);
        if (this.hiddenParents.has(itemId)) return false;
        return this.rows.has(itemId) || (this.teamsOn && visibleTask(itemId));
      })
      .slice(0, parents.length > 1 ? this.contentBudget : undefined);
    const ids = new Set(found.map(parentIssueId));
    const rows = [
      ...[...this.notes.values()]
        .filter((row) => ids.has(String(row['itemId'])))
        .map((row) => ({ m: 'Note', d: row })),
      ...[...this.taskNotes.values()]
        .filter((row) => ids.has(String(row['issueId'])))
        .map((row) => ({ m: 'TaskNote', d: row })),
    ]
      .sort((a, b) => (a.d.id < b.d.id ? -1 : 1))
      .map(({ m, d }): ContentFrame => ({ t: 'row', m, d: { ...d } }));
    return [
      { t: 'meta', lastSyncId: this.head, parents: found, rows: rows.length },
      ...rows,
      { t: 'end', rows: rows.length },
    ];
  }

  /** `GET /sync/content`, with the server's answers before the first frame (SPEC-011 §5.2). */
  async #content(url: string, signal?: AbortSignal): Promise<Response> {
    if (this.failContent > 0) {
      this.failContent -= 1;
      throw new TypeError('Failed to fetch');
    }
    if (this.signedOut) return errorResponse(401, 'UNAUTHENTICATED');
    if (this.contentStatus !== 200) {
      return errorResponse(
        this.contentStatus,
        CONTENT_ERROR_CODES[this.contentStatus] ?? 'INTERNAL',
      );
    }
    let query: ContentQuery;
    try {
      query = decodeContentQuery(Object.fromEntries(new URL(url).searchParams));
    } catch (error) {
      if (error instanceof MissingUserIdError) return errorResponse(426, 'CLIENT_OUTDATED');
      if (error instanceof ProtocolError) return errorResponse(400, 'INVALID_INPUT');
      throw error;
    }
    this.users.content.push(query.userId);
    // SPEC-002 E14: another user's replica gets nothing.
    if (query.userId !== USER_ID) return errorResponse(401, 'UNAUTHENTICATED');
    if (query.schemaHash !== this.schemaHash) return errorResponse(426, 'CLIENT_OUTDATED');
    this.contentRequests.push([...query.parents]);
    const frames = this.contentSnapshot(query.parents);
    const sent = this.truncateContent ? frames.slice(0, -1) : frames;
    if (!this.holdContent) return ndjsonResponse(sent);
    // As `fetch`: aborting the request while it waits for the answer rejects it.
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
      this.#heldContent.push(() => resolve(ndjsonResponse(sent)));
    });
  }

  /** Let held mutate responses through, in order. */
  release(): void {
    for (const send of this.#held.splice(0)) send();
  }

  /** How many times the server ran a mutation (not counting replays). */
  executed(op?: string): number {
    return this.mutateRequests
      .flatMap((request) => request.mutations)
      .filter((m) => op === undefined || m.op === op).length;
  }

  #mutate(init: RequestInit): Promise<Response> {
    if (this.failRequests > 0) {
      this.failRequests -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const headers = new Headers(init.headers);
    this.mutateHeaders.push(headers);
    if (this.signedOut) return Promise.resolve(errorResponse(401, 'UNAUTHENTICATED'));
    if (this.csrfToken !== undefined && headers.get(CSRF_HEADER) !== this.csrfToken) {
      this.csrfRefusals += 1;
      return Promise.resolve(errorResponse(403, CSRF_INVALID));
    }
    if (this.forbidMutate) return Promise.resolve(errorResponse(403, 'FORBIDDEN'));
    if (typeof init.body !== 'string') throw new Error('The queue sends a JSON string body');
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const size = new TextEncoder().encode(init.body).length;
    this.bodySizes.push(size);
    if (size > this.maxBodyBytes) {
      return Promise.resolve(
        respond(413, {
          ok: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Too large', correlationId: 'c' },
        }),
      );
    }
    const request = decodeMutateRequest(JSON.parse(init.body));
    this.users.mutate.push(request.userId);
    if (request.mutations.some((m) => this.invalidOps.has(m.op))) {
      return Promise.resolve(
        respond(400, {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'This change is not valid on the server.',
            correlationId: 'c',
          },
        }),
      );
    }
    if (request.schemaHash !== this.schemaHash) {
      return Promise.resolve(
        respond(426, {
          ok: false,
          error: { code: 'CLIENT_OUTDATED', message: 'Reload', correlationId: 'c' },
        }),
      );
    }
    let client = this.clients.get(request.clientId);
    if (client === undefined) {
      this.clients.set(request.clientId, (client = { lastSeq: 0, results: new Map() }));
    }
    const first = request.mutations[0]?.seq ?? 1;
    if (first > client.lastSeq + 1) {
      return Promise.resolve(
        respond(400, {
          ok: false,
          error: { code: 'SEQ_GAP', message: 'Gap', correlationId: 'c', lastSeq: client.lastSeq },
        }),
      );
    }
    const fresh = request.mutations.filter((m) => m.seq > (client?.lastSeq ?? 0));
    this.mutateRequests.push({ ...request, mutations: fresh });
    const results = request.mutations.map((mutation): MutationResult => {
      const stored = client.results.get(mutation.seq);
      if (stored) return stored;
      const result = this.#execute(request.clientId, mutation.seq, mutation.op, mutation.input);
      client.results.set(mutation.seq, result);
      client.lastSeq = mutation.seq;
      return result;
    });
    if (this.loseResponses > 0) {
      this.loseResponses -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const response = respond(200, { results });
    if (!this.holdResponses) return Promise.resolve(response);
    return new Promise((resolve, reject) => {
      this.#held.push(() => resolve(response));
      // Like `fetch`: an abort rejects the request (the server already ran it).
      init.signal?.addEventListener('abort', () => {
        this.aborted += 1;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }

  /** The server side of the fixture operations (`ops.ts`), one transaction each. */
  #execute(clientId: string, seq: number, op: string, input: unknown): MutationResult {
    const fields = typeof input === 'object' && input !== null ? input : {};
    const get = (key: string): unknown => (key in fields ? Reflect.get(fields, key) : undefined);
    const itemId = String(get('id'));
    const existing = this.rows.get(itemId);
    const notFound = (): MutationResult => ({
      seq,
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'Debug item not found. It may have been deleted.' },
    });
    const archivedRefusal = (): MutationResult => ({
      seq,
      status: 'error',
      error: { code: 'CONFLICT', message: 'This item is archived. Restore it to edit it.' },
    });
    this.#acking = { clientId, seq };
    try {
      switch (op) {
        case 'debug.create':
          if (existing) {
            // With issues, as the server sends a field's refusal (SPEC-003 §9).
            const message = 'A debug item with this id exists.';
            return {
              seq,
              status: 'error',
              error: { code: 'CONFLICT', message, issues: [{ path: ['id'], message }] },
            };
          }
          this.#upsertRow({
            id: itemId,
            title: String(get('title')),
            counter: 0,
            groups: ['workspace'],
            archivedAt: null,
          });
          break;
        case 'debug.archive':
        case 'debug.unarchive':
          if (!existing) return notFound();
          this.#archiveRow(itemId, op === 'debug.archive');
          break;
        case 'debug.rename':
        case 'debug.broken':
          if (!existing) return notFound();
          if (this.refuseArchivedEdits && existing.archived) return archivedRefusal();
          this.#upsertRow({ ...existing.row, title: String(get('title')) });
          break;
        case 'debug.touch':
          if (!existing) return notFound();
          if (this.refuseArchivedEdits && existing.archived) return archivedRefusal();
          this.#upsertRow({ ...existing.row, counter: Number(existing.row.counter) + 1 });
          break;
        case 'debug.delete':
          if (!existing) return notFound();
          this.rows.delete(itemId);
          this.#commit({ id: this.head + 1, a: 'D', m: 'DebugItem', mid: itemId });
          break;
        case 'debug.note': {
          const parent = String(get('itemId'));
          if (!this.rows.has(parent)) return notFound();
          const row = { id: itemId, itemId: parent, body: String(get('body')) };
          const before = this.notes.has(itemId);
          this.notes.set(itemId, row);
          this.#commit({ id: this.head + 1, a: before ? 'U' : 'I', m: 'Note', d: { ...row } });
          break;
        }
        case 'debug.hide':
          this.invisible();
          this.acks.set(this.head, { clientId, seq });
          for (const connection of this.live) connection.deliver();
          break;
        default:
          return { seq, status: 'error', error: { code: 'UNKNOWN_OPERATION', message: op } };
      }
      return { seq, status: 'ok', lastSyncId: this.head };
    } finally {
      this.#acking = undefined;
    }
  }

  #upsertRow(row: ModelRow): void {
    const existing = this.rows.get(row.id);
    this.rows.set(row.id, { row, archived: existing?.archived ?? false });
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'DebugItem', d: { ...row } });
  }

  /** The bootstrap frames of the current state (one REPEATABLE READ snapshot). */
  snapshot(): BootstrapFrame[] {
    const rows = [...this.rows.values()]
      .sort((a, b) => (a.row.id < b.row.id ? -1 : 1))
      .map(({ row, archived }) => ({ model: 'DebugItem', row, archived }));
    return bootstrapFrames(rows, { lastSyncId: this.head, schemaHash: this.schemaHash });
  }

  /** `GET /sync/ws`: opens on the next microtask, like a real socket. */
  readonly socket: SocketFactory = (url, handlers) => {
    const connection = new HubConnection(this, url, handlers);
    this.connections.push(connection);
    queueMicrotask(() => connection.open());
    return connection.client;
  };

  /** Connections that are open and not closed. */
  get live(): HubConnection[] {
    return this.connections.filter((c) => c.isOpen);
  }

  /** The most recent connection. */
  get last(): HubConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error('no connection yet');
    return connection;
  }

  // Writes: one sync_log packet each, delivered to every live connection.

  upsert(n: number, fields: Record<string, unknown> = {}): void {
    const existing = this.rows.get(id(n));
    const row = debugRow(n, { ...(existing?.row ?? {}), ...fields });
    this.rows.set(id(n), { row, archived: existing?.archived ?? false });
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'DebugItem', d: { ...row } });
  }

  /**
   * Archive (or unarchive) as the repo does: set (or clear) `archivedAt`, also when it already
   * is, and log an `A` (or `V`) with the full row (v0.7, SPEC-011 §5.5).
   */
  archive(n: number, archived = true): void {
    this.#archiveRow(id(n), archived);
  }

  #archiveRow(rowId: string, archived: boolean): void {
    const existing = this.rows.get(rowId);
    if (existing === undefined) return;
    const archivedAt = archived ? new Date(Date.now()).toISOString() : null;
    const row = { ...existing.row, archivedAt };
    this.rows.set(rowId, { row, archived });
    this.#commit({ id: this.head + 1, a: archived ? 'A' : 'V', m: 'DebugItem', d: { ...row } });
  }

  /** Insert or update note `n` of item `item`: an `I` or `U` content packet. */
  upsertNote(n: number, item: number, body?: string): void {
    const existing = this.notes.get(id(n));
    const kept = existing?.['body'];
    const row = noteRow(n, item, body ?? (typeof kept === 'string' ? kept : `Note ${n}`));
    this.notes.set(row.id, row);
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'Note', d: { ...row } });
  }

  /** Delete note `n`: a content `D`, which carries only the id (SPEC-011 §5.3 step 4). */
  removeNote(n: number): void {
    if (!this.notes.delete(id(n))) return;
    this.#commit({ id: this.head + 1, a: 'D', m: 'Note', mid: id(n) });
  }

  /**
   * Purge item `n` with its notes, as the server's purge does: the item's `D` is logged, its
   * content deletes are not (ADR-0022).
   */
  purge(n: number): void {
    for (const [noteId, row] of this.notes) {
      if (row['itemId'] === id(n)) this.notes.delete(noteId);
    }
    this.remove(n);
  }

  /**
   * A group change of item `n` as the repo logs one: `D`, then `U` with the row, in one message
   * (sync-protocol §6). The item stays visible, so its content stays (SPEC-011 E24).
   */
  regroup(n: number): void {
    const existing = this.rows.get(id(n));
    if (existing === undefined) return;
    this.#commit({ id: this.head + 1, a: 'D', m: 'DebugItem', mid: id(n) }, undefined, false);
    this.#commit({ id: this.head + 1, a: 'U', m: 'DebugItem', d: { ...existing.row } });
  }

  remove(n: number): void {
    if (!this.rows.delete(id(n))) return;
    this.#commit({ id: this.head + 1, a: 'D', m: 'DebugItem', mid: id(n) });
  }

  /** A change to rows the client cannot see: the id is used, nothing is sent. */
  invisible(): void {
    this.head += 1;
  }

  /** Log a packet and deliver it; `deliver: false` keeps it for the next (a `D`+`U` pair goes together). */
  #commit(packet: DeltaPacket, groups?: readonly string[], deliver = true): void {
    this.head = packet.id;
    this.log.push(packet);
    if (groups !== undefined) this.packetGroups.set(packet.id, groups);
    if (this.#acking) this.acks.set(packet.id, this.#acking);
    if (deliver) for (const connection of this.live) connection.deliver();
  }
}

export class HubConnection {
  readonly since: number;
  readonly clientId: string;
  readonly userId: string;
  readonly schemaHash: string;
  readonly received: ClientMessage[] = [];
  /** The id of the last packet sent on this connection (`prev` of the next message). */
  sent: number;
  /** Acks are sent for sync ids up to here. */
  ackedThrough: number;
  /** Messages sent to the client, in order. */
  readonly messages: ServerMessage[] = [];
  isOpen = false;
  closedWith: number | undefined;
  /** When set, `deliver` holds packets back (a slow or stalled server). */
  paused = false;
  /** `teams` on the URL (v0.8); undefined when absent. */
  readonly teams: readonly string[] | undefined;
  /** The connection's sync groups (with the team world on). */
  readonly groups = new Set<string>();
  /** `subscribe`/`unsubscribe` not yet handled, in order. */
  readonly #requests: ClientMessage[] = [];
  /** The `subscribed` of a URL with `teams` goes first, before catch-up. */
  #greeted = false;
  /** The last logged id looked at, sent or filtered out. */
  #through = 0;

  readonly client: SocketConnection;

  constructor(
    readonly hub: FakeHub,
    url: string,
    readonly handlers: SocketHandlers,
  ) {
    const parsed = new URL(url);
    const params = decodeSocketConnectParams(Object.fromEntries(parsed.searchParams));
    this.since = params.since;
    this.clientId = params.clientId;
    this.userId = params.userId;
    hub.users.socket.push(params.userId);
    this.schemaHash = params.schemaHash;
    this.sent = params.since;
    this.ackedThrough = params.since;
    this.teams = params.teams;
    if (hub.teamsOn) {
      const groups =
        params.teams === undefined
          ? hub.memberGroups(params.userId)
          : [
              ...hub.homeGroups(params.userId),
              ...hub.accept(params.userId, params.teams).map((t) => `team:${t}`),
            ];
      for (const group of groups) this.groups.add(group);
    }
    this.client = {
      send: (data) => {
        const message = decodeClientMessage(data);
        this.received.push(message);
        if (message.t === 'subscribe' || message.t === 'unsubscribe') {
          this.#requests.push(message);
          // The hub handles requests once live, after what it has to send (sync-protocol §6.1).
          queueMicrotask(() => this.deliver());
        }
      },
      close: (code) => {
        this.isOpen = false;
        this.closedWith ??= code;
      },
    };
  }

  open(): void {
    if (this.closedWith !== undefined) return;
    this.isOpen = true;
    if (this.hub.signedOut) {
      this.handlers.onOpen();
      this.close(CloseCode.SessionRevoked);
      return;
    }
    this.handlers.onOpen();
    if (this.schemaHash !== this.hub.schemaHash) this.send({ t: 'resync', reason: 'schema' });
    else if (this.since < this.hub.retainedFrom) this.send({ t: 'resync', reason: 'too_old' });
    else this.deliver();
  }

  /**
   * Send every logged packet after `sent`, in pages, each with its `prev`, and
   * the acks of this client's mutations they cover. Acks for mutations with
   * no visible packet go in a message of their own (`packets: []`).
   */
  deliver(): void {
    if (!this.isOpen || this.paused) return;
    if (this.teams !== undefined && !this.#greeted) {
      // The greeting is an ack too, and goes first: nothing is sent before it.
      if (this.hub.holdAcks) return;
      this.#greeted = true;
      const accepted = this.hub.accept(this.userId, this.teams);
      this.send({ t: 'subscribed', teams: accepted, at: this.since });
    }
    this.#deliverPackets();
    while (this.isOpen && !this.paused && !this.hub.holdAcks && this.#requests.length > 0) {
      const request = this.#requests.shift();
      if (request === undefined) break;
      if (request.t === 'subscribe') {
        const accepted = this.hub.accept(this.userId, request.teams);
        for (const team of accepted) this.groups.add(`team:${team}`);
        this.send({ t: 'subscribed', teams: accepted, at: this.hub.head });
      } else if (request.t === 'unsubscribe') {
        const home = new Set(this.hub.homeGroups(this.userId));
        const teams = request.teams.filter((t) => !home.has(`team:${t}`));
        for (const team of teams) this.groups.delete(`team:${team}`);
        this.send({ t: 'unsubscribed', teams, at: this.hub.head });
      }
      this.#deliverPackets();
    }
  }

  /** Whether `packet` reaches this connection, and as what (its groups cut to the connection's). */
  #visible(packet: DeltaPacket): DeltaPacket | undefined {
    const groups = this.hub.packetGroups.get(packet.id);
    if (groups === undefined) return packet;
    if (!groups.some((group) => this.groups.has(group))) return undefined;
    if (packet.a === 'D' || packet.a === 'G') return packet;
    return { ...packet, d: this.hub.cut(packet.m, packet.d, this.groups) };
  }

  #deliverPackets(): void {
    // Every logged packet is looked at once, under the groups of that moment: one a later
    // `subscribe` makes visible is before its `at`, and never sent (sync-protocol §6.1).
    const fresh = this.hub.log.filter((packet) => packet.id > Math.max(this.sent, this.#through));
    const seen = fresh.at(-1);
    if (seen !== undefined) this.#through = seen.id;
    const packets = fresh.flatMap((packet) => this.#visible(packet) ?? []);
    for (let start = 0; start < packets.length; start += this.hub.pageSize) {
      const page = packets.slice(start, start + this.hub.pageSize);
      const last = page.at(-1);
      if (last === undefined) break;
      const ack = this.#acksThrough(last.id);
      this.send({ t: 'deltas', prev: this.sent, packets: page, ack });
      this.sent = last.id;
    }
    const rest = this.#acksThrough(this.hub.head);
    if (rest.length > 0) this.send({ t: 'deltas', prev: this.sent, packets: [], ack: rest });
  }

  /** This client's acks for sync ids after `ackedThrough`, up to `id`. */
  #acksThrough(id: number): Ack[] {
    const acks = [...this.hub.acks]
      .filter(([at, ack]) => at > this.ackedThrough && at <= id && ack.clientId === this.clientId)
      .map(([, ack]) => ack);
    this.ackedThrough = Math.max(this.ackedThrough, id);
    return acks;
  }

  send(message: ServerMessage): void {
    if (!this.isOpen) return;
    this.messages.push(message);
    this.handlers.onMessage(encodeSocketMessage(message));
  }

  /** Send raw text, e.g. a malformed frame. */
  sendRaw(data: unknown): void {
    if (this.isOpen) this.handlers.onMessage(data);
  }

  /** Lose the next `count` packets: the hub believes it sent them. */
  lose(count = 1): void {
    const lost = this.hub.log.filter((packet) => packet.id > this.sent).slice(0, count);
    const last = lost.at(-1);
    if (last) this.sent = last.id;
  }

  /** Send the last `deltas` message again (a duplicate after a retry). */
  repeat(): void {
    const last = this.messages.findLast((message) => message.t === 'deltas');
    if (last) this.send(last);
  }

  /** Close from the server side (default: the network dropped, 1006). */
  close(code = 1006): void {
    if (this.closedWith !== undefined) return;
    this.isOpen = false;
    this.closedWith = code;
    this.handlers.onClose(code);
  }

  revoke(): void {
    this.close(CloseCode.SessionRevoked);
  }
}
