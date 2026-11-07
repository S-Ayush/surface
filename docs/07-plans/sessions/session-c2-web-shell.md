# Session C, phase 2: Web app shell

Worktree: `/Users/admin/Desktop/Learning/surface-c` · First branch: `p005-s5-shortcuts` · Guide: [README](README.md) §7 · Phase 1 log: [session-c-design-system.md](session-c-design-system.md)

Assigned 2026-11-07. Session C built the design system in phase 1. Phase 2 turns `apps/web` from a placeholder into the keyboard-first app shell.

## Setup

The phase 1 worktree was removed, so create it again:

```bash
cd /Users/admin/Desktop/Learning/surface
git worktree add ../surface-c -b p005-s5-shortcuts main
cd ../surface-c && source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
claude
```

## Scope, in order

Read [PLAN-005](../PLAN-005-app-shell-command-menu-shortcuts.md) S4–S8, [SPEC-005](../../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md), [shortcuts.md](../../05-design/shortcuts.md), [command-menu.md](../../05-design/command-menu.md) and the PLAN-002 S6–S8 "As built" notes (the client store you render from).

1. **PLAN-005 S5: shortcut engine and help overlay.** It has no dependencies and starts now.
   - First, as a small separate commit: turn off Zod's `eval` probe with `z.config({ jitless: true })`. Put it in a module of its own, imported first in `apps/web/src/main.tsx`. This was session A's PLAN-004 S9 handoff: under the CSP the probe reports a violation on every load.
2. **PLAN-005 S6: command menu.**
   - Registry operations and the client store are on `main`.
   - Until PLAN-001 models land (session E, S1 and S8), build and test against the `debug.*` models.
   - Add live teams as a source when they exist.
3. **PLAN-005 S4: shell layout and routing.**
   - Starts when session A's PLAN-001 S3 (auth) and session E's PLAN-001 S1 (models) are on `main`.
   - Route guards: setup, auth, store-ready, admin.
   - Register `PRODUCTION_MODELS` (`@surface/domain/model`) in the web client's store, so its schema hash matches the server's (session E handoff).
4. **PLAN-005 S7: preferences, banners, screen restyle.**
   - Needs session D's PLAN-002 S10 UI hooks (`useConnectionState`, `usePendingCount`, `onRejected`, `onOutdated`).
   - Needs the `UserPreferences` model from E's PLAN-001 S1 (on `main`): its own row, id = the user's id, `values` json, synced to `user:<id>`. `user.updatePreferences` shapes `values` (session E handoff).
   - You own the `user.updatePreferences` operation and its handler.
5. **PLAN-005 S8: accessibility and polish.**
   - The keyboard-only demo e2e is held: run the demo by hand and record it in "As built".
   - The axe sweep over Storybook still runs.

## Owns

