/**
 * The real server behind `SimServer` (PLAN-002 S9 part 2, ADR-0016): the
 * executor, the repo layer, `sync_log`, the hub and Postgres, started in this
 * process through `@surface/server/testing` on a fresh database per case.
 *
 * The simulation stays one fixed order of events, as far as a real server
 * allows:
 * - The network hands the server one thing at a time (a request, a socket
 *   opening, closing or sending, a restart, a read). Each finishes before the
 *   next starts: a request once its response is read and every open socket
 *   has received what it committed, so its rows and acks are on their way
 *   before anything else happens. Virtual time stands still meanwhile
 *   (`trackRealWork`).
 * - What arrives on the real sockets is held and handed to the tabs in a
 *   fixed order (socket creation order, then arrival) when the clock settles
 *   (`addRealEvents`), so the network's seeded delays are drawn the same way
 *   each run.
 * Unprompted traffic (the hub's pings on its fake interval, its polls) arrives
 * within a few turns of the real event loop; the clock waits that long before
 * it moves on. A failing seed has replayed exactly so far; `replay` in the
 * integration suite checks it.
 *
 * The hub's timers (pings, pong deadlines) and the rate limiter's clock are
 * the simulation's fake ones: the server starts after `installClock`. So is
 * its shutdown drain timeout, which cannot fire while virtual time stands
 * still: every step has a real-time deadline instead (`REAL_WAIT_MS`). The
 * case's seeded randomness is process-wide, but the server's own draws (its
 * Postgres connections' SCRAM nonces, its retry jitter) get real randomness
 * (`SERVER_CODE` in `random.ts`): how many it makes depends on real timing.
 *
 * A case fails on anything the server does wrong that the client would
 * survive by retrying: a 5xx, an error it logs, a step past its deadline.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelDef } from '@surface/domain/model';
import { DebugItem, PRODUCTION_MODELS } from '@surface/domain/model';
import type { TestDatabaseHandle, TestServer, TestUser } from '@surface/server/testing';
import { createDatabaseFrom, errorLogger, startTestServer } from '@surface/server/testing';
import type { SocketConnection, SocketHandlers } from '@surface/sync-client';
import { CSRF_HEADER, computeSchemaHash } from '@surface/sync-protocol';
import { addRealEvents, trackRealWork } from './clock.js';
import type {
  CommentServer,
  CommentState,
  ReactionState,
  StoredDraft,
  IssueFixtures,
  IssueLifecycleState,
  IssueRecord,
  LifecycleServer,
  IssueState,
  ItemState,
  WorkflowServer,
  WorkflowState,
} from './server.js';

export interface RealServerOptions {
  /** Superuser URL of the cluster (`startTestPostgres`). */
  readonly adminUrl: string;
  /** A migrated template database to clone (`createTemplateDatabase`). */
  readonly template: string;
  readonly users: number;
}

/** How long the real server may take over one step before the case fails. */
const REAL_WAIT_MS = 15_000;
/**
 * Real event loop turns without anything new before the clock moves on: a
 * frame the hub wrote during a fake timer is read within a turn or two.
 */
const QUIET_TURNS = 4;
/** What the real server syncs with fixtures on: the web app's models, plus `DebugItem`. */
const REAL_MODELS: readonly ModelDef[] = [DebugItem, ...PRODUCTION_MODELS];

const MUTATE_PATH = '/sync/mutate';

/** The second team's id (a UUIDv7, as `team.create` takes). */
const OTHER_TEAM_ID = '01930000-0000-7000-8000-00000000f001';

/**
 * Labels the issue steps name, by reference: a workspace label, a team label, and an exclusive
 * group with two labels (SPEC-010 §4.2). Ids are UUIDv7, as `label.create` takes.
 */
