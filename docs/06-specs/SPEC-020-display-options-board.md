# SPEC-020: Display options and board

Status: **Draft** · Milestone: **M2** · Date: 2026-11-25
Implements: FR-VIEW-02 (board layout, `Mod+B`; the list shipped in M1), FR-VIEW-03 (grouping, sub-grouping and swimlanes), FR-VIEW-04 (ordering, with a manual order shared by everyone), FR-VIEW-05 (drag between groups changes the property, drag within a group reorders), FR-VIEW-06 (display properties), FR-VIEW-07 (toggles: sub-issues, empty groups, completed issues), FR-VIEW-14 (10k+ issues at 60 fps) · NFR-01, NFR-04, NFR-19, NFR-20
Depends on: SPEC-012 (the list, IssueRow, GroupHeader, VirtualList, the list focus model, the property pickers, the M1 shortcut map), SPEC-011 (Issue, `sortOrder`, `issue.update`, partial issue loading §5.7), SPEC-010 (statuses, labels and label groups, estimate scales), SPEC-005 (shortcut engine, command menu), SPEC-021 (where view state is stored, filters, and which issues a view holds)
Related: SPEC-022 (multi-select, moving a selection, undo and redo, context menu, peek) · SPEC-023 (My issues tabs) · [design-system §5.3](../05-design/design-system.md) · [shortcuts §3.3](../05-design/shortcuts.md) · [command-menu §2](../05-design/command-menu.md)

---

## 1. Problem & goal

M1's issue list has one fixed shape: grouped by status, ordered by priority, with fixed columns. Teams plan in different shapes. A lead wants a board of status columns to drag work across; an engineer wants their team's issues grouped by assignee; someone triaging wants the newest first. This spec adds Linear's **display options**: list or board layout (`Mod+B`), grouping and sub-grouping (board swimlanes), ordering (including a **manual order that everyone shares**), which properties show on rows and cards, and the toggles for empty groups and completed issues. Dragging a card to another column changes the property behind the column; dragging it within a column reorders it. Every option works by keyboard, and a view of 10,000 issues scrolls at 60 fps in both layouts.

This spec **owns the shape of view state** (§4.1): the layout and display options of one view. SPEC-021 stores it (personal overrides, "Set as default", custom views) and decides which issues a view holds (filters, partial loading).

## 2. Scope

**In scope**

- The **view state** (§4.1): its fields, defaults, validation and versioning, shared by every issue list and board.
- The **Display options** popover (`Shift+V`, §3.1) and its command-menu commands (§3.12).
- **Board layout** (§3.5): columns, swimlanes, cards, the column menu (hide a column), create in a column, horizontal and vertical virtualisation.
- **Grouping and sub-grouping** (§3.3) in both layouts: none, status, assignee, priority, label, a label group, and team.
- **Ordering** (§3.4): manual, status, priority, last created, last updated, due date, estimate; reverse.
- **Manual order** (§4.3): the `position` input on `issue.update`, its server rules and its optimistic update.
- **Drag and drop** (§3.6) with the mouse, and the same moves by keyboard (§3.7).
- **Display properties** (§3.8) and the group count (issues or estimate sum).
- **Toggles** (§3.9): show empty groups, completed issues (all, past week, past month, none). Show sub-issues is reserved for M3.
- Generalising SPEC-012's list (grouping, nested sub-group headers, visible columns) and its focus model to two dimensions on the board.

**Out of scope**