- `apps/web/**`, except the feature folders session E adds for its PLAN-001 screens (`apps/web/src/features/{teams,account,invites,members}/**`) once your S4 shell is on `main`
- `packages/ui/**`, `packages/editor/**`
- The `user.updatePreferences` operation and handler
- PLAN-005 S4–S8 sections; SPEC-005 changes (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

- `apps/server/**`, except your preferences handler
- `packages/sync-client/**` and `packages/sync-protocol/**`: you consume D's hooks; ask D for changes
- Migrations: ask session E (preferences need none: the `UserPreferences` model already exists)
- `CLAUDE.md`, `.claude/**`

## Notes

- **Ports:** dev server 5174, Storybook 6006. Stop any other Storybook on 6006 first.
- **The web app renders from the store** (CLAUDE.md, architecture rule 3). It never fetches and writes base state itself, and every change is a dispatched operation.
- **Keyboard first:** every action reachable from a shortcut or `Mod+K` (SPEC-005).

## Handoffs (requests from C to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| E | **Command-menu entries for your operations** (PLAN-005 S6, `3d16aba`; first needed for PLAN-001 S9's "Create team", "Invite member…", "Rename team…", "Join team…"). **Where:** `apps/web/src/features/<feature>/commands.ts` exporting e.g. `TEAM_COMMANDS: Readonly<Record<string, OperationCommand>>` keyed by operation name (`OperationCommand` from `apps/web/src/command-menu/sources/operations.ts`), plus one spread line in `apps/web/src/features/commands.ts` (shared, append-only, README §7; you may create `features/<feature>/commands.ts` before PLAN-005 S4). **Entry:** exactly one of `opens: CommandId` (your form's command, registered with `useCommand` while the form's host is mounted; the command is hidden until then), `run: (ctx, op) => …` (dispatch directly) or `page: (ctx, op) => CommandPage` (a picker page, e.g. `colorPage`); `refs: (ctx) => ({ team: { id: … } })` whenever `ui.contexts` names an entity (read the id from `ctx.target.ids[0]` when `ctx.target.kind === 'team'`); optional `section` (default `create` for `*.create`, else `settings`). **Rules** (`checkOperationCommands`, run by `apps/web/test/command-operations.test.ts`, so your `pnpm check` fails until they hold): every operation with `ui` has an entry and no entry is stale; entity-scoped entries give `refs`; a `ui.shortcut` must be bound in `apps/web/src/shortcuts/registry.ts` (or set it to `null`); a user with every permission is offered the command in its first context. **Permissions:** the menu's pre-check runs without the operation's input, so check the role before reading input (`p.admin() && input.ids.length > 0`, not the reverse), or Members are offered a command the server then refuses (SPEC-005 AC-2 note). **From C:** `apps/web/src/commands/catalog.ts` (command ids for `opens`) and `shortcuts/registry.ts` are mine: list the form command ids and any shortcuts you need here or in your file, and I add them. | Blocks E only when an operation gets `ui` metadata (the test names what is missing). | open |
| E | **Re your handoff to C** (`UserPreferences`, `PRODUCTION_MODELS`, hue test): done on `p005-s6-command-menu` (`3d16aba`). `packages/ui/test/label-hues.test.ts` keeps `LABEL_HUES` equal to `COLOR_HUES` (`@surface/domain` is a ui dev dependency); PLAN-005 §3 and S7 now use the `UserPreferences` model (no S7 migration); registering `PRODUCTION_MODELS` is a PLAN-005 S4 bullet, as the web app has no store until the shell creates it. Please mark your row done once S6 is on `main`. | Information only. | open |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-07 | Zod jitless (PLAN-004 S9 handoff from A) | p005-s5-shortcuts | built | `apps/web/src/zod-config.ts` imported first in `main.tsx`; `zod` added to `apps/web` (already in the lockfile). Unit-tested; not checked on a CSP-served build. Separate commit. |
| 2026-11-07 | PLAN-005 S5 | p005-s5-shortcuts | built | Shortcut engine, registry, conflict check, `?` help, command handler registry (`apps/web/src/{shortcuts,commands,theme}`). SPEC-005 §5 gains "overlay capture" and E3 is refined (Alt/Ctrl letters by `event.code`, non-Latin fallback); shortcuts.md rules 2 and 5 and an `F8` row updated. `pnpm check` green (web 97 tests); checked by hand in Chromium. Waiting for /review and /commit. |
| 2026-11-07 | PLAN-005 S5 review | p005-s5-shortcuts | fixed | slice-reviewer: 0 blockers, 2 majors, 6 minor, 3 nits; all fixed. M1: the second key of a sequence now passes the typing and overlay gate. M2: command handlers have explicit levels (`app` < `page` < `overlay`) instead of mount order. Minor: last-word help search, `Alt+<symbol>` rejected and `Mod+,` without Option, override direction checked, editor/page scopes overlap, `Mod+Enter` uses the focused form and respects a disabled or busy submit button, hint and `inBuild` tests. Nits: Zod comment, SPEC E3 "outside A–Z", stable `bindings` note. Each fix mutation-checked. Rebased onto `db3128c`; `pnpm check` green (web 112 tests); real page rechecked in Chromium. |
| 2026-11-07 | Zod jitless + PLAN-005 S5 | main | merged | Rebased onto `db3128c` (no-op). `pnpm install`, `pnpm check` (web 112 tests) green; `pnpm test:int` 179 + 2 of 3 perf passed: `sync-lock.perf` (p95 < 2 ms) failed once under load (load average about 4, other sessions running) and passed on two re-runs; server code untouched by this branch. `main` is checked out in the primary worktree, so it was fast-forwarded there with `git merge --ff-only` instead of `git fetch . HEAD:main`; main at `7ddc5d1`. Next: PLAN-005 S6. |
| 2026-11-07 | PLAN-005 S6 | p005-s6-command-menu | built | Command menu (`apps/web/src/command-menu/`): operation, navigation and app sources, fuzzy × context × frecency ranking, nested pages, `Mod+Enter`, ARIA combobox, virtualisation above 50 rows. `packages/ui`: `Dialog variant="command"`, `VisuallyHidden`, `command-menu-width` token. `mobx` added to `apps/web` (single 7.1.5 copy). SPEC-005 §4.1–4.2 updated (`target` replaces `focused`/`selection`, `appliesTo`, Suggested semantics). `pnpm check` green (web 145 tests); checked by hand in Chromium, including 305 commands (filter < 1 ms, open < 3 ms). **For E:** append `OPERATION_COMMANDS` entries for ops with `ui` metadata. **For S4:** pass `actor`, `store`, `navigate`, `teams`, `route` to `<CommandMenuProvider>`. Rebased onto `acf0fa1`; session E's handoff picked up: `packages/ui/test/label-hues.test.ts` keeps `LABEL_HUES` equal to `COLOR_HUES` (`@surface/domain` added to ui as a dev dependency), the `UserPreferences` model replaces the preferences column in the S4/S7 notes, and S4 registers `PRODUCTION_MODELS`. Waiting for /review and /commit. |
| 2026-11-07 | PLAN-005 S6 review | p005-s6-command-menu | fixed | slice-reviewer: 0 blockers, 5 majors, 11 minors, 7 nits; all fixed except two nits (`aria-expanded` kept; the reaction's second ranking run kept, as timing only the render run would call `performance.now()` during render) and the Storybook/visual minor (deferred, recorded as a gap). M1 a click runs the clicked row; M2 IME keys ignored; M4 commands run from `Dialog` `onClosed` after focus restore (new `packages/ui` prop); M5 run logic is a pure `execute` with tests; M3 operation commands move to the shared `apps/web/src/features/commands.ts` (sessions README §7 list extended; handoff to E). Docs: SPEC-005 §4.1 dated note, §4.3 and AC-2 notes; command-menu.md §4–5. Each fix mutation-checked (13 mutants killed). `pnpm check` green (web 163 tests); real page rechecked in Chromium. |
| 2026-11-07 | PLAN-005 S6 second review | p005-s6-command-menu | fixed | slice-reviewer: 0 blockers, 1 major, 4 minors, 5 nits; all fixed, plus one gap recorded (no DOM test for `Dialog` `onClosed` ordering). Major: `useCommandContext` precedence by level (`page` < `focus` < `selection`), relabels in place. Minors: `checkOperationCommands` (refs, bound shortcut, offered to a fully permitted user) replaces the names-only coverage test; unbound `ui.shortcut` hints hidden; "No results" outside the listbox; frecency cap tested. Nits: SPEC §4.2 boost note, `track` closes the render-to-subscribe gap, frecency tabs comment, command-menu.md fast path M1. Rebased onto `08f2ccd`. Mutation-checked (7 mutants killed). |
| 2026-11-07 | PLAN-005 S6 | main | merged | `3d16aba`, already on `08f2ccd` (rebase a no-op). `pnpm install`, `pnpm check` (web 172, server 322) and `pnpm test:int` (188 + 3 perf) green. `main` is checked out in the primary worktree, so it was fast-forwarded there with `git merge --ff-only`. Session E: operation commands now live in the shared `apps/web/src/features/commands.ts` (README §7). Next: PLAN-005 S4, blocked on A's PLAN-001 S3. |

## Prompt

```
You are session C of the Surface project, phase 2, working in the git worktree /Users/admin/Desktop/Learning/surface-c. Your track is the web app shell: PLAN-005 S5, S6, S4, S7 and S8, in that order.
Read, in order:
- CLAUDE.md, docs/07-plans/sessions/README.md (especially §7, phase 2), docs/07-plans/sessions/session-c2-web-shell.md;
- then PLAN-005, SPEC-005, docs/05-design/, and the PLAN-002 S6–S8 "As built" notes.
Check the Log and Handoffs tables in all phase 2 session files (a2, c2, d2, e2) before starting.

Implement the scope in session-c2-web-shell.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with the Zod jitless commit, then PLAN-005 S5 on branch p005-s5-shortcuts.
Edit only the files listed under "Owns", and the shared registry files append-only. Ask other sessions for changes through the Handoffs table.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-c2-web-shell.md;
- update PLAN-005's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```
