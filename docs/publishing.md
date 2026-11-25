# Publishing Surface

Status: **§1, §2 and §4 done 2026-11-26 (pushed public); §3 settings with the owner** · Date: 2026-11-25 · Related: [ADR-0026](04-architecture/adr/0026-open-source-mit.md) (MIT), [PLAN-017](07-plans/PLAN-017-brand-open-source.md) S4, [SECURITY.md](../SECURITY.md)

Run this checklist on the day the repository goes public. Nothing in it has run yet: the repository has no remote. Tick each box, then record the date and the commit at the end.

**2026-11-26:** the user created `github.com/S-Ayush/surface` as a **public** repository with a GitHub-made "Initial commit" (an MIT `LICENSE` naming the owner), and chose to push public at once rather than private first. `main` (`ff44d55`) replaced that commit with one force push, guarded by a lease on its hash and approved by the user; `main` is never force-pushed again. The copyright line stays "The Surface contributors". The push runs as the collaborator account `cw-ashrivastav`. The §3 settings need the owner account. See the [coordination log](07-plans/sessions/p017-coordination.md).

## The user's decisions (2026-11-25)

| Question | Decision |
| --- | --- |
| Licence | MIT ([ADR-0026](04-architecture/adr/0026-open-source-mit.md)) |
| History | Publish the **full history as it is**. Every commit carries the author's own name and email, and the user accepts that. |
| Internal material | Publish it: the plans and their session logs (`docs/07-plans/sessions/`, including local `/Users/…` paths), the review notes, and the agent setup in `.claude/` (rules, skills, hooks, the `slice-reviewer` agent). `.claude/settings.local.json`, `CLAUDE.local.md` and `.claude/worktrees/` stay out (`.gitignore`). |
| Home | `github.com/s-ayush/surface`. The README, the compose files and the Dockerfile already name it and `ghcr.io/s-ayush/surface`. |

## 1. Before you push

- [ ] `main` is green: `pnpm check` (it includes `licenses:check`).
- [ ] The working tree is clean (`git status --short` prints nothing), and no stray branches are left that you don't mean to publish (`git branch`).
- [ ] Scan the full history for secrets again. The 2026-11-25 scan found none (see [the coordination log](07-plans/sessions/p017-coordination.md)). With Docker running, gitleaks prints findings with their values redacted:

  ```sh
  docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.21.2 git /repo --redact -v
  ```

  Expect hits only in test fixtures and documented examples (`seed.ts`, `*-routes.test.ts`, `smtp://user:…@host` in `config.ts` and `docker/.env.example`), plus `apps/server/dev.env`, whose `SESSION_SECRET` is 64 zeros. **A real secret stops the publish.** Rotate it first, then decide how to remove it from the history.

## 2. Create the repository and push

- [ ] On GitHub, create `s-ayush/surface` as **private** and **empty**: no README, licence or `.gitignore`, because the repository has its own.
- [ ] Push `main` and any tags:

  ```sh
  git remote add origin git@github.com:s-ayush/surface.git
  git push -u origin main
  git push origin --tags
  ```

- [ ] Wait for the first **CI** run on `main` to pass: static, unit and build, the deep tier, and the Docker image build. It is the first run on Linux. If it fails, fix it on a branch before going public.

## 3. Settings, while still private

- [ ] **Security → Private vulnerability reporting: on.** `SECURITY.md` and `CODE_OF_CONDUCT.md` send reports there, so turn it on before the repository is public.
- [ ] **Rules for `main`:** require a pull request, require the CI checks "Static, unit and build", "Docker image builds" and "PR title is a Conventional Commit", and block force pushes and deletion. CLAUDE.md already says never to force-push `main`.
- [ ] **About:**
  - Description: "The only open-source issue tracker your team needs."
  - Topics: `issue-tracker`, `self-hosted`, `local-first`, `keyboard-first`, `project-management`, `typescript`.
  - Uncheck Releases and Packages until the first release.
- [ ] **Features:** keep Issues on, for bug reports from outside. Turn Wiki off, because the docs live in `docs/`.
- [ ] **Actions → General:** set workflow permissions to "Read repository contents". CI publishes nothing.

## 4. Go public

- [ ] **Settings → Change visibility → Public.**
- [ ] GitHub shows "MIT license" in the sidebar.
- [ ] The README lockup renders, the dark version included (switch the GitHub theme), and the links to `docs/`, `LICENSE`, `CONTRIBUTING.md` and `SECURITY.md` open.
- [ ] The README says there is no published image yet, so its install step 2 builds from source. Publishing images to `ghcr.io/s-ayush/surface` comes with the first release, and is not part of this checklist.

## 5. Record it

- [ ] Add a row to the [PLAN-017 coordination log](07-plans/sessions/p017-coordination.md) with the date, the commit pushed, and the scan result.
