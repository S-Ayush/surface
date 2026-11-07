# ADR-0018: Opening the app while the server can't be reached

Status: **Accepted** (chosen by the user, 2026-11-07) · Date: 2026-11-07

## Context
SPEC-002 AC-6 and the M0 demo (plans README §5) require that an offline change survive a reload made while still offline: the rename shows from the IndexedDB replica, and it reaches the server once the connection returns.

The web app couldn't do that. Before it opens the replica, it asks the server who is signed in (`GET /auth/capabilities`, then `GET /auth/session`; SPEC-001 Q9), because the replica is opened for a user and a workspace (SPEC-002 §5). With the server unreachable, both requests fail, and the app showed "Surface can't reach the server" (SPEC-005 §3) instead of the shell. The replica and the queued rename were on the device, but nothing opened them. PLAN-005 S8 found this while running the M0 demo by hand.

That run used the dev stack, where Vite serves the page and only the API was stopped. In the single image (SPEC-004) the server serves the page too: `index.html` is sent `no-cache` and nothing caches it in the browser (no service worker), so a reload while the browser is offline, or while the server is stopped, fails on the page itself, before any of the app's code runs. Making that reload work needs the app cached in the browser, a separate decision (see Consequences). This ADR covers the step after the page has loaded.

## Options
1. **Remember the last session on this device.** After each successful check, keep the session's ids (`userId`, `workspaceId`) and the SMTP capability in `localStorage`. Forget them on logout and whenever the server says nobody is signed in. If the server can't be reached at startup and a session is remembered, open the shell with that session's replica, marked offline, and check the session again once the server answers.
2. **A separate slice later.** Keep the error page in M0 and record AC-6 as not met.
3. **Keep the error page for good.** Treat "offline reload" as reloading a tab that is already open, which a browser can't do without the server.

## Decision
Option 1, built in PLAN-005 S8 (`apps/web/src/app/auth.ts`).

- **Unreachable** means a network error, a `5xx` status (`503 SETUP_REQUIRED` on `/auth/session` excepted: that one is an answer), or no answer within 10 s. Any other answer is used as it is: a `401` means nobody is signed in, and an unexpected `4xx` still shows the error page.
- **What is kept:** `{ session: { userId, workspaceId }, smtp }` under `surface.last-session`, validated with Zod on read. No token, cookie or name. Storage that throws (private modes, blocked site data) behaves as if nothing were kept.
- **Opening offline:** the auth state is ready with the remembered session, `setupComplete: true` (a session exists only after setup), and `offline: true`. The shell opens the replica as on any start (SPEC-002 §5), and the sync store shows its own banners.
- **Checking again:** after 2 s, 5 s, 10 s, then every 30 s, cut short by the browser's `online` event, the app asks for the session again until the server answers:
  - the same session: kept, under the same epoch, so the shell keeps its store and the queue flushes;
  - nobody signed in: signed out, keeping `next` (as a revoked session does);
  - another session (someone signed in from another tab meanwhile): opened under a new epoch, which replaces the store.
- Without a remembered session, an unreachable server still shows the error page. So does an answer to a later check that is wrong rather than missing (a `4xx` other than `401`), as a reload would.
- After a sync socket's `4001` or a request's `401` (SPEC-001 Q11), the session check that follows keeps the session when the server can't be reached, instead of signing out: the next `4001` or `401` asks again.

## Consequences
+ When the page loads but the server can't answer for the session (the API stopped behind a separately served page, as on the dev stack; the database down, so `/auth/*` answers `5xx`; the server not ready, `503`; or no answer within 10 s), the shell, the replica and the queued changes come back, and the changes sync once the server answers (checked by hand on the dev stack in PLAN-005 S8).
− **It doesn't make SPEC-002 AC-6 hold for the single image.** A reload while the browser is offline or the server is stopped never loads the page (Context). That needs the app cached in the browser, for example by a service worker (PRD Q6 has an installable app as a Could), which touches SPEC-004 (static serving, CSP) and needs its own ADR. The user chose a service worker for the app's own files (2026-11-07), in a later slice.
+ No server, protocol or spec change outside the web app. The server stays authoritative: it authenticates every request by its cookie, and a revoked session is signed out on the first answer.
− The app doesn't wait for that answer before it syncs: the sync client reconnects on its own schedule and sends the queued changes as soon as its socket opens. If the browser's cookie now belongs to another user (they signed in from another tab while this one was offline), the remembered user's changes are sent as that user, and that user's deltas reach the remembered user's replica, until the check replaces the store. Any tab whose socket is down when the cookie changes has the same gap; an identity check when the socket connects would close both (a follow-up for the sync engine, in session-c2's Handoffs).
− The device reveals which user last signed in until they log out or the server says the session ended. That is no more than the IndexedDB replica (SPEC-002 §5) already keeps, under the same origin, and much less.
− A session revoked while the device was offline still opens offline until the server answers. Again, the replica was already readable on that device.
− If storage can't be written, the remembered session is removed rather than left for someone else, so that device needs the server to load again.
− Logging out while offline fails as before (the server can't end the session), so the remembered session stays until the server is reachable. A follow-up may forget it locally and end the session later.
