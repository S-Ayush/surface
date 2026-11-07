/**
 * Magic links and password reset over HTTP (SPEC-001 §3.2, §3.3, §6.1; PLAN-001 S4). Plain
 * routes, like sign-in: there is no actor yet.
 *
 * - `POST /auth/magic-link` and `POST /auth/forgot` answer the same `200` for every well-formed
 *   address, before looking anything up. The lookup, the link and the email happen after the
 *   answer is sent, so neither the body nor the timing tells whether an account exists (AC-5).
 *   An address the email schema refuses never gets this far: it fails the same format check for
 *   everyone (`emailProblem`).
 * - `POST /auth/magic {token}` uses a magic link and signs in. The emailed link opens a page
 *   that asks first, so a mail scanner opening it uses nothing, and another site can't sign the
 *   browser into someone else's account (login CSRF; like sign-in, another `Origin` is refused).
 * - `POST /auth/reset {token, password}` sets the password, ends every session of the user
 *   (E10) and signs this browser in.
 *
 * Writes and the email they queue share one transaction (`withTransaction`): a link is stored
 * only if its email is queued, and the other way round.
 */
import {
  EMAIL_MAX_LENGTH,
  emailProblem,
  normaliseEmail,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
} from '@surface/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csrfCookie, csrfToken } from '../../auth/csrf.js';
import { hashPassword } from '../../auth/password.js';
import { createSession, sessionCookie, type NewSession } from '../../auth/session.js';
import type { SessionAuth } from '../../auth/sessions.js';
import { deleteUserSessions, type SessionSelection } from '../../auth/store.js';
import type { WithTransaction } from '../../executor/transaction.js';
import { errorBody, ROUTE_ERROR_STATUS } from '../../http/errors.js';
import type { EmailOutbox } from '../../jobs/email.js';
import type { Lifecycle } from '../../lifecycle.js';
import {
  activeUserByEmail,
  issueLink,
  LINK_REQUEST_COOLDOWN_MS,
  LINK_TOKEN_MAX_LENGTH,
  setPasswordHash,
  useLink,
  workspaceName,
  type LinkDb,
  type LinkKind,
} from '../../mail/link-tokens.js';
import { magicLinkUrl, passwordResetUrl } from '../../mail/links.js';

export const MAGIC_LINK_REQUEST_PATH = '/auth/magic-link';
export const MAGIC_LINK_PATH = '/auth/magic';
export const FORGOT_PATH = '/auth/forgot';
export const RESET_PATH = '/auth/reset';

/** What the routes read and write, on the route's transaction. Tests pass a fake. */
export interface AccountStore {
  activeUserByEmail(db: LinkDb, email: string): Promise<{ id: string; email: string } | undefined>;
  workspaceName(db: LinkDb): Promise<string>;
  issueLink: typeof issueLink;
  useLink: typeof useLink;
  setPasswordHash(db: LinkDb, userId: string, hash: string, now: Date): Promise<void>;
  createSession(db: LinkDb, session: NewSession): Promise<{ id: string; token: string }>;
  /** Deletes sessions and returns their ids, for closing their sockets after the commit. */
  endSessions(db: LinkDb, userId: string, which: SessionSelection): Promise<string[]>;
}

export const PG_ACCOUNT_STORE: AccountStore = {
  activeUserByEmail,
  workspaceName,
  issueLink,
  useLink,
  setPasswordHash,
  createSession,
  endSessions: deleteUserSessions,
};

export interface AccountRouteDeps {
  readonly auth: SessionAuth;
  readonly lifecycle: Lifecycle;
  readonly secureCookies: boolean;
  readonly sessionSecret: string;
  /** `SURFACE_URL`'s origin: the only page that may sign in (login CSRF). */
  readonly allowedOrigin: string;
  /** `SURFACE_URL`: emailed links point here (SPEC-004 E3). */
  readonly publicUrl: string;
  readonly email: EmailOutbox;
  readonly withTransaction: WithTransaction;
  readonly store?: AccountStore;
  /** Closes these sessions' sockets with `4001` on every replica. */
  readonly closeSessions?: (sessionIds: readonly string[]) => void;
  readonly now?: () => Date;
  readonly hashPassword?: (password: string) => Promise<string>;
  /** The work a link request does after its answer is sent; tests await it. */
  readonly background?: (work: Promise<void>) => void;
}

