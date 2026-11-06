# Surface

Self-hosted, keyboard-first issue tracker inspired by Linear, for small teams (10–50 people, no hard cap).
It is an internal tool: one Docker image + PostgreSQL, no commercial edition, no multi-tenancy, no telemetry.
Speed comes from a local-first sync engine: the client holds a replica of workspace metadata and renders from it.

## Where the truth lives

Read the relevant docs **before** changing code. Precedence when they disagree: accepted spec → plan → code.

| Need                                                                  | Read                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Build order, what is done, what is next                               | `docs/07-plans/README.md`, then the `PLAN-NNN` file ("✅ Done" + "As built" notes per slice) |
| What a feature must do (acceptance criteria `AC-n`, edge cases `E-n`) | `docs/06-specs/SPEC-NNN-*.md`                                                                |
| Entities, invariants `INV-nn`, state machines, permissions, events    | `docs/03-domain/`                                                                            |
| Architecture, stack, sync protocol, MCP                               | `docs/04-architecture/` (+ `adr/` for decisions)                                             |
| UI tokens, components, shortcuts, command menu                        | `docs/05-design/`                                                                            |
| Scope (v1 / Later / Never) and NFR budgets                            | `docs/02-product/PRD.md`, `docs/01-vision/VISION.md`                                         |
| Process, templates, milestones                                        | `docs/METHODOLOGY.md`                                                                        |

If the code you need to write would contradict a spec, **stop and say so**. Fix the spec (and add an ADR if a decision changes) in the same change. Never silently diverge. Accepted ADRs are never edited: supersede them with a new ADR.

## Environment

- **Node 24** via nvm (`.nvmrc`). The machine's default Node is 23, so run `source ~/.nvm/nvm.sh && nvm use` first if `node -v` is not v24.
- **pnpm 10** (pinned in `packageManager`). Never use npm or yarn in this repo.
- **Docker** comes from Colima. If `docker info` fails, run `colima start`. Integration tests and compose need it.

## Commands

| Command                                 | What it does                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                            | The full gate: build → lint (ESLint + dependency-cruiser + Prettier) → typecheck → unit tests. Run it before saying work is done. |
| `pnpm test` / `pnpm test:int`           | Unit tests / integration tests (`*.int.test.ts`, real Postgres)                                                                   |
| `pnpm --filter @surface/<pkg> <script>` | Run a script in one package (e.g. `pnpm --filter @surface/server test`)                                                           |
| `pnpm lint:deps`                        | Package boundary check only                                                                                                       |
| `pnpm format`                           | Prettier write                                                                                                                    |
| `pnpm --filter @surface/server dev`     | Server in watch mode (uses `apps/server/dev.env`)                                                                                 |

## Repository layout and boundaries

```
apps/server   Fastify: HTTP API, sync hub, MCP, auth, jobs (Node)
apps/web      React 19 SPA (Vite), served by the server
packages/domain         entity types, enums, invariants, filter engine (no deps)
packages/operations     operation definitions shared by client and server (→ domain)
packages/sync-protocol  wire types + codecs (→ domain)
packages/sync-client    client store, IndexedDB, mutation queue (→ domain, operations, sync-protocol)
packages/ui, editor     design system / rich text (→ domain)
packages/config         shared tsconfig, ESLint, Prettier, Vitest presets
```

- Boundaries are enforced by `.dependency-cruiser.cjs`. The server never imports `ui`, `sync-client` or `apps/web`, and packages never import apps. Don't weaken a rule to make an import pass. Move the code instead.
- Packages export TypeScript source under the `@surface/source` condition. Only server-runtime packages build to `dist/`. Adding a workspace dependency means adding it to that package's `package.json` (`"workspace:*"`).

## Architecture rules that must never be broken

