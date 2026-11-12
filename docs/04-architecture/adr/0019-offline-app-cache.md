# ADR-0019: Keeping the app's own files in the browser (offline app cache)

Status: **Accepted** (direction chosen by the user through the coordinator; this design approved by the user, 2026-11-07; amended before merge after the S9 review, approved by the user, 2026-11-12: navigation preload, no worker update on Reload) · Date: 2026-11-07

## Context
SPEC-002 AC-6 and the M0 demo (plans README §5) require that an offline change survive a reload made while still offline. ADR-0018 opens the remembered session's replica once the page has loaded. But in the single image (SPEC-004) the server also serves the page: `index.html` is sent `no-cache` and the hashed files under `/assets/` are cached by HTTP for a year (`apps/server/src/http/static.ts`). A reload while the browser is offline, or while the server is stopped, fails on the page request, before any of the app's code runs. PLAN-005 S8's review found this; its hand check had passed only on the dev stack, where Vite serves the page.

The user chose to keep the app's own files in the browser with a service worker. Their constraints:
- same-origin app files only (`index.html` and the hashed assets), never `/api`, `/auth`, `/sync`, `/setup` or any data;
- no outbound calls (CLAUDE.md rule 5);
- a new build replaces the old files cleanly, and an old cached app never runs against a new server for long (the "Surface was updated" banner, `CLIENT_OUTDATED`);
- a service worker needs a secure context (HTTPS, or `localhost`): a team serving Surface over plain `http://` on its network gets no offline reload. That limit is accepted.

## Options
1. **A hand-written service worker, built by Vite**, with the page and the build's asset list cached at install, network first for pages.
2. **A PWA plugin or Workbox** (`vite-plugin-pwa`). Less code of our own, but a new build and runtime dependency for about a hundred lines of logic, with defaults (runtime caching, update prompts) to switch off rather than on.
3. **HTTP caching only** (`index.html` cached for a while, `stale-while-revalidate`). No worker, but the browser still makes the request offline and gives up without an answer, and a deploy shows the old page for as long as it is cached.

## Decision
Option 1 (no new dependency).

- **Where:** the worker is `apps/web/src/offline/sw.ts`. Its rules (what it handles, what it answers) are a separate module of pure functions, unit-tested with a fake cache and fetch. A small Vite plugin in `apps/web` bundles the worker into one file, `dist/sw.js`, at the root (scope `/`), and writes into it the build id and the build's file list (`index.html` and every file under `assets/`). No worker in dev (`vite`), where Vite serves the files.
- **Registration:** `main.tsx` registers `/sw.js` in production builds when `navigator.serviceWorker` exists, which it does only in a secure context. Nothing else changes for a plain-HTTP origin.
- **Install:** fetch `index.html` and every listed asset into a cache named after the build id. The install fails, and the previous worker stays, if any file fails; the failed build's cache is deleted, so it is never kept in place of the previous build's.
- **What it answers** (everything else goes to the network untouched, so `/api`, `/auth`, `/sync`, `/files`, `/mcp`, `/setup`, health and metrics are never seen):
  - same-origin `GET /assets/*`: from the cache, else the network;
  - same-origin page navigations (`mode: 'navigate'`) outside the server's paths (`SERVER_PREFIXES`, matched as the server matches them) and `/setup`: **network first**, so online loads get what they get today (`no-cache`, the setup redirect, a new deploy). Navigation preload is on, so the request goes out while the worker starts rather than after. Only when the network fails, answers `5xx`, or doesn't answer within 10 s (as ADR-0018's "unreachable"), it answers with the cached `index.html`, which carries the headers it was served with (CSP included).
  - The cache is never filled from a navigation: the page and its assets are cached together, at install, so the cached page always matches the cached assets.
- **Updates:** the browser checks `/sw.js` on navigation; a new build has a new build id, so its worker installs, takes over at once (`skipWaiting`, `clients.claim`) and deletes all caches but its own and the one before it. Keeping the previous build's cache lets a tab still running the old build load its lazily imported chunks.
- **An old app against a new server:** a cached app starts only when the server doesn't answer. Once it answers, a schema change raises the existing outdated banner (SPEC-005 §8, `CLIENT_OUTDATED`); its Reload is a plain reload: it goes to the network first, so it gets the new build, and the browser checks `/sw.js` on that load, which installs the new worker. A build with the same schema keeps working until the next load, as an open tab does today.
- **Server (session A's):** `/sw.js` is served with `Cache-Control: no-cache`, like `index.html`. The CSP needs no change: `worker-src` falls back to `script-src 'self'`.

## Consequences
+ With the single image over HTTPS (or on `localhost`), a reload while offline or with the server stopped loads the app, and ADR-0018 opens the remembered session: SPEC-002 AC-6 holds after a reload.
+ No new dependency, no outbound call, and no data in the cache: only the files of one build (plus the previous one), which anyone can download from the server.
+ Online loads still come from the server first. With navigation preload, the request doesn't wait for the worker to start; without it (a browser that lacks it), a cold worker adds its start-up time to each full page load.
− A server that drops packets without refusing them costs up to 10 s before the cached page answers, then up to 10 s more for the app's own session check (ADR-0018): about 20 s before the shell. A browser that is offline fails at once.
− The worker's copy of the server's paths can drift from `SERVER_PREFIXES`, since the web app can't import the server; a shared list is session A's follow-up. Online loads are unaffected (network first); offline, a new server path would get the cached app.
− Over plain `http://` (other than `localhost`), browsers don't run service workers, so there is no offline reload. SPEC-004's deployment notes say so (session A).
− A cached app can be one build behind the server while offline, and for the first load after the server comes back if the schema didn't change. The outdated banner covers schema changes.
− The worker can't be tested in Node beyond its rules and the build step: installing, taking over and answering offline are checked by hand on the built image while e2e tests are held (plans README §6).
− Unregistering is part of any future removal: a worker stays installed in browsers until a new `/sw.js` replaces it (a worker that unregisters itself) or site data is cleared.
