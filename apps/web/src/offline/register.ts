// Registers the offline app cache's worker (ADR-0019). Updates need nothing here: the browser
// checks `/sw.js` on every page load, and a reload goes to the server first.

/** Served from the build's root, so its scope is the whole site. */
export const WORKER_URL = '/sw.js';

/** `navigator`, as far as the worker goes. `serviceWorker` is missing outside a secure context. */
export interface WorkerHost {
  readonly serviceWorker?: {
    register(url: string, options: { scope: string }): Promise<unknown>;
  };
}

/**
 * Production builds only: in dev, Vite serves the files and a worker would keep stale ones. Over
 * plain http:// (other than localhost) browsers have no service workers, and nothing changes.
 */
export async function registerAppCache({
  production,
  host,
}: {
  readonly production: boolean;
  readonly host: WorkerHost;
}): Promise<void> {
  if (!production || host.serviceWorker === undefined) return;
  try {
    await host.serviceWorker.register(WORKER_URL, { scope: '/' });
  } catch {
    // Without the worker the app loads from the server, as before ADR-0019.
  }
}
