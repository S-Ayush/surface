---
name: commit
description: Commit the current work using the project's branch and Conventional Commits rules, after checking the gate is green.
argument-hint: [optional message hint]
disable-model-invocation: true
---

The user asked to commit. Hint (may be empty): $ARGUMENTS

1. Run `git status` and `git diff` (staged and unstaged) to see exactly what will be committed. Check it all belongs together. Never commit `.env*` files (except `.env.example`), `dist/`, `node_modules/` or local scratch files. Look at anything unexpected before staging it.
2. If you're on `main`, create the slice branch first (`p<plan>-s<slice>-<topic>`).
3. Run `pnpm check`. If it fails, stop and report. Don't commit red work unless the user explicitly says to.
4. If the changes span more than one slice or concern, make separate commits per slice or concern, each of which builds on its own.
5. Write each message as a Conventional Commit:
   - Subject: `type(scope): imperative summary` (≤ 72 chars). Types: feat, fix, chore, docs, test, refactor, perf, build, ci. Scopes are package or app names (`server`, `web`, `domain`, `sync-client`, ...). Mention the plan slice in the subject when there is one, e.g. `(PLAN-004 S3)`.
   - Body: what changed and why, as short bullets, including any deviations from the spec.
   - End with the attribution trailer your environment specifies, if any.
6. Never use `--no-verify`, never amend commits that are already pushed, and don't push unless the user asks.
7. Report the commit hashes, their subjects, and the branch.