const EmailBody = z.object({ email: z.string().max(EMAIL_MAX_LENGTH * 2) });
const Token = z.string().max(LINK_TOKEN_MAX_LENGTH);
const MagicBody = z.object({ token: Token });
const ResetBody = z.object({ token: Token, password: z.string().max(PASSWORD_MAX_LENGTH * 2) });

const NO_EMAIL: Readonly<Record<LinkKind, string>> = {
  magicLink:
    "Login links need email, which isn't set up on this server. Log in with your password.",
  passwordReset: 'Email isn’t set up on this server. Ask an Admin for a reset link.',
};

const USED_UP: Readonly<Record<LinkKind, string>> = {
  magicLink:
    'This login link has expired or was already used. Ask for a new one on the login page.',
  passwordReset: 'This reset link has expired or was already used. Ask for a new one.',
};

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? PG_ACCOUNT_STORE;
  const hash = deps.hashPassword ?? hashPassword;
  const background =
    deps.background ??
    ((work: Promise<void>) => {
      void work;
    });

  /** POST /auth/magic-link and /auth/forgot: the same answer, then the work (AC-5). */
  const requestLink = (kind: LinkKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    if (!deps.email.enabled) {
      return reply.code(404).send(errorBody(request, 'NOT_FOUND', NO_EMAIL[kind]));
    }
    const body = EmailBody.safeParse(request.body);
    const problem = body.success ? emailProblem(body.data.email) : 'Email is required';
    if (!body.success || problem !== undefined) {
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', `${problem}.`));
    }
    const email = normaliseEmail(body.data.email); // E2
    const at = now();
    const log = request.log;
    const work = deps
      .withTransaction(async (client) => {
        const user = await store.activeUserByEmail(client, email);
        if (user === undefined) return undefined;
        const link = await store.issueLink(client, kind, user.id, {
          now: at,
          cooldownMs: LINK_REQUEST_COOLDOWN_MS,
        });
        if (link === undefined) return { userId: user.id, sent: false };
        const url =
          kind === 'magicLink'
            ? magicLinkUrl(deps.publicUrl, link.token)
            : passwordResetUrl(deps.publicUrl, link.token);
        const name = await store.workspaceName(client);
        await deps.email.enqueue(client, {
          template: kind,
          to: user.email,
          workspaceName: name,
          link: url,
        });
        return { userId: user.id, sent: true };
      })
      .then(
        (outcome) => {
          // Never the email: it says who has an account (and may be mistyped into the field).
          if (outcome === undefined) log.info({ event: `${kind}.requested` }, 'no such account');
          else if (!outcome.sent) log.info({ event: `${kind}.requested`, ...outcome }, 'too soon');
          else log.info({ event: `${kind}.requested`, userId: outcome.userId }, 'link queued');
        },
        (error: unknown) => {
          log.error({ err: error, event: `${kind}.requested` }, 'could not queue the link');
        },
      );
    background(work);
    return reply.header('cache-control', 'no-store').send({ ok: true, result: {} });
  };

  app.post(MAGIC_LINK_REQUEST_PATH, requestLink('magicLink'));
  app.post(FORGOT_PATH, requestLink('passwordReset'));

  app.post(MAGIC_LINK_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    if (!sameOrigin(request, reply, deps.allowedOrigin)) return reply;
    const body = MagicBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(
          errorBody(
            request,
            'INVALID_INPUT',
            'This login link is incomplete. Open it from the email again.',
          ),
        );
    }
    const at = now();
    const previous = await deps.auth.session(request);
    const signedIn = await deps.withTransaction(async (client) => {
      const userId = await store.useLink(client, 'magicLink', body.data.token, at);
      if (userId === undefined) return undefined;
      // The session this browser had ends, as on sign-in (SPEC-001 Q11).
      const ended =
        previous === undefined
          ? []
          : await store.endSessions(client, previous.userId, { only: previous.id });
      const session = await store.createSession(client, newSession(request, userId, at));
      return { userId, session, ended };
    });
    if (signedIn === undefined) {
      request.log.warn({ event: 'auth.login_failed', reason: 'magic_link' }, 'login link refused');
      return reply.code(401).send(errorBody(request, 'UNAUTHENTICATED', USED_UP.magicLink));
    }
    closeAfterResponse(request, reply, signedIn.ended, deps.closeSessions);
    request.log.info(
      { event: 'auth.login', method: 'magic_link', userId: signedIn.userId },
      'signed in',
    );
    return signIn(reply, signedIn.session, signedIn.userId);
  });

  app.post(RESET_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    if (!sameOrigin(request, reply, deps.allowedOrigin)) return reply;
    const body = ResetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', 'Enter a new password.'));
    }
    const problem = passwordProblem(body.data.password);
    if (problem !== undefined) {
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', `${problem}.`));
    }
    // Hashed before the transaction, so it holds no locks during argon2's work.
    const passwordHash = await hash(body.data.password);
    const at = now();
    const previous = await deps.auth.session(request);
    const reset = await deps.withTransaction(async (client) => {
      const userId = await store.useLink(client, 'passwordReset', body.data.token, at);
      if (userId === undefined) return undefined;
      await store.setPasswordHash(client, userId, passwordHash, at);
      // Every session of the user ends, wherever it is (E10).
      const ended = await store.endSessions(client, userId, { all: true });
      // So does this browser's, if it was someone else's (SPEC-001 Q11).
      if (previous !== undefined && previous.userId !== userId) {
        ended.push(...(await store.endSessions(client, previous.userId, { only: previous.id })));
      }
      const session = await store.createSession(client, newSession(request, userId, at));
      return { userId, session, ended };
    });
    if (reset === undefined) {
      request.log.warn({ event: 'auth.password_reset_failed' }, 'reset link refused');
      return reply.code(401).send(errorBody(request, 'UNAUTHENTICATED', USED_UP.passwordReset));
    }
    closeAfterResponse(request, reply, reset.ended, deps.closeSessions);
    request.log.info({ event: 'auth.password_reset', userId: reset.userId }, 'password reset');
    return signIn(reply, reset.session, reset.userId);
  });

  function signIn(reply: FastifyReply, session: { id: string; token: string }, userId: string) {
    return reply
      .header('set-cookie', [
        sessionCookie(session.token, { secure: deps.secureCookies }),
        csrfCookie(csrfToken(deps.sessionSecret, session.id), { secure: deps.secureCookies }),
      ])
      .header('cache-control', 'no-store')
      .send({ ok: true, result: { userId } });
  }
}