const FIXTURE_LABELS = [
  { ref: 'Flaky', input: { id: '01930000-0000-7000-8000-00000000a001', name: 'Flaky' } },
  {
    ref: 'Frontend',
    input: { id: '01930000-0000-7000-8000-00000000a002', team: 'SIM', name: 'Frontend' },
  },
  {
    ref: 'Size',
    input: { id: '01930000-0000-7000-8000-00000000a003', team: 'SIM', name: 'Size', isGroup: true },
  },
  {
    ref: 'Size/Small',
    input: {
      id: '01930000-0000-7000-8000-00000000a004',
      team: 'SIM',
      name: 'Small',
      group: 'Size',
    },
  },
  {
    ref: 'Size/Large',
    input: {
      id: '01930000-0000-7000-8000-00000000a005',
      team: 'SIM',
      name: 'Large',
      group: 'Size',
    },
  },
] as const;

/** Statuses that carry no body (the `Response` constructor refuses one). */
const NULL_BODY = new Set([101, 204, 205, 304]);

export async function startRealServer(options: RealServerOptions): Promise<RealServer> {
  const database = await createDatabaseFrom(options.adminUrl, options.template);
  const problems: string[] = [];
  let entry: TestServer | undefined;
  try {
    entry = await startTestServer({
      databaseUrl: database.url,
      users: options.users,
      logger: errorLogger((summary) => problems.push(`logged an error: ${summary}`)),
    });
    // Every model the server syncs, the engine fixture included (SPEC-002 Q8).
    if (computeSchemaHash(REAL_MODELS) !== entry.schemaHash) {
      throw new Error(
        "The simulation's models differ from the real server's. Update REAL_MODELS in real-server.ts.",
      );
    }
    return new RealServer(entry, database, problems);
  } catch (error) {
    await entry?.stop();
    await database.drop();
    throw error;
  }
}

/** One real WebSocket, as a tab's `SocketConnection` sees it. */
interface RealSocket {
  readonly handlers: SocketHandlers;
  /** Events received and not yet handed over, oldest first. */
  readonly arrived: (() => void)[];
  ws: WebSocket | undefined;
  open: boolean;
  closed: boolean;
  /** The tab closed it (or the network dropped it): it waits for nothing more. */
  abandoned: boolean;
  /** The id of the last packet received (the connect `since` at first). */
  lastSeen: number;
  /** The signed-in user: a row only other users' `user:` groups hold never reaches it. */
  readonly userId: string;
  /** Told to re-bootstrap: it will receive nothing more. */
  resynced: boolean;
}

export class RealServer implements CommentServer, WorkflowServer, LifecycleServer {
  readonly users: readonly string[];
  readonly models = REAL_MODELS;
  /** What went wrong on the server side; each is a failure of the case. */
  readonly problems: string[];
  /** HTTP responses by status. */
  readonly statuses = new Map<number, number>();
  /**
   * `429`s to `POST /sync/mutate` after some of the batch committed: the
   * mutations before the refusal stay, and are replayed when resent
   * (SPEC-002 Q12).
   */
  refusedMidBatch = 0;
  issueFixtures: IssueFixtures | undefined;
  readonly #entry: TestServer;
  readonly #database: TestDatabaseHandle;
  readonly #byId: ReadonlyMap<string, TestUser>;
  readonly #sockets: RealSocket[] = [];
  readonly #stopEvents: () => void;
  #queue: Promise<unknown> = Promise.resolve();
  /** A step ran past its deadline: the server is stuck, and later steps fail at once. */
  #stuck: string | undefined;
  #disposed = false;

