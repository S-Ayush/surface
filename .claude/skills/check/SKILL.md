---
name: check
description: Run the full quality gate (build, lint, boundaries, format, typecheck, tests, and integration tests when Docker is up) and fix what fails.
disable-model-invocation: true
---

1. Run `pnpm check`. If `docker info` succeeds and the repo has `*.int.test.ts` files, also run `pnpm test:int`.
2. For each failure, find the root cause and fix it properly:
   - Lint or type errors: fix the code. Don't add `eslint-disable`, `@ts-ignore`, `as any` or casts to silence them.
   - Boundary violations (dependency-cruiser): move the code to the right package. Never relax a rule in `.dependency-cruiser.cjs`.
   - Formatting: run `pnpm format`.
   - Test failures: decide whether the code or the expectation is wrong, and fix that one. Never skip or delete a test to get green.
3. Re-run until everything passes, or until a failure needs a decision from the user.
4. Report what failed, what you changed for each failure, and the final result of each command.
