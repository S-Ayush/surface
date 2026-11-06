/**
 * Serves the built web app (SPEC-004 §5):
 * - `/assets/*` (content-hashed by Vite): cached for a year, immutable.
 * - `index.html`: `no-cache`, so a new deploy is picked up on next load.
 * - Unknown paths that want HTML get `index.html` (client-side routing).
 * - Unknown paths under server prefixes get a JSON 404.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendNotFound } from './errors.js';

/** Paths owned by the server; never answered with the SPA shell. */
export const SERVER_PREFIXES = [
  '/api/',
  '/sync/',
  '/auth/',
  '/files/',
  '/mcp',
  '/healthz',
  '/readyz',
  '/metrics',
];

const IMMUTABLE = 'public, max-age=31536000, immutable';

export async function registerWebApp(app: FastifyInstance, webDir: string): Promise<void> {
  const indexFile = path.join(webDir, 'index.html');
  const hasWebApp = existsSync(indexFile);

  if (hasWebApp) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: true,
      setHeaders: (reply, filePath) => {
        const relative = path.relative(webDir, filePath).split(path.sep).join('/');
        if (relative.startsWith('assets/')) reply.header('cache-control', IMMUTABLE);
        else if (relative === 'index.html') reply.header('cache-control', 'no-cache');
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
  if (
    SERVER_PREFIXES.some(
      (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
    )
  ) {
    return false;
  }
  // A missing file like /assets/old-abc123.js must 404, not return HTML.
  if (path.extname(pathname) !== '') return false;
  return request.headers.accept?.includes('text/html') ?? false;
}
