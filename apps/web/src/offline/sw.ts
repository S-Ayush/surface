// The offline app cache's service worker (ADR-0019). Bundled on its own into `dist/sw.js` by
// `vite-app-cache.ts`, which defines `__SURFACE_APP_BUILD__`. The rules are in `app-cache.ts`.
import { answerAsset, answerPage, cleanup, install, route, type AppBuild } from './app-cache.js';

declare const __SURFACE_APP_BUILD__: AppBuild;

// The worker's global scope, described here: apps/web type-checks against the DOM library, and
// the WebWorker one can't be loaded beside it.
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  /** The navigation preload's answer; undefined when preload is off or this isn't a page load. */
  readonly preloadResponse?: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  readonly registration: { readonly navigationPreload?: { enable(): Promise<void> } };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

function isWorkerScope(scope: unknown): scope is WorkerScope {
  return (
    typeof scope === 'object' && scope !== null && 'skipWaiting' in scope && 'clients' in scope
  );
}

const build = __SURFACE_APP_BUILD__;

function start(scope: WorkerScope): void {
  const network = (request: Request) => fetch(request);

  // A new build takes over at once; the previous build's cache stays for tabs still on it.
  scope.addEventListener('install', (event) => {
    event.waitUntil(install(build, scope.caches).then(() => scope.skipWaiting()));
  });
  scope.addEventListener('activate', (event) => {
    // Navigation preload sends a page load while the worker starts, so pages don't wait for it.
    event.waitUntil(
      Promise.all([
        cleanup(build, scope.caches),
        scope.registration.navigationPreload?.enable(),
      ]).then(() => scope.clients.claim()),
    );
  });
  scope.addEventListener('fetch', (event) => {
    const kind = route(event.request, scope.location.origin);
    if (kind === 'asset') {
      event.respondWith(answerAsset(event.request, { caches: scope.caches, fetch: network }));
    } else if (kind === 'page') {
      event.respondWith(
        answerPage(event.request, {
          caches: scope.caches,
          fetch: network,
          build,
          preload: event.preloadResponse,
        }),
      );
    }
    // Anything else isn't answered here, so the browser sends it as if there were no worker.
  });
}

// `globalThis` can't be narrowed in place; as `unknown` it narrows to the worker's scope alone.
const scope: unknown = globalThis;
if (isWorkerScope(scope)) start(scope);
