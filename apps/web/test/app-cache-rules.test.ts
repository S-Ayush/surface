// ADR-0019: what the service worker handles and how it answers. The worker itself only wires these
// rules to its events; installing and answering offline in a browser are checked by hand (e2e
// held, plans README §6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAGE_TIMEOUT_MS,
  answerAsset,
  answerPage,
  cacheName,
  cleanup,
  install,
  route,
  type AppBuild,
  type CacheStorageLike,
} from '../src/offline/app-cache.js';

const ORIGIN = 'https://surface.example.com';

const get = (path: string, mode: RequestMode = 'no-cors') => ({
  method: 'GET',
  url: `${ORIGIN}${path}`,
  mode,
});

describe('what the worker answers', () => {
  it('answers the build’s hashed files', () => {
    expect(route(get('/assets/index-abc123.js'), ORIGIN)).toBe('asset');
    expect(route(get('/assets/inter-latin.woff2'), ORIGIN)).toBe('asset');
  });

  it('answers page loads of the app’s own routes', () => {
    for (const path of ['/', '/my-issues', '/team/ENG', '/settings/account/profile', '/login']) {
      expect(route(get(path, 'navigate'), ORIGIN)).toBe('page');
    }
  });

  it('never answers the server’s own paths or /setup, even as a page load', () => {
    const paths = [
      '/api/ops/team.create',
      '/auth/session',
      '/sync/ws',
      '/sync/bootstrap',
      '/files/abc',
      '/mcp',
      '/mcp/sse',
      '/healthz',
      '/readyz',
      '/metrics',
      '/setup',
      '/setup/status',
    ];
    for (const path of paths) {
      expect(route(get(path, 'navigate'), ORIGIN), path).toBeUndefined();
      expect(route(get(path), ORIGIN), path).toBeUndefined();
    }
  });

  it('draws the line where the server does (SERVER_PREFIXES in apps/server/src/http/static.ts)', () => {
    // `/api/`, `/sync/`, `/auth/` and `/files/` are whole segments; the server's other paths are
    // plain prefixes, so it answers `/mcpx` and `/metricsfoo` itself (a JSON 404).
    expect(route(get('/apikeys', 'navigate'), ORIGIN)).toBe('page');
    expect(route(get('/filesystem', 'navigate'), ORIGIN)).toBe('page');
    expect(route(get('/setupguide', 'navigate'), ORIGIN)).toBe('page');
    for (const path of ['/mcpx', '/metricsfoo', '/healthzz', '/readyz-now']) {
      expect(route(get(path, 'navigate'), ORIGIN), path).toBeUndefined();
    }
  });

  it('leaves other requests, other origins and other methods to the network', () => {
    expect(route(get('/favicon.svg'), ORIGIN)).toBeUndefined();
    expect(route(get('/team/ENG'), ORIGIN)).toBeUndefined(); // a fetch, not a page load
    expect(route({ ...get('/assets/a.js'), method: 'POST' }, ORIGIN)).toBeUndefined();
    expect(
      route({ method: 'GET', url: 'https://cdn.example.com/assets/a.js', mode: 'cors' }, ORIGIN),
    ).toBeUndefined();
    expect(
      route({ method: 'GET', url: 'https://other.example.com/', mode: 'navigate' }, ORIGIN),
    ).toBeUndefined();
  });
});

/** CacheStorage in memory, keyed by path; keys() in creation order, as browsers keep them. */
function fakeCaches(fetchFn: (path: string) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const pathOf = (request: RequestInfo | URL) =>
    new URL(
      typeof request === 'string' ? request : 'url' in request ? request.url : request.href,
      ORIGIN,
    ).pathname;
  const open = (name: string) => {
    let store = stores.get(name);
    if (store === undefined) {
      store = new Map();
      stores.set(name, store);
    }
    const entries = store;
    return Promise.resolve({
      match: (request: RequestInfo | URL) => Promise.resolve(entries.get(pathOf(request))?.clone()),
      addAll: async (paths: readonly string[]) => {
        // All or nothing, like Cache.addAll.
        const responses = await Promise.all(
          paths.map(async (path) => {
            const response = await fetchFn(path);
            if (!response.ok) throw new TypeError(`${path} ${String(response.status)}`);
            return [path, response] as const;
          }),
        );
        for (const [path, response] of responses) entries.set(path, response);
      },
    });
  };
  const caches: CacheStorageLike = {
    open,
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => Promise.resolve(stores.delete(name)),
    match: (request, options) => {
      const only = options?.cacheName;
      for (const [name, entries] of stores) {
        if (only !== undefined && name !== only) continue;
        const hit = entries.get(pathOf(request));
        if (hit !== undefined) return Promise.resolve(hit.clone());
      }
      return Promise.resolve(undefined);
    },
  };
  return { caches, stores };
}

const BUILD: AppBuild = { id: 'b2', files: ['/index.html', '/assets/index-b2.js'] };

const serve = (path: string) =>
  Promise.resolve(
    new Response(`file ${path}`, {
      status: 200,
      headers: { 'content-security-policy': "default-src 'self'" },
    }),
  );

