// The paths the server answers itself (SPEC-004 §5): never with the web app's page, and never by the
// offline worker (ADR-0019, PLAN-005 S9). One list, so the server and the worker can't drift.
//
// No imports, Zod included, so the worker can import it alone, as
// `@surface/sync-protocol/server-paths`, without the package's schemas (`server-paths.test.ts`
// guards it).

/**
 * A prefix ending in `/` is a whole segment: `/api` and `/api/…`, not `/apix`. The others are plain
 * prefixes, so `/mcpx` is the server's too.
 */
export const SERVER_PREFIXES = [
  '/api/',
  '/sync/',
  '/auth/',
  '/files/',
  '/mcp',
  '/healthz',
  '/readyz',
  '/metrics',
] as const;

/** Whether `pathname` (a URL's path, without its query string) is one the server answers itself. */
export function isServerPath(pathname: string): boolean {
  return SERVER_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
}