1. **Every state change is an operation.** Operations are defined once in `packages/operations` (`defineOperation`) and run through the server executor. This applies to the web client, the HTTP API and MCP alike: no side-channel writes and no ad-hoc REST mutations.
2. **Only the repo layer writes synced tables** (`apps/server/src/sync/repo.ts`). It records `sync_log` rows in the same transaction. Writing a synced table any other way silently breaks sync.
3. **The server is authoritative.** The client writes base state only from server data. Optimistic changes live in the overlay.
4. **Private teams never leak.** Every query and delta is filtered by sync groups (`sync_groups && actorGroups`). Invisible rows are `NOT_FOUND`, never `FORBIDDEN`. See `docs/03-domain/permissions.md` §5 for the leak checklist that tests must cover.
5. **No outbound network calls** except to the user's own SMTP server. That rules out telemetry, update checks, CDNs, external fonts and remote scripts.
6. **Secrets never reach logs or error messages.** Logging goes through pino with redaction (`apps/server/src/logger.ts`), and nothing uses `console.*`.
7. **Configuration only comes from `loadConfig()`** (`apps/server/src/config.ts`). Nothing else reads `process.env`. A new variable needs the Zod schema, its tests, `.env.example` and the SPEC-004 §7 table.

## Out of scope: do not build or scaffold

SSO/SAML, guests, sub-teams, built-in AI or AI agents, third-party integrations (GitHub/Slack/Teams), a commercial/cloud edition, multi-tenancy, and telemetry. If a task seems to need one of these, ask first.

## Code conventions

- TypeScript strict with `noUncheckedIndexedAccess`. ESM with explicit `.js` extensions in relative imports. Use `import type` for types.
- Validate with Zod at every boundary (env, HTTP input, wire messages, operation input/output). Inside those boundaries, trust the types.
- No `any`, no `as` casts in operation definitions or handlers, and no non-null `!` on data from outside. Prefer type guards and narrowing.
- HTTP errors use the SPEC-003 shape `{ ok: false, error: { code, message, correlationId } }`. 5xx responses never expose internals.
- Error and UI messages are short, specific, and say how to fix the problem, in sentence case ("Team key must be 2–5 letters, like ENG").
- Comments explain _why_ and point to the spec (`// SPEC-002 §4.3`), not _what_.
- Don't add dependencies casually. Prefer the platform and what is already installed, and justify anything new in the change summary.

## Testing

- **Every acceptance criterion has a named test.** The mapping lives in the plan's test plan table. Name tests after behaviour, not implementation.
- **File naming:** `*.test.ts` for unit tests (no Docker), `*.int.test.ts` for tests that need Postgres (Testcontainers locally, a service container in CI). E2E tests live in `e2e/` (Playwright).
- **Sync and permission logic** gets property tests (fast-check) and leak tests, not just examples.
- **No real sleeps** to wait for conditions. Await events, poll with a deadline, or use fake timers.
- **Fixing a bug starts with a test** that fails without the fix.

## Workflow

- **Work happens in plan slices.** Each slice is one branch and one PR, independently mergeable with a green `pnpm check`. Branch names follow `p<plan>-s<slice>-<topic>`, e.g. `p004-s3-db`.
- **When a slice is finished:**
  - mark it `✅ Done <date>` in its plan, with an "As built" note recording versions, deviations and anything a later slice needs to know;
  - update the spec if behaviour or configuration changed.
- **Parallel sessions:** M0 runs as four sessions in separate git worktrees (`docs/07-plans/sessions/`). If you were started as one of them, follow its file: edit only what it owns, log each slice there, and use handoffs for anything else.
- **Commits** follow Conventional Commits (`feat(server): …`, `chore: …`, `docs: …`). Commit only when asked. Never `--no-verify`, never force-push `main`.
- **Report honestly:** say what was verified (tests run, commands executed) and what wasn't. If a check fails, show it. Don't claim it passes.

## Project commands (`.claude/skills/`)

`/status` (where are we) · `/slice PLAN-NNN Sn` (implement a slice end to end) · `/check` (run and fix the gate) · `/review` (independent review via the `slice-reviewer` agent) · `/commit` (commit by the conventions above) · `/spec <area>` (draft a spec) · `/adr <title>` (record a decision). Path-scoped rules in `.claude/rules/` load automatically for the files you touch.
