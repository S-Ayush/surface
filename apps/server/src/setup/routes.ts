/**
 * First-run setup over HTTP (SPEC-001 §3.1, §6.1): `GET /setup/status`, `POST /setup`, and the
 * guard that keeps everything else closed until setup is done.
 *
 * - **API, sync, auth, files, MCP:** `503 SETUP_REQUIRED` while setup is incomplete.
 * - **Pages:** a browser asking for any page is sent to `/setup`, and to `/` once setup is done.
 * - **Always open:** health, readiness, metrics, static files and the setup routes themselves.
 *
 * `/setup` is a page (the wizard) and `/setup/status` an endpoint, so `/setup/` is not one of the
 * SPA-excluded `SERVER_PREFIXES`: that would also exclude the page.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { csrfCookie, csrfToken } from '../auth/csrf.js';
import { sessionCookie } from '../auth/session.js';
import { errorBody, ROUTE_ERROR_STATUS } from '../http/errors.js';
import type { Lifecycle } from '../lifecycle.js';
import { setupInputSchema } from './input.js';
import type { SetupStore } from './store.js';

export const SETUP_PATH = '/setup';
export const SETUP_STATUS_PATH = '/setup/status';

/** Paths closed with `503 SETUP_REQUIRED` until setup is done. */
const CLOSED_PREFIXES = ['/api/', '/sync/', '/auth/', '/files/', '/mcp'];
/**
 * Paths open whatever the setup state. `/auth/capabilities` says whether setup is done, so the
 * login page can tell (SPEC-001 §6.1).
 */
const OPEN_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  SETUP_STATUS_PATH,
  '/auth/capabilities',
]);

/**
 * Whether setup is done, remembered once it is: after that the guard costs nothing. Until then it
 * asks the database each time, so another replica finishing setup is noticed at once.
 */
export class SetupGate {
  readonly #store: Pick<SetupStore, 'isComplete'>;
  #complete = false;

  constructor(store: Pick<SetupStore, 'isComplete'>) {
    this.#store = store;
  }

  async isComplete(): Promise<boolean> {
    if (!this.#complete) this.#complete = await this.#store.isComplete();
    return this.#complete;
  }

  markComplete(): void {
    this.#complete = true;
  }
}

export interface SetupRouteDeps {
  readonly store: SetupStore;
  readonly gate: SetupGate;
  readonly lifecycle: Lifecycle;
  /** `Secure` on the session cookie (https `SURFACE_URL`). */
  readonly secureCookies: boolean;
  /** Signs the CSRF token set with the session (`auth/csrf.ts`). */
  readonly sessionSecret: string;
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  app.addHook('onRequest', (request, reply) => guard(request, reply, deps));

  app.get(SETUP_STATUS_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    const complete = await deps.gate.isComplete();
    const token = tokenParam(request);
    const tokenValid = !complete && token !== undefined && (await deps.store.tokenValid(token));
    return reply
      .header('cache-control', 'no-store')
      .send({ ok: true, result: { complete, tokenValid } });
  });

  app.post(SETUP_PATH, async (request, reply) => {
    if (!deps.lifecycle.everReady) return unavailable(request, reply);
    const parsed = setupInputSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Check the setup form and try again';
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', message));
    }
    // Hashing the password costs 19 MiB and tens of milliseconds, so a request that can't finish
    // setup must not reach it. The store checks both again under the row lock (E1); these checks
    // only keep anyone without the token from making the server hash.
    if (await deps.gate.isComplete()) return alreadyComplete(request, reply);
    if (!(await deps.store.tokenValid(parsed.data.token))) return wrongLink(request, reply);
    const outcome = await deps.store.complete(parsed.data, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'complete') {
        deps.gate.markComplete();
        return alreadyComplete(request, reply);
      }
      return wrongLink(request, reply);
    }
    deps.gate.markComplete();
    request.log.info({ teamKey: outcome.teamKey }, 'setup complete');
    return reply
      .code(201)
      .header('set-cookie', [
        sessionCookie(outcome.session.token, { secure: deps.secureCookies }),
        csrfCookie(csrfToken(deps.sessionSecret, outcome.session.id), {
          secure: deps.secureCookies,
        }),
      ])
      .header('cache-control', 'no-store')
      .send({ ok: true, result: { next: `/team/${outcome.teamKey}` } });
  });
}

async function guard(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: SetupRouteDeps,
): Promise<FastifyReply | undefined> {
  // Before migrations have run the state can't be read; the routes answer 503 meanwhile. While
  // draining, requests are still served, so the guard still applies (S3 review B2), unless
  // startup never finished.
  if (!deps.lifecycle.everReady) return undefined;
  const pathname = routedPath(request);
  if (OPEN_PATHS.has(pathname) || pathname.startsWith('/assets/')) return undefined;
  const isPage = wantsPage(request, pathname);
  if (await deps.gate.isComplete()) {
    // The wizard has nothing left to do.
    if (isPage && pathname === SETUP_PATH) return reply.redirect('/', 302);
    return undefined;
  }
  if (
    CLOSED_PREFIXES.some(
      (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
    )
  ) {
    return reply
      .code(ROUTE_ERROR_STATUS.SETUP_REQUIRED)
      .send(
        errorBody(
          request,
          'SETUP_REQUIRED',
          'Surface is not set up yet. Open the setup link from the server logs to finish setup.',
        ),
      );
  }
  if (isPage && pathname !== SETUP_PATH) return reply.redirect(SETUP_PATH, 302);
  return undefined;
}

/**
 * The path as the router matches it. The router percent-decodes before matching, so `/%61pi/ops`
 * reaches `/api/ops`; checking the raw URL would let it past the guard. Decoding more than the
 * router does (`%2F`) can only close more, never less.
 */
function routedPath(request: FastifyRequest): string {
  const raw = request.url.split('?')[0] ?? '/';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed: the router answers 400 itself
  }
}

function alreadyComplete(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(409)
    .send(errorBody(request, 'CONFLICT', 'Setup is already complete. Sign in instead.'));
}

function wrongLink(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(403)
    .send(
      errorBody(
        request,
        'FORBIDDEN',
        'This setup link is not valid. Use the latest link in the server logs, or run "surface setup-token".',
      ),
    );
}

/** A browser navigating to a page (not a file, not an API call). */
function wantsPage(request: FastifyRequest, pathname: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (/\.[A-Za-z0-9]+$/.test(pathname)) return false;
  return request.headers.accept?.includes('text/html') ?? false;
}

function tokenParam(request: FastifyRequest): string | undefined {
  const { query } = request;
  if (typeof query !== 'object' || query === null) return undefined;
  const token: unknown = Reflect.get(query, 'token');
  return typeof token === 'string' && token.length > 0 && token.length <= 128 ? token : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
    .header('retry-after', '5')
    .send(errorBody(request, 'UNAVAILABLE', 'Surface is starting. Try again in a few seconds.'));
}
