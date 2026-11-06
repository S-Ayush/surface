---
name: spec
description: Draft a new feature spec (SPEC-NNN) from the methodology template, grounded in the PRD and domain docs.
argument-hint: <feature or area, e.g. "issues core" or SPEC-010>
disable-model-invocation: true
---

Draft a spec for: $ARGUMENTS

1. Read the spec template in `docs/METHODOLOGY.md` ("Spec template"), the index in `docs/06-specs/README.md` (for the next number and any planned spec for this area), and one existing accepted spec as a style reference, e.g. SPEC-001.
2. Gather the inputs:
   - the PRD requirements (`FR-*`, `NFR-*`) for this area, with their tier and milestone;
   - the domain entities, invariants (`INV-*`), state machines and permissions involved;
   - the architecture constraints (operations, sync groups, sync-protocol load strategy).
3. Write `docs/06-specs/SPEC-NNN-<slug>.md` with Status **Draft**.
   - Every acceptance criterion must be testable and numbered `AC-n`. Number edge cases `E-n`.
   - List the operations the feature adds, with their names, refs and permissions, and the sync groups it touches.
   - Respect the out-of-scope list in `CLAUDE.md`. Don't spec SSO, guests, AI, integrations, telemetry or sub-teams.
4. Put open questions in a table with a **proposed default** for each, so the user can accept them in bulk.
5. Add the spec to `docs/06-specs/README.md`.
6. Report the file path, a short summary, and the open questions.
