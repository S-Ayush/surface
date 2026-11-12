/**
 * Showing and accepting an invite over HTTP (SPEC-001 §3.4, §6.1, E3–E5, D8; PLAN-001 S5).
 * Plain routes, like setup and sign-in: the invitee has no account, so there is no actor to run
 * an operation as (server rules, "Mutations"). Synced rows still go through the repo (store.ts).
 *
 * - `GET /api/invite/:token` → what the page shows: the workspace, who invited, the email if the
 *   invite has one, and the role. A used, revoked, expired or unknown link is the same `404`
 *   (E4). The page itself is `/invite/:token`; `/api/` keeps the two apart, and request logs
 *   mask both (`SENSITIVE_PATH_PATTERNS`).
 * - `POST /api/invite/:token/accept {name, displayName, password, email?, timezone?}` creates the
 *   user and the memberships, marks the invite accepted and signs in, in one transaction: a
 *   refusal (E3, E5) leaves the invite pending. Another site's page is refused (login CSRF), and
 *   the session this browser had ends, as on sign-in (SPEC-001 Q11).
 * - Refused accepts count like failed sign-ins, per invite and per address (S9 security review
 *   L2): E3 tells whether an email has an account, so a link's holder may ask only so often, and
 *   each try costs an argon2 hash.
 */
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameProblem,
  displayNameSuggestionPrefix,
  displayNameTakenMessage,
  EMAIL_MAX_LENGTH,
  EMAIL_TAKEN_MESSAGE,
  emailProblem,
  INVITE_INVALID_MESSAGE,
  NAME_MAX_LENGTH,
  nameProblem,
  normaliseEmail,
  PASSWORD_MAX_LENGTH,
  passwordProblem,
  suggestDisplayName,
  timeZoneProblem,
  canonicalTimeZone,
} from '@surface/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ipKey, type AttemptStore } from '../../auth/attempts.js';
import { audit } from '../../auth/audit.js';
import { hashPassword } from '../../auth/password.js';
import type { SessionAuth } from '../../auth/sessions.js';
import type { WithTransaction } from '../../executor/transaction.js';
import { errorBody } from '../../http/errors.js';
import type { Lifecycle } from '../../lifecycle.js';
import { hashLinkToken, LINK_TOKEN_MAX_LENGTH } from '../../mail/link-tokens.js';
import {
  closeAfterResponse,
  newSession,
  sameOrigin,
  signedIn,
  unavailable,
} from '../account/sign-in.js';
import { PG_INVITE_STORE, TakenError, type InviteStore } from './store.js';

export const INVITE_PATH = '/api/invite/:token';
export const ACCEPT_PATH = '/api/invite/:token/accept';

export interface InviteRouteDeps {
  readonly auth: SessionAuth;
  readonly lifecycle: Lifecycle;
  readonly secureCookies: boolean;
  readonly sessionSecret: string;
  readonly allowedOrigin: string;
  readonly withTransaction: WithTransaction;
  readonly store?: InviteStore;
  /** The sign-in lockout's store: refused accepts count per invite and per address (AC-6). */
  readonly attempts: AttemptStore;
  readonly closeSessions?: (sessionIds: readonly string[]) => void;
  readonly now?: () => Date;
  readonly hashPassword?: (password: string) => Promise<string>;
}

const Params = z.object({ token: z.string().min(1).max(LINK_TOKEN_MAX_LENGTH) });

const AcceptBody = z.object({
  name: z.string().max(NAME_MAX_LENGTH.person * 4),
  displayName: z.string().max(DISPLAY_NAME_MAX_LENGTH * 4),
  password: z.string().max(PASSWORD_MAX_LENGTH * 2),
  email: z
    .string()
    .max(EMAIL_MAX_LENGTH * 2)
    .optional(),
  timezone: z.string().max(100).optional(),
});

type Field = 'name' | 'displayName' | 'password' | 'email';

/** A refusal about one field, so the page shows it on that field (SPEC-003 error `issues`). */
class FieldError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'CONFLICT',
    readonly field: Field,
    message: string,
  ) {
    super(message);
  }
}

/** The invite stopped being pending (E4): the transaction rolls back with nothing written. */
class InviteGone extends Error {}

const STATUS = { INVALID_INPUT: 400, CONFLICT: 409 } as const;

function fieldErrorBody(request: FastifyRequest, error: FieldError) {
  const body = errorBody(request, error.code, error.message);
  return {
    ...body,
    error: { ...body.error, issues: [{ path: [error.field], message: error.message }] },
  };
}