describe('installing a build', () => {
  it('keeps the page and every file of the build in a cache named after it', async () => {
    const { caches, stores } = fakeCaches(serve);
    await install(BUILD, caches);
    expect([...(stores.get(cacheName('b2'))?.keys() ?? [])]).toEqual(BUILD.files);
  });

  it('fails, keeping nothing new, when any file fails', async () => {
    const { caches, stores } = fakeCaches((path) =>
      path.endsWith('.js') ? Promise.resolve(new Response('', { status: 404 })) : serve(path),
    );
    await expect(install(BUILD, caches)).rejects.toThrow();
    expect(stores.has(cacheName('b2'))).toBe(false);
  });

  it('leaves no empty cache that a later build would keep in place of the previous one', async () => {
    let failing = true;
    const { caches, stores } = fakeCaches((path) =>
      failing && path.endsWith('.js')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : serve(path),
    );
    await install({ id: 'b1', files: ['/index.html'] }, caches);
    failing = false;
    await install({ id: 'b1', files: ['/index.html'] }, caches);
    failing = true;
    await expect(install(BUILD, caches)).rejects.toThrow(); // b2, offline mid-install
    failing = false;
    const b3: AppBuild = { id: 'b3', files: ['/index.html'] };
    await install(b3, caches);
    await cleanup(b3, caches);
    expect([...stores.keys()]).toEqual([cacheName('b1'), cacheName('b3')]);
  });
});

describe('taking over from an older build', () => {
  it('keeps its own cache and the one before it, and deletes older builds’ caches', async () => {
    const { caches, stores } = fakeCaches(serve);
    for (const id of ['a0', 'a1', 'b1']) await caches.open(cacheName(id));
    await caches.open('someone-else'); // not ours
    await install(BUILD, caches);
    await cleanup(BUILD, caches);
    expect([...stores.keys()]).toEqual([cacheName('b1'), 'someone-else', cacheName('b2')]);
  });
});

describe('answering a file of the build', () => {
  it('answers from any build’s cache, so a tab on the previous build still loads its chunks', async () => {
    const { caches } = fakeCaches(serve);
    await install({ id: 'b1', files: ['/assets/old-b1.js'] }, caches);
    const network = vi.fn(serve);
    const response = await answerAsset(new Request(`${ORIGIN}/assets/old-b1.js`), {
      caches,
      fetch: (request) => network(new URL(request.url).pathname),
    });
    expect(await response.text()).toBe('file /assets/old-b1.js');
    expect(network).not.toHaveBeenCalled();
  });

  it('goes to the network for a file no cache has', async () => {
    const { caches } = fakeCaches(serve);
    const response = await answerAsset(new Request(`${ORIGIN}/assets/new.js`), {
      caches,
      fetch: () => Promise.resolve(new Response('from network')),
    });
    expect(await response.text()).toBe('from network');
  });
});

describe('answering a page load', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function installed() {
    const { caches } = fakeCaches(serve);
    await install(BUILD, caches);
    return caches;
  }
  const page = () => new Request(`${ORIGIN}/team/ENG`);

  it('answers from the server whenever it answers below 500, so online loads are unchanged', async () => {
    const caches = await installed();
    for (const status of [200, 302, 401, 404]) {
      const response = await answerPage(page(), {
        caches,
        build: BUILD,
        fetch: () => Promise.resolve(new Response(`server ${String(status)}`, { status })),
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(`server ${String(status)}`);
    }
  });

  it('answers with the cached page, with the headers it was served with, when the network fails', async () => {
    const caches = await installed();
    const response = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(await response.text()).toBe('file /index.html');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('answers with the cached page when the server answers 5xx (a proxy in front of a stopped server)', async () => {
    const caches = await installed();
    for (const status of [500, 502, 503, 504]) {
      const response = await answerPage(page(), {
        caches,
        build: BUILD,
        fetch: () => Promise.resolve(new Response('Bad gateway', { status })),
      });
      expect(await response.text()).toBe('file /index.html');
    }
  });

  it('answers with the cached page when the server says nothing for 10 seconds', async () => {
    const caches = await installed();
    vi.useFakeTimers();
    let settled = false;
    const answer = answerPage(page(), {
      caches,
      build: BUILD,
      fetch: () => new Promise<Response>(() => undefined),
    }).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await answer).text()).toBe('file /index.html');
  });

  it('uses the browser’s navigation preload when it has one, instead of a second request', async () => {
    const caches = await installed();
    const network = vi.fn(() => Promise.resolve(new Response('fetched')));
    const response = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: network,
      preload: Promise.resolve(new Response('preloaded')),
    });
    expect(await response.text()).toBe('preloaded');
    expect(network).not.toHaveBeenCalled();
    const without = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: network,
      preload: Promise.resolve(undefined),
    });
    expect(await without.text()).toBe('fetched');
  });

  it('answers with the cached page when the navigation preload fails', async () => {
    const caches = await installed();
    const response = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: () => Promise.reject(new TypeError('unused')),
      preload: Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(await response.text()).toBe('file /index.html');
  });

  it('passes the failure on when no page is cached', async () => {
    const { caches } = fakeCaches(serve);
    const gateway = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: () => Promise.resolve(new Response('Bad gateway', { status: 502 })),
    });
    expect(gateway.status).toBe(502);
    await expect(
      answerPage(page(), {
        caches,
        build: BUILD,
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    ).rejects.toThrow('Failed to fetch');
  });

  it('uses the previous build’s page when its own is not cached yet', async () => {
    const { caches } = fakeCaches(serve);
    await install({ id: 'b1', files: ['/index.html'] }, caches);
    const response = await answerPage(page(), {
      caches,
      build: BUILD,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(await response.text()).toBe('file /index.html');
  });
});
