/**
 * Who a request comes from, by its session cookie (PLAN-001 S3, ADR-0007). Read once per
 * request and remembered, so the CSRF check, the route and the socket share one lookup.
 *
 * The actor is built from the database on each request: the user's role and every team
 * membership (`memberOf`, and the sync groups of private teams). Joining or leaving a team, or a
 * role change, applies to the very next request (session E's handoff for PLAN-001 S8).
 */
import { userActor, type Actor } from '@surface/domain';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ActorResolver } from '../http/ops.js';
import { hashSessionToken, readCookie, SESSION_COOKIE } from './session.js';
import type { AuthStore } from './store.js';

/** `last_used_at` and the sliding expiry move at most this often (PLAN-001 S3). */
export const TOUCH_EVERY_MS = 5 * 60 * 1000;

export interface ResolvedSession {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly actor: Actor;
}

export interface SessionAuthOptions {
  readonly now?: () => Date;
  readonly log?: Pick<Logger, 'warn'>;
}

export class SessionAuth {
  readonly #store: AuthStore;
  readonly #now: () => Date;
  readonly #log: Pick<Logger, 'warn'> | undefined;
  readonly #pending = new WeakMap<FastifyRequest, Promise<ResolvedSession | undefined>>();
  readonly #resolved = new WeakMap<FastifyRequest, ResolvedSession>();
  readonly #extended = new WeakMap<FastifyRequest, { id: string; token: string }>();

  constructor(store: AuthStore, options: SessionAuthOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log;
  }

  /** The request's live session, or undefined (no cookie, unknown, expired, user inactive). */
  session(request: FastifyRequest): Promise<ResolvedSession | undefined> {
    let pending = this.#pending.get(request);
    if (pending === undefined) {
      pending = this.#lookup(request);
      this.#pending.set(request, pending);
    }
    return pending;
  }

  readonly resolveActor: ActorResolver = async (request) => (await this.session(request))?.actor;

  /** After `resolveActor`: the session behind it, for `hub.closeSessions` (AC-8). */
  readonly sessionIdOf = (request: FastifyRequest): string | undefined =>
    this.#resolved.get(request)?.id;

  /**
   * The session this request extended, if it did, with the token it came with: the response sets
   * the cookies again so the browser keeps them as long as the database does (sliding expiry).
   */
  extended(request: FastifyRequest): { id: string; token: string } | undefined {
    return this.#extended.get(request);
  }

  async #lookup(request: FastifyRequest): Promise<ResolvedSession | undefined> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    // Ours are 43 characters; anything far longer isn't worth hashing.
    if (token === undefined || token.length > 128) return undefined;
    const now = this.#now();
    const record = await this.#store.session(hashSessionToken(token), now);
    if (record === undefined) return undefined;
    if (now.getTime() - record.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
      // The request goes on if this fails; the next one tries again.
      const touched = await this.#store.touch(record.id, now).then(
        () => true,
        (error: unknown) => {
          this.#log?.warn({ err: error, sessionId: record.id }, 'could not extend the session');
          return false;
        },
      );
      if (touched) this.#extended.set(request, { id: record.id, token });
    }
    const resolved: ResolvedSession = {
      id: record.id,
      userId: record.userId,
      workspaceId: record.workspaceId,
      actor: userActor({
        userId: record.userId,
        role: record.role,
        memberships: record.memberships,
      }),
    };
    this.#resolved.set(request, resolved);
    return resolved;
  }
}
