// The offline app cache's rules (ADR-0019): which requests the service worker answers, and how.
// Pure functions over a CacheStorage-like store and a fetch, so they are tested in Node; `sw.ts`
// wires them to the worker's events. Its one import, the server's paths, has no imports itself, so
// the worker bundle stays small.
import { isServerPath } from '@surface/sync-protocol/server-paths';

/** One build of the web app: its id, and the page and files the worker keeps (`vite-app-cache.ts`). */
export type AppBuild = { readonly id: string; readonly files: readonly string[] };

/** The parts of `Cache` the worker uses. */
export interface CacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  addAll(requests: readonly string[]): Promise<void>;
}

/** The parts of `CacheStorage` the worker uses. `keys()` lists caches in creation order. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
  match(
    request: RequestInfo | URL,
    options?: { cacheName?: string },
  ): Promise<Response | undefined>;
}

/** How long a page load waits for the server before the cached page answers (as ADR-0018). */
export const PAGE_TIMEOUT_MS = 10_000;

const CACHE_PREFIX = 'surface-app-';
const PAGE = '/index.html';

export const cacheName = (buildId: string): string => `${CACHE_PREFIX}${buildId}`;

/** Paths the worker never answers: the server's, and `/setup`, which the server redirects to. */
function notTheApp(path: string): boolean {
  return path === '/setup' || path.startsWith('/setup/') || isServerPath(path);
}

/** `asset`: a file of a build; `page`: a page load of the app; undefined: left to the network. */
export function route(
  request: { readonly method: string; readonly url: string; readonly mode: RequestMode },
  origin: string,
): 'asset' | 'page' | undefined {
  if (request.method !== 'GET') return undefined;
  const url = new URL(request.url);
  if (url.origin !== origin) return undefined;
  const path = url.pathname;
  if (notTheApp(path)) return undefined;
  if (path.startsWith('/assets/')) return 'asset';
  return request.mode === 'navigate' ? 'page' : undefined;
}

/**
 * Keeps the build's page and files together; all or nothing (`Cache.addAll`). A failure deletes
 * the cache `open` created, so `cleanup` never mistakes an empty one for the previous build's.
 */
export async function install(build: AppBuild, caches: CacheStorageLike): Promise<void> {
  const name = cacheName(build.id);
  try {
    await (await caches.open(name)).addAll(build.files);
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}

/**
 * Deletes older builds' caches, keeping this build's and the one before it: a tab still running
 * the previous build may yet load its lazily imported files.
 */
export async function cleanup(build: AppBuild, caches: CacheStorageLike): Promise<void> {
  const own = cacheName(build.id);
  const older = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== own,
  );
  await Promise.all(older.slice(0, -1).map((name) => caches.delete(name)));
}

type Network = {
  readonly caches: CacheStorageLike;
  readonly fetch: (request: Request) => Promise<Response>;
};

/** A file of a build: from any build's cache (hashed names never change), else the network. */
export async function answerAsset(request: Request, { caches, fetch }: Network): Promise<Response> {
  return (await caches.match(request)) ?? fetch(request);
}

/**
 * A page load: the server first. `preload` is the browser's navigation preload, sent while the
 * worker was starting, so a page load doesn't wait for the worker before it goes out; without one
 * the worker sends the request itself. The cached page answers only when the server can't: a
 * network error, a 5xx (a proxy in front of a stopped server), or nothing within
 * `PAGE_TIMEOUT_MS`. Without a cached page, the server's answer or failure is passed on.
 */
export async function answerPage(
  request: Request,
  {
    caches,
    fetch,
    build,
    preload,
  }: Network & {
    readonly build: AppBuild;
    readonly preload?: Promise<Response | undefined>;
  },
): Promise<Response> {
  const pending = (preload ?? Promise.resolve(undefined)).then(
    (preloaded) => preloaded ?? fetch(request),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    pending.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    ),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, PAGE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (first !== 'timeout' && 'response' in first && first.response.status < 500) {
    return first.response;
  }
  const cached = await cachedPage(build, caches);
  if (cached !== undefined) return cached;
  return pending;
}

/** This build's page, or any build's: one that is still installing has none yet. */
async function cachedPage(
  build: AppBuild,
  caches: CacheStorageLike,
): Promise<Response | undefined> {
  return (await caches.match(PAGE, { cacheName: cacheName(build.id) })) ?? caches.match(PAGE);
}
