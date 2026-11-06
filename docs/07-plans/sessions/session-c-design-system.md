# Session C: Design-system foundations

Worktree: `/Users/admin/Desktop/Learning/surface-c` · First branch: `p005-s1-tokens` · Guide: [README](README.md)

## Setup

```bash
cd /Users/admin/Desktop/Learning/surface
git worktree add ../surface-c -b p005-s1-tokens main
cd ../surface-c && source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
claude
```

## Scope, in order

Read [PLAN-005](../PLAN-005-app-shell-command-menu-shortcuts.md) S1–S3, [SPEC-005](../../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md) (AC-11, AC-12, AC-13) and all of [design-system.md](../../05-design/design-system.md).

1. **S1: token pipeline and themes:**
   - token sources in `packages/ui/tokens/`, plus `pnpm ui:tokens` to generate CSS variables and typed constants;
   - bundled fonts (Inter variable, JetBrains Mono) with no external requests;
   - a theme bootstrap with no flash on load;
   - the contrast test (`pnpm test:tokens`) and the Stylelint rule (no hex or raw px outside token files).
2. **S2: primitives and Storybook:** the component list in PLAN-005 S2, meeting the design-system §5.4 checklist. Add Storybook with the a11y addon and keyboard interaction tests, and Playwright visual snapshots in both themes. Use the current Storybook major version; the plan's "Storybook 8" is from when it was written. Record the version in "As built".
3. **S3: overlays and overlay manager:** Popover, Menu, ContextMenu, Dialog, Toast and Banner on Radix, plus `OverlayManager` (modal stack, focus restore, Esc routing, toast and banner queues).

Stop after S3. S4+ (shell and router) needs auth and the sync store from phase 2.

## Owns

- `packages/ui/**` (tokens, components, icons, Storybook config, stories, visual tests)
- In `apps/web`: `index.html` (theme bootstrap, font preload), `src/styles/**`, and `src/main.tsx` (only to import the global CSS)
- Root-level Stylelint config, and the `ui:tokens`, `test:tokens` and `storybook` scripts (additive changes to the root `package.json`)
- The S1–S3 sections of `docs/07-plans/PLAN-005-*.md`; `docs/05-design/**` (only for corrections, logged)

## Must not touch

`apps/server/**`, `packages/{domain,operations,sync-*}/**`, `.github/**` (ask B for CI jobs), `CLAUDE.md`, `.claude/**`.

## Notes

- **Self-contained:** fonts, icons (`lucide-react`) and everything else are bundled. CI's no-egress test fails on any external URL.
- **Visual tests** run Playwright's Chromium. Keep the baselines deterministic: bundled fonts, animations disabled in snapshot mode.

## Prompt

```
You are session C of the Surface project, working in the git worktree /Users/admin/Desktop/Learning/surface-c. Your track is the design-system foundations: PLAN-005 slices S1–S3.
Read, in order: CLAUDE.md, docs/07-plans/sessions/README.md, docs/07-plans/sessions/session-c-design-system.md, then PLAN-005, SPEC-005, docs/05-design/design-system.md, shortcuts.md and command-menu.md.
Check the Log and Handoffs tables in all four session files before starting.

Implement the scope in session-c-design-system.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with PLAN-005 S1 on branch p005-s1-tokens.
Edit only the files listed under "Owns". Request anything else through the Handoffs table; for example, ask session B to add Storybook, visual and axe jobs to CI.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-c-design-system.md;
- update PLAN-005's "As built" notes;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
Stop after S3. Use ports 6006 (Storybook) and 5174 (Vite) in this worktree.
```