export function registerInviteRoutes(app: FastifyInstance, deps: InviteRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? PG_INVITE_STORE;
  const hash = deps.hashPassword ?? hashPassword;

  const gone = (request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(404)
      .header('cache-control', 'no-store')
      .send(errorBody(request, 'NOT_FOUND', INVITE_INVALID_MESSAGE));

  app.get(INVITE_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    const params = Params.safeParse(request.params);
    if (!params.success) return gone(request, reply);
    const invite = await deps.withTransaction((client) =>
      store.pendingInvite(client, hashLinkToken(params.data.token), now()),
    );
    if (invite === undefined) return gone(request, reply);
    return reply.header('cache-control', 'no-store').send({ ok: true, result: invite });
  });

  app.post(ACCEPT_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    if (!sameOrigin(request, reply, deps.allowedOrigin)) return reply;
    const params = Params.safeParse(request.params);
    if (!params.success) return gone(request, reply);
    const body = AcceptBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(
          errorBody(request, 'INVALID_INPUT', 'Enter your name, a display name and a password.'),
        );
    }
    const input = body.data;
    const tokenHash = hashLinkToken(params.data.token);
    // The link first: a dead one is E4 before any field, and before argon2's costly work, which
    // a stranger could otherwise ask for with any token. (GET already tells a live link apart.)
    const pending = await deps.withTransaction((client) =>
      store.pendingInvite(client, tokenHash, now()),
    );
    if (pending === undefined) return gone(request, reply);
    // The page asks for an email only when the invite has none; a typed one is then ignored.
    const needsEmail = pending.email === null;
    // Checked in the order of the form, so the first problem shown is the first field.
    const problems: [Field, string | undefined][] = [
      ['email', needsEmail ? emailProblem(input.email ?? '') : undefined],
      ['name', nameProblem('Name', input.name, NAME_MAX_LENGTH.person)],
      ['displayName', displayNameProblem(input.displayName)],
      ['password', passwordProblem(input.password)],
    ];
    const first = problems.find(([, problem]) => problem !== undefined);
    if (first?.[1] !== undefined) {
      return reply
        .code(400)
        .send(fieldErrorBody(request, new FieldError('INVALID_INPUT', first[0], `${first[1]}.`)));
    }
    // Reserved before argon2 and the checks that tell emails apart, and forgotten once the invite
    // is accepted. Problems the page could have caught (above) and dead links don't count.
    const keys = [`invite:${tokenHash}`, ipKey(request.ip)];
    const reservation = await deps.attempts.reserve(keys, now());
    if (!reservation.ok) {
      const minutes = Math.ceil(reservation.lockedForSeconds / 60);
      request.log.warn(
        { reason: 'locked', ip: request.ip },
        'invite accept refused: too many tries',
      );
      return reply
        .code(429)
        .header('retry-after', String(reservation.lockedForSeconds))
        .send(
          errorBody(
            request,
            'RATE_LIMITED',
            `Too many tries with this invite. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          ),
        );
    }
    const timezone =
      input.timezone !== undefined && timeZoneProblem(input.timezone) === undefined
        ? canonicalTimeZone(input.timezone)
        : 'UTC';
    // Hashed before the transaction, so it holds no locks during argon2's work.
    const passwordHash = await hash(input.password);
    const at = now();
    const previous = await deps.auth.session(request);

    let joined;
    try {
      joined = await deps.withTransaction(async (client) => {
        // One wins: the claim is `UPDATE … WHERE` pending (E4), and the row stays locked until
        // commit, so a revoke at the same moment waits and then finds it accepted.
        const invite = await store.claim(client, tokenHash, at);
        if (invite === undefined) throw new InviteGone();
        const email =
          invite.email ?? (input.email === undefined ? undefined : normaliseEmail(input.email));
        if (email === undefined)
          throw new FieldError('INVALID_INPUT', 'email', 'Email is required.');
        // E3: the email may have gained an account since the invite was made.
        if (await store.emailTaken(client, email)) {
          throw new FieldError('CONFLICT', 'email', `${EMAIL_TAKEN_MESSAGE}. Log in instead.`);
        }
        const displayName = input.displayName.trim();
        // Every name the suggestion could be starts with this prefix, even at the length limit.
        const similar = await store.displayNamesLike(
          client,
          displayNameSuggestionPrefix(displayName),
        );
        if (similar.some((taken) => taken.toLowerCase() === displayName.toLowerCase())) {
          // E5, with the first free variant.
          const suggestion = suggestDisplayName(displayName, similar);
          throw new FieldError(
            'CONFLICT',
            'displayName',
            `${displayNameTakenMessage(suggestion)}.`,
          );
        }
        const member = await store.createMember(
          client,
          {
            invite,
            email,
            name: input.name.trim(),
            displayName,
            timezone,
            passwordHash,
          },
          at,
        );
        // The session this browser had ends, as on sign-in (Q11).
        const ended =
          previous === undefined
            ? []
            : await store.endSessions(client, previous.userId, { only: previous.id });
        const session = await store.createSession(client, newSession(request, member.userId, at));
        return { invite, member, session, ended };
      });
    } catch (error) {
      if (error instanceof InviteGone) return gone(request, reply);
      if (error instanceof FieldError) {
        return reply.code(STATUS[error.code]).send(fieldErrorBody(request, error));
      }
      // Someone took the email or display name between the check and the insert.
      if (error instanceof TakenError) {
        const taken =
          error.field === 'email'
            ? new FieldError('CONFLICT', 'email', `${EMAIL_TAKEN_MESSAGE}. Log in instead.`)
            : new FieldError(
                'CONFLICT',
                'displayName',
                'That display name was just taken. Try another one.',
              );
        return reply.code(409).send(fieldErrorBody(request, taken));
      }
      throw error;
    }

    await deps.attempts.succeeded(reservation.attempt, keys[0] ?? '');
    closeAfterResponse(request, reply, joined.ended, deps.closeSessions);
    // SPEC-001 §10, after the commit: this route is outside the executor (no ctx.audit).
    audit(
      request.log,
      'user.joined',
      {
        userId: joined.member.userId,
        actorId: joined.invite.invitedById,
        reason: 'invite',
        sessionId: joined.session.id,
        ip: request.ip,
      },
      'joined by invite',
    );
    return signedIn(reply, deps, joined.session, joined.member.userId);
  });
}