  constructor(entry: TestServer, database: TestDatabaseHandle, problems: string[]) {
    this.#entry = entry;
    this.#database = database;
    this.problems = problems;
    this.users = entry.users.map((user) => user.id);
    this.#byId = new Map(entry.users.map((user) => [user.id, user]));
    this.#stopEvents = addRealEvents({
      quietTurns: QUIET_TURNS,
      flush: () => this.#flush(),
    });
  }

  fetch(user: string, url: string, init: RequestInit): Promise<Response> {
    const signedIn = this.#user(user);
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    return this.#serially(`answer ${method} ${path}`, async (signal) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', signedIn.cookie);
      if (method === 'POST') headers.set(CSRF_HEADER, signedIn.csrfToken);
      const before = path === MUTATE_PATH ? await this.#entry.head() : undefined;
      // Not the tab's abort signal: once on the wire, a request reaches the
      // server whatever the tab does (`network.ts` decides what the tab sees).
      // Only the step's deadline ends it.
      const response = await fetch(this.#onServer(url, 'http:'), {
        method,
        headers,
        signal,
        ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
      });
      const body = await response.arrayBuffer();
      this.statuses.set(response.status, (this.statuses.get(response.status) ?? 0) + 1);
      // Never legitimate here: the client would retry and hide it.
      if (response.status >= 500) {
        this.problems.push(`${method} ${path} answered ${response.status}`);
      }
      if (before !== undefined && response.status === 429) {
        if ((await this.#entry.head()) > before) this.refusedMidBatch += 1;
      }
      await this.#caughtUp(signal);
      // The body is read whole; it is handed over as is.
      const returned = new Headers(response.headers);
      returned.delete('content-encoding');
      returned.delete('content-length');
      return new Response(NULL_BODY.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: returned,
      });
    });
  }

  socket(user: string, url: string, handlers: SocketHandlers): SocketConnection {
    const signedIn = this.#user(user);
    const since = Number(new URL(url).searchParams.get('since') ?? 0);
    const socket: RealSocket = {
      handlers,
      arrived: [],
      ws: undefined,
      open: false,
      closed: false,
      abandoned: false,
      lastSeen: Number.isSafeInteger(since) ? since : 0,
      userId: signedIn.id,
      resynced: false,
    };
    this.#sockets.push(socket);
    void this.#serially('open a socket and catch it up', async (signal) => {
      if (socket.abandoned) return;
      const ws = nodeWebSocket(this.#onServer(url, 'ws:'), signedIn.cookie);
      socket.ws = ws;
      ws.addEventListener('open', () => {
        socket.open = true;
        socket.arrived.push(() => handlers.onOpen());
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        const data: unknown = event.data;
        if (typeof data === 'string') this.#saw(socket, data);
        socket.arrived.push(() => handlers.onMessage(data));
      });
      ws.addEventListener('close', (event) => {
        socket.closed = true;
        socket.arrived.push(() => handlers.onClose(event.code));
      });
      await this.#untilSeen(
        (seen) => socket.closed || (socket.open && (socket.resynced || seen(socket))),
        signal,
      );
    }).catch(() => undefined);
    return {
      send: (data) => {
        void this.#serially('read a frame from a tab', async () => {
          if (socket.ws === undefined || !socket.open || socket.closed) return;
          socket.ws.send(data);
          // A pong has no answer to wait for: give the hub a moment to read it.
          await delay(1);
        }).catch(() => undefined);
      },
      close: (code, reason) => {
        socket.abandoned = true;
        void this.#serially('close a socket', async (signal) => {
          const ws = socket.ws;
          if (ws === undefined || socket.closed) return;
          // A browser may only send 1000 or 3000–4999; 1006 means "the network dropped it".
          ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
          await this.#until(() => socket.closed, signal);
        }).catch(() => undefined);
      },
    };
  }

  restart(): void {
    void this.#serially('restart and close every socket', async (signal) => {
      await this.#entry.restart();
      await this.#until(
        () => this.#sockets.every((socket) => socket.ws === undefined || socket.closed),
        signal,
      );
    }).catch(() => undefined);
  }

  head(): Promise<number> {
    return this.#serially('read the head', () => this.#entry.head());
  }

  headFor(userId: string): Promise<number> {
    return this.#serially('read the head', () => this.#entry.headFor(userId));
  }

  items(): Promise<Record<string, ItemState>> {
    return this.#serially('read the items', async () => {
      const rows = await this.#entry.items();
      return Object.fromEntries(
        rows.map((row): [string, ItemState] => [
          row.id,
          {
            title: row.title,
            counter: row.counter,
            groups: [...row.syncGroups],
            archivedAt: row.archivedAt,
            archived: row.archived,
          },
        ]),
      );
    });
  }

  seed(items: readonly { id: string; title: string }[]): Promise<void> {
    const admin = this.#entry.users[0];
    if (admin === undefined) return Promise.reject(new Error('The real server has no users.'));
    return this.#serially('seed the items', async () => {
      for (const item of items) {
        const result = await this.#entry.run(admin, 'debug.create', item);
        if (!result.ok) throw new Error(`Seeding ${item.id} failed: ${result.error.message}`);
      }
    });
  }

  /**
   * PLAN-011 S4: the labels the issue steps name, in the setup's team (SIM) and the workspace,
   * with an exclusive group, and a second team whose status an SIM issue may not take. Through
   * the executor as the Admin, like `seed`.
   */
  seedIssueFixtures(): Promise<IssueFixtures> {
    const admin = this.#entry.users[0];
    if (admin === undefined) return Promise.reject(new Error('The real server has no users.'));
    return this.#serially('seed the issue fixtures', async () => {
      const run = async (name: string, input: object): Promise<unknown> => {
        const result = await this.#entry.run(admin, name, input);
        if (!result.ok) throw new Error(`Seeding ${name} failed: ${result.error.message}`);
        return result.result;
      };
      for (const label of FIXTURE_LABELS) await run('label.create', label.input);
      const team = await run('team.create', { id: OTHER_TEAM_ID, name: 'Operations', key: 'OPS' });
      const statusId: unknown =
        typeof team === 'object' && team !== null ? Reflect.get(team, 'defaultStatusId') : null;
      if (typeof statusId !== 'string') throw new Error('team.create returned no default status.');
      const fixtures: IssueFixtures = {
        labels: Object.fromEntries(FIXTURE_LABELS.map((l) => [l.ref, l.input.id])),
        otherTeamStatusId: statusId,
      };
      this.issueFixtures = fixtures;
      return fixtures;
    });
  }

  issueRows(): Promise<readonly IssueRecord[]> {
    return this.#serially('read the issues', async () =>
      (await this.#entry.issues()).map((row) => ({
        id: row.id,
        teamId: row.teamId,
        number: row.number,
        labelIds: row.labelIds,
        sortOrder: row.sortOrder,
        insertedAt: row.insertedAt,
      })),
    );
  }

  issues(): Promise<Record<string, IssueState>> {
    return this.#serially('read the issues', async () => {
      const rows = await this.#entry.issues();
      return Object.fromEntries(
        rows.map((row): [string, IssueState] => [
          row.id,
          {
            teamId: row.teamId,
            number: row.number,
            title: row.title,
            statusId: row.statusId,
            priority: row.priority,
            labelIds: [...row.labelIds],
            sortOrder: row.sortOrder,
            groups: [...row.syncGroups],
          },
        ]),
      );
    });
  }

  drafts(): Promise<Record<string, StoredDraft>> {
    return this.#serially('read the drafts', async () => {
      const rows = await this.#entry.drafts();
      return Object.fromEntries(
        rows.map((row): [string, StoredDraft] => [
          row.id,
          {
            userId: row.userId,
            kind: row.kind,
            teamId: row.teamId,
            issueId: row.issueId,
            data: row.data,
            groups: [...row.syncGroups],
          },
        ]),
      );
    });
  }

  comments(): Promise<Record<string, CommentState>> {
    return this.#serially('read the comments', async () => {
      const rows = await this.#entry.comments();
      return Object.fromEntries(
        rows.map((row): [string, CommentState] => [
          row.id,
          {
            issueId: row.issueId,
            teamId: row.teamId,
            parentCommentId: row.parentCommentId,
            userId: row.userId,
            actorKind: row.actorKind,
            body: row.body,
            version: row.version,
            editedAt: row.editedAt,
            deletedAt: row.deletedAt,
            resolvedAt: row.resolvedAt,
            resolvedById: row.resolvedById,
          },
        ]),
      );
    });
  }

  reactionCount(): Promise<number> {
    return this.#serially('count the reactions', () => this.#entry.reactionCount());
  }

  reactions(): Promise<Record<string, ReactionState>> {
    return this.#serially('read the reactions', async () => {
      const rows = await this.#entry.reactions();
      return Object.fromEntries(
        rows.map((row): [string, ReactionState] => [
          row.id,
          {
            issueId: row.issueId,
            teamId: row.teamId,
            commentId: row.commentId,
            userId: row.userId,
            emoji: row.emoji,
            createdAt: row.createdAt,
          },
        ]),
      );
    });
  }

  /** The server's `event_outbox` events of `type`, oldest first, with their data (PLAN-013 S4). */
  events(type: string): Promise<readonly { readonly type: string; readonly data: unknown }[]> {
    return this.#serially(`read the ${type} events`, () => this.#entry.events(type));
  }

  workflow(): Promise<WorkflowState> {
    return this.#serially('read the workflow', () => this.#entry.workflow());
  }

  /** PLAN-015 S2: each stored issue's `archivedAt` and `deletedAt`. */
  issueLifecycles(): Promise<Record<string, IssueLifecycleState>> {
    return this.#serially('read the issue lifecycles', async () =>
      Object.fromEntries(
        (await this.#entry.issueLifecycles()).map((row): [string, IssueLifecycleState] => [
          row.id,
          { archivedAt: row.archivedAt, deletedAt: row.deletedAt },
        ]),
      ),
    );
  }

  compactLog(): void {
    void this.#serially('compact the log', () => this.#entry.compactLog()).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopEvents();
    await this.#queue.catch(() => undefined);
    for (const socket of this.#sockets) {
      socket.abandoned = true;
      if (socket.ws !== undefined && !socket.closed) socket.ws.close(1000, 'done');
    }
    try {
      // A stuck server may never finish shutting down; the drop ends its connections.
      await withDeadline('stop', () => this.#entry.stop());
    } catch (error) {
      if (this.#stuck === undefined) throw error;
    } finally {
      await this.#database.drop();
    }
  }

  /**
   * Run `work` after everything handed to the server before it, holding the
   * clock until it is done, or until `REAL_WAIT_MS` of real time has passed.
   * A failure is a problem of the case, and also the caller's to handle (a
   * request fails, as over a network). After a step past its deadline the
   * server counts as stuck: later steps fail at once instead of waiting
   * their turn behind it.
   */
  #serially<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => {
      if (this.#stuck !== undefined) {
        throw new SkippedError(`Skipped "${what}": the server is stuck (${this.#stuck}).`);
      }
      return withDeadline(what, work).catch((error: unknown) => {
        if (error instanceof DeadlineError) this.#stuck ??= what;
        throw error;
      });
    });
    this.#queue = run.catch((error: unknown) => {
      // One problem for the stuck step; the skipped ones after it add nothing.
      if (!(error instanceof SkippedError)) this.problems.push(message(error));
    });
    return trackRealWork(run);
  }

  /**
   * Every open socket has received everything committed that its user can see, or will receive
   * nothing more. Assumes each socket may see every row the simulation writes except other
   * users' drafts: its steps write `debug.*` items in the `workspace` group, issues and labels of
   * public teams (PLAN-011 S4), and drafts in their owner's `user:` group only (PLAN-012 S5),
   * which `headFor` leaves out for everyone else. A row outside a socket's groups is never sent
   * to it (`DeltaWriter`), so a step that wrote another kind would wait out the deadline here.
   */
  #caughtUp(signal: AbortSignal): Promise<void> {
    return this.#untilSeen(
      (seen) => this.#sockets.every((socket) => !this.#waitsOn(socket) || seen(socket)),
      signal,
    );
  }

  /**
   * Poll until `done(seen)` holds, on the real clock, until the step's deadline: `seen(socket)`
   * says the socket has received every row its user can (up to `headFor` that user).
   */
  async #untilSeen(
    done: (seen: (socket: RealSocket) => boolean) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const heads = new Map<string, number>();
      for (const socket of this.#sockets) {
        if (!heads.has(socket.userId)) {
          heads.set(socket.userId, await this.#entry.headFor(socket.userId));
        }
      }
      if (done((socket) => socket.lastSeen >= (heads.get(socket.userId) ?? 0))) return;
      signal.throwIfAborted();
      await delay(1, undefined, { signal });
    }
  }

  #waitsOn(socket: RealSocket): boolean {
    return socket.open && !socket.closed && !socket.abandoned && !socket.resynced;
  }

  /** Poll until `done()` holds, on the real clock, until the step's deadline. */
  async #until(done: () => boolean, signal: AbortSignal): Promise<void> {
    while (!done()) {
      signal.throwIfAborted();
      await delay(1, undefined, { signal });
    }
  }

  /** Note how far a socket has got, from a message it received. */
  #saw(socket: RealSocket, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.problems.push(`sent a socket frame that is not JSON: ${data.slice(0, 80)}`);
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const type: unknown = Reflect.get(message, 't');
    if (type === 'resync') socket.resynced = true;
    if (type !== 'deltas') return;
    const packets: unknown = Reflect.get(message, 'packets');
    if (!Array.isArray(packets)) return;
    for (const packet of packets) {
      const id: unknown =
        typeof packet === 'object' && packet !== null ? Reflect.get(packet, 'id') : undefined;
      if (typeof id === 'number' && id > socket.lastSeen) socket.lastSeen = id;
    }
  }

  /** Hand over what arrived: by socket in creation order, each in arrival order. */
  #flush(): boolean {
    let delivered = false;
    for (const socket of this.#sockets) {
      for (
        let event = socket.arrived.shift();
        event !== undefined;
        event = socket.arrived.shift()
      ) {
        delivered = true;
        event();
      }
    }
    return delivered;
  }

  #user(id: string): TestUser {
    const user = this.#byId.get(id);
    if (user === undefined) throw new Error(`No signed-in user ${id} on the real server.`);
    return user;
  }

  /** The tab's URL (`http://surface.test/...`), pointed at where the server listens now. */
  #onServer(url: string, protocol: 'http:' | 'ws:'): string {
    const target = new URL(url);
    const server = new URL(this.#entry.url);
    target.protocol = protocol;
    target.host = server.host;
    return target.toString();
  }
}

/**
 * A WebSocket that sends `cookie`. Node's takes undici's `{ headers }` as its
 * second argument, which the DOM type does not describe. It sends no
 * `Origin`, so the socket route accepts it (`@surface/server/testing`).
 */
function nodeWebSocket(url: string, cookie: string): WebSocket {
  const ws: unknown = Reflect.construct(WebSocket, [url, { headers: { cookie } }]);
  if (!(ws instanceof WebSocket)) throw new TypeError('This runtime has no WebSocket.');
  return ws;
}

class DeadlineError extends Error {}
class SkippedError extends Error {}

/**
 * `work`, given a signal that aborts at the deadline; rejects with a
 * `DeadlineError` then. Real time (`node:timers/promises`): the fake clock
 * stands still while the server works.
 */
async function withDeadline<T>(
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const expired = delay(REAL_WAIT_MS, undefined, { signal: controller.signal, ref: false }).then(
    () => {
      controller.abort();
      throw new DeadlineError(`The real server did not ${what} within ${REAL_WAIT_MS / 1000} s.`);
    },
    // Aborted because the work finished first: never settles.
    () => new Promise<never>(() => undefined),
  );
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    controller.abort();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
