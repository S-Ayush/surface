# ADR-0016: Where the sync simulation harness lives

Status: **Accepted** (chosen by the user, 2026-11-07) · Date: 2026-11-07

## Context
PLAN-002 S9 asks for property tests of the whole sync engine: several real `sync-client` stores on fake-indexeddb, the real server (executor and Postgres), and a controllable network between them (SPEC-002 AC-2 convergence, AC-3 exactly-once). The plan put the harness in `packages/sync-client/test/sim/`.

The package boundaries forbid that in both directions (`.dependency-cruiser.cjs`): packages never import `apps/`, so `sync-client` cannot load the server, and the server never imports `sync-client`. CLAUDE.md says not to weaken a rule to make an import pass. Also, `apps/server` exports nothing today (no exports map).

## Options
1. **A new private workspace package, `tests/sync-sim`** (`@surface/sync-sim`). It imports both sides. Nothing imports it.
2. **Keep the harness in `sync-client`** against its in-process fake hub, and test the server separately in `apps/server`. No new package, but AC-2 and AC-3 would prove the client against a fake: a mismatch between client and server could pass both halves.

## Decision
Option 1.

- `pnpm-workspace.yaml` adds `tests/*`; `pnpm lint:deps` scans `tests/` too.
- Two additive dependency-cruiser rules:
  - `nothing-imports-tests`: nothing outside `tests/` may import from it.
  - `test-doubles-only-in-tests`: `@surface/sync-client/testing` (sync-client's fake hub and storage, exported from `test/support/testing.ts`) may be imported only by sync-client's own tests and by `tests/`. App and package code never sees it.
- No existing rule changes: `tests/` is outside `apps/` and `packages/`, so the rules for those still hold as written.
- The server side sits behind an interface (`SimServer`). The first adapter wraps the fake hub, so the harness and both properties run now. Once PLAN-002 S5 is on `main`, a second adapter starts the real server in-process against a test database; it needs a narrow test entry exported by `apps/server` (handoff to session A). Tests that use it need Postgres and are named `*.int.test.ts`.

## Consequences
+ The properties exercise real code on both sides of the wire once the real adapter lands, which is what AC-2 and AC-3 are for.
+ The boundaries between apps and packages stay exactly as strict as before.
+ The fake-hub adapter keeps a fast, Docker-free run of both properties in every `pnpm test`.
− One more workspace package to maintain, and one exported test entry in `sync-client` (guarded by the rule above).
− `apps/server` must export a test entry for `tests/` to start it in-process. It is test-only, but it is still a surface to keep stable.
− The simulated browser is in-process: a tab "crashes" at a storage-call boundary (between IndexedDB transactions), never inside one, and its dead store object is frozen rather than gone. A failure that needs a torn IndexedDB transaction is out of reach, as it is for a real browser, which commits a transaction atomically.
