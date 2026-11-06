---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - '**/test/**'
  - 'e2e/**'
---

# Tests

- **Kinds:**
  - `*.test.ts(x)` are unit tests: no Docker or network, fast, run by `pnpm test`.
  - `*.int.test.ts` need Postgres: run by `pnpm test:int` with Testcontainers locally (Docker via Colima) or a CI service container. Each file gets its own database.
  - `e2e/` holds Playwright tests against the built app or the compose stack. **On hold** (`docs/07-plans/README.md` §6): don't write e2e, perf, smoke or new `*.int.test.ts` tests for now; plan rows marked ⏸ stay unwritten. Exceptions, still written: the sync property suite and private-team leak tests. Keep and run the existing integration tests when you change code they cover.
- **Acceptance criteria:** each spec AC maps to a named test in the plan's test plan table. When you add the test, use that file name. If you can't, update the table.
- **Behaviour first:** assert observable behaviour (HTTP status and body, emitted rows, rendered text), not private internals. Name tests as a sentence about behaviour.
- **Determinism:**
  - No real `sleep` to wait for something. Await the event, poll with a deadline, or use fake timers. Short sleeps are acceptable only to _create_ a race on purpose.
  - Property tests (fast-check) use fixed seeds in CI and print the failing seed.
- **Security checks are tests too:** redaction (secrets absent from logs and errors), enumeration and timing for auth, and the private-team leak checklist (`docs/03-domain/permissions.md` §5).
- **Helpers:** reuse `test/helpers.ts`, e.g. `testApp()`, `testConfig()` and `captureLogs()` in the server. Extend those helpers rather than duplicating setup.
- **Don't weaken tests to go green.** A failing test is a bug or a wrong expectation: find out which, and say which in the summary.
