---
name: status
description: Report where the build stands: milestone progress, current branch and slice, what is next, and anything blocking.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(git status *), Bash(git log *), Bash(git branch *), Bash(git worktree list *), Bash(docker info *), Bash(node -v)
---

Produce a short status report. Don't change anything.

1. Read `docs/07-plans/README.md` for the plans, order and exit checklist. Then grep the `docs/07-plans/PLAN-*.md` slice headings for `✅ Done` to see what is finished.
2. Run `git branch --show-current`, `git status --short` and `git log --oneline -10`. If the branch name matches `p<plan>-s<slice>-*`, say which slice it is and whether that slice has uncommitted or unmerged work.
3. If `docs/07-plans/sessions/` exists, read each `session-*.md` file. Report each session's latest Log row, plus any Handoffs still marked `open`. Run `git worktree list` to see which worktrees exist.
4. Check the environment: is `node -v` v24, and does `docker info` succeed?
5. Report in this order:
   - Done: slices completed per plan.
   - In progress: the current branch and slice, and its state.
   - Next: the next slice by build order, with its dependencies and whether they are met.
   - Sessions: one line per parallel session (slice, state) and any open handoffs.
   - Blockers: environment problems, failing checks you know about, open questions.
     Keep it under 20 lines.