- Filters, the filter bar, filters in the URL, custom views, the built-in team views (All issues, Active, Backlog), personal overrides versus "Set as default", favorites, and where a view's issues come from: **SPEC-021**.
- Multi-select, moving or dragging a selection, bulk edit, undo and redo of moves, the right-click menu on a card, peek (`Space`): **SPEC-022**. This spec defines what one issue's move does; SPEC-022 applies it to a selection and makes it undoable.
- My issues tabs and whether they have display options: **SPEC-023** (this spec's view state is available to it).
- Grouping by project, cycle or parent issue; the project, cycle and milestone display properties; the **Show sub-issues** toggle; nested sub-issues in lists: **M3**, when those fields exist (§3.10).
- Linear options for features Surface doesn't have or won't build: customer, release, SLA status, links count, time in status, pull requests, Sentry (integrations are out of scope, CLAUDE.md). Timeline layout (FR-VIEW-13, M5). Focus grouping of My issues (SPEC-023 may take it). List density (Later, SPEC-005 §2).
- Sidebar team reordering by drag (SPEC-005 §7 mentions it for M2; it isn't in this spec's requirements).

## 3. User flows

Every flow below applies to any issue view that SPEC-021 renders: a team's All issues, Active and Backlog, and custom views. Copying Linear's documented behaviour, cited as [Linear: Display options](https://linear.app/docs/display-options) and [Linear: Board layout](https://linear.app/docs/board-layout).

### 3.1 Display options (`Shift+V`)

1. `Shift+V` (list scope), the **Display** button in the view header (design-system §3, ViewToolbar), or "Show display options" in `Mod+K` opens the Display options popover, anchored to the button. Focus goes to its first control. Linear uses the same key and command ([Linear: Display options](https://linear.app/docs/display-options), "Keyboard").
2. The popover holds, top to bottom:
   - **Layout:** a SegmentedControl, List · Board (`Mod+B` does the same, §3.2).
   - **Grouping** and **Sub-grouping:** two selects (§3.3).
   - **Ordering:** a select and a reverse button (↑↓) beside it (§3.4). The reverse button is disabled for Manual, with the tooltip "Manual order can't be reversed."
   - **Completed issues:** a select, All · Past week · Past month · None (§3.9). Hidden on views that hold no completed issues (SPEC-021: Active, Backlog).
   - **Show empty groups:** a Switch (§3.9). Hidden while grouping is None.
   - **Display properties:** a wrap of toggle chips, one per property (§3.8).
   - A footer, owned by SPEC-021 §3.6: **Reset to default** (shown when the user's view state differs from the default) and **Set as default** (shown when it differs from the default, for users allowed to set it).
3. Every change applies at once to the open view and is kept as the user's personal view state for that view (SPEC-021 §3.6: Linear's "To update for your view only, simply modify the display options"). There is no Apply button. `Esc` or a click outside closes the popover and returns focus to the Display button, or to the focused row when it was opened with `Shift+V`.
4. Controls that don't apply right now are hidden, not disabled (Sub-grouping and Show empty groups while Grouping is None, Completed issues on Active and Backlog). The one exception is the reverse button, which stays visible and disabled for Manual, with its reason.

### 3.2 Layout: list or board (`Mod+B`)

1. `Mod+B` (list scope, not while typing) toggles between list and board, as in Linear ([Linear: Board layout](https://linear.app/docs/board-layout), "Configure"). So do the Layout control in Display options and "Switch to board layout" / "Switch to list layout" in `Mod+K`.
2. Grouping, sub-grouping, ordering, properties and toggles are **shared** by both layouts: "Board views and List view cannot be ordered independently" ([Linear: Board layout](https://linear.app/docs/board-layout), "Feature parity"). The two exceptions are **Show empty groups** and **hidden columns**, kept per layout (§4.1; Q3).
3. The focused issue stays focused across the switch, and is scrolled into view.
4. A board with grouping None has one column, named after the view ("All issues", the custom view's name).
5. **Below 768 px** the board isn't offered: the view renders as a list, and the Layout control and `Mod+B` are hidden (NFR-20: the small layout is for reading, commenting and changing properties). The stored layout is kept and returns at a wider width.

### 3.3 Grouping and sub-grouping

**Options** (Linear's list, cut to the fields Surface has in M2; [Linear: Display options](https://linear.app/docs/display-options), "Grouping"):

| Grouping | Groups | Group order | Header shows |
|---|---|---|---|
| None | one | — | no header in a list; one column on a board |
| Status | a team view: the team's statuses in workflow order (SPEC-010: category order, then position), Triage and Duplicate left out (M2 has neither); a view over several teams: **named status groups**, one per status name, in category order then name, as SPEC-012 §3.9's My issues | as listed | StatusIcon, name, count, `+` |
| Assignee | No assignee, then users by name (Q6) | as listed | Avatar, name, count, `+` |
| Priority | Urgent, High, Medium, Low, No priority (Q6) | as listed | PriorityIcon, name, count, `+` |
| Label | one group per label applied to an issue in the view, by name (a team label and a workspace label with the same name are one group, as in Linear's multi-team views, [Linear: Labels](https://linear.app/docs/labels), "Filtering and views"), then No label | as listed | LabelChip, count, `+` |
| *Label group* (one entry per label group the view's teams can use, by name, e.g. "Type") | one group per label of that group, by name, then "No Type" | as listed | LabelChip, count, `+` |
| Team | the teams in the view, in sidebar order. Offered only on views that can hold more than one team (SPEC-021) | as listed | team icon and key, count, `+` |

- **An issue appears once per group its value selects.** For Label, an issue with two labels appears in both groups, and in No label only when it has none. For a multi-select label group (SPEC-010), an issue with two of its labels appears in both; for an exclusive group, in at most one (INV-07). Counts count rows, so the groups' counts can sum to more than the view's issue count, as with `issue.groupBy` by label (SPEC-011 §6.1).
- **Group count:** each header shows the number of issues in the group, or the sum of their estimates. Clicking the count toggles between the two for the view (`groupCount`, §4.1), as in Linear ("You can click this to toggle between either option"). The estimate sum adds the stored estimate values (SPEC-010 §4.3), skipping issues with none, and shows "12 pts". The toggle isn't shown on a view whose teams all have estimates off.
- **Sub-grouping** offers the same options except the current grouping. In a list it is a second level of headers under each group; on a board it is **swimlanes**: horizontal lanes across every column ([Linear: Display options](https://linear.app/docs/display-options), "Sub-grouping": "available in lists and boards (as rows)"). Changing Grouping to the current sub-grouping clears the sub-grouping.
- **Collapsing:** `T` on a focused group header, sub-group header or swimlane header collapses or expands it; a click on its chevron does the same; `Alt+T` collapses or expands all groups (SPEC-012 §3.3 item 7; [Linear: Board layout](https://linear.app/docs/board-layout), "T to toggle the collapse or expansion of a swimlane"). Board columns don't collapse; they can be hidden (§3.5 item 4). Collapse state stays in `localStorage` per device, keyed by view and grouping (SPEC-012 §3.3 item 3), not in the view state. Completed and Canceled status groups start collapsed in a list (SPEC-012 D16).
- **Empty groups** are hidden unless Show empty groups is on (§3.9).
- **`+` on a header** opens the composer with that group's value set (status, assignee, priority, label, team), and the sub-group's value too when it is in a swimlane or sub-group (SPEC-012 §3.1 generalised). A named status group sets the status of that name in the composer's team when the team has one, else leaves the team's default. "No assignee", "No priority" and "No label" set nothing.

### 3.4 Ordering

**Options** ([Linear: Display options](https://linear.app/docs/display-options), "Ordering": "Status, Manual, Priority, Last created, Last updated, Due date"; Estimate is the PRD's, FR-VIEW-04; Linear's Link count is left out):

| Ordering | Order within a group (not reversed) | Ties |
|---|---|---|
| Manual | `sortOrder` ascending, then id (SPEC-011 §4.5): the order everyone shares | — |
| Status | Started, Unstarted, Backlog, then Completed, Canceled ("closest to done → farthest from done, followed by completed and canceled", Linear); within a category by status position | manual order |
| Priority | Urgent → Low, No priority last | SPEC-012 D17: `updatedAt` newest first, then number highest first, then id (Q5) |
| Last created | `createdAt` newest first | manual order |
| Last updated | `updatedAt` newest first | manual order |
| Due date | `dueDate` soonest first; no due date last | manual order |
| Estimate | `estimate` largest first; no estimate last (Q4) | manual order |

- **Reverse** (↑↓ in Display options, "Reverse order" in `Mod+K`) reverses the primary key only. Issues without a value (no due date, no estimate) stay last either way, and ties keep their order. Manual can't be reversed, as in Linear ("You can also reverse the sort order of your issues, except when sorting manually").
- On a board grouped by Status, ordering by Status orders nothing new within a column; it is still allowed.
- Every ordering is total (the last key is the id), so equal values never swap between renders (SPEC-012 AC-4's property, extended to every ordering).
- **Manual order is shared by everyone.** Moving an issue in manual order changes its `sortOrder` for every user and every view, as in Linear ("Manual ordering is unique in that it will update the manual order for everyone in the workspace"). There is one global order (SPEC-011 §4.5); a view shows its issues in that order. A new issue goes first (SPEC-011 Q7), so it appears at the top of its group.

### 3.5 Board

1. **Columns** are the groups of §3.3, left to right, each a fixed width (`--board-column-width`, proposed 320 px, a design-system token change, §12). A column header shows the group's icon, name and count (or estimate sum), a `+` that opens the composer with the column's value, and a ⋯ menu.
2. **Cards** are the column's issues in the view's ordering. A card shows the identifier, the title (at most two lines, clamped with an ellipsis) and a row of the chosen display properties (§3.8), with the assignee's avatar at the right end. The description is never shown ([Linear: Board layout](https://linear.app/docs/board-layout), FAQ). Card heights are fixed per view: the minimum card height (72 px, design-system §2.5) holds two title lines and one property row, whatever the title's length, so the window can be computed without measuring (Q8).
3. **Scrolling.** Without swimlanes, each column scrolls vertically on its own, and the board scrolls horizontally (trackpad, `Shift`+wheel, or dragging an empty area of the board, as Linear). With swimlanes, the whole board scrolls vertically as one, the column headers stay sticky at the top and the lane headers stay sticky at the left. Both axes are virtualised (§4.4): only the columns and cards in view, plus a fixed overscan, are mounted.
4. **Hide a column:** the column's ⋯ menu has **Hide column**. Hidden columns collapse into a narrow last column, "Hidden columns", listing each with its count; choosing one shows it again (**Show column**). An issue can be dropped onto a hidden column's entry without showing it. This copies Linear ([Linear: Board layout](https://linear.app/docs/board-layout), "Hide columns"). Hidden columns are part of the view state, kept per grouping (§4.1). A list has no hidden groups: filters do that (SPEC-021), as in Linear.
5. **Swimlanes** (sub-grouping, §3.3) are lanes across every column. A lane header shows the sub-group's icon, name and count, and a chevron. `T` on a focused lane header, or a click on the chevron, collapses or expands the lane. Empty lanes follow Show empty groups.
6. **Empty columns** (when shown) display "No issues" and accept drops.
7. **Focus and keys on a board** (list scope; §3.11): one focused card, with SPEC-012's focus rules (focus survives live re-sorts, follows a moved card, moves to a neighbour when its card leaves, and is restored on return). `J` / `↓` and `K` / `↑` move within the column (and on into the next or previous lane's part of the same column); `←` and `→` move to the nearest card, by index, in the previous or next visible column (skipping empty ones); `Enter` opens the focused issue; `T` on a lane header collapses it. Property shortcuts (SPEC-012 §3.6) act on the focused card.
8. **Live updates:** a card whose issue changes column (someone changed its status) moves at once; a focused card keeps focus and scrolls into view (SPEC-012 E1). Reordering is not animated (design-system §2.6).

### 3.6 Drag and drop (FR-VIEW-05)

In both layouts the mouse can drag an issue row or card. The pointer must move 4 px before a drag starts, so a click still opens the issue. While dragging, the source shows a placeholder, the target column or group is highlighted, and, when the view is ordered manually, a line shows where the issue will land. Near an edge the board or list scrolls (autoscroll). `Esc` cancels; a drop outside any group cancels.

1. **Into another group:** the issue takes the group's value: "You can drag and drop issues between each grouping and it will automatically adopt the properties of that grouping" ([Linear: Display options](https://linear.app/docs/display-options), "Sub-grouping"). The change is one `issue.update` with the patch of the table below, optimistic like every edit (SPEC-011 §6.2). In a swimlane, a drop that changes both the column and the lane sends both changes in the same `issue.update`.
2. **With manual ordering**, the drop also sets the issue's position between the two issues around the drop line (`position`, §4.3), in the same `issue.update`. With any other ordering, the issue lands where the ordering puts it, and there is no drop line.
3. **Within its own group:** only with manual ordering. It sends `issue.update {issue, position}` and nothing else. With another ordering, dropping in the same group does nothing, and a hint says "Order by Manual to move issues within a group." (Q7).
4. **Refused drops.** The client checks a drop before sending anything, with the rules the pickers use (SPEC-012 §3.5). A refused drop snaps back, sends nothing, and shows a toast with the reason. The server's own refusal rolls back the overlay and shows its message (NFR-08).

| Grouping | Drop into group G sends | Refused when (toast) |
|---|---|---|
| Status (a team view) | `status: G` | never (Triage and Duplicate are not columns in M2) |
| Status (named groups) | `status:` the issue's own team's status named G | the issue's team has no status of that name: "DES has no status named In Review." |
| Assignee | `assignee: G`, or `null` for No assignee | the issue's team is private and G isn't a member: "Ada isn't a member of DES, so they can't be assigned DES issues." (SPEC-011: the assignee must see the team) |
| Priority | `priority: G` | never |
| Label | `removeLabels: [source label]` (when the source is a label group, not No label), `addLabels: [G]` (when G isn't No label) | G is a team label of another team: "Frontend is an ENG label, so it can't go on DES-12."; G is archived (an archived label is a group only while some issue has it, and SPEC-010 refuses to add it): "Frontend is archived. Unarchive it in settings to add it." |
| Label group | the same with the group's labels; for an exclusive group the add alone replaces the other (INV-07) | as Label |
| Team | — | always: "Moving issues between teams arrives with M3." (moving teams is M3, SPEC-011 §4.1) |
| None | only reorders (item 3) | — |

   A label group whose name matches several labels across teams (a multi-team view) adds the label of that name that the issue's team can use: its own team's label first, else the workspace label (SPEC-003 §4 `LabelRef` order). When neither exists the drop is refused with "DES has no label named Frontend."

5. **Dropping on a hidden column's entry** (§3.5 item 4) applies that column's patch. With manual ordering the issue goes to the top of that group.
6. **Moving a selection** (several selected issues dragged together) is SPEC-022's: it applies this table to each issue.

### 3.7 Moving by keyboard

The same moves without a mouse (list scope, the focused issue; SPEC-022 extends them to a selection). The keys are those reserved for these commands in shortcuts §3.9, Linear's own.

| Keys | Layout | Action | Available when |
|---|---|---|---|
| `Alt+↑` / `Alt+↓` | both | Move the issue one position up or down within its group | ordering is Manual |
| `Alt+Shift+↑` / `Alt+Shift+↓` | both | Move the issue to the top or bottom of its group ([Linear: Board layout](https://linear.app/docs/board-layout), "Move to top or bottom") | ordering is Manual |
| `Alt+←` / `Alt+→` | board | Move the card to the previous or next visible column: the drop patch of §3.6 for that column. With manual ordering it goes to the top of the column | grouping isn't None or Team |

- When a command isn't available, the key shows the engine's hint, with a specific reason: "Order by Manual to move issues." or "Group the board to move cards between columns."
- A move at a group's edge (`Alt+↑` on the first issue) does nothing. `Alt+↓` never crosses into the next group.
- "Move to top" and "Move to bottom" are also in `Mod+K`, and in the card or row menu, which SPEC-022 owns.
- **Changing the grouped property any other way on a manually ordered board** (the `S` status picker on a status board, the command menu, `Alt+←`/`→`) also moves the issue to the top of its new column: "when you move issues to a new column on a board, it will go to the top if you make the change with the keyboard shortcut S or command menu and to wherever you placed it if you used the mouse" ([Linear: Board layout](https://linear.app/docs/board-layout), "Move to top or bottom"). The client adds `position: {before: <the first issue of the new column in this view>}` to that `issue.update`. A list, or a board ordered any other way, sends no position (Q9).

### 3.8 Display properties (FR-VIEW-06)

Display options lists the properties as toggle chips; each shows or hides that property on every row and card of the view. Title is always shown. Filters choose which issues show; display properties choose what each shows ([Linear: Display options](https://linear.app/docs/display-options), "Display properties").

| Property | List column (M1 position kept) | Card | Default |
|---|---|---|---|
| Priority | before the identifier | property row | on |
| ID | identifier column | above the title | on |
| Status | before the title | property row | on |
| Labels | after the title | property row (up to 3 chips, then "+2") | on |
| Estimate | after labels (only on teams that use estimates) | property row | on |
| Due date | after estimate | property row | on |
| Assignee | after due date | avatar, right end | on |
| Created | last column | property row | on |
| Updated | after created ("2h ago", the full time in a tooltip) | property row | off |

- The defaults reproduce the M1 list (SPEC-012 §3.3 item 5, D2), so nothing changes for a user until they change it.
- M3 adds Project, Cycle and Milestone (and Linear's sub-issue count) as chips when the fields exist; they are not shown before (§3.10).
- Hiding a property hides its column; the title column takes the space. Hidden properties are still editable with their shortcuts and the row menu.

### 3.9 Toggles (FR-VIEW-07)

- **Completed issues:** All · Past week · Past month · None. It applies to issues in the Completed and Canceled categories: All shows them; Past week shows those whose `completedAt` or `canceledAt` is within the last 7 days; Past month within the last 30 days; None hides them. Other issues always show. The window is computed against the device clock and recomputed every minute and when the view opens, so an issue leaves the window without a delta. It is evaluated on the client and never stored in a filter (SPEC-021's filters are separate). Linear documents the same choice for completed projects ("show projects that have completed in the last week, month, or year … or no completed projects"); the PRD's set is used for issues (Q2).
- **Show empty groups:** shows every possible group of the grouping (and sub-grouping), not only those with issues: for Status every status of the view's teams (named groups across teams), for Assignee the members of the view's team (for a multi-team view, every active user) plus No assignee, for Priority all five, for Label every non-archived label the view's teams can use plus No label, for a label group its non-archived labels plus "No <group>", for Team the view's teams. Kept per layout (§4.1): an empty status column is a drop target on a board.
- **Show sub-issues:** reserved for M3 (§3.10).

### 3.10 What M2 does with M3 fields

| M3 feature | In M2 |
|---|---|
| Group or sub-group by Project, Cycle, Parent issue | Not offered. The view state schema doesn't accept them until M3 extends it (§4.1). |
| Display properties Project, Cycle, Milestone, sub-issue count | Not offered. |
| **Show sub-issues** toggle | Not shown: every issue is top-level until parents exist. The view state keeps `showSubIssues` (default on) so M3 needs no migration. |
| Ordering by sub-issue order | M3's `subIssueSortOrder` (domain-model §4.6); not part of this spec. |
| Dragging into a Project or Cycle column | Arrives with those groupings in M3; the drop patch table (§3.6) gains rows. |

### 3.11 Shortcut map (M2 keys of this spec)

Every key is in Linear's panel and reserved for this command in shortcuts §3.9. All are registry entries with a command (shortcuts §1 rule 6), show in `?`, and pass the conflict test. "Typing": whether the binding fires while focus is in a text field or the editor (SPEC-012 §4.2).

| Keys | Scope | Action | Typing |
|---|---|---|---|
| `Mod+B` | list | Toggle list / board | no (`whileTyping: false`: in the editor `Mod+B` is bold) |
| `Shift+V` | list | Open Display options | no |
| `Alt+↑` / `Alt+↓` | list | Move the issue up / down one position (manual) | no |
| `Alt+Shift+↑` / `Alt+Shift+↓` | list | Move the issue to the top / bottom of its group (manual) | no |
| `Alt+←` / `Alt+→` | list (board only) | Move the card to the previous / next column | no |
| `←` / `→` | list (board only) | Focus the previous / next column | no |
| `T` | list | Collapse or expand the focused group, sub-group or swimlane (extends SPEC-012's `T`) | no |

- The `Alt` chords match on `event.code` (SPEC-012 §4.2 item 2), so macOS Option never changes them.
- `Mod+Shift+←` / `Mod+Shift+→` in design-system §5.3 (BoardColumn) become `Alt+←` / `Alt+→`, Linear's keys, as shortcuts §3.9 already says ("the reserved key below is the one to use when the command arrives").

### 3.12 Command menu

In the list context (a list or board page), copying Linear's "Show display options" and its board command:

| Command | Effect |
|---|---|
| Show display options | §3.1 |
| Switch to board layout / Switch to list layout | §3.2 (one is shown, by the current layout) |
| Group by… / Sub-group by… | a sub-page with §3.3's options; picking one sets it |
| Order by… | a sub-page with §3.4's options |
| Reverse order | flips `ordering.reversed`; unavailable for Manual |
| Show empty groups / Hide empty groups | flips the toggle for the current layout |
| Completed issues… | a sub-page: All, Past week, Past month, None |
| Show property… / Hide property… | a sub-page of the properties to toggle |
| Move to top / Move to bottom / Move up / Move down | §3.7; on the focused issue |
| Move to previous column / Move to next column | §3.7; board only |

These are web-app commands, like SPEC-012's property commands. Each changes the user's personal view state through SPEC-021's `viewPreference.set` (or a move through `issue.update`); none is a new registry `ui` entry.

## 4. Domain & client changes

No new synced model. One new input on `issue.update` (`position`, §4.3). The view state is a JSON value with a Zod schema in `packages/domain`, stored by SPEC-021's models.

### 4.1 View state

`ViewState` (`packages/domain/src/view-state.ts`). SPEC-021 stores it in `CustomView.display`, `ViewDefault.display` and `ViewPreference.display`.

| Field | Type | Default (built-in views, §4.1.1) | Rule |
|---|---|---|---|
| `version` | `1` | `1` | Raised only by an incompatible change |
| `layout` | `list` \| `board` | `list` | |
| `grouping` | `none` \| `status` \| `assignee` \| `priority` \| `label` \| `team` \| `{labelGroup: uuid}` | `status` | M3 adds `project`, `cycle`, `parent` |
| `subGrouping` | the same, or `none` | `none` | Never equal to `grouping` (except `none`); a value equal to it reads as `none` |
| `ordering` | `{field: 'manual' \| 'status' \| 'priority' \| 'createdAt' \| 'updatedAt' \| 'dueDate' \| 'estimate', reversed: boolean}` | `{field: 'priority', reversed: false}` | `reversed` is ignored for `manual` |
| `completedIssues` | `all` \| `pastWeek` \| `pastMonth` \| `none` | `all` | |
| `showEmptyGroups` | `{list: boolean, board: boolean}` | `{list: false, board: true}` (Q3) | |
| `showSubIssues` | boolean | `true` | Reserved; no effect until M3 |
| `groupCount` | `issues` \| `estimate` | `issues` | |
| `properties` | array of `priority` \| `id` \| `status` \| `labels` \| `estimate` \| `dueDate` \| `assignee` \| `createdAt` \| `updatedAt`, no duplicates | the "on" set of §3.8 | Order in the array is ignored: rows and cards use §3.8's order |
| `hiddenColumns` | `{[groupingKey]: string[]}` (`groupingKey` is the grouping's name or `labelGroup:<id>`; each value is a group key: a status id, a user id, a priority number as text, a label id, a team id, a status name for named groups, or `none` for the No-value group) | `{}` | At most 200 keys in all |

- **Reading never fails.** `readViewState(json)` reads each field on its own and falls back to that field's default when it is missing or invalid (the pattern of `readPreferences`, `packages/operations/src/ops/preferences.ts`), and drops unknown fields. So a value written by a newer client, or an M3 value read by an M2 client, degrades field by field, and a corrupt row still renders. `ViewStateSchema` (strict) validates what an operation **writes** (SPEC-021 §6), so the server never stores a malformed value.
- **Ids in the view state** (`{labelGroup}`, `hiddenColumns` keys) are checked by SPEC-021 for scope (a workspace view must not name a private team's label), exactly as ids in filters.
- **Size:** at most 4 KB as JSON (the schema's bounds keep it far below).

#### 4.1.1 Built-in default

`DEFAULT_VIEW_STATE` is the default above: list, grouped by status, ordered by priority, every completed issue, empty groups hidden in a list and shown on a board, the M1 columns. It reproduces M1's list exactly (SPEC-012 §3.3), so the M2 release changes nothing until a user changes something. SPEC-021 defines when a view uses a stored default instead.

### 4.2 Pure functions in `packages/domain` (unit and property tested)

Extending SPEC-012 §4.1's `compareIssuesInGroup` and `statusGroups` (`packages/domain/src/issue-order.ts`):

- `compareIssues(ordering, lookups)`: the comparator of §3.4 for each ordering, total (ends with id).
- `groupIssues(issues, state, lookups, now)`: the groups (and sub-groups) of §3.3, each with its ordered issues, its count and its estimate sum, with the completed window (§3.9) and Show empty groups applied. Lookups give statuses, labels, label groups, users, team memberships and teams. Pure: no store access.
- `completedWindowIncludes(issue, window, now)`.
- `dropPatch(issue, grouping, fromKey, toKey, lookups)`: `{ok: true, input}` with the `issue.update` fields of §3.6's table, or `{ok: false, message}` with the toast text. Used by drag, `Alt+←`/`→` and SPEC-022's selection moves.
- `positionFor(neighbours)`: the `position` input for a drop between two rows or a keyboard move (§3.7), as issue ids.
- `keyForPosition(lo, hi, jitter)` in `order-key.ts`: the key strictly between `lo` and `hi` (either may be absent), used by the server and the optimistic update (§4.3). Its property tests: the key is strictly between its bounds, never longer than the limit of §4.3 item 6 when the bounds are within it, and a valid fractional key.
- `readViewState(json)`, `ViewStateSchema`, `DEFAULT_VIEW_STATE` (§4.1).

### 4.3 Manual order: `position` on `issue.update`

The order key already exists: Issue `sortOrder`, one global fractional key with jitter, server-computed, read as `(sortOrder, id)` (SPEC-011 §4.5, domain-model §4.6). M2 adds the one thing missing, a way for a person to move an issue in it. This is an architecture decision (the shape of the operation, the key rules, the key-length limit and its re-spacing), so it needs an ADR on acceptance (§12, "Shared manual order of issues"). Proposed design (Q1):

1. **Input.** `issue.update` gains `position?: {after?: IssueRef | null, before?: IssueRef | null}`, with at least one non-null. "After A, before B" means the issue's new key is strictly between A's and B's. It can be combined with any other field of `issue.update` (one drop is one operation, so SPEC-022's undo reverts it in one step). Naming the issue itself as `after` or `before` is `INVALID_INPUT` ("An issue can't be placed next to itself.").
2. **Neighbours resolve like any `IssueRef`** (SPEC-003 §4): an unknown or invisible neighbour is `NOT_FOUND`, worded as for an issue that doesn't exist, after API key `teamIds` narrowing. A neighbour may be in another team (multi-team views share the one order). A neighbour that is archived or deleted is still used for its key: the client's view was correct when it sent the move.
3. **Bounds.** Under the moved issue's lock (SPEC-011 §4.8; neighbours are read, not locked), the server reads `lo` = `after.sortOrder` and `hi` = `before.sortOrder`.
   - Only `after`: `hi` = the smallest key above `lo` among the issues **the actor can see** (`sync_groups && visibleGroups(actor)`, live, the moved issue left out), or none. So "after A" places the issue directly after A, not at the end.
   - Only `before`: `lo` = the largest key below `hi`, the same way.
   - Both, but `lo ≥ hi` (someone moved one of them meanwhile): `hi` is recomputed as for "only `after`": the issue goes directly after A.
   - Counting only visible issues keeps the result from depending on a private issue's key, so it reveals nothing about invisible issues (§5, AC-14).
4. **Key.** `keyForPosition(lo, hi, jitter)` with a random jitter on the server. The update writes `sortOrder` through the repo (rule 2), and the `U` delta reaches every client holding the issue.
5. **A position-only change** writes no IssueHistory entry, emits no `issue.updated` event, and doesn't move `updatedAt` (reordering is not a property edit, and "Last updated" ordering must not jump; Q10). Combined with a property change, the property change records history and moves `updatedAt` as usual.
6. **Key length.** Keys grow when issues are inserted again and again at the same spot. A key is at most **128 characters**. When the computed key would be longer, the server **re-spaces** the neighbourhood: it takes up to 50 issues on each side of the insertion point in the global order (whether or not the actor can see them), assigns them and the moved issue evenly spaced short keys between the keys just outside that run, and writes them with `repo.updateWhere` (`touchUpdatedAt: false`, no history, no events), so every client holding one of them gets its `U`. Their relative order is unchanged. If the keys just outside the run are themselves too close for short keys, the run doubles (up to 1,000 issues) until they fit. **Locks:** the moved issue is already locked, and SPEC-011 §4.8 takes issue locks in ascending id, so the server can't add the run's locks afterwards. When it finds a re-space is needed, it rolls back and runs the operation once more, locking the moved issue and the whole run together in ascending id first. This retry and its lock set are what the ADR must settle (Q1).
7. **Optimistic update.** `issue.update`'s `optimistic` predicts the key with the same function over the store's rows (the successor or predecessor among the issues the client holds), with jitter from `jitterFromId(issueId)` (SPEC-011 §6.2), so rebuilding the overlay gives the same key. `sortOrder` stays a server-computed field (SPEC-003 §8): the server's key replaces the prediction. A predicted re-space is not attempted: past the limit the prediction may be long and is corrected by the deltas.
8. **Concurrency.** Two users moving different issues into the same gap get different keys (random jitter) and a stable order. Two users moving the same issue: the last write wins. A move is intent-level (neighbours, not a key), so it replays correctly after offline queuing: the issue lands next to the named neighbours wherever they are by then.
9. **Lifecycle.** Moving an archived or deleted issue is `CONFLICT` like any edit (SPEC-011 §6.1).
10. **Permissions:** those of `issue.update` (any user who can see the team; API keys need `read_write`).

### 4.4 Components (`packages/ui`) and features (`apps/web`)

| Where | What |
|---|---|
| `packages/ui` (presentational, stories with axe and visual baselines) | **DisplayOptions** (the popover body), **BoardColumn**, **BoardCard**, **SwimlaneHeader**, **HiddenColumns**, **VirtualGrid** (two-axis window over fixed sizes), **DropIndicator**; IssueRow gains visible-columns props and nested header levels; GroupHeader gains the estimate-sum toggle and a level |
| `apps/web/src/features/views/` (new; bound to the store and `dispatch`, unit tested) | the view-state resolver (SPEC-021), the board page, the drag controller (pointer events, autoscroll, drop resolution), the board focus model, the move commands, the display-options commands |
| `apps/web/src/features/issues/` | the list generalised to `groupIssues` and the view state; the list focus model gains nested headers |

- **Drag and drop is built in-house** on pointer events, without a library (Q11): the window is arithmetic (fixed sizes), so the drop target is computed from the pointer position without measuring, and HTML5 drag-and-drop doesn't work with virtualised targets or autoscroll. About as much code as `VirtualList` was.
- **Virtualisation:** `VirtualGrid` generalises `VirtualList` (SPEC-012 §4.4) to columns × rows and lanes, with fixed column width, card height and header heights. The focused card stays mounted while scrolled out of view (SPEC-012 §3.3 item 9).
- **No new dependencies.**

## 5. Sync & permissions

- **No new model and no new sync group.** View state lives in SPEC-021's models; this spec reads it.
- **Rows come from the view's source** (SPEC-021 §5.4): grouping, counts, sums, ordering, the completed window and empty groups are computed on the client over the rows the view holds. Group counts on a view whose teams are all loaded are exact; while a team is still loading, they grow (SPEC-021 §5.4).
- **Edits** are `issue.update` (SPEC-011): optimistic, queued offline, rolled back on refusal. Drags and keyboard moves work offline on held issues and replay in order.
- **Manual order** travels as `sortOrder` on Issue `U` deltas, in the issue's own groups: everyone holding the issue sees the move. No group changes.
- **Leak rules** (permissions.md §5 gains them, §12): `position.after` / `position.before` naming a private issue the actor can't see is `NOT_FOUND`, identical to an unknown id; the computed key is the same whether or not invisible issues lie between the neighbours (§4.3 item 3). Group headers and empty groups list only statuses, labels, users and teams the replica holds, so a private team's statuses or labels never appear as groups to a non-member.

## 6. API

- **`issue.update`** gains `position?: {after?: IssueRef | null, before?: IssueRef | null}` (§4.3). Its description, keywords ("reorder issue", "move issue to top") and an example (`{issue: 'ENG-2', position: {after: 'ENG-1'}}`) are updated; `pnpm registry:lint` passes. API and MCP callers get the same manual order as the app.
- **`issue.list` `orderBy`** gains `estimate` (nulls last), so the API can read the orders of §3.4 that have a column (manual is `sortOrder`, already there). Status ordering stays client-only (it depends on workflow positions); `issue.list` doesn't offer it. (SPEC-021 decides whether any view reads issues from the server; if it does, it needs the orders it uses.)
- No other operation. Display options are view state, written through SPEC-021's operations.

## 7. UI

### 7.1 Screens

| Screen | Components |
|---|---|
| Any issue view (SPEC-021 routes), list layout | PageHeader, ViewToolbar (filter: SPEC-021; Display button; layout toggle), GroupHeader (two levels), IssueRow (visible columns), VirtualList |
| The same, board layout | ViewToolbar, BoardColumn, BoardCard, SwimlaneHeader, HiddenColumns, VirtualGrid, DropIndicator |
| Display options | Popover with DisplayOptions: SegmentedControl, selects (Menu), Switch, toggle chips, the SPEC-021 footer |

The header's right side (design-system §3) shows, in order: the filter button (SPEC-021), the layout toggle (two IconButtons, List and Board, with `Mod+B` in their tooltips, as Linear's "board and list icons next to Display options"), and the Display button (with `Shift+V`).

### 7.2 States

| State | Shown |
|---|---|
| View loading (a team still loading, SPEC-021 §5.4) | The rows held so far, and the header's loading indicator (SPEC-021) |
| No issues in the view | SPEC-021's empty state; a board shows its columns only when Show empty groups is on, else the empty state |
| Every group hidden on a board | "All columns are hidden." with **Show all columns** |
| A drop refused | The card snaps back; a toast with the reason (§3.6) |
| A move rejected by the server | Rolled back; a toast with the server's message |
| Offline | Moves and edits queue (SPEC-005 §8's banner shows the count) |

### 7.3 Small screens (NFR-20)

- **768–1279 px:** the board works as at full width; the sidebar is a drawer below 1024 px (SPEC-005).
- **< 768 px:** list only (§3.2 item 5); compact rows (SPEC-012 §7.3) show priority, identifier, title, status and assignee whatever the display properties, so the row fits at 375 px. Display options keeps Grouping, Ordering and the toggles, and hides Layout and Display properties.

### 7.4 Accessibility (NFR-19)

- **List:** the `treegrid` of SPEC-012 §7.4 (D22), with sub-group headers at `aria-level` 2 and issue rows at level 3 when sub-grouped. Header names include the count: "In Progress, 12 issues, collapsed".
- **Board:** a region named "<view name> board". Each column is a group (`role="group"`, `aria-label` "Todo, 12 issues") holding a `list` of cards (`listitem`), with `aria-setsize` and `aria-posinset` on each card so virtualisation keeps positions. A card is one focusable element (roving `tabindex` over the whole board) named "ENG-42, Fix login, Todo, Urgent, assigned to Ada". Lanes are groups named "Ada, 5 issues, expanded" with `aria-expanded`. The focused card stays mounted.
- **Moves are announced** in the polite live region: "Moved ENG-42 to In Progress", "Moved ENG-42 to position 3 of 12", "ENG-42 can't move there: <reason>". Every drag has a keyboard equivalent (§3.7).
- Display options: a dialog-less popover with labelled controls; the toggle chips are `aria-pressed` buttons ("Show Labels"). The disabled reverse button is `aria-disabled` with its reason in `aria-describedby`.
- Every new `packages/ui` component has stories in light and dark that pass axe.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | The focused card's issue moves to another column by someone else | The card moves; focus follows it and scrolls it into view (SPEC-012 E1). |
| E2 | An issue is dropped while its own `issue.update` from another tab is in flight | Both are queued intents; the server applies them in order; the last value wins. |
| E3 | Two users move different issues into the same gap at the same time | Both land between the neighbours, in the order of their random jitter; every client shows the same order after the deltas (§4.3 item 8). |
| E4 | A user moves an issue after A while someone else moves A elsewhere | The server places it directly after A's current position (`lo ≥ hi` rule, §4.3 item 3). |
| E5 | A move names a neighbour that was deleted or archived since | Its key is still used; the move succeeds (§4.3 item 2). |
| E6 | A move names a neighbour in a private team the actor can't see (a crafted request) | `NOT_FOUND`, identical to an unknown id; nothing is written. |
| E7 | Repeated inserts at the same spot reach the key limit | The server re-spaces up to 50 issues on each side (§4.3 item 6); their order doesn't change; every client holding them gets `U` deltas. |
| E8 | A drop into a named status group whose name the issue's team lacks | Refused before sending: "DES has no status named In Review." (§3.6). |
| E9 | A drop onto an assignee column of a user who can't see the issue's private team | Refused before sending (§3.6); the server refuses it too if the client's data was stale. |
| E10 | An issue with labels Bug and Frontend is dragged from the Bug column to Backend | `removeLabels: [Bug], addLabels: [Backend]`: it keeps Frontend and shows in Frontend and Backend. |
| E11 | Dragging from No label to a label of an exclusive group the issue already has another label of | `addLabels` replaces the group's other label (INV-07). |
| E12 | Grouping by a label group that is then deleted, or moved to the workspace (SPEC-010) | The grouping reads as Status's default (`readViewState` can't resolve the group; the stored value is left for SPEC-021's owner to fix); the toolbar shows "This view was grouped by a label group that no longer exists." once. |
| E13 | Ordering by Estimate on a view mixing teams with different scales | Ordered by the stored number (SPEC-010 §4.3); off-scale values sort by their number. |
| E14 | `Alt+↑` with ordering other than Manual | Nothing moves; the hint "Order by Manual to move issues." (§3.7). |
| E15 | `Mod+B` while the issue description editor has focus (peek, SPEC-022) | The editor's bold wins (`whileTyping: false` on the list binding; the editor scope is more specific). |
| E16 | The window narrows below 768 px on a board | The view renders as a list; the stored layout stays `board` and returns when the window widens (§3.2 item 5). |
| E17 | A view grouped by Team on a team view (one team) | The Team grouping isn't offered there; a stored `team` grouping reads as None. |
| E18 | Every column hidden | "All columns are hidden." with Show all columns (§7.2). |
| E19 | The completed window moves past an issue while the view is open | It leaves the view at the next minute tick; a focused row moves focus to its neighbour (SPEC-012 E2). |
| E20 | A dragged issue is deleted by someone else mid-drag | The drag cancels when the row leaves the view; nothing is sent; the announcement of SPEC-012 E2 runs. |
| E21 | A move is queued offline and its neighbour is purged before it is sent | The neighbour ref is `NOT_FOUND`; the move is refused and rolled back with a toast. |
| E22 | A view state written by a newer client (an unknown grouping, a property M2 doesn't know) | Read field by field: unknown values fall back to their defaults; unknown properties are dropped (§4.1). |
| E23 | A drop changes the column and the lane, and the lane's change is refused (e.g. the assignee can't see the team) | Nothing is sent; the whole drop is refused with the lane's reason. |
| E24 | A view holds 10,000 issues in one status column | The column is a virtual list; only visible cards plus overscan are mounted (AC-17). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)); they are marked ⏸ and checked by hand. Leak tests and the sync property suite are still written (Postgres allowed). Story tests (axe, keyboard) are the UI slices' local Definition of Done, as in PLAN-005 and PLAN-012.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `readViewState` returns a valid `ViewState` for any JSON input (never throws), keeps every valid field, replaces each invalid or missing field with its default, drops unknown fields, and reads a `subGrouping` equal to `grouping` as `none`. `ViewStateSchema` refuses what `readViewState` would repair. `DEFAULT_VIEW_STATE` renders the M1 list unchanged (grouping, order, columns, collapsed groups). | unit + property |
| AC-2 | `groupIssues` puts each issue in exactly the groups its value selects (once per label for Label grouping, once per label of a multi-select group), in the group order of §3.3, with the right counts and estimate sums; Show empty groups adds exactly the groups of §3.9; the completed window keeps exactly the closed issues within it. | unit + property |
| AC-3 | Each ordering of §3.4 orders as specified, puts missing values last in both directions, reverses only the primary key, ignores `reversed` for Manual, and is total (no two distinct issues compare equal). | unit + property |
| AC-4 | `Shift+V` and the Display button open Display options; each control changes the view at once and dispatches the personal view state (SPEC-021); `Esc` returns focus where it was; hidden controls follow §3.1 item 4. | unit (commands, popover model) + story |
| AC-5 | `Mod+B`, the layout buttons and the command switch layouts, keep the focused issue focused, and keep grouping, ordering and properties; Show empty groups and hidden columns are kept per layout. Below 768 px only the list renders and the stored layout is kept. | unit |
| AC-6 | The board renders the groups as columns with header, count or estimate sum (click toggles), `+` and ⋯; `+` opens the composer with the column's (and lane's) value; Hide column moves it to Hidden columns, and Show column brings it back. | unit + story |
| AC-7 | Sub-grouping renders nested headers in a list and swimlanes on a board; `T` and the chevron collapse a lane or group; `Alt+T` collapses or expands all; collapse state survives a reload on the device. | unit + story |
| AC-8 | `dropPatch` returns the `issue.update` input of §3.6's table for every grouping (status, named status, assignee, priority, label, label group, None) and the refusal text for every refused case; a drop changing column and lane is one input. | unit + property (a drop to the source group is a no-op patch) |
| AC-9 | Drag and drop: a drag starts after 4 px; a drop into another group dispatches `dropPatch`'s input (plus `position` when manual); a drop in the same group dispatches only `position` when manual and nothing otherwise, with the hint; `Esc` and a drop outside cancel; a refused drop sends nothing and shows the toast. | unit (drag controller with synthetic pointer events, fake dispatcher) + e2e ⏸ |
| AC-10 | Keyboard moves: `Alt+↑`/`↓`, `Alt+Shift+↑`/`↓` and `Alt+←`/`→` dispatch the moves of §3.7 with the right `position`; they are unavailable with the reasons of §3.7; a move at a group's edge does nothing; changing the grouped property on a manually ordered board adds `position: {before: first}`. | unit (commands, availability) |
| AC-11 | `position`: the server places the issue strictly between the named neighbours; with only `after` directly after it (no visible issue between); with only `before` directly before; with `lo ≥ hi` directly after `after`; naming itself is `INVALID_INPUT`; an archived or deleted moved issue is `CONFLICT`; an archived or deleted neighbour still works. | unit (key functions, handler with a fake repo) + integration ⏸ |
| AC-12 | A position-only update writes no history, emits no `issue.updated`, and leaves `updatedAt` unchanged; combined with a property change it records the change as usual. | unit (handler) + integration ⏸ |
| AC-13 | The optimistic `position` predicts the same key on every overlay rebuild (jitter from the issue id), and the server's key replaces it; concurrent moves from several clients converge to the server's order. | unit + **sync property suite** (moves join the generator; not held) |
| AC-14 | **Leak:** `position.after` / `before` naming a private team's issue is `NOT_FOUND` for a non-member and for an API key outside the team, identical to an unknown id, and writes nothing; the key computed for "after A" is the same whether or not a private issue the actor can't see lies between A and its visible successor. | leak test (Postgres allowed) |
| AC-15 | Keys never exceed 128 characters: past the limit the server re-spaces the neighbourhood, keeps every issue's relative order, logs `U` for each re-spaced row with no history and no `updatedAt` change, and takes its locks in SPEC-011 §4.8's order (the retry of §4.3 item 6). | unit (key function) + property (order preserved) + integration ⏸ |
| AC-16 | Display properties show and hide exactly their columns and card fields; the defaults equal M1's columns; Title is always shown; < 768 px rows show the compact set. | unit + story |
| AC-17 | `VirtualGrid` mounts only the columns and cards in view plus a fixed overscan for any board size, keeps the focused card mounted, and computes positions without measuring; with 10,000 issues (one column, and spread over 10 columns with 5 lanes) scrolling stays at 60 fps in both layouts. | unit (window arithmetic) + perf ⏸ |
| AC-18 | Board focus: `J`/`K`/`↑`/`↓` move within a column and across lanes, `←`/`→` to the nearest card of the next visible column, `Enter` opens; focus survives live moves and returns on revisit (SPEC-012 AC-5 extended to two dimensions). | unit (board focus model) |
| AC-19 | Every binding of §3.11 is registered with a command, shows in `?`, matches Linear's panel, passes the conflict and reserved-keys tests (`Mod+B` doesn't steal the editor's bold), and the `Alt` chords match on `event.code`. | unit (registry, conflicts) |
| AC-20 | The commands of §3.12 appear in the list context only, apply their change, and are unavailable where §3.7 says. | unit (command sources) |
| AC-21 | Accessibility: the list exposes the levels of §7.4; the board exposes groups, lists, `aria-setsize` and `aria-posinset`, named cards and lanes; moves and refusals are announced; every new component passes axe in light and dark. | unit (announcer) + story (axe) |
| AC-22 | `issue.list` accepts `orderBy: estimate` (nulls last) and its order matches `compareIssues` for Estimate over the same rows. | unit (list model) + integration ⏸ |
| AC-23 | Group-by and order-by on a view mixing teams: named status groups merge same-name statuses in category order; label groups merge same-name labels; a drop into a named group sets the issue's own team's status (or refuses, E8). | unit |

## 10. Metrics & performance

- A view of 10,000 issues: first paint < 200 ms from the replica in either layout; 60 fps scrolling (NFR-04, FR-VIEW-14). `groupIssues` over 10,000 issues with grouping and sub-grouping < 50 ms on the reference laptop (perf ⏸).
- A property change by drop or key paints in < 16 ms (NFR-01); a reorder paints in < 16 ms.
- Re-spacing (§4.3 item 6) usually writes 101 rows, and never more than 1,001.
- No new log events.

## 11. Open questions

| # | Question | Proposed default |
|---|---|---|
| Q1 | **Manual order design** (needs an ADR, §12): add `position {after, before}` to `issue.update`, or a separate `issue.move` operation? And how to keep keys short: re-space up to 50 issues on each side when a key passes 128 characters (§4.3 item 6), or something else (a nightly re-key, no limit)? | `position` on `issue.update` (a drop that changes a property and the position is one operation and one undo step); the 128-character limit with neighbourhood re-spacing, retried with all locks in id order. Recorded in a new ADR, "Shared manual order of issues". |
| Q2 | Completed issues choices: the PRD's All · Past week · Past month · None, or more (past day, past 3 months)? Linear's issue options aren't in its docs. | The PRD's four; "past month" is the last 30 days (filter durations have no months, SPEC-003 §7.4). |
| Q3 | Show empty groups: one setting for both layouts, or one per layout? M1's list hides empty groups, but an empty status column must show on a board to be a drop target. | Per layout: list off, board on (§4.1). |
| Q4 | Ordering by Estimate (PRD; Linear doesn't list it): largest or smallest first? | Largest first, no estimate last. |
| Q5 | Priority ordering ties: keep M1's tie-break (most recently updated, then number, SPEC-012 D17) or use manual order like every other ordering? | Keep D17, so the M1 list doesn't change. |
| Q6 | Group order for Assignee and Priority, which Linear's docs don't give: where do "No assignee" and "No priority" go? | No assignee first, then users by name; priority Urgent → Low, then No priority (the order of the priority picker's values, without "No priority" first). |
| Q7 | Dragging within a group when ordering isn't Manual: do nothing with a hint, or switch the view to Manual? | Do nothing, with the hint "Order by Manual to move issues within a group." |
| Q8 | Card height: fixed per view (two title lines reserved, so short titles leave space), or measured per card (Linear's cards vary)? Measuring conflicts with design-system §5.4 ("no measuring on render") and the 60 fps budget. | Fixed: 72 px with two title lines and one property row. |
| Q9 | Copy Linear's "a keyboard or command-menu change of the grouped property on a manually ordered board moves the issue to the top of its new column" (§3.7)? It changes the shared order for everyone. | Copy it, on boards ordered manually only. |
| Q10 | Does a position-only move change `updatedAt`, write history or emit `issue.updated` (webhooks, M6)? | None of the three. |
| Q11 | Drag and drop in-house on pointer events, or a library (for example dnd-kit)? | In-house; no new dependency. |
| Q12 | Offer Team grouping (Linear has it; the PRD's list doesn't) on multi-team views? | Yes, on views that can hold several teams; not droppable until M3. |
| Q13 | Offer grouping by a specific label group in addition to Label (Linear's board offers both "Label" and "Label group")? | Yes, one entry per label group. |

## Decisions

None yet. Accepted answers move here with a date.

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| ADR-0026 (new) | — | **"Shared manual order of issues"**: one global `sortOrder` moved by `issue.update {position}` with neighbour refs; bounds computed over visible issues only; the 128-character limit and neighbourhood re-spacing; no history or `updatedAt` for a position-only change (Q1, Q10). Add it to `adr/README.md`. | New ADR (doesn't supersede one) |
| SPEC-011 | §6.1 `issue.update` | Add `position?: {after?: IssueRef \| null, before?: IssueRef \| null}` and §4.3's rules; `issue.list` `orderBy` gains `estimate`. Dated "Changed (SPEC-020)". | No (the ADR above) |
| SPEC-011 | §4.5 Sort key, §6.2 | A person can now move an issue (SPEC-020 §4.3); keys are at most 128 characters; the optimistic `position` uses `jitterFromId`. Q7's "until M2 adds manual ordering controls" is fulfilled. | No |
| SPEC-011 | §4.8 lock table | Add the re-spacing writer: the moved issue and its run, `FOR UPDATE` in ascending id (retry with the full set). | No |
| SPEC-012 | §3.3 items 2–5, §4.1, §7.4, D17 | The list follows the view state (SPEC-020 §4.1); M1's fixed grouping, order and columns become `DEFAULT_VIEW_STATE`; the treegrid gains level 3 rows when sub-grouped. D17 stays the Priority ordering's tie-break (Q5). | No |
| SPEC-003 | §8 server-computed fields | `sortOrder` stays server-computed; `issue.update`'s `optimistic` may predict it for `position`. | No |
| domain-model.md | §4.6 Issue `sortOrder`; §4.15 | `sortOrder` "moved by `issue.update {position}`; at most 128 characters". §4.15: `display` is a `ViewState` (SPEC-020 §4.1). | No |
| domain-model.md | §7 issue domain | No new operation (the `position` input is on `issue.update`). | No |
| events.md | `issue.updated` row | A position-only update emits no `issue.updated`. | No |
| permissions.md | §5 leak checklist | Add: "`issue.update` `position` neighbours resolve as `IssueRef` (`NOT_FOUND` for an invisible issue), and the key computed for a move doesn't depend on invisible issues (SPEC-020 AC-14)." | No |
| sync-protocol.md | §10 | Manual-order moves join the convergence property generator (SPEC-020 AC-13). | No |
| shortcuts.md | §3.3 | Mark M2 keys live: `Mod+B` (`whileTyping: false`), `Shift+V`, `Alt+↑`/`↓`, `Alt+Shift+↑`/`↓`, `Alt+←`/`→` (board), `←`/`→` (board focus), `T` also on sub-group and lane headers. Replace the row "`Mod+Shift+←` / `→` (board)" with `Alt+←` / `Alt+→` (§3.9's reserved keys). Remove these keys from §3.9's reserved list. | No |
| design-system.md | §5.3 BoardColumn · BoardCard | "`Mod+Shift+←/→` moves the focused card between columns" → "`Alt+←/→`"; add the column ⋯ menu (Hide column), Hidden columns, swimlanes, fixed card height (two title lines). Add DisplayOptions, SwimlaneHeader, HiddenColumns, VirtualGrid, DropIndicator to the inventory. | No |
| design-system.md | §2.5 | Add `--board-column-width` (320) and the lane header height (32). | No |
| command-menu.md | §2 Toggles | Add the display commands of SPEC-020 §3.12 (list context). | No |
| SPEC-005 | §3 "URL state" | "filters and display (M2) are encoded in query params" → "filters (M2, SPEC-021) are encoded in the URL; display options are not (as Linear)". | No |
| PRD | FR-VIEW-03, 04 | FR-VIEW-03: add Team and label-group grouping (Q12, Q13); project and cycle grouping arrive with M3. FR-VIEW-04: ordering names follow Linear (Last created, Last updated). | No |
| PRD | FR-VIEW-07 | "show sub-issues" arrives with M3 (sub-issues); M2 ships empty groups and completed issues. | No |
