/**
 * Sign-in over HTTP (SPEC-001 §3.2, §6.1; PLAN-001 S3). Like setup, these are plain routes, not
 * operations: an operation needs an actor, and signing in is how there gets to be one.
 *
 * - `POST /auth/login` reserves an attempt against the lockout, then checks the password, doing
 *   the same work for an unknown email as for a wrong password (AC-5), and sets the session and
 *   CSRF cookies.
 * - A request that extends its session (sliding expiry) gets both cookies again.
 * - `POST /auth/logout` ends the session and closes its sockets (AC-8).
 * - `GET /auth/session` is who is signed in, for the web app to open its replica.
 * - `GET /auth/capabilities` is what the login page may offer; open before setup.
 * - Every other cookie-authenticated POST must carry the CSRF token (`csrf.ts`).
 */
import { randomBytes } from 'node:crypto';
import { EMAIL_MAX_LENGTH, normaliseEmail, PASSWORD_MAX_LENGTH } from '@surface/domain';
// One source for the names the client uses too (session D's sync-client, session C's web app).
import { CSRF_COOKIE, CSRF_HEADER, CSRF_INVALID, SESSION_PATH } from '@surface/sync-protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody, ROUTE_ERROR_STATUS } from '../http/errors.js';
import type { Lifecycle } from '../lifecycle.js';
import { accountKey, ipKey, type AttemptStore } from './attempts.js';
import type { WithTransaction } from '../executor/transaction.js';
import type { EmailOutbox } from '../jobs/email.js';
import { csrfCookie, csrfToken, csrfTokenMatches } from './csrf.js';
import { hashPassword, verifyPassword } from './password.js';
import { clearedCookie, readCookie, SESSION_COOKIE, sessionCookie } from './session.js';
import type { SessionAuth } from './sessions.js';
import type { AuthStore } from './store.js';

export const LOGIN_PATH = '/auth/login';
export const LOGOUT_PATH = '/auth/logout';
export const CAPABILITIES_PATH = '/auth/capabilities';

/** POSTs made before there is a session to protect, so they carry no CSRF token. */
const CSRF_EXEMPT = new Set([LOGIN_PATH, '/setup']);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AuthRouteDeps {
  readonly auth: SessionAuth;
  readonly store: AuthStore;
  readonly attempts: AttemptStore;
  readonly lifecycle: Lifecycle;
  readonly secureCookies: boolean;
  readonly sessionSecret: string;
  /** `SURFACE_URL`'s origin: the only page that may sign in (login CSRF). */
  readonly allowedOrigin: string;
  readonly smtpEnabled: boolean;
  readonly setupComplete: () => Promise<boolean>;
  /** Closes these sessions' sockets with `4001` (the sync hub; absent on a worker). */
  readonly closeSessions?: (sessionIds: readonly string[]) => void;
  /**
   * Queues email on the route's own transaction (`enqueue(client, email)`), for the magic-link
   * and reset routes (PLAN-001 S4, session E). Absent in tests that send none.
   */
  readonly email?: EmailOutbox;
  /**
   * One transaction for a route's writes and the email it queues: `withTransaction(async (client)
   * => { …writes on client…; await email.enqueue(client, job) })`. Absent in tests that need none.
   */
  readonly withTransaction?: WithTransaction;
  readonly now?: () => Date;
  /** Password checking, swappable so tests can count the work done (AC-5). */
  readonly verify?: (hash: string, password: string) => Promise<boolean>;
}

const LoginBody = z.object({
  // Room for spaces around the longest address we accept; they are trimmed (E2).
  email: z.string().max(EMAIL_MAX_LENGTH * 2),
  // Long enough for any password we accept (`PASSWORD_MAX_LENGTH` code points, each at most two
  // UTF-16 units); longer is refused before any work is done.
  password: z.string().max(PASSWORD_MAX_LENGTH * 2),
});

