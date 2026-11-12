/**
 * What the routes that sign someone in without a password share (magic link and reset, PLAN-001
 * S4; accepting an invite, S5): the login-CSRF origin check, the new session's details, the
 * cookies, closing the ended sessions' sockets after the answer, and the "starting" answer.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { csrfCookie, csrfToken } from '../../auth/csrf.js';
import { sessionCookie, type NewSession } from '../../auth/session.js';
import { errorBody, ROUTE_ERROR_STATUS } from '../../http/errors.js';

export function newSession(request: FastifyRequest, userId: string, now: Date): NewSession {
  return { userId, userAgent: request.headers['user-agent'], ip: request.ip, now };
}

/** Another site's page can't sign this browser in (login CSRF), as on `POST /auth/login`. */
export function sameOrigin(request: FastifyRequest, reply: FastifyReply, allowed: string): boolean {
  const { origin } = request.headers;
  if (origin === undefined || origin === allowed) return true;
  request.log.warn({ origin }, 'sign-in from another origin refused');
  void reply.code(403).send(errorBody(request, 'FORBIDDEN', `Sign in at ${allowed}.`));
  return false;
}

/** Answers `{ userId }` with the new session's cookies (SPEC-001 §6.1). */
export function signedIn(
  reply: FastifyReply,
  deps: { readonly secureCookies: boolean; readonly sessionSecret: string },
  session: { readonly id: string; readonly token: string },
  userId: string,
): FastifyReply {
  return reply
    .header('set-cookie', [
      sessionCookie(session.token, { secure: deps.secureCookies }),
      csrfCookie(csrfToken(deps.sessionSecret, session.id), { secure: deps.secureCookies }),
    ])
    .header('cache-control', 'no-store')
    .send({ ok: true, result: { userId } });
}

/**
 * Closes the ended sessions' sockets once the response is on its way, as sign-in does: this
 * browser's other tabs recheck `GET /auth/session` on `4001`, and must find the new cookie.
 */
export function closeAfterResponse(
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

export function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
    .header('retry-after', '5')
    .send(errorBody(request, 'UNAVAILABLE', 'Surface is starting. Try again in a few seconds.'));
}
