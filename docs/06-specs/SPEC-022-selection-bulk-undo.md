# SPEC-022: Multi-select, bulk edit, undo/redo, context menu & peek

Status: **Draft** · Milestone: **M2** · Date: 2026-11-25
Implements: FR-NAV-05 (multi-select with `X`, shift-click, `Mod+A`; bulk edit of any property) · FR-NAV-06 (undo / redo with `Mod+Z` / `Mod+Shift+Z` for property changes, moves and deletes) · FR-NAV-07 (peek with `Space`) · FR-NAV-11 (right-click context menu mirroring the command menu) · PRD §5.6 key criterion "every property change can be undone with `Cmd+Z`" · NFR-01, 06, 07, 08, 14, 18, 19
Depends on: SPEC-011 (issues, `issue.update`, history), SPEC-012 (lists, focus model, pickers, row menu, `Esc` chain, the M1 last-delete `Mod+Z`), SPEC-015 (delete, restore, lifecycle rule table), SPEC-003 (registry, executor, the `inverse` hook reserved for M2), SPEC-005 (command menu, command targets, shortcut engine), SPEC-002 / sync-protocol (mutation queue, overlay, mutation results)
Related, drafted in parallel: SPEC-020 (board layout, display options, drag and drop, manual order), SPEC-021 (filters, custom views), SPEC-023 (search, My issues). This spec defines selection, bulk edit, undo and the context menu **for every issue list and board they render**; it does not specify their layouts, filters or search.
Related docs: [design-system §3](../05-design/design-system.md) (focus vs selection, peek popover) · [shortcuts §3.1, §3.3](../05-design/shortcuts.md) · [command-menu §3.3](../05-design/command-menu.md) · [sync-protocol §5.5](../04-architecture/sync-protocol.md#55-undo--redo) · [ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md)

---

## 1. Problem & goal

M1 edits one issue at a time and can undo only the last delete. Triage and planning mean changing many issues at once ("move these twelve to Backlog", "assign all of these to me"), and a keyboard-first tool needs a safe way to take a change back. This spec adds **selection** (`X`, shift-click, `Mod+A`) on every issue list and board, **bulk edit** of every property from the same keys, pickers, `Mod+K` commands and a bottom action bar, a general **undo / redo** stack (`Mod+Z` / `Mod+Shift+Z`) that replaces M1's last-delete slot, a **context menu** on right-click that offers what `Mod+K` offers for the same target, and **peek** (`Space`), a small read-only popover that previews an issue without leaving the list.

All of it keeps Surface's rules: every change, including an undo, is an operation run by the server's executor; undo never writes base state; a private team's issue is never revealed by a bulk answer or an undo.

## 2. Scope

**In scope**

- Selection on issue lists and boards: `X`, `Shift+X`, `Shift+↑` / `Shift+↓` (and `Shift+J` / `Shift+K`), shift-click, a row checkbox, `Mod+A` (all, collapsed groups included), `Mod+Alt+A` (group), `Esc` (clear). `Mod`-click is not selection: it opens the issue in a new browser tab (D6). Selection state, its rules on live updates, and its accessibility.
- Bulk edit of every M2 issue property (status, priority, assignee, labels, estimate, due date) on a selection: keys, pickers, property commands, the bulk action bar, and bulk delete and restore.
- New operations `issue.bulkUpdate`, `issue.bulkDelete`, `issue.bulkRestore` (§6), with per-issue outcomes.
- Undo and redo: what enters the stack, inverses as operations, the stack's scope and size, conflicts with other people's changes, refusals, offline and other tabs. The `inverse` hook of SPEC-003 §3.1 is implemented for the operations in §4.3.
- The context menu on issue rows and board cards (and the keyboard context-menu key), built from the command sources.
- Peek (`Space`, hold `Space`) on issue lists and boards.
- The `Esc` chain's M2 steps, and the shortcut map for all of the above.

**Out of scope**

- Board layout, drag and drop, display options, manual order (SPEC-020). This spec only says that a drag of a selected card is a bulk edit with one undo entry (§3.4), and what SPEC-020's reorder operation must provide for undo (§4.3).
- Filters, custom views and URL state (SPEC-021); global search and its result list (SPEC-023). Whether search results can be selected is SPEC-023's call; if they can, this spec's rules apply.
- Bulk title edits (Linear has none), bulk description edits, bulk comments.
- Undo of comment, reaction, description, draft, settings (statuses, labels, teams, members) and account changes. The editor keeps its own text undo (SPEC-013).
- Team moves, parent, project, cycle (M3). Their operations add `inverse` and bulk fields when they arrive (§4.3 rule for later operations).
- Context menus on sidebar items, views and group headers (proposed for later, Q9).
- `issue.bulkCreate` (domain-model §7 lists it for MCP and M3 sub-issues).

## 3. User flows

### 3.1 Select issues (FR-NAV-05)

Copied from Linear's "Select issues" and "Board layout" docs (D1, D2). **Focused** (highlighted) and **selected** are different (design-system §3): one row is focused and moves with `J` / `K`; any number of rows are selected and show `--bg-selected`. Commands act on the selection when there is one, else on the focused row.

1. **`X`** toggles the focused row's selection and makes it the **anchor**.
2. **`Shift+↓` / `Shift+↑`** (also `Shift+J` / `Shift+K`, shortcuts.md §3.3) move focus one row and select every issue row from the anchor to the new focus. With no anchor, the row focused before the key becomes the anchor and is selected.
3. **`Shift+X`** selects every issue row from the anchor to the focused row (Linear's board key, D2).
4. **Mouse:** hovering near a row's left edge shows its checkbox (Linear, D1); a click on it toggles the row. **Shift-click** selects from the anchor to the clicked row. **`Mod`-click** opens the issue in a new browser tab and doesn't change the selection (D6; Linear's web app, 2026-11-25). Selection is by `X`, shift-click and the hover checkbox. A plain click still opens the issue (SPEC-012).
5. **`Mod+A`** selects every issue row the view lists, **including rows in collapsed groups** (D5), apart from rows the view hasn't loaded (§3.7). **`Mod+Alt+A`** selects every row of the focused row's group (a key SPEC-012 §3.6 reserved from Linear's panel). Neither fires while typing (`whileTyping: false`, SPEC-012 §4.2).
6. **`Esc`** clears the selection (the `Esc` chain, §3.9; Q18). So does leaving the route. Observation, Linear's web app on 2026-11-25: after `Mod+A`, `Esc` did not clear the selection there, and the bar's × did. It may have been a focus artefact, so Q18 keeps `Esc` as the default.
7. Ranges (`Shift+↓`/`↑`, `Shift+X`, shift-click) skip group headers and rows of collapsed groups; `Mod+A` does not skip them (item 5). Selecting a group header with `X` does nothing; `Mod+Alt+A` on a focused header selects its group.
8. **What the selection holds:** issue ids, in view order. It lives in memory per route (and per tab), survives re-sorts, layout switches between list and board (SPEC-020) and the issue page round trip (`Enter`, then `Esc` back restores focus and selection, like SPEC-012's focus memory). It is not in the URL and not synced.
9. **Live updates:** an issue that leaves the view (it was deleted, archived, moved out of a filter, or its team unsubscribed) leaves the selection; the count updates and a polite live region announces "ENG-42 left the selection" once per batch ("3 issues left the selection"). Focus follows SPEC-012 E2.
10. **Selection count:** the bulk action bar (§3.3) shows "N selected". There is no cap on selecting; a bulk action over more than 1,000 issues is refused before anything is sent: "Select at most 1,000 issues to change them together." (Q4).

### 3.2 Bulk edit (FR-NAV-05)

Linear: "update the issue field like you would any issue" (D1).

1. With a selection, the property keys (`S`, `P`, `A`, `I`, `L`, `Shift+E`, `Shift+D`, `Mod+Shift+D`), the bulk action bar, the context menu and the `Mod+K` property commands act on every selected issue. `Mod+K`'s context chip reads "12 selected issues" (command-menu §1) and titles read "Change status of 12 issues…".
2. **Pickers on a selection** (SPEC-012 §3.5 with these differences):
   - The current value is checked only when every selected issue has it; a mixed value shows no check, and the trigger reads "Mixed".
   - **Status:** one team in the selection: that team's statuses. Several teams: the statuses whose **name and category** exist in every team of the selection (the My issues grouping rule, SPEC-012 §3.9), sent by name so each issue resolves it in its own team. When none are shared, the picker shows "These issues are in teams with no status in common. Select issues of one team to change their status." Triage and Duplicate stay excluded.
   - **Assignee:** "No assignee", **Me**, then the users who can be assigned to **every** selected issue (a private team's issue only to its members, INV-18). So no choice in the list can be refused for being outside a private team.
   - **Labels:** workspace labels, plus a team's labels only when every selected issue is in that team. Each label shows checked (all have it), mixed (some) or unchecked. Toggling a label to checked adds it to every issue (the group rule INV-07 replaces another label of an exclusive group); to unchecked removes it from all. Closing applies all toggles as one `issue.bulkUpdate` per chunk (§4.2).
   - **Estimate:** offered only when every team of the selection uses the same scale; otherwise `Shift+E` shows "These issues' teams use different estimate scales. Select issues of one team to set an estimate." A team with estimates off is the SPEC-012 hint.
   - **Due date:** as SPEC-012. **Assign to me** (`I`) assigns every selected issue to the user (an issue already assigned to them is unchanged).
3. **`Shift+R`** (rename) works on one issue: with more than one selected it shows "Rename works on one issue at a time."
4. **Dispatch:** the client sends `issue.bulkUpdate` (§6.1) with the selected ids, chunked to 250 per operation (§4.2). Every chunk is optimistic, so the change paints at once and works offline.
5. **Outcome:** when every chunk is confirmed, a toast says "Updated 12 issues" with **Undo** (design-system §5.1; Q6). Issues the server skipped (§4.2) roll back alone; the toast then says "Updated 9 of 12 issues. 3 weren't changed: ENG-4 was deleted, ENG-7 is archived, and 1 more." with **Undo** and **Show all**, which opens a dialog listing each skipped issue with its reason. A wholly refused chunk (invalid input, rate limit exhausted) is SPEC-012's rejection toast. A change to one issue shows no toast (D7). Whether a bulk change shows a toast at all wasn't observed in Linear's web app, so the toast above is the proposed default (Q6).
6. **Delete** (`Mod+Backspace`, bar, menu, `Mod+K`) on a selection opens the confirm dialog `Delete 12 issues?` with SPEC-012 §3.11's body text, **Cancel** and **Delete**, and sends `issue.bulkDelete`. After a delete (one issue or several), a toast reads "Deleted ENG-42" ("Deleted 12 issues"; the bulk wording wasn't observed) with "You can restore deleted issues from the archive" and a **View recently deleted** action that opens the team's archive page on its Deleted tab (SPEC-015). It has no Undo button; `Mod+Z` still restores (D3, D7). On the team archive page (SPEC-015), **Restore** (`#`) on a selection sends `issue.bulkRestore`; an archived-and-deleted mix restores both. No dialog for restore.
7. **History and events** are per issue, as if each issue had been edited alone: one IssueHistory entry per changed issue (with SPEC-011's folds), one `issue.updated` event per changed issue (events.md). A bulk edit is not an entity of its own.

### 3.3 The bulk action bar

Linear: "common bulk actions appear in a toolbar at the bottom of the view" (D1).

- Shown at the bottom centre of the list or board while at least one issue is selected; hidden when none is. A `toolbar` labelled "Bulk actions for 12 issues".
- Content: "12 selected" with a clear button (`Esc`), then **Status**, **Priority**, **Assignee**, **Labels**, **Estimate** (when §3.2 allows it), **Due date**, **Delete**, and **More** (opens the context menu for the selection, §3.5). Each button opens the §3.2 picker anchored to it and shows its key hint. On the archive page the bar holds **Restore** (and **Delete** for archived issues only).
- At < 768 px it collapses to "12 selected", **Edit** (the context menu) and clear.
- The bar comes right after the list in `Tab` order, so `Tab` from the focused row reaches it and `Shift+Tab` returns; it has no key of its own (`F6` belongs to the browser's address bar).

### 3.4 Board and drag (with SPEC-020)

Selection keys and mouse rules are the same on a board (Linear: "the same shortcuts work to select issues in the board view", D2). Dragging a card that is part of the selection drags the whole selection; dropping it in another column is one `issue.bulkUpdate` setting that column's grouping property (SPEC-020 defines which), and one undo entry. Dragging an unselected card moves that card only and leaves the selection as it is.

### 3.5 Context menu (FR-NAV-11)

1. **Right-click** on an issue row or board card, or the platform context-menu key (the Menu key, or `Shift+F10`, which the browser turns into a `contextmenu` event) on the focused row, opens the context menu at the pointer or under the row.
2. **Target:** a right-click on a selected row targets the whole selection (Linear: "right-click the selection to open the contextual menu", D1). A right-click on an unselected row targets that row only, with the single-issue menu, and leaves the selection as it is (D8). The menu's header line names the target: "ENG-42" or "12 issues".
3. **Mirrors `Mod+K`:** the menu is built from the same command sources and availability rules (`ui.available`, the permission pre-check) as the command menu for that target, so a command is in one exactly when it is in the other (AC-18). Navigation and global commands are left out. Order (SPEC-012 §3.3 item 5, extended): Status › · Priority › · Assignee › · Due date › · Labels › · Estimate › (when used) · Assign to me · Copy › · separator · Delete…. On an archived or deleted issue: Copy › · Restore (`#`) · Delete (archived only) · Permanently delete… (Admin, deleted only), as SPEC-012 §3.4 item 8.
4. **Submenus** list the picker's options (§3.2 rules, quick-key hints included); choosing one dispatches at once. Labels is a checkbox submenu applied on close; Due date opens the date picker anchored to the row.
5. Every item shows its key hint. Keyboard: arrows, `Enter`, `Esc` (Radix menu, already in `packages/ui`).
6. On a selection, **Copy ›** lists, as Linear's menu does (D9): **Copy IDs** (`Mod+.`; `ENG-4, ENG-7, ENG-12`), **Copy URLs**, **Copy titles**, **Copy titles as links**, **Copy issues as Markdown**, **Copy everything as Markdown** and **Copy git branch name**. Each is SPEC-012 §3.7's copy action applied to every selected issue, in view order, one issue per line (the Markdown ones separated by a blank line); each of SPEC-012 §3.7's copy keys acts on the selection too. **Copy everything as Markdown** includes the description, loaded like the issue page loads it; an issue whose content was never hydrated and can't be fetched offline is left out, and the toast says how many. All of them build a string on the client from the replica: no integration, no network. Linear's "Copy as prompt" is left out (built-in AI is out of scope, CLAUDE.md).

### 3.6 Undo and redo (FR-NAV-06)

1. **`Mod+Z`** outside a text field or the editor undoes the newest entry of this tab's undo stack; **`Mod+Shift+Z`** redoes the newest undone entry. Inside a text field or the editor the keys undo text (unchanged). Both are global bindings with `whileTyping: false`, and commands "Undo" and "Redo" in `Mod+K` (titled with the entry: "Undo set priority of ENG-42 to High"), unavailable when the stack is empty. M1's `issue.restoreLastDeleted` binding and its last-delete slot are removed: a delete is now an ordinary entry (§4.3), and `Mod+Z` right after a delete still restores it, as Linear documents (D3).
2. **What enters the stack** (§4.3): changes the user makes in this tab with `issue.update` (any property, title included once it is saved), `issue.bulkUpdate`, `issue.delete`, `issue.bulkDelete`, `issue.restore` / `issue.bulkRestore` of a deleted issue, board drags (SPEC-020's operations), manual reorder (SPEC-020) and attachment removal (`attachment.delete`, Q10). One user action is one entry, however many operations it sent (a bulk edit in four chunks is one entry).
3. **What undo does:** it dispatches the entry's inverse operations as new mutations (sync-protocol §5.5), so they are optimistic, queue offline, are checked by the server and leave their own history ("Ada set priority to Medium"). It never edits base state or removes history.
4. **Changed since** (Q1): before dispatching, undo compares each field the entry set with the value the store now shows. A field that someone (or something) has changed since is left alone for that issue; the rest is undone. The toast then says "Undo set priority of 9 of 12 issues. 3 were changed since, so they were left as they are."
5. **Feedback:** each undo and redo shows a toast naming what it did, in Linear's wording (D7): "Undo set status of ENG-42 to Todo." and "Redo set priority of 12 issues to High." (the entry's action phrase after "Undo" or "Redo"), because the change may be off-screen, and a polite announcement. A single property change itself shows no toast. A refused or skipped part is reported in the same toast (§3.2 item 5's wording, "couldn't be undone").
6. **Redo** re-sends the entry's forward change for the issues the undo restored. A new undoable action clears the redo side. Redoing a delete deletes again without the dialog (the user confirmed it once; D10, as in Linear's web app).
7. **Nothing to undo:** the key does nothing; `Mod+K`'s Undo is unavailable. An entry that cannot be undone (§4.4: no pre-state) is still on the stack, so `Mod+Z` reaches it, says "Can't undo: status of ENG-87 (it wasn't loaded here)." and pops it, rather than silently undoing an older change.
8. **Undo from another page** (D12): each entry remembers the page it was made on (the route's path and query). When the newest entry belongs to a page other than the current one, `Mod+Z` (or Undo in `Mod+K`) first asks, in a dialog: **"Undo set status of ENG-42 to Todo?"** with the text "This operation was performed on a different page than you are currently on. Open that page and undo the operation?" and the buttons **Cancel** and **Undo**. **Undo** navigates to that page and undoes the entry there; **Cancel** leaves the stack alone. Redo asks the same way with "Redo …?" (the redo case wasn't observed in Linear; this follows the undo case). If the page no longer exists, the router shows its not-found state and the undo still runs.

### 3.7 Selection with partial loading (ADR-0020)

- Lists and boards of subscribed teams and My issues render from the replica, which holds every live issue of those teams (SPEC-011 §5.7): `Mod+A` selects everything the view lists, offline too.
- Views that read from the server in pages (the team archive tabs, SPEC-015; any server-backed list SPEC-021 or SPEC-023 defines) list only what they have loaded. `Mod+A` selects the loaded rows; when the view says more exist, the bar reads "50 selected · more not loaded" (Q2).
- Issues selected from a server-backed view may not be in the replica. Their bulk change predicts nothing locally (the optimistic code finds no row, SPEC-003 §8); the rows show the server's answer when it arrives (the view refreshes on the user's own confirmations, SPEC-015 §3.3), and the toast waits for confirmation ("Updating 12 issues…" until then).

### 3.8 Peek (FR-NAV-07)

Linear: "press the Space bar and turn it off by pressing the Space bar again. To temporarily turn it on, hold the Space bar down" (D4); on a board, `Space` on a card (D2). In Linear's web app (2026-11-25) `Space` on a hovered row opens a small read-only popover with the issue's identifier, status and age, priority, assignee and description (D11).

1. **`Space`** on the row or card under the pointer, else the focused one, opens the peek popover for it; `Space` again, `Esc`, or the popover's close button closes it. **Holding** `Space` (keyup more than 300 ms after keydown, with no other key between) shows peek only while held.
2. While peek is open, `J` / `K` move focus and peek follows the focused issue. Focus stays in the list: the popover is non-modal, named "Peek: ENG-42 Fix login redirect", takes no focus and doesn't trap it. `Enter` opens the issue page as usual.
3. **Content** (Linear's, D11): identifier and title, status and age ("Todo · 3d"), priority, assignee and the description (rendered, clamped to the popover's height, not editable). There is no activity list. The values are read-only pills; whether Linear's pills are clickable wasn't checked, so Surface keeps them read-only. The property keys still act on the peeked issue (the focused one), so changes show in peek at once, as in Linear.
4. **Loading:** peek requests the issue's content like the issue page (SPEC-012 §3.4 item 10); the description shows a skeleton after 150 ms, and "Available when online" offline when never hydrated. An issue the replica doesn't hold (a server-backed row) is read with `issue.get`; an archived or deleted one shows SPEC-012 §3.4 item 8's read-only state with its badge.
5. **Layout** (design-system §3): a small popover anchored beside the row or card, about 360 px wide, kept inside the window; the list keeps its own width. Below 768 px `Space` opens the issue page instead.
6. Peek doesn't change the URL. It closes when the route changes. With a selection, peek still follows focus, not the selection.

### 3.9 `Esc` chain (SPEC-012 §4.2 item 5, M2 steps)

Editor popover → leave the text field or editor → **close peek** → **clear the selection** → on the issue page, back to the source list. Overlays (menus, pickers, dialogs, the context menu) close first, as today.

### 3.10 M2 shortcut map (this spec's keys)

Linear's keys (D1–D4). The conflict test (SPEC-005 AC-7) covers these with SPEC-020, SPEC-021 and SPEC-023's keys.

| Keys | Scope | Action | Typing | Note |
|---|---|---|---|---|
| `X` | list | Toggle selection of the focused row | no | was reserved |
| `Shift+X` | list | Select from the anchor to the focused row | no | Linear board doc |
| `Shift+↓` / `Shift+↑`, `Shift+J` / `Shift+K` | list | Extend the selection down / up | no | `Shift+J/K` already in shortcuts.md |
| `Mod+A` | list | Select all in view | **no** | `whileTyping: false` |
| `Mod+Alt+A` | list | Select the focused row's group | **no** | matched on `KeyA` (Alt chord) |
| `Esc` | global (`ui:escape`) | Close peek, then clear the selection (§3.9) | yes | |
| `Space` | list | Peek the hovered or focused issue (toggle; hold for temporary) | no | |
| `Mod+Z` | global | Undo (replaces "restore the last deleted issue") | **no** | |
| `Mod+Shift+Z` | global | Redo | **no** | |
| `S` `P` `A` `I` `L` `Shift+E` `Shift+D` `Mod+Shift+D` `Mod+Backspace` `#` | issue | As SPEC-012, on the selection when there is one | as SPEC-012 | |

`Mod+Y` (Windows redo) is not bound: Linear documents `Cmd/Ctrl+Shift+Z` only (D3), and `Mod+Y` is a browser key in some browsers. The `issue` scope's definition already covers "selected in a list" (shortcuts.md §2).

## 4. Domain & client changes

No new synced model and no new invariant. New operations (§6), a client selection model, and the client undo stack.

### 4.1 Selection model (`apps/web/src/features/issues/selection.ts`)

Pure, unit and property tested: `toggle(id)`, `extendTo(id, viewOrder)`, `rangeTo(id, viewOrder)`, `selectAll(viewRows)`, `selectGroup(groupId)`, `clear()`, `retain(viewIds)` (drop ids that left the view). State: `{ ids: ordered set, anchor: id | null }`. The list and board views share it through the list model (SPEC-012 §4.4; SPEC-020's board uses the same).

### 4.2 Bulk edit semantics

- **One operation per chunk** of at most 250 issues (`issue.bulkUpdate`, `issue.bulkDelete`, `issue.bulkRestore`), not one `issue.update` per issue (Q13, ADR-0028). Reasons: the server's per-actor mutation limit is 120 per minute (SPEC-003 §9, `rate-limit.ts`), so 250 single updates would wait two minutes; one queue entry and one optimistic layer per chunk instead of 250; the operation is the `issue.bulkUpdate` that domain-model §7 and mcp-design §5 rule 2 already plan for MCP.
- **Per-issue outcomes.** The server checks each issue under its own row lock and applies it only if it passes (visible, live, the change valid for its team: status, labels, estimate scale, a private team's assignee). An issue that fails is **skipped**, with the code and message `issue.update` would have given; the others commit together. A database error fails the whole operation and writes nothing.
- **Invisible is unknown.** A ref that doesn't resolve, or resolves to an issue the actor can't see, is skipped as `NOT_FOUND` with the message SPEC-012 §3.4 item 7 uses ("ENG-99 doesn't exist, or you don't have access to it."), byte-identical for both (rule 4).
- **Chunks** are dispatched in view order, consecutive seqs, so the queue sends them in order; each is its own transaction. The client sums their outcomes into one toast and one undo entry.
- **The prediction** of `issue.bulkUpdate` runs `issue.update`'s prediction for each issue it holds (one shared function in `packages/operations`), so a bulk change and N single changes predict the same rows (AC-7). A skipped issue's prediction is dropped when the chunk is confirmed, because confirmation rebuilds the overlay from base (sync-protocol §5.2).

### 4.3 Undo entries and inverses

An **undo entry** (client memory, `apps/web/src/features/undo/`):

```
UndoEntry {
  id: string
  label: string                       // the action phrase: "set status of ENG-42 to Todo", "set priority of 12 issues to High"
  page: string                        // route path and query where it was made (§3.6 item 8)
  forward: OperationCall[]            // what was dispatched (all chunks)
  inverse: OperationCall[] | null     // null: not undoable here (§4.4)
  expect: Map<issueId, Map<field, value>>   // what the entry set, for §3.6 item 4
  state: 'pending' | 'confirmed' | 'undone'
}
```

**The `inverse` hook** (SPEC-003 §3.1) becomes `inverse(input, read) → OperationCall[] | null`: `read(model, id)` is the store as it was **before** the dispatch (base plus earlier pending mutations), extended by the web with the rows a server-backed view shows (§4.4). It is pure and runs at dispatch, before `optimistic`.

| Operation | Inverse |
|---|---|
| `issue.update` | `issue.update` setting every changed field back to its pre-value. Labels: `removeLabels` for labels it added that weren't there, `addLabels` for labels it removed or that the exclusive-group rule replaced (INV-07). Status side effects (`startedAt`, `completedAt`, `canceledAt`) are recomputed by the server, not restored (E14). |
| `issue.bulkUpdate` | One `issue.bulkUpdate` per distinct pre-value (per field), each over the issues that had that value, chunked to 250. E.g. a priority change over issues that were Low and None gives two calls. |
| `issue.delete`, `issue.bulkDelete` | `issue.restore` / `issue.bulkRestore` of the same issues |
| `issue.restore`, `issue.bulkRestore` | `issue.delete` / `issue.bulkDelete` of the issues that were **deleted** before. A restore of an **archived** issue has no inverse (there is no user archive operation, SPEC-015 D6), so such an entry is not undoable (E15). |
| `attachment.delete` | SPEC-014 §3.5's re-create (`attachment.createFile` on the detached file within 24 h, or `attachment.createLink`) (Q10) |
| SPEC-020's drag and reorder operations | SPEC-020 must give them an `inverse` that restores the previous property and the previous `sortOrder` key (its input names a key, or the previous neighbours) |

**Rules**

- **Redo** dispatches `forward` again, restricted to the issues the undo actually restored, and recomputes the inverse from the store at that moment.
- **Stack:** per tab, in memory only, newest 100 entries, cleared on reload, sign-out, store replacement and `resync` (sync-protocol §5.5, unchanged). A resync follows the loss of a private team (sync-protocol §6), so the stack never outlives what the user could see.
- **A rejected forward** removes its entry (nothing happened to undo). A skipped part of a bulk forward is removed from the entry's `expect` and inverse.
- **Undo while the forward is pending** is allowed: the inverse queues after it (seq order) and the server applies both in order.
- **A refused inverse** (`OptimisticRefusal` at dispatch, or a server refusal) is reported (§3.6 item 5); the entry counts as undone for the parts that applied, and the refused parts are not retried.
- **Every later operation that changes an issue property** (M3's project, cycle, parent, team move) declares `inverse` and a bulk field, or its spec says why it can't. A registry lint rule enforces a declared `inverse` for mutations listed as undoable (`UNDOABLE_OPERATIONS`, §12).

### 4.4 Pre-state for issues the replica doesn't hold

The replica holds no archived or deleted issue, and not every issue of a server-backed view (ADR-0020). For those, `read` falls back to the row the view displays (`IssueSummary` from `issue.list`, `issue.get` or SPEC-015's archive queries). If neither has the issue, the inverse is `null` and the entry is a **barrier** (§3.6 item 7). No extra server read is made to build an inverse.

## 5. Sync & permissions

- **Models:** no new model; no `schemaHash` change. `issue.bulkUpdate` writes Issue rows (and history) through the repo exactly as `issue.update` does: one `U` per changed issue (`D` then `U` when an assignee change moves a public issue's `user:` groups, sync-protocol §6). `issue.bulkDelete` and `issue.bulkRestore` write as their single forms (SPEC-015 §5.1).
- **Lock order** (SPEC-011 §4.8): key locks on every status and label the chunk newly sets, in id order, then the issue rows `FOR UPDATE` in ascending id (through `lockIssueForWrite` in `edit` or `lifecycle` mode), never the reverse, so bulk writers and single edits don't deadlock.
- **Lifecycle** (SPEC-015 §4.3): `issue.bulkUpdate` follows `issue.update`'s row (archived and deleted issues skipped with `CONFLICT`), `issue.bulkDelete` and `issue.bulkRestore` follow their single forms' rows, per issue. The table gains these rows (§12).
- **Private teams** (rule 4, permissions.md §5): visibility is checked per issue under the actor's `visibleGroups` and an API key's `teamIds`; an invisible issue is skipped exactly like an unknown one, and its status and label names never resolve in a team the actor can't see. The answer never names, counts or orders an invisible issue differently from an unknown id (AC-14).
- **Permissions:** anyone who can see an issue may edit, delete and restore it (permissions.md §3.3), so the bulk operations use `p.any()` like their single forms; `issue.bulkDelete` is `destructive` (an API key needs `allowDestructive`).
- **Offline:** bulk edits, deletes, undos and redos queue like any operation (sync-protocol §5.3). Their skipped parts arrive with the confirmation after reconnecting and are reported then (the shell's late-outcome toast).
- **Other tabs:** each tab has its own stack and sends its own queue (SPEC-002 E5). An undo in one tab never undoes another tab's change; a change made in another tab after this tab's entry is a "changed since" case (§3.6 item 4). A queue adopted from a closed tab arrives with no undo entries.
- **Undo is never a side channel:** inverses are registry operations dispatched through `dispatch` (rule 1), validated, permission-checked and logged like any other (rules 2 and 3).

## 6. API

### 6.1 New operations

| Operation | Kind | Input → output, notes |
|---|---|---|
| `issue.bulkUpdate` | m | `{issues: IssueRef[] (1–250, distinct), status?: StatusRef (scoped to each issue), priority?, assignee?: UserRef \| null, estimate?: int \| null, dueDate?: date \| null, addLabels?: LabelRef[] (scoped to each issue), removeLabels?: LabelRef[]}`, at least one change → `{updated: {id, identifier}[], skipped: {issue: <ref as given>, code, message, path?}[]}`. A label in both lists is `INVALID_INPUT`. Permission `p.any()`. Not destructive. `optimistic`: §4.2. `inverse`: §4.3. `ui`: none (property commands, SPEC-012 §3.8, gain the `issues` target). |
| `issue.bulkDelete` | m | `{issues: IssueRef[] (1–250)}` → `{deleted: {id, identifier, purgeAfter}[], skipped: […]}`. Destructive. `optimistic`: removes each held issue (as `issue.delete`). `ui`: **Delete issues…** in the `issues` context, `Mod+Backspace`. |
| `issue.bulkRestore` | m | `{issues: IssueRef[] (1–250)}` → `{restored: {id, identifier}[], skipped: […]}`. `optimistic`: none (as `issue.restore`). `ui`: **Restore issues** in the `issues` context, `#`. |

Each has a summary, description, ≥ 2 keywords and examples that run against the seed fixture (SPEC-003 §11). Names follow domain-model §7 and mcp-design §5 rule 2; the field is `issues` (reference types), not mcp-design's illustrative `ids` (§12).

### 6.2 Executor and protocol changes (ADR-0028)

1. **Lenient reference arrays.** A reference array may be declared `eachOrSkip` (SPEC-003 §4): an element that doesn't resolve, or isn't visible, is passed to the handler as unresolved instead of failing the call, and the handler reports it in `skipped` with the unknown-ref `NOT_FOUND` message. Only the three bulk operations may use it (`LENIENT_REF_OPERATIONS`, pinned by a lint test, like `OPAQUE_ID_OPERATIONS`).
2. **Per-issue checks in one transaction.** The handler composes `issue.update`'s, `issue.delete`'s and `issue.restore`'s internal functions (SPEC-003 Q2), checking each issue under its lock before writing it, so a refused issue writes nothing and the rest commit.
3. **Sync protocol v0.9 (additive).** An `ok` mutation result may carry `skipped: [{index, code, message, path?}]` (`index` into the input's `issues`, so no id is echoed), stored with the result so a replayed seq returns it. Older clients ignore it. `issue.bulk*` through `POST /api/ops` return `skipped` in their output as above.

### 6.3 Errors

- "Select at most 1,000 issues to change them together." (client, before dispatch)
- "These issues are in teams with no status in common. Select issues of one team to change their status." (client)
- "These issues' teams use different estimate scales. Select issues of one team to set an estimate." (client)
- "Rename works on one issue at a time." (client)
- "Can't undo: status of ENG-87 (it wasn't loaded here)." (client, §3.6 item 7)
- Skipped issues carry `issue.update`'s, `issue.delete`'s or `issue.restore`'s own messages (SPEC-011 §6.4, SPEC-015).
- `INVALID_INPUT` "Name 1 to 250 issues." and "Each issue can be named once." on `issues`.

## 7. UI

### 7.1 Components

| Where | What |
|---|---|
| `packages/ui` | `SelectionCheckbox` (row and card), `BulkActionBar`, `PeekPopover` (anchored popover, close), the Menu's checkbox-item and "mixed" state, the picker's "Mixed" trigger |
| `apps/web/src/features/issues/` | the selection model (§4.1) and its bindings, bulk dispatch and chunking, the bulk outcome toast and **Show all** dialog, `IssueContextMenu` (built from the command sources), peek content and its hold-`Space` controller, the undo-from-another-page dialog |
| `apps/web/src/features/undo/` | the undo stack, entry building from `inverse`, the "changed since" check, the Undo and Redo commands and bindings |
| `apps/web/src/command-menu/` | the `issues` target from a selection; a "context menu" rendering of a command source (no navigation section) |

**No new dependencies.**

### 7.2 States

| State | Shown |
|---|---|
| Selection empty | No bar, no checkboxes except on hover |
| Selection active | Checkboxes on every row, the bar, the chip "12 selected issues" in `Mod+K` |
| Bulk change in flight, online | The change is painted; the toast waits for confirmation ("Updating 12 issues…" after 1 s) |
| Bulk change offline | Painted and queued; the offline banner's count includes it (SPEC-005 §8) |
| Partly skipped | The §3.2 item 5 toast with **Show all** |
| Undo with nothing to undo | Nothing; `Mod+K` Undo unavailable |
| Undo barrier | "Can't undo: …" toast |
| Peek loading / offline | Skeleton after 150 ms / "Available when online" |
| Peek of an archived or deleted issue | Read-only with its badge (SPEC-012 §3.4 item 8) |

### 7.3 Accessibility (NFR-19)

- The list `treegrid` gets `aria-multiselectable="true"` and `aria-selected` on every issue row (SPEC-012 §7.4 deferred this to M2). Board cards get the same in their `grid` (SPEC-020).
- Polite announcements: "ENG-42 selected", "12 issues selected", "Selection cleared", "3 issues left the selection", "Updated 12 issues", "Undo set …", "Redo set …".
- The bar is a `toolbar` with a name; peek is a named, non-modal popover; the context menu is Radix's `menu`. Focus returns to the row after any menu or picker closes.
- Selection is never shown by colour alone: the checkbox is checked.
- Every story passes axe in light and dark.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | A selected issue is deleted, archived or leaves the filter by someone else's change | It leaves the selection; the count updates; one announcement per batch (§3.1 item 9). |
| E2 | A bulk edit names an issue someone else just deleted or that was auto-archived | That issue is skipped with `CONFLICT` ("ENG-42 was deleted. Restore it to edit it."); the rest apply; the toast reports it. |
| E3 | A bulk status change over issues of two teams, one of which has no status of that name (a status deleted meanwhile) | That team's issues are skipped (`NOT_FOUND` on `status`, reworded by `status-gone` when the replica saw the delete); the others change. |
| E4 | A bulk assignee change to a user who has just left a private team in the selection | The picker no longer offers them once the membership delta arrives; if already sent, that team's issues are skipped (`INVALID_INPUT`, INV-18) and the rest change. |
| E5 | A selection holds an issue of a private team the user was just removed from | The resync drops the rows and the stack (§4.3); the selection drops the ids. Anything already queued for them is answered `NOT_FOUND` (skipped), worded as for an unknown issue. |
| E6 | Someone changes ENG-42's priority after my bulk priority change, then I press `Mod+Z` | ENG-42 is left alone (changed since); the others are undone; the toast says so (§3.6 item 4). |
| E7 | I undo a status change, but the old status was deleted meanwhile | The inverse is refused (`NOT_FOUND` / `CONFLICT` on `status`, "That status was deleted. Choose another."); the toast reports it; the entry counts as undone. |
| E8 | I undo an edit on an issue that has since been archived or deleted | Refused with SPEC-011's `CONFLICT` message; reported; not retried. |
| E9 | I undo a delete after someone permanently deleted the issue, or after `purgeAfter` | `issue.restore` is refused (SPEC-015); the toast shows the server's message. |
| E10 | I press `Mod+Z` twice quickly | Two entries are undone, in stack order; each inverse queues after the one before. |
| E11 | I make a change, go offline, undo, redo, then reconnect | Four mutations queue in order and apply in order; the end state is the redone change (unless changed since by someone else, which the server's last-writer-wins settles, NFR-07). |
| E12 | The forward change is rejected after I already pressed `Mod+Z` | The entry is dropped. The queued inverse sets the values the issue already has (or restores a live issue), which the server treats as a no-op (SPEC-011 E12, SPEC-015 §4.3). |
| E13 | Two tabs: tab A changes priority, tab B changes it again, tab A presses `Mod+Z` | Tab A sees B's value (same replica's deltas) and leaves it (changed since). |
| E14 | I complete an issue (sets `completedAt`), then undo | The status goes back; the server recomputes the timestamps from the categories (INV-20), so `completedAt` is cleared and `startedAt` follows state-machines §1, not the old value. |
| E15 | I restore an archived issue from the archive page, then press `Mod+Z` | "Can't undo: restore of ENG-42 (Surface archives issues automatically only)." The entry is popped. |
| E16 | Labels: I add `Bug` to 5 issues; 2 already had it; 1 had `Feature` in the same exclusive group | Undo removes `Bug` from the 3 that didn't have it and re-adds `Feature` to the one it replaced; the 2 keep `Bug`. Label order may change (a re-added label goes last). |
| E17 | `Mod+A` in a view of 3,000 issues, then `S` | Refused before sending: "Select at most 1,000 issues to change them together." (Q4). |
| E18 | `Mod+A` with Completed and Canceled collapsed | Their issues are selected too (D5), and the bar counts them, so `S` then changes them as well. A collapsed header shows how many of its rows are selected. |
| E19 | `Mod+A` while focus is in the filter field (SPEC-021) or a picker | Selects the field's text (`whileTyping: false`); the picker scope wins. |
| E20 | `Space` while focus is in a text field, a button or a picker | Types a space, presses the button, or toggles the picker's label; no peek. |
| E21 | Holding `Space` and pressing `J` meanwhile | The hold counts as a toggle (another key came between), so peek stays open and follows focus. |
| E22 | Right-click on an unselected row while 5 are selected | The single-issue menu acts on that row only; the selection stays (D8). |
| E23 | Right-click on an archived row in the archive page with a mixed selection | The menu offers what applies to every target (Restore; Delete only if all are archived), as `Mod+K` does for the same target. |
| E24 | A bulk edit over 600 issues | Three chunks (250, 250, 100), one toast and one undo entry; if the second is refused whole, the toast says which part changed and the entry holds only the confirmed chunks. |
| E25 | An undo entry's inverse holds more calls than the rate limit allows at once | The queue resends after `Retry-After` (sync-protocol §4.4); the toast waits; nothing is dropped. |
| E26 | The user leaves the route with a bulk change in flight | The selection clears; the change continues and its toast shows wherever the user is. |
| E27 | Peek is open and the peeked issue is deleted | Peek switches to the deleted state like the issue page (SPEC-012 E3) until focus moves. |
| E28 | `Mod+Z` while the composer or a dialog is open | Nothing (global bindings don't fire over an overlay, shortcuts.md §1 rule 2); text fields undo text. |
| E29 | A bulk edit whose every issue is skipped | `ok` with all skipped; the toast says "None of the 3 issues were changed: …"; no undo entry. |
| E30 | `Mod+Z` when the newest entry was made on another page | The dialog of §3.6 item 8 asks first; Cancel leaves the stack as it is; Undo navigates there and undoes. |
| E31 | `Mod`-click on a row | The issue opens in a new browser tab; the selection and focus stay (D6). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)); they are marked ⏸ and checked by hand. **Not held:** unit and property tests, the sync property suite (sync-sim real-server files) and private-team leak tests (`*-leak.int.test.ts`, Postgres allowed).

| AC | Criterion | Test |
|---|---|---|
| AC-1 | Selection keys and mouse: `X` toggles and sets the anchor; `Shift+↓/↑`, `Shift+J/K`, `Shift+X` and shift-click select the range from the anchor, skipping headers and collapsed rows; the checkbox toggles; `Mod`-click opens the issue in a new tab and leaves the selection alone; `Mod+A` selects every listed row, collapsed groups included; `Mod+Alt+A` selects the focused group; `Esc` clears. | unit (selection model, bindings) |
| AC-2 | **Property:** for any sequence of selection actions and view changes (rows added, removed, re-sorted, groups collapsed), the selection is a subset of the view's issue rows, in view order, with no duplicates, and `retain` drops exactly the ids that left. | property (fast-check) |
| AC-3 | Selection survives re-sorts, a list/board switch and the issue-page round trip; it clears on `Esc` and on leaving the route; it is per tab. | unit |
| AC-4 | With a selection, each property key, bar button, context-menu item and `Mod+K` property command dispatches `issue.bulkUpdate` over the selection with the right field; without one, it acts on the focused row as in M1. `Shift+R` refuses on a multi-selection. | unit (fake dispatcher) |
| AC-5 | Pickers on a selection: mixed values show unchecked and "Mixed"; the status picker offers shared name-and-category statuses across teams (none: the hint); the assignee picker offers only users assignable to every issue; team labels only for a one-team selection; tri-state labels apply one update on close; estimate only for one shared scale. | unit + story |
| AC-6 | Chunking: a selection of N issues is sent as ⌈N/250⌉ operations in view order with consecutive seqs; over 1,000 is refused before dispatch. **Property:** chunks cover each id exactly once, in order. | unit + property |
| AC-7 | **Property:** for any replica state and patch, `issue.bulkUpdate`'s optimistic over issues I equals applying `issue.update`'s optimistic to each issue of I in order. | property (fast-check, `packages/operations`) |
| AC-8 | Server: `issue.bulkUpdate` applies each valid issue and skips each invalid one with `issue.update`'s code and message (archived, deleted, status not in the team, label rules, estimate scale, private-team assignee, unknown); history and `issue.updated` events are per changed issue; a skipped issue writes nothing; an injected database error writes nothing at all. | sync property suite (`bulk-real-server.int.test.ts`, real executor and Postgres) + unit (handler with a fake repo) |
| AC-9 | **Sync property:** random clients mixing `issue.update`, `issue.bulkUpdate`, `issue.bulkDelete`, `issue.bulkRestore`, undos and redos under network faults converge: every client equals a fresh bootstrap once quiescent (sync-protocol §10.1), and no mutation is applied twice (§10.2). | sync property suite (sync-sim fake hub `bulk-undo.prop.test.ts` + `bulk-real-server.int.test.ts`) |
| AC-10 | **Leak:** a bulk operation naming a mix of visible issues, a private team's issue the actor isn't in, an issue outside an API key's `teamIds`, and an unknown id applies only the visible ones; the invisible and unknown entries are byte-identical in `skipped` (code, message, path, position) over `POST /api/ops` and `/sync/mutate`; nothing is written, logged or delivered for them; an Admin outside the private team gets the same. | leak test (`bulk-leak.int.test.ts`, Postgres allowed) |
| AC-11 | **Leak:** a status or label named in a bulk edit never resolves to a private team's status or label for a non-member; `skipped` never names a private team, issue, status or label; a stored `skipped` result replays identically. | leak test (`bulk-leak.int.test.ts`) |
| AC-12 | `skipped` on `/sync/mutate` (v0.9): the codec accepts results with and without it, the stored result replays it, and an older client's decoder ignores it. | unit (sync-protocol codecs, server mutate route with a fake executor) |
| AC-13 | The executor's lenient reference arrays: only the operations in `LENIENT_REF_OPERATIONS` may declare one (lint test); an unresolved element reaches the handler as unresolved and never fails the call. | unit (lint, resolver) |
| AC-14 | Lock order: a bulk edit and concurrent single edits, label deletes and auto-archive on overlapping issues never deadlock and end in a state equal to some serial order. | sync property suite (`bulk-real-server.int.test.ts`) |
| AC-15 | Bulk delete opens `Delete N issues?`, sends `issue.bulkDelete` only on **Delete**, removes the held issues optimistically; bulk restore on the archive page sends `issue.bulkRestore`; their lifecycle rule table rows exist and are tested per row (SPEC-015 AC-1). | unit (dialog, lifecycle table test) |
| AC-16 | Bulk outcome: one toast for all chunks ("Updated 12 issues", the partial wording, "None of …"), with **Undo**; **Show all** lists each skipped issue with its reason; offline, the report comes after reconnecting. | unit (outcome aggregator, fake dispatcher) |
| AC-17 | Bulk action bar: shows only with a selection, holds the §3.3 actions with key hints, follows the list in `Tab` order, collapses below 768 px. | unit + story |
| AC-18 | Context menu: for every target (one live issue, one archived, one deleted, a live selection, a mixed archive selection), its commands are exactly the `Mod+K` suggestions for that target minus navigation and global commands, in §3.5's order, with key hints; right-click on a selected row targets the selection, on an unselected row that row only; the context-menu key opens it on the focused row. | unit (menu built from command sources, per-target table) + story |
| AC-19 | `Mod+Z` / `Mod+Shift+Z` and `Mod+K` Undo / Redo: undo dispatches the entry's inverse, redo its forward; when the entry was made on another page the dialog of §3.6 item 8 asks first, and Undo navigates there; a new action clears redo; the stack keeps 100 entries and clears on reload, sign-out, store change and resync; neither key fires while typing or over an overlay; M1's last-delete binding is gone and `Mod+Z` after a delete restores it. | unit (stack, bindings) |
| AC-20 | **Property:** for any issue state and any `issue.update` or `issue.bulkUpdate` input, applying its optimistic, then its inverse's optimistic, gives back the pre-state's status, priority, assignee, estimate, due date and title, and the same label **set**; delete then its inverse restores; restore of a deleted issue then its inverse deletes. | property (fast-check, `packages/operations`) |
| AC-21 | **Property (stack model):** for any sequence of do, undo, redo, confirm, reject and remote change, undo never overwrites a field whose stored value differs from what the entry set; a rejected forward leaves no entry; undo-all then redo-all with no remote change returns to the same state. | property (fast-check, undo stack with a fake store) |
| AC-22 | Undo feedback: the undo and redo toasts read "Undo <action>." and "Redo <action>."; a single property change and a plain delete add no Undo toast, and a delete shows "Deleted ENG-42" with "View recently deleted" and no Undo button; the toasts name the change; skipped, refused and changed-since parts are counted in the same toast; a barrier entry shows "Can't undo: …" and is popped. | unit |
| AC-23 | Pre-state for issues not in the replica comes from the view's server rows; with neither, the entry is a barrier; no server read is made to build an inverse. | unit (inverse reader) |
| AC-24 | Peek: `Space` on the hovered (else focused) row toggles a read-only popover with identifier, status and age, priority, assignee and description; a hold of more than 300 ms shows it while held, another key during the hold makes it a toggle, `Esc` closes it, `J`/`K` make it follow focus; focus stays in the list; content loads like the issue page (skeleton, "Available when online", `issue.get` for a row not held, read-only for archived or deleted); below 768 px `Space` opens the issue page. | unit (controller with fake timers, content loader) + story |
| AC-25 | Peek property keys change the peeked issue and the change shows in the popover; the popover never edits anything. | unit |
| AC-30 | The Copy submenu on a selection lists the seven items of §3.5 item 6 in that order, each copies SPEC-012 §3.7's string for every selected issue in view order, and "Copy as prompt" is absent. | unit (copy builders, menu model) |
| AC-26 | Accessibility: `aria-multiselectable` and `aria-selected` on rows, the bar's toolbar name, peek's region name, the §7.3 announcements; stories pass axe in light and dark. | unit (announcer) + story (axe) |
| AC-27 | Every binding of §3.10 is registered with a command, shows in `?`, passes the conflict and reserved-keys tests, and `Mod+A`, `Mod+Alt+A`, `Mod+Z` and `Mod+Shift+Z` set `whileTyping: false`. | unit (registry, conflicts) |
| AC-28 | Keyboard only: select a range, set its status, undo, redo, peek, right-click equivalent (context-menu key), bulk delete and undo the delete. | e2e ⏸ (checked by hand) |
| AC-29 | A bulk change of 250 issues paints in < 50 ms after the choice (NFR-01) and commits on the server in < 1 s p95 at the reference scale; `Mod+A` on 10,000 rows selects in < 50 ms. | perf ⏸ (`*.perf.test.ts` for the client parts, deep tier; server part checked by hand) |

## 10. Metrics & performance

- Local selection, bulk paint, undo and redo paint: p95 < 50 ms (NFR-01), including `Mod+A` over 10,000 rows.
- One bulk chunk of 250 issues commits in < 1 s p95 on the reference machine; its deltas reach other clients within NFR-02's 150 ms after commit.
- Peek opens in < 100 ms from a hydrated cache (the issue page budget).
- No new log events beyond the executor's per-operation line; a bulk operation logs `updated` and `skipped` counts, never ids of skipped issues.

## 11. Open questions

Each has a proposed default; the user can accept them in bulk.

| # | Question | Proposed default |
|---|---|---|
| Q1 | When undoing, what happens to a field someone changed since? Linear's docs don't say. | Leave that issue's field as it is and say so in the toast (client check against the store, §3.6 item 4). A server-side precondition (an `expect` input on `issue.update`) is not added in M2; offline undos rely on last-writer-wins. |
| Q2 | `Mod+A` on a server-paged view (archive tabs, server-backed views of SPEC-021/023) | Select the loaded rows only, with "· more not loaded" in the bar. No "select all N matching" in M2. |
| Q3 | **Decided, see D5.** Does `Mod+A` select rows inside collapsed groups? | Yes, as Linear. |
| Q4 | Limit on a bulk action | 1,000 issues per action (4 chunks of 250); selecting has no limit. |
| Q5 | **Decided, see D6.** `Mod`-click on a row | Opens the issue in a new browser tab; it doesn't toggle selection. |
| Q6 | **Partly decided, see D7.** Still open: the toast for a **bulk** change (not observed in Linear's web app). Linear shows none for a single property change, a toast for each undo and redo, and "Deleted <ID>" for a delete. | "Updated N issues" with **Undo** for bulk; the rest as D7. A difference found later is a dated change here. Changes design-system §4 principle 5 and command-menu §3.2, §3.4 (§12). |
| Q7 | **Decided, see D8.** Right-click on an unselected row while a selection exists | The menu targets that row only; the selection stays. |
| Q8 | **Decided, see D9.** Copy actions on a selection | The seven items of §3.5 item 6; `Mod+.` copies the IDs. |
| Q9 | Context menus on other items (sidebar teams and views, group headers, comments) in M2 | Issue rows and cards only. Group headers, sidebar items and views later (with SPEC-021 for views). |
| Q10 | Does attachment removal join the undo stack? | Yes: `Mod+Z` re-creates it as SPEC-014's Undo toast does; the toast's **Undo** button stays. |
| Q11 | **Decided, see D10.** Redo of a delete | Deletes again without the dialog (the user confirmed it once). |
| Q12 | **Decided, see D11.** Is peek editable (pills open pickers, description editable)? | A small read-only popover; property keys act on the peeked issue. |
| Q13 | Bulk edit as one `issue.bulkUpdate` per chunk with per-issue skips (needs lenient ref arrays and sync protocol v0.9), or one `issue.update` per issue (no protocol change, but needs the session mutation rate limit raised or lifted, and 250 queue entries per chunk)? | `issue.bulkUpdate` with per-issue skips, recorded in ADR-0028. |
| Q14 | Chunk size per bulk operation | 250 issues. |
| Q15 | Undo stack scope | Per tab, memory only, 100 entries, cleared on reload, sign-out and resync (sync-protocol §5.5 as accepted). Not shared across tabs or devices. |
| Q16 | Are bulk delete and restore new operations (`issue.bulkDelete`, `issue.bulkRestore`) rather than N single calls? | Yes, for the same reasons as Q13. |
| Q17 | **Decided, see D12.** Should undo be offered after navigating away from where the change was made? | Yes, after a dialog that offers to go back to that page (§3.6 item 8). |
| Q18 | Does `Esc` clear the selection? In Linear's web app on 2026-11-25 it did not after `Mod+A`; the bar's × did. That may have been a focus artefact. | `Esc` clears the selection (§3.9), and the bar's × does too. Re-check Linear when the slice is built. |

## Decisions

Behaviour copied from Linear's public docs under the standing rule "copy Linear". Everything else is in §11.

| # | Decision | Source |
|---|---|---|
| D1 | Highlight (focus) and select are distinct; `X` selects the highlighted issue; shift-click selects; a checkbox shows near a row's left edge on hover; `Shift` with `↑`/`↓` extends the selection; `Mod+A` selects every issue on the list or board; `Esc` clears; with a selection, `Mod+K` and right-click act on it; properties are changed "like you would any issue"; common bulk actions sit in a toolbar at the bottom. Source: [linear.app/docs/select-issues](https://linear.app/docs/select-issues), [creating-issues § Select issues](https://linear.app/docs/creating-issues), [assigning-issues](https://linear.app/docs/assigning-issues) ("right-click to update the assignee from the bulk action bar"). |
| D2 | Selection on the board | The board uses the same selection keys, `Shift+X` or shift-click to select several, and `Space` on a card to peek. Source: [linear.app/docs/board-layout](https://linear.app/docs/board-layout). |
| D3 | `Mod+Z` after a delete | `Mod+Z` restores an issue right after it was deleted ("the fastest way to restore it"), and undoes a team move; the editor uses `Mod+Z` / `Mod+Shift+Z` for text. Source: [delete-archive-issues](https://linear.app/docs/delete-archive-issues), [editing-issues](https://linear.app/docs/editing-issues), [editor](https://linear.app/docs/editor). |
| D4 | `Space` toggles peek | `Space` toggles peek; holding `Space` shows it only while held. Source: [custom-views § Peek preview](https://linear.app/docs/custom-views). |
| D5 | Q3: `Mod+A` and collapsed groups | **Decided by the user on 2026-11-25** ("we want same as Linear"): `Mod+A` includes issues in collapsed groups. In Linear the bar read "19 selected" and a collapsed header read "14 · 15 selected". Checked in Linear's web app on 2026-11-25. |
| D6 | Q5: `Mod`-click on a row | **Decided by the user on 2026-11-25** ("we want same as Linear"): `Mod`-click opens the issue in a new browser tab and does not toggle selection; selection is by `X`, shift-click and the hover checkbox. Checked in Linear's web app on 2026-11-25. |
| D7 | Q6: toasts (single change, undo, redo, delete) | **Decided by the user on 2026-11-25** ("we want same as Linear"): no toast for a single property change; undo shows "Undo <action>." (for example "Undo set status of TUN-545 to Todo.") and redo "Redo …"; a delete shows "Deleted <ID>" with "You can restore deleted issues from the archive" and a "View recently deleted" action, and no Undo button. The toast for a bulk change was not observed, so that part of Q6 stays open. Checked in Linear's web app on 2026-11-25. |
| D8 | Q7: right-click on an unselected row while others are selected | **Decided by the user on 2026-11-25** ("we want same as Linear"): the single-issue menu for that row, and the selection stays. This is the spec's default. Checked in Linear's web app on 2026-11-25. |
| D9 | Q8: copy on a selection | **Decided by the user on 2026-11-25** ("we want same as Linear"): the Copy submenu lists Copy IDs (`Mod+.`), Copy URLs, Copy titles, Copy titles as links, Copy issues as Markdown, Copy everything as Markdown and Copy git branch name (a local string, no integration). Linear's "Copy as prompt" was left out: built-in AI is out of scope (CLAUDE.md). Checked in Linear's web app on 2026-11-25. |
| D10 | Q11: redo of a delete | **Decided by the user on 2026-11-25** ("we want same as Linear"): redo deletes again without the dialog. This is the spec's default. Checked in Linear's web app on 2026-11-25. |
| D11 | Q12: peek | **Decided by the user on 2026-11-25** ("we want same as Linear"): `Space` on a hovered row opens a small read-only popover (identifier, status and age, priority, assignee, description); the property keys act on the peeked issue. Whether the pills in Linear's popover are clickable wasn't checked, so Surface keeps them read-only. This replaces the side panel with activity that this spec first proposed. Checked in Linear's web app on 2026-11-25. |
| D12 | Q17: undo after navigating away | **Decided by the user on 2026-11-25** ("we want same as Linear"): Linear asks in a dialog, "Undo <action>? This operation was performed on a different page than you are currently on. Open that page and undo the operation?", with Cancel and Undo; Undo goes back to that page and undoes there. Checked in Linear's web app on 2026-11-25. |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| ADR | new | **ADR-0028 Bulk issue operations with per-issue outcomes:** `issue.bulkUpdate`, `issue.bulkDelete`, `issue.bulkRestore` as one operation per chunk of ≤ 250, per-issue checks in one transaction, lenient reference arrays limited to `LENIENT_REF_OPERATIONS`, `skipped` on `ok` mutation results (sync protocol v0.9); the rejected option (one `issue.update` per issue) and the rate-limit reason. | New ADR |
| ADR | new | **ADR-0029 Undo and redo as inverse operations:** inverses are registry operations built at dispatch from the pre-dispatch store (`inverse(input, read) → calls[]`), a per-tab memory stack of 100, the "changed since" client check, barriers for missing pre-state, what is and isn't undoable. Elaborates sync-protocol §5.5 without changing it. | New ADR (no supersession) |
| SPEC-003 | §3.1 `inverse` | `inverse(input, read)` returns `OperationCall[] \| null` (was one call); `read` is the pre-dispatch store view; implemented in M2 for the operations of this spec's §4.3. Add `UNDOABLE_OPERATIONS` and a lint rule: each listed mutation declares `inverse`. | No (ADR-0029) |
| SPEC-003 | §4 | Add lenient reference arrays (`eachOrSkip`) for `LENIENT_REF_OPERATIONS` only (§6.2), with the unknown-ref `NOT_FOUND` message per skipped element. | No (ADR-0028) |
| SPEC-003 | §11 | New rule 9: lenient reference arrays only in `LENIENT_REF_OPERATIONS`; every mutation in `UNDOABLE_OPERATIONS` declares `inverse`. | No |
| SPEC-003 | §2 Out of scope | Remove "`inverse()` for undo (… implemented in M2)". | No |
| sync-protocol.md | §4.4, §11 | v0.9, additive: an `ok` result may carry `skipped: [{index, code, message, path?}]`, stored for replay. | No (ADR-0028) |
| sync-protocol.md | §5.5 | Add: "one user action is one entry, whatever number of mutations it sent; the inverse is computed before the dispatch's optimistic; fields changed since are skipped (SPEC-022 §3.6)". | No |
| sync-protocol.md | §10 | Test obligation 9: bulk operations and undo/redo interleaved with other clients converge (SPEC-022 AC-9). | No |
| SPEC-015 | §4.3 table | Rows: `issue.bulkUpdate` as `issue.update`, per issue; `issue.bulkDelete` as `issue.delete`, per issue; `issue.bulkRestore` as `issue.restore`, per issue. | No |
| SPEC-015 | §3.1 item 4 | "until M2's general undo stack replaces it" → `Mod+Z` undoes the delete as the newest entry of the undo stack (SPEC-022). | No |
| SPEC-012 | §3.6, §3.11 item 3, §4.2 items 5–6, AC-16 | The last-delete slot and `issue.restoreLastDeleted` are replaced by the undo stack; the `Esc` chain gains "close peek" before "clear the selection"; `X`, `Shift+X`, `Mod+A`, `Mod+Alt+A`, `Space` leave the reserved list; §7.4's deferred `aria-selected` arrives. Dated "Changed (SPEC-022)". | No |
| SPEC-012 | §3.11 item 2, D8 | A delete shows the toast "Deleted ENG-42" with "View recently deleted" and no Undo button (SPEC-022 §3.2 item 6, D7); "no Undo toast" keeps meaning no Undo button. The Copy submenu on a selection lists the seven items of SPEC-022 §3.5 item 6. Dated "Changed (SPEC-022)". | No |
| SPEC-005 | §4, §5 | Command targets: the `issues` target comes from a list selection; command sources can render as a context menu (no navigation or global sections). Undo / Redo commands. | No |
| SPEC-011 | §6.1 | Note: `issue.update` declares `inverse` (SPEC-022 §4.3); `issue.bulkUpdate` reuses its checks and history per issue. | No |
| domain-model.md | §7 | `issue.bulkUpdate` stays; add `issue.bulkDelete` and `issue.bulkRestore`. | No |
| mcp-design.md | §4 example | `issue.bulkUpdate`'s input is `{issues: [...], ...}`, not `{ids: [...]}`; its output has `updated` and `skipped`. | No |
| permissions.md | §3.3, §5 | Bulk edit, delete and restore follow the single operations' rules per issue. Leak checklist item: "A bulk operation answers an invisible issue exactly like an unknown id, writes nothing for it, and never resolves a name in an invisible team" (`bulk-leak.int.test.ts`). | No |
| events.md | `issue.updated` row | Note: a bulk edit emits one event per changed issue; there is no bulk event. | No |
| shortcuts.md | §3.1, §3.3 | `Mod+Z` / `Mod+Shift+Z` row becomes M2 "Undo / redo"; remove the M1 last-delete row. Lists: add `Shift+X`, `Shift+↑`/`↓`, `Mod+Alt+A`; `Mod+A` "not while typing"; `Space` "toggle; hold for temporary". `Esc`: "close the overlay, close peek, clear the selection". | No |
| command-menu.md | §3.2, §3.3, §3.4 | Replace "the menu closes and an Undo toast shows" with D7's rule (no toast for one issue; a toast with Undo for bulk, Q6). Undo and Redo are titled "Undo set status of ENG-42 to Todo". Multiple-selected context: titles "… of N issues", Delete issues…, Restore issues, and the seven Copy items of §3.5 item 6 (D9). Add: the context menu renders the same sources for the same target (§3.5). | No |
| design-system.md | §3 Peek, §4 principle 5, §5.1 Toast, §5 components | Peek: a small read-only popover (about 360 px, anchored to the row; D11), replacing the 480 px resizable side panel and the peek column of the layout sketch; none below 768 px. Principle 5: reversible single-issue property changes apply at once **without** a toast; `Mod+Z` undoes them and its toast reads "Undo <action>." (D7); bulk changes show "Updated N issues" with Undo (Q6). Add `BulkActionBar`, `SelectionCheckbox`, `PeekPopover`. | No |
| PRD | FR-NAV-05, 06, 07, 11; §5.6 key criterion | Link SPEC-022; FR-NAV-06: "per tab, 100 steps; changes made by others since are left alone". Remove "In M1, `Cmd+Z` restores only the last deleted issue". | No |
| glossary.md | terms | Add **Selection**, **Anchor**, **Peek**, **Undo entry**, **Bulk action bar**. | No |
| specs README | M2 table | Add SPEC-022 (FR-NAV-05, 06, 07, 11). | No |
