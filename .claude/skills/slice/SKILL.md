---
name: slice
description: Implement one slice of an implementation plan end to end (read the plan and spec, build, test every AC, run the gate, record "As built").
argument-hint: <PLAN-NNN> <Sn>   e.g. PLAN-004 S3
disable-model-invocation: true
---

Implement slice **$1** of **$0**.

## 1. Understand before coding

1. Open `docs/07-plans/$0-*.md` and read the `### $1:` section, the plan's test plan table, and its "Risks & mitigations".
2. Read the "As built" notes of earlier slices in the same plan. They record deviations you must build on.
3. Read the spec sections the slice implements (linked at the top of the plan), plus any domain, permission or architecture docs it references.
4. Check the slice's dependencies (in the plan header and in `docs/07-plans/README.md`). If one isn't `✅ Done`, stop and report what's missing.
5. If the slice contradicts the spec, or the spec leaves a decision open that only the user can make, ask before coding. Otherwise pick the conservative option and record it.

## 2. Set up

- Run `git status`. The tree must be clean; if not, ask what to do with the changes.
- If you're on `main`, create the branch `p<plan number>-s<slice number>-<short-topic>`, e.g. `p004-s3-db`.
- Check that `node -v` is v24 and, if the slice needs a database, that `docker info` works.

## 3. Build

- Before writing code, post a short plan: the files to add or change, and the AC → test mapping.
- Implement in small steps. Write the tests for each AC alongside the code, and run the package tests often.
- Follow `CLAUDE.md` and the `.claude/rules/` that apply. Don't widen scope beyond the slice. Note follow-ups instead.

## 4. Verify

- Run `pnpm check` until it is green. Run `pnpm test:int` too if you touched database code.
- Exercise the real thing where it applies: boot the server, curl the endpoints, open the page.
- Never disable a lint rule, skip a test or loosen a boundary to get green. Fix the cause.

## 5. Record

- In the plan, add `· ✅ Done <today>` to the slice heading and an "As built" blockquote covering versions, structure, deviations, and notes for later slices.
- If behaviour or configuration changed, update the spec in the same change.

## 6. Report

Summarise what was built, each AC with the test that covers it, any deviations, exactly what you verified (commands and results), and the next slice. Don't commit: the user runs `/commit` when ready.