const INCORRECT = 'Email or password is incorrect';

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const verify = deps.verify ?? verifyPassword;
  // An unknown email is checked against this, so it takes as long as a wrong password (AC-5).
  // Made now, so the first sign-in doesn't pay for it.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));
  dummyHash.catch(() => undefined); // awaited, and its error surfaced, on first use
  const cookies = (sessionId: string, token: string) => [
    sessionCookie(token, { secure: deps.secureCookies }),
    csrfCookie(csrfToken(deps.sessionSecret, sessionId), { secure: deps.secureCookies }),
  ];
  const clearCookies = () => [
    clearedCookie(SESSION_COOKIE, { secure: deps.secureCookies }),
    clearedCookie(CSRF_COOKIE, { secure: deps.secureCookies }),
  ];

  app.addHook('onRequest', async (request, reply) => {
    // Skipped only until startup has finished, when the sessions table may not exist yet.
    // Operations still run while draining, so the check must too (S3 review B2).
    if (!UNSAFE_METHODS.has(request.method) || !deps.lifecycle.everReady) return;
    if (CSRF_EXEMPT.has(request.url.split('?')[0] ?? '')) return;
    // Only cookie-authenticated requests need the token; without a live session the route
    // answers 401 itself.
    if (readCookie(request.headers.cookie, SESSION_COOKIE) === undefined) return;
    const session = await deps.auth.session(request);
    if (session === undefined) return;
    if (csrfTokenMatches(deps.sessionSecret, session.id, request.headers[CSRF_HEADER])) return;
    // Its own code, not FORBIDDEN: the client can tell a missing or stale token from a refusal,
    // get the cookie again (`GET /auth/session`) and resend once (SPEC-001 Q7).
    return reply
      .code(ROUTE_ERROR_STATUS.CSRF_INVALID)
      .send(
        errorBody(
          request,
          CSRF_INVALID,
          'This request is missing its security token. Reload the page and try again.',
        ),
      );
  });

  // Sliding expiry: the database moved `expires_at`; the browser's cookies must move too, or it
  // drops them 30 days after sign-in however active the user is (S3 review M1).
  app.addHook('onSend', async (request, reply, payload) => {
    const extended = deps.auth.extended(request);
    if (extended === undefined) return payload;
    const set = [reply.getHeader('set-cookie') ?? []].flat().map(String);
    // A response that sets or clears the session itself (sign-in, sign-out) has the last word.
    if (set.some((c) => c.startsWith(`${SESSION_COOKIE}=`))) return payload;
    // Fastify appends to `set-cookie` rather than replacing it. A response carrying the session
    // token must never be kept by a shared cache.
    reply.header('set-cookie', sessionCookie(extended.token, { secure: deps.secureCookies }));
    reply.header('cache-control', 'no-store');
    if (!set.some((c) => c.startsWith(`${CSRF_COOKIE}=`))) {
      reply.header(
        'set-cookie',
        csrfCookie(csrfToken(deps.sessionSecret, extended.id), { secure: deps.secureCookies }),
      );
    }
    return payload;
  });

  app.post(LOGIN_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    // A sign-in form on another site could sign the browser into the attacker's account.
    const { origin } = request.headers;
    if (origin !== undefined && origin !== deps.allowedOrigin) {
      request.log.warn({ origin }, 'sign-in from another origin refused');
      return reply
        .code(403)
        .send(errorBody(request, 'FORBIDDEN', `Sign in at ${deps.allowedOrigin}.`));
    }
    const body = LoginBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(errorBody(request, 'INVALID_INPUT', 'Enter your email and password.'));
    }
    const email = normaliseEmail(body.data.email); // E2
    const at = now();
    const keys = [accountKey(email), ipKey(request.ip)];
    // Reserved before the password is checked, so guesses sent at once can't all pass (B1).
    const reservation = await deps.attempts.reserve(keys, at);
    if (!reservation.ok) {
      const locked = reservation.lockedForSeconds;
      const minutes = Math.ceil(locked / 60);
      // SPEC-001 §10. Never the email: it may be a password typed into the wrong field.
      request.log.warn(
        { event: 'auth.login_failed', reason: 'locked', retryAfter: locked },
        'sign-in refused: too many attempts',
      );
      return reply
        .code(429)
        .header('retry-after', String(locked))
        .send(
          errorBody(
            request,
            'RATE_LIMITED',
            `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          ),
        );
    }

    const credentials = await deps.store.credentials(email);
    const matches = await verify(
      credentials?.passwordHash ?? (await dummyHash),
      body.data.password,
    );
    if (credentials === undefined || !matches) {
      // The reserved attempt stays, as the failure.
      request.log.warn(
        {
          event: 'auth.login_failed',
          reason: 'incorrect',
          ...(credentials ? { userId: credentials.userId } : {}),
        },
        'sign-in failed',
      );
      return reply.code(401).send(errorBody(request, 'UNAUTHENTICATED', INCORRECT));
    }

    await deps.attempts.succeeded(reservation.attempt, accountKey(email));
    // The session this browser had ends: it would otherwise linger in the sessions list (§3.5),
    // and its sockets would go on as whoever signed in before.
    const previous = await deps.auth.session(request);
    if (previous !== undefined) {
      await deps.store.deleteSession(previous.id);
      // Its sockets close once this response is on its way (Q11). The browser's other tabs
      // recheck `GET /auth/session` on `4001`; before then they would still send the old cookie.
      // 'close' fires whether the response finished or the connection dropped; if it dropped
      // already (during the password check), it fired before we could listen, so close now.
      const closeSessions = deps.closeSessions;
      if (closeSessions) {
        const close = () => {
          // An event listener: a throw here would end the process, not this request.
          try {
            closeSessions([previous.id]);
          } catch (error) {
            request.log.error({ err: error }, 'could not close the replaced session’s sockets');
          }
        };
        if (reply.raw.destroyed || reply.raw.closed) close();
        else reply.raw.once('close', close);
      }
    }
    const session = await deps.store.createSession({
      userId: credentials.userId,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      now: at,
    });
    request.log.info({ event: 'auth.login', userId: credentials.userId }, 'signed in');
    return reply
      .header('set-cookie', cookies(session.id, session.token))
      .header('cache-control', 'no-store')
      .send({ ok: true, result: { userId: credentials.userId } });
  });

  app.post(LOGOUT_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    const session = await deps.auth.session(request);
    if (session !== undefined) {
      await deps.store.deleteSession(session.id);
      deps.closeSessions?.([session.id]);
      request.log.info({ userId: session.userId }, 'signed out');
    }
    // Signed out either way, so a stale tab can always sign out.
    return reply
      .header('set-cookie', clearCookies())
      .header('cache-control', 'no-store')
      .send({ ok: true, result: {} });
  });

  app.get(SESSION_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    const session = await deps.auth.session(request);
    if (session === undefined) {
      // The cookies are left alone: this may answer a request sent with an old cookie after the
      // browser stored a newer one (signing in again, Q11), and clearing them would end that new
      // session too. A dead cookie only earns more 401s; signing out or in replaces it.
      return reply
        .code(401)
        .header('cache-control', 'no-store')
        .send(errorBody(request, 'UNAUTHENTICATED', 'Sign in to continue.'));
    }
    // Sets the CSRF cookie again, in case the browser lost it.
    return reply
      .header(
        'set-cookie',
        csrfCookie(csrfToken(deps.sessionSecret, session.id), { secure: deps.secureCookies }),
      )
      .header('cache-control', 'no-store')
      .send({ ok: true, result: { userId: session.userId, workspaceId: session.workspaceId } });
  });

  app.get(CAPABILITIES_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    return reply.header('cache-control', 'no-store').send({
      ok: true,
      result: { smtp: deps.smtpEnabled, setupComplete: await deps.setupComplete() },
    });
  });
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
    .header('retry-after', '5')
    .send(errorBody(request, 'UNAVAILABLE', 'Surface is starting. Try again in a few seconds.'));
}
