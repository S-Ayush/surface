# PLAN-016 UI polish: coordination log

Coordinator session started 2026-11-25. Plan: [PLAN-016](../PLAN-016-ui-polish.md). Source audit: [2026-11 Linear UI gap audit](../../05-design/audits/2026-11-linear-ui-gap-audit.md).

**How slices run:** the same way as M1 ([m1-coordination.md](m1-coordination.md)). Each slice is one agent in its own worktree and branch (`p016-sN-topic`), on Sonnet unless the work is heavy. The coordinator reviews the slice: by reading a small diff, or with the `slice-reviewer` agent for larger ones. Findings go back to the same agent. The coordinator merges with `--ff-only` once `pnpm check` is green. **New slices start only on the user's go-ahead.**

**The user's decisions, 2026-11-25:**
- Surface keeps its own look and adopts Linear's craft.
- This plan runs before M2.
- Rows are 44/36.
- The command menu has no backdrop.
- Keyboard pickers open in the command-menu shell.
- Start the docs, then S0 and S1. Later slices wait for a go-ahead.

**Browser checks:** a headless Playwright capture against a throwaway local instance (`surface-capture` compose project, web `cap.localhost:5180`, server `:3100`). Claude in Chrome is used only for Linear, read-only, and only after checking that the browser is on this Mac.

## Log (append-only)

| Date | Event | Notes |
|---|---|---|
| 2026-11-25 | Docs merged (`0c08f09`) | Audit, design-system v0.2, command-menu v0.2, SPEC-005 D4, SPEC-012 D32 and PLAN-016. The coordinator moved the row-height change from S1 to S4. |
| 2026-11-25 | S0 merged (`d54bb79`) | Visible-bug hotfix: breadcrumb links, one focus ring on inputs, the command-menu input ring, and the title offset. All four reproduced. The tests read the CSS source, because jsdom can't compute CSS Modules. Coordinator review: `width: auto` would have shrunk the title's button and input, so it was fixed with an explicit `calc` width. Not checked in a browser. |
