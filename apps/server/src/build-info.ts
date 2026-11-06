/**
 * Version and paths. Files in src/ and dist/ sit at the same depth, so these
 * relative URLs work both in development (tsx) and in production (node dist/).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  /** Git commit baked into the image at build time (`SURFACE_COMMIT`), or "dev". */
  commit: string;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (!cached) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    cached = { version: pkg.version, commit: process.env.SURFACE_COMMIT ?? 'dev' };
  }
  return cached;
}

/** Built web app inside the monorepo (`apps/web/dist`). The image overrides it via SURFACE_WEB_DIR. */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}
