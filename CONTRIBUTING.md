# Contributing to Surface

Thank you for helping. Surface is a small, opinionated tool, so a short read of this page saves
you a rejected pull request.

## Licence of contributions

Surface is MIT-licensed ([ADR-0026](docs/04-architecture/adr/0026-open-source-mit.md)). By opening a
pull request you agree that your contribution is released under the same licence. There is no
contributor licence agreement.

## Scope

Surface is for one company per install. Read the [vision](docs/01-vision/VISION.md) (principles and
non-goals) and the [PRD](docs/02-product/PRD.md) (what is in v1, Later and Never) before proposing a
feature.

Out of scope, so a pull request for any of these will be closed:

- SSO, SAML, OIDC or SCIM
- guest accounts
- sub-teams
- built-in AI or AI agents
- third-party integrations (GitHub, Slack, Teams)
- a commercial or cloud edition, billing, plans or feature gating
- multi-tenancy
- telemetry, update checks, or any outbound network call except to your own SMTP server

If you are unsure, open an issue first and ask.

## Specs first

Work follows spec, then plan, then code ([METHODOLOGY](docs/METHODOLOGY.md)):

- A feature has a spec in [`docs/06-specs/`](docs/06-specs/) with numbered acceptance criteria
  (`AC-n`) and edge cases (`E-n`).
- The build order and slices live in [`docs/07-plans/`](docs/07-plans/README.md).
- If your code would contradict a spec, change the spec in the same pull request. If a decision
  changes, add an ADR in [`docs/04-architecture/adr/`](docs/04-architecture/adr/README.md). Never edit
  an accepted ADR: supersede it with a new one.

## Setup

You need Node 24 (`nvm use`), pnpm 10 and Docker. Use pnpm only, never npm or yarn.

```sh
pnpm install
pnpm dev
```

## Workflow

Work happens in slices from a plan. Each slice is one branch and one pull request that can merge on
its own.

- **Branch names:** `p<plan>-s<slice>-<topic>`, for example `p004-s3-db`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), for example
  `feat(server): add the label filter`. Never skip the hooks (`--no-verify`).
- **Gate:** `pnpm check` must be green before you ask for review. It runs build, lint (ESLint,
  dependency-cruiser, Stylelint, Prettier), the licence check, typecheck and unit tests.
  `pnpm check:fast` is quicker while you iterate.
- **Finishing a slice:** mark it done in its plan with an "As built" note, and update the spec if
  behaviour or configuration changed.

## Rules the code must follow

The full list is in [CLAUDE.md](CLAUDE.md) (it is written for coding agents, and it applies to
people too). The ones that matter most:

1. Every state change is an operation, defined once in `packages/operations`. No side-channel writes.
2. Only the repo layer writes synced tables.
3. The server is authoritative. The client writes base state only from server data.
4. Private teams never leak. Invisible rows are `NOT_FOUND`, never `FORBIDDEN`.
5. No outbound network calls except to your own SMTP server.
6. Secrets never reach logs or error messages.
7. Configuration only comes from `loadConfig()`.

## Tests

- Every acceptance criterion has a named test. Name tests after behaviour, not implementation.
- `*.test.ts` are unit tests and need no Docker. `*.int.test.ts` need PostgreSQL.
- Unit tests never call the network. Use fakes.
- Sync and permission logic gets property tests (fast-check) and leak tests, not only examples.
- No real sleeps to wait for a condition. Await events, poll with a deadline, or use fake timers.
- A bug fix starts with a test that fails without the fix.
- While the testing hold in the [plans README §6](docs/07-plans/README.md) is in force, do not add
  tests that need a browser, a running stack or PostgreSQL, apart from the private-team leak tests.

## Code style

TypeScript strict, ESM with explicit `.js` extensions in relative imports. Validate with Zod at
every boundary. No `any`, and no `as` casts in operation definitions or handlers. Comments explain
why and point to the spec. Messages are short, specific, in sentence case, and say how to fix the
problem. Do not add a dependency without a reason, and its licence must pass `pnpm licenses:check`.

## Reporting problems

For a bug or idea, open an issue. For a security problem, do not open an issue: follow
[SECURITY.md](SECURITY.md).
