---
name: adr
description: Record an architecture decision as a new ADR (or supersede an existing one) in docs/04-architecture/adr.
argument-hint: <decision title> [supersedes NNNN]
disable-model-invocation: true
---

Record this decision: $ARGUMENTS

1. Read `docs/04-architecture/adr/README.md` for the next number, and one or two existing ADRs, so the new one follows the same structure and status line.
2. Write `docs/04-architecture/adr/NNNN-<slug>.md`: context, the decision itself, the alternatives considered (and why not), and the consequences (+ and −). Keep it to about a page.
3. If it supersedes an earlier ADR, change **only** that ADR's status line to `Superseded by ADR-NNNN`. Never rewrite its decision.
4. Add a row to `adr/README.md`. Update `architecture.md` and any specs that state the old decision.
5. Report the new ADR and every document you changed.
