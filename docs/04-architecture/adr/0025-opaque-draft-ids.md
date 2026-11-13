# ADR-0025: Opaque ids in draft operations (exception to registry rule 4)

Status: **Accepted** (coordinator decision in the PLAN-012 S5 review, 2026-11-13) · Date: 2026-11-13 · An exception to [SPEC-003 §11](../../06-specs/SPEC-003-operation-registry-executor.md#11-registry-lint-ci) rule 4 ("inputs name other entities with reference types"); no ADR is superseded.

## Context
SPEC-003 §4 says an operation names another entity with a reference type (`TeamRef`, `IssueRef`, …). The executor resolves every reference before the handler runs, and resolving checks that the actor can see what it names: an invisible team or issue is `NOT_FOUND`. Registry lint rule 4 enforces it: a raw uuid in a public operation's input fails the build, except a create's own `id` and internal or `systemOnly` operations.

Drafts (SPEC-012 §4.3) need the opposite. A draft is the owner's own data: it keeps a team, an issue, and the status, assignee and labels the person chose, and it must stay valid when the owner later loses access (left a private team, the issue was deleted). The owner must be able to save and discard it without access, and the server must not tell anyone whether the team or issue exists. Resolving the ids would refuse the draft and reveal existence through the error.

## Options
1. **Reference types, with a "don't check visibility" flag on the reference.** Touches the resolver that every operation uses, and a flag on a ref is easy to copy into the wrong operation.
2. **Mark the operations `internal`.** They would disappear from the API and MCP, and an internal op must never run in production.
3. **Name the opaque input paths on the operation (`opaqueIds`), and let lint rule 4 skip exactly those paths, for a reviewed list of operations.**

## Decision
Option 3.
- `defineOperation` gains `opaqueIds`: the input paths (as the lint names them: `teamId`, `data.labelIds[]`) whose uuids the server stores without resolving. Rule 4 skips those paths only, and flags an entry that is not a uuid path of the input, so a stale entry can't hide a new field.
- Only the operations in `OPAQUE_ID_OPERATIONS` (`packages/operations/src/lint.ts`) may set `opaqueIds`: `draft.save` and `draft.discard`. Any other operation with `opaqueIds` fails rule 4. A unit test pins the list, so adding an operation changes that test and needs a new ADR or an amendment recorded here.
- A handler of such an operation must never read the entity an opaque id names, nor return anything about it. The draft handlers read only the actor's own `drafts` rows.

## Consequences
+ Drafts work without access and never reveal a private team or a deleted issue (SPEC-012 §4.3; the leak test `draft-groups.int.test.ts` covers it).
+ The resolver and every other operation are unchanged, and rule 4 still guards every new field.
− `draft.save` and `draft.discard` accept only uuids for the team and issue, not keys or identifiers (`ENG`, `ENG-42`). API and MCP callers read the uuid first. Drafts are a UI feature, so this costs little.
− A reviewer must check that a handler on the list never resolves an opaque id. The lint can't see it.