## Handoffs (requests from C to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| A | When the CSP lands (architecture §security headers), allow the theme bootstrap with `script-src 'self' 'sha256-…'`, not `'unsafe-inline'`. Simplest: at startup, hash the single inline `<script>` in the served `dist/index.html` (a test keeps it the only one). | Without it a strict CSP blocks the script and the theme flashes. Not blocking now. | open |
| B | FYI: root `pnpm lint` now also runs `pnpm lint:css` (Stylelint, root `stylelint.config.js`), so CI's lint step covers CSS with no change. If CI calls the sub-steps individually, add `pnpm lint:css`. | So every session's CSS is gated in CI. Not blocking. | open |
| B | Two CI jobs for PLAN-005 S2. (1) **Storybook tests:** `pnpm install`, `pnpm --filter @surface/ui exec playwright install --with-deps chromium`, `pnpm test:storybook`. (2) **Visual:** run the job in `container: mcr.microsoft.com/playwright:v1.65.0-noble` on an amd64 runner, set up Node 24 + pnpm, `pnpm install`, `pnpm --filter @surface/ui storybook:build`, `pnpm --filter @surface/ui test:visual:run`; upload `packages/ui/dist/visual-report` on failure. Baselines are committed in `packages/ui/visual/__screenshots__`. | AC-12 / AC-13 must run in CI. Not blocking merges of other slices. | open |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-005 S1 | p005-s1-tokens | built, in review | Tokens, generator, fonts, theme bootstrap, contrast test (163 pairs × 2 themes), Stylelint. `pnpm check` green. Light accent/focus/tertiary colours corrected in design-system §2.1 (logged there). Shared-file changes: root `package.json` (+`stylelint`, scripts `lint:css` added to `lint`, `ui:tokens`, `test:tokens`), lockfile. Handoff to A: CSP hash. |
| 2026-11-06 | PLAN-005 S1 | p005-s1-tokens | review fixed | All 14 /review findings fixed: unit-safe reduced-motion tokens (now in `tokens.css`), complete per-token usage contract in the contrast test, new `--border-control` (3:1 input edge; gray-9 darkened), SPEC-005 §6 row for the `surface.theme` cache, stricter bootstrap test, generator duplicate-name check, `--check` mode removed, physical units banned. Spec change: SPEC-005 §6 (one row). Ready for /commit. |
| 2026-11-06 | PLAN-005 S2 | p005-s2-primitives | built, in review | Branched from p005-s1-tokens (S1 not on main yet). 17 components, Storybook 10.6.6, 78 story tests (keyboard + axe, both themes), 50 visual baselines (pinned Playwright image, amd64), 430 unit tests. `pnpm check` green (uncached). Shared-file changes: root `package.json` scripts `storybook`, `test:storybook`, `test:visual`; lockfile. Handoff to B: Storybook and visual CI jobs. |
| 2026-11-06 | PLAN-005 S2 | p005-s2-primitives | review fixed | All /review findings fixed: stale visual output removed, visual tolerance tightened (mutation-checked), control hover/error/focus specificity, reduced motion for Spinner/Switch/ProgressBar/Skeleton, Button `aria-keyshortcuts`, `parseChord('Mod++')`, per-component visual guard, Storybook setup file removed, tokens for remaining magic numbers. Shared-file change: `packages/config/eslint.js` (additive `no-restricted-syntax` block banning raw colours/px in inline `style` for web/ui/editor TSX). Docs: design-system §2.1 (`--on-label` row), §5.1 Kbd row, §5.4 note; PLAN-005 §4 test-plan rows AC-12/AC-13. Not owned, logged only: PLAN-005 §2 file list still says `e2e/visual/*` (now `packages/ui/visual/`). Ready for /commit. |
| 2026-11-06 | PLAN-005 S3 | p005-s3-overlays | built, in review | Rebased S1+S2 onto main first (clean; S1 and S2 are now `9aa613f` and `7e3fd24` on this branch). Popover, Menu + ContextMenu (shared entries), Dialog (dirty guard), Toast, Banner, `overlayManager` (layer stack, focus restore, toast/banner queues, `toast()`, `banner.show()`). No new dependencies. `pnpm check` green (uncached, 452 ui unit tests); 114 story tests; 63 visual (12 new baselines, two runs). Shared files: none. Docs: design-system §5.2 as-built note. Notes for S4/S5 in PLAN-005 S3 "As built". |
| 2026-11-06 | PLAN-005 S3 | p005-s3-overlays | review fixed | All /review findings fixed, each with a story that failed first: one `--z-overlay` level (menus inside dialogs were behind them), focus restore through open menus and for anchor-only popovers, `overlayManager.isOverlayEscape()` (window capture) replacing the `topLayer()` advice to S5, toasts no longer `preventDefault` page Esc, persistent banner live regions, banner `priority`, discard confirm closes with its dialog, dialog landmarks, toast id collisions and re-announce, menu `textValue`, context-menu keyboard and axe end-state stories. 456 unit, 136 story, 65 visual tests. Docs: design-system §2.5 z-index correction and §5.2 note, command-menu.md note (errors while the menu stays open); PLAN-005 S3 As built rewritten. Shared files: none. Ready for /commit. |
