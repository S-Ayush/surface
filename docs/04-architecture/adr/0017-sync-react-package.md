# ADR-0017: Where the sync inspector and UI hooks live

Status: **Accepted** (chosen by the user, 2026-11-07) · Date: 2026-11-07

## Context
PLAN-002 S10 adds the sync inspector panel (SPEC-002 §5.4) and the UI hooks PLAN-005 consumes: `useConnectionState()`, `usePendingCount()`, `useBootstrapProgress()`, and the conditions behind the system banners (SPEC-005 §8). SPEC-002 §5.1 put the panel in `packages/sync-client/inspector/`.

The boundaries forbid that (`.dependency-cruiser.cjs`): `sync-client` is headless (`sync-client-no-ui`), so it cannot import React or `@surface/ui`. And `ui` may import only `domain` (`ui-and-editor-only-domain`), so the panel cannot live there either. CLAUDE.md says not to weaken a rule to make an import pass.

React state must also stay consistent with the store's MobX observables. The usual bridge is `mobx-react-lite`, a new dependency.

## Options
1. **A new package, `@surface/sync-react`.** It depends on `sync-client` and `ui`, and holds the hooks and the panel. `sync-client` gains framework-free adapters (`subscribe(listener)` and `getSnapshot()`, built on MobX `reaction`), and the hooks wrap them with React's `useSyncExternalStore`.
2. **Put the hooks and the panel in `apps/web`.** No new package, but the hooks are not reusable or testable outside the app, and session C's app code would own sync internals.
3. **Option 1 with `mobx-react-lite`** instead of the adapters: one more dependency, and the hooks' behaviour would be tested only through React.

## Decision
Option 1.

- `packages/sync-react` (`@surface/sync-react`): React hooks, a `SyncStoreProvider`, and the `<SyncInspector>` panel built from `@surface/ui` primitives. React is a peer dependency, as in `ui`.
- `sync-client` exports `observe(read)`, which turns any read of the store into a `subscribe`/`getSnapshot` pair with a stable snapshot, plus selectors for the hooks and the inspector. These are tested in Node with the rest of the package.
- Two additive dependency-cruiser rules:
  - `sync-react-deps`: `sync-react` may import only `sync-client`, `domain` and `ui`.
  - `server-no-sync-react`: the server never imports it.
  No existing rule changes. `sync-client-no-ui` and `ui-and-editor-only-domain` already keep both of those packages from importing it.
- Whether the panel shows (dev builds, or `?debug=sync` for Admins) is decided by `inspectorAllowed()` in `sync-react`. The app mounts the panel.

## Consequences
+ `sync-client` stays headless, and its adapters are tested without a DOM.
+ No new third-party dependency.
+ PLAN-005 consumes the hooks from one place; the app only mounts the panel and shows the banners.
− One more workspace package to maintain.
− The hooks themselves and the panel are tested only as server-rendered markup in Node: rendering after a change, and clicks, need a browser, which waits for the e2e hold to lift (`docs/07-plans/README.md` §6).
