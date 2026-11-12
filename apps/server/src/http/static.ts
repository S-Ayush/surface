/**
 * Serves the built web app (SPEC-004 §5):
 * - `/assets/*` (content-hashed by Vite): cached for a year, immutable.
 * - `index.html` and the offline worker `sw.js` (ADR-0019): `no-cache`, so a new deploy is picked
 *   up on next load.
 * - Unknown paths that want HTML get `index.html` (client-side routing).
 * - Unknown paths under server prefixes get a JSON 404.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { isServerPath } from '@surface/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNotFound } from './errors.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The built app page, or undefined when the web app isn't built. */
export function readIndexHtml(webDir: string): string | undefined {
  const indexFile = path.join(webDir, 'index.html');
  return existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : undefined;
}

/** `hasWebApp`: whether `readIndexHtml(webDir)` found the page, so both agree on one check. */
export async function registerWebApp(
  app: FastifyInstance,
  webDir: string,
  hasWebApp: boolean,
): Promise<void> {
  if (hasWebApp) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: true,
      setHeaders: (reply, filePath) => {
        const relative = path.relative(webDir, filePath).split(path.sep).join('/');
        if (relative.startsWith('assets/')) reply.header('cache-control', IMMUTABLE);
        // The offline worker (ADR-0019) like the page. Browsers skip their HTTP cache when they check
        // for a new worker; this keeps proxies from serving an old one, and `sw.js` from ever taking
        // the assets' year-long policy.
        else if (relative === 'index.html' || relative === 'sw.js') {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  } else {
    app.log.warn(
      { webDir },
      'web app not built; serving the API only (run `pnpm --filter @surface/web build`)',
    );
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasWebApp && wantsAppShell(request)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendNotFound(request, reply);
  });
}

function wantsAppShell(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const pathname = request.url.split('?')[0] ?? '/';
  // The server's own paths (`SERVER_PREFIXES` in @surface/sync-protocol, shared with the offline
  // worker) are never answered with the page.
  if (isServerPath(pathname)) return false;
  // A missing file like /assets/old-abc123.js must 404, not return HTML.
  if (path.extname(pathname) !== '') return false;
  return request.headers.accept?.includes('text/html') ?? false;
}