function newSession(request: FastifyRequest, userId: string, now: Date): NewSession {
  return { userId, userAgent: request.headers['user-agent'], ip: request.ip, now };
}

/** Another site's page can't sign this browser in (login CSRF), as on `POST /auth/login`. */
function sameOrigin(request: FastifyRequest, reply: FastifyReply, allowed: string): boolean {
  const { origin } = request.headers;
  if (origin === undefined || origin === allowed) return true;
  request.log.warn({ origin }, 'sign-in from another origin refused');
  void reply.code(403).send(errorBody(request, 'FORBIDDEN', `Sign in at ${allowed}.`));
  return false;
}

/**
 * Closes the ended sessions' sockets once the response is on its way, as sign-in does: this
 * browser's other tabs recheck `GET /auth/session` on `4001`, and must find the new cookie.
 */
function closeAfterResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  ids: readonly string[],
  closeSessions: ((ids: readonly string[]) => void) | undefined,
): void {
  if (ids.length === 0 || closeSessions === undefined) return;
  const close = () => {
    // An event listener: a throw here would end the process, not this request.
    try {
      closeSessions(ids);
    } catch (error) {
      request.log.error({ err: error }, 'could not close the ended sessions’ sockets');
    }
  };
  if (reply.raw.destroyed || reply.raw.closed) close();
  else reply.raw.once('close', close);
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
    .header('retry-after', '5')
    .send(errorBody(request, 'UNAVAILABLE', 'Surface is starting. Try again in a few seconds.'));
}
