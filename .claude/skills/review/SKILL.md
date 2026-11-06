---
name: review
description: Independent review of the current branch against its plan slice, spec ACs and project rules, using the slice-reviewer agent.
argument-hint: [base branch, default main]
disable-model-invocation: true
---

Review the current branch against base branch `$ARGUMENTS` (use `main` if no argument was given).

1. Work out the slice from the branch name (`p<plan>-s<slice>-*`) and find its section in `docs/07-plans/`.
2. Use the **slice-reviewer** subagent. Give it the base branch, the plan file and slice, and the spec file. Don't give it your own opinion of the code: the review should be independent.
3. Relay its findings grouped by severity, with `file:line` references. For each finding, say whether you agree and why. Don't fix anything unless the user asks.
