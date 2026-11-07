/**
 * Content-Security-Policy (SPEC-004 §15). Scripts, styles and fonts come only from the server
 * itself; the single inline script, the theme bootstrap in `index.html`, is allowed by its
 * sha256 hash, never with 'unsafe-inline'. The hash is read from the served file at startup, so
 * the policy always matches the build the server ships.
 *
 * HSTS (architecture.md, security row) when `SURFACE_URL` is https: browsers then refuse plain
 * http to this host for a year, so a network attacker can't strip TLS from a later visit. Not
 * `includeSubDomains` or `preload`: the install owns its host only. Browsers ignore the header
 * over http, so sending it behind a TLS-terminating proxy is right (PLAN-001 S9, review L1).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** A `<script>` without `src`, whatever its other attributes, and its exact text. */
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

/**
 * CSP source expressions for every inline script in `html`, as the browser hashes them: the
 * HTML parser turns CRLF and CR into LF before the script text is hashed.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((match) => {
    const text = (match[1] ?? '').replace(/\r\n?/g, '\n');
    const digest = createHash('sha256').update(text, 'utf8').digest('base64');
    return `'sha256-${digest}'`;
  });
  return [...new Set(hashes)];
}

/** The policy for a page whose inline scripts have `scriptHashes`. */
export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "style-src 'self'",
    // Vite inlines small fonts and images as data: URIs; blob: is for local previews.
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    // 'self' covers the same-origin WebSocket (/sync/ws) in CSP Level 3.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** One year, in seconds. */
export const HSTS = 'max-age=31536000';

/**
 * Sends the policy on every response, the JSON API included (an error page is a page too), and
 * HSTS when `https` (the public URL is https).
 */
export function registerSecurityHeaders(
  app: FastifyInstance,
  indexHtml: string | undefined,
  { https }: { readonly https: boolean },
): void {
  const policy = contentSecurityPolicy(
    indexHtml === undefined ? [] : inlineScriptHashes(indexHtml),
  );
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', policy);
    if (https) reply.header('strict-transport-security', HSTS);
  });
}
