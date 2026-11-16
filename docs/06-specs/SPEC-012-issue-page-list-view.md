# SPEC-012: Issue page, composer & list view

Status: **Accepted** (2026-11-12, M1 acceptance gate) · Milestone: **M1** · Date: 2026-11-12 (revised after review, 2026-11-12)
Implements: FR-ISS-02 (composer), 04 (inline editing and property shortcuts), 08 (copy ID, URL, title, Markdown), 11 (drafts, now synced), 17 (git branch name) · FR-VIEW-02 (list layout; board is M2) · FR-NAV-01 (team Issues and Archive items, Drafts item), 02 (issue commands), 03 (M1 shortcuts) · the Assigned and Created tabs of FR-NAV-10 (brought forward, D5) · NFR-01, 04, 06, 08, 18, 19, 20
Depends on: SPEC-011 (issues, content), SPEC-010 (statuses, labels, estimates), SPEC-005 (shell, command menu, shortcut engine), SPEC-013 (editor and comment area, hosted here), SPEC-014 (attachment area, hosted here), SPEC-015 (delete, restore, the team archive with Recently deleted, auto-archive: what the delete and restore controls do)
Related: [design-system §3–§5](../05-design/design-system.md) · [shortcuts §2–§3](../05-design/shortcuts.md) · [command-menu §2–§3](../05-design/command-menu.md)

---

## 1. Problem & goal

SPEC-011 gives Surface issues, but no way to see or touch them in the app. This spec adds the screens people use all day: the **composer** that creates an issue from anywhere with `C`, the **issue page** where an issue is read and edited, the team's **issue list**, and a minimal **Assigned to me** list as the home page. Every action works by keyboard and from `Mod+K`. The lists of the user's own teams and My issues render from the local replica with no spinner and survive going offline. Another public team's issues, and archived or deleted issues, load from the server the first time (SPEC-011 §5.7, ADR-0020). The M1 exit is dogfooding (METHODOLOGY §3), so these screens must be good enough for the team to run Surface's own backlog in Surface.

This spec also owns the **M1 shortcut map** (§3.6): every key that M1's specs bind, the new scopes, and the shortcut engine changes they need.

## 2. Scope

**In scope**

- Composer: modal, context-prefilled, property pills, "Create more", `Mod+Enter`, "Save as draft?" on close.
- Issue page `/issue/:identifier/:slug` (the slug is optional on input): title, description (SPEC-013's editor), properties panel, activity (history from SPEC-011, comments from SPEC-013), attachments area (SPEC-014), previous / next through the list it was opened from, `Esc` back to that list.
- Team list `/team/:key/issues`: list layout grouped by status in workflow order, a fixed order within groups, collapsible groups with counts, virtualised.
- My issues → **Assigned** and **Created** (`/my-issues`, `/my-issues/created`): the user's issues across teams (D5).
- **Drafts** (`/drafts`, `G` `D`): unsent composer drafts and unsent comments, synced across the user's devices (§3.2).
- The property pickers for status, priority, assignee, labels, estimate and due date.
- The M1 shortcut map and the engine changes it needs (§3.6, §4.2).
- Copy identifier, link, "ID + title" and git branch name.
- Synced drafts for the composer and for comments: the `Draft` model and its two operations (§3.2, §4.3).
- Loading, empty, not-found, offline and "Available when online" states; accessibility; reading at 375 px.
- The client side of partial issue loading (SPEC-011 §5.7) on these screens: another team's list, an issue the replica doesn't hold, the identifier fallback (§3.3 item 10, §3.4 item 11).
- Deleting the local replica database on explicit sign-out (§3.12, Q3).

**Out of scope**

- Board layout, filters, display options, view tabs (Active, Backlog), custom views, multi-select and bulk edit, peek, general undo and redo, manual reordering, global search: M2. The My issues tabs Subscribed (M4) and Activity (later).
- The editor itself, comments, resolve and reactions (SPEC-013); upload and attachment rendering (SPEC-014); what delete, restore, auto-archive and permanent delete do, and the team archive pages (SPEC-015). This spec places their controls and binds their keys. There is no manual archive.
- Project, cycle, parent, relations, team moves (M3); triage, subscriptions, templates (M4); pre-filled create URL (FR-ISS-13, M2).
- Linear's embeds, external images and link unfurling: not copied (see Decisions, D9).

## 3. User flows

### 3.1 Create an issue (`C`)

1. `C` anywhere (global scope, not while typing), the sidebar's **New issue** button, a group header's `+`, or "Create issue…" in `Mod+K` opens the composer: a Dialog (`lg`, 720 px), focus in the title. `V` (new issue full screen) is reserved for later.
2. **Prefill from context:** the team of the current route (team list, team settings, an issue page), else the home team preference, else the first team the user is a member of, else the first team the user can see. A group header's `+` also sets that group's status. With a saved draft for that team, the draft is restored instead (§3.2).
3. **No team to create in** (the user can see no team): the composer is not opened. A toast says "Create a team first. You can do it in Settings → Teams." with **Open settings**.
4. The header shows the team as a chip ("ENG › New issue"). The chip opens a team picker; changing team keeps title and description, keeps workspace labels, and drops status, team labels, an estimate the new team's scale doesn't allow, and an assignee who isn't a member of the new team when it is private (SPEC-011: the assignee must be able to see the team), with an inline note naming what was dropped ("Dropped: status Todo, label Frontend, assignee Ada.").
5. Fields: **title** (one line; `Enter` moves focus to the description), **description** (SPEC-013 editor), then a row of PropertyPills: status (shows the team's default), priority, assignee, labels, estimate (hidden while the team's scale is `off`), due date. Each pill opens its picker (§3.5). The composer has no single-letter property shortcuts, so typing never triggers one; pills are reached with `Tab` and opened with `Enter` or `Space` (D13).
6. `Mod+Enter` (the existing `dialog.submit` binding, shortcuts §3.8) or **Create issue** submits the form, which dispatches `issue.create` with a fresh UUIDv7. The composer closes (or stays, with "Create more"), focus returns to where it was, and a toast says "Created ENG-…" with **Open**; the toast text becomes "Created ENG-42" when the number arrives. A polite live region announces it.
7. **Empty title:** the Create button is `aria-disabled` (not `disabled`, so it stays focusable and `dialog.submit` still reaches the form) with the tooltip "Add a title to create the issue". Submitting anyway shows the inline error "Title is required." on the title field and moves focus there.
8. **Create more** (a Switch, remembered per device): after creating, the title and description clear, the properties stay, focus returns to the title.
9. **Rejection:** the overlay row is rolled back (SPEC-011 E3); the composer has already closed, so a toast shows the server's message with **Restore in composer**, which reopens it with what was sent. If the composer holds content that isn't the rejected issue (usually the next issue, with "Create more" on), it first asks "Replace what is in the composer with the rejected issue?" with **Replace** and **Cancel**; Cancel keeps the composer and the toast's text stays copyable (E20). With "Create more" on, the composer is still open when the answer arrives, so the toast waits until it closes (D26).
10. **`Esc` in the composer:** an open editor popover (slash menu, link bubble, a picker) closes first; the next `Esc` closes the composer. With content, the composer first asks "Save as draft?" (§3.2).

### 3.2 Drafts (FR-ISS-11)

Drafts are saved on the server and follow the user to every device (Linear does the same; D4). They are a synced model, `Draft`, in the user's own sync group (§4.3).

- **Closing the composer** (`Esc`, the close button, a click outside) with any content asks **"Save as draft?"** with **Save** and **Discard**. `Esc` again, or **Discard**, drops the content; **Save** keeps team, title, description and chosen properties as the team's draft (`draft.save`). An empty composer closes without a prompt. Creating the issue clears the team's draft (`draft.discard`).
- **Save never replaces another draft silently** (D25). When the composer's team already has a saved draft that this composer didn't open (the team was changed in the composer, or a hidden team's draft was opened in the default team, E7), **Save** first asks "Replace the ENG draft?" with **Replace** and **Cancel**. Replace saves this one as the team's draft (and the draft the composer opened, if any, is discarded, so the content moves rather than copies). Cancel, or `Esc`, goes back to the composer with nothing lost.
- **One composer draft per team**, and at most 50 composer drafts per user: saving a 51st deletes the oldest (D27). The next `C` for that team restores its draft, with a "Draft restored · Discard" line under the header. **Discard** clears it. The **Drafts page** (`/drafts`, `G` `D`, sidebar **Drafts**) lists every composer draft (title, team, saved time) and every unsent comment (issue identifier and title, first line of the text, saved time). Opening a composer draft opens the composer with it, on any device. Opening an unsent comment opens the issue page with the text in the comment box. The row menu has **Delete draft**.
- **Comment drafts:** an unsent comment (SPEC-013 comment box) is kept per issue and shown in the box whenever the issue page opens, on any device. A comment draft's `data` is `{text}`. Sending the comment discards the draft (`draft.discard`, SPEC-013 §3.1). If the server rejects the comment, its text goes back into the issue's comment draft when that draft is empty or gone; if the user has typed something new meanwhile, that draft stays and the toast offers **Copy text**. The draft is deleted when its text is empty. At most 50 comment drafts per user: saving a 51st deletes the oldest. The client discards a comment draft older than 30 days when it reads it.
- **Saving:** comment drafts are saved 500 ms after the last change and on navigation (`draft.save`, optimistic, so it works offline and queues like any operation). The composer saves only when the person chooses **Save**.
- **Storage:** the replica holds `Draft` rows like any other synced model, so there is no separate drafts store. A draft survives reloads, resyncs and bootstraps. In the memory fallback (IndexedDB unavailable, SPEC-002 E6) the replica, drafts included, lives in memory for the tab's life; the server copy is what survives. The shell's IndexedDB banner already says that.
- **Sign-out:** drafts are the user's data on the server, so they survive it. Explicit sign-out deletes the replica on the device (§3.12); the next sign-in bootstraps it again, drafts included.
- On restore, values that no longer resolve (a deleted status or label, an archived label, a team the user can no longer see, an assignee who can't see a private team) are dropped with the same inline note as a team change.

### 3.3 The issue list (`/team/:key/issues`)

1. Reached from the sidebar (team ▸ **Issues**), `G` `E`, `Ctrl+Shift+1…9` (the n-th team in the sidebar, D15), "Go to ENG issues" in `Mod+K`, and links.
2. The header shows the breadcrumb "ENG › Issues" and an issue count (the team's issues in the replica, which holds every live issue of a subscribed team). No view tabs, filter or display controls in M1.
3. Issues are grouped by **status**, in workflow order (SPEC-010: category order, then position). Each GroupHeader shows the StatusIcon, name, count and a `+`. Groups with no issues are hidden. Completed and Canceled groups start collapsed (D16). Collapse state is kept per team and device in `localStorage`.
4. Within a group the order is fixed (D17): priority (Urgent first, No priority last), then `updatedAt`, newest first, then identifier number, descending (a total order, so equal timestamps never swap). Live deltas re-sort without moving the focused row out from under the keyboard: a focused row that moves keeps focus and scrolls into view.
5. **Rows** (IssueRow, fixed columns in M1): priority · identifier · status · title · labels · estimate (when the team uses estimates) · due date · assignee · **created** (a short date, "Nov 6", with the year when it isn't this year; D2). Pills open their pickers on click. **Right-click** (or the row's context-menu key) opens the row menu, in this order: Status `S` · Priority `P` · Assignee `A` · Due date `Shift+D` · Labels `L` · Estimate `Shift+E` (when used) · Copy › (§3.7) · Delete `Mod+Backspace`. Later milestones add their items between Labels and Copy.
6. Archived and deleted issues are not listed (SPEC-015); the replica doesn't hold them (SPEC-011 §5.7). When the team has archived issues, a footer line "N archived issues" links to the team archive (`/team/:key/archive`, SPEC-015). N comes from `issue.count` with `{team, includeArchived: true, filter: archivedAt is set}`, fetched when the list opens and on focus; the line is hidden offline and until the answer arrives. The sidebar has a team-level **Archive** item (`G` `X`) leading to SPEC-015's page, "Archived issues", whose second tab is "Recently deleted issues". Its rows are this spec's IssueRow; the date column shows the deletion day on that tab (§3.10). Pending issues (no number yet) show `ENG-…`.
7. **Keys:** `J` / `↓` and `K` / `↑` move focus through rows and group headers. `Enter` opens the focused issue. `T` on a focused group header collapses or expands it (a click on the header does the same); `Alt+T` collapses or expands all groups. Property shortcuts (§3.6) act on the focused row.
8. **Focus memory:** the list remembers, per route and tab (in memory), the focused issue's id and the scroll position. Coming back to the route (`Esc` from the issue page, the browser's back button, a link) restores the scroll and focuses that row; if the issue left the list, its neighbour at the same index.
9. The list is virtualised (fixed row and header heights per design-system §2.5) and scrolls at 60 fps with 10,000 issues (NFR-04). The focused row stays mounted while it is scrolled out of view, so focus is never lost to the document body.
10. **A public team the user isn't a member of** (SPEC-011 §5.7). Opening its list subscribes the client to the team on demand (at most 5 such teams; the least recently opened is dropped). Until the partial bootstrap is applied, the list shows "Loading…" (the skeleton after 150 ms), then renders from the replica and stays live like a member team's. Offline, a team that was never loaded shows "Available when online"; a team still subscribed renders from the replica. The load state comes from a `sync-react` hook (PLAN-011 S4c).

### 3.4 The issue page (`/issue/:identifier`)

Layout per [design-system §3](../05-design/design-system.md): a centred text column (max 760 px) and a 280 px properties panel.

1. **Header:** breadcrumb "ENG › Issues › ENG-42 Title…" (team and Issues are links), buttons that copy the link, the ID and the git branch name (§3.7), the ⋯ menu (**Copy ›**, **Delete**, later milestones' items), and, when the page was opened from a list, the position "3 / 41" with ↓ and ↑ buttons (`J` / `K` on the page, D14). Without a source list (a pasted link, `Mod+K`) the position is hidden (L15).
   **URL:** `/issue/ENG-42/<title-slug>`, built with SPEC-011's `issueSlug`. Any slug, or none, resolves to the issue, and the address is then replaced (`history.replaceState`) with the current slug. A title change replaces it again (D1).
2. **Title:** EditableTitle. Click or `Shift+R` to edit; `Enter` or blur saves (`issue.update {title}`), `Esc` cancels.
3. **Description:** SPEC-013's editor, editable in place. **Reactions** on the issue itself sit under the description (a row of reaction chips and an add button; SPEC-013 §3.4, D7). `Ctrl+Shift+I` focuses the description. It saves with `issue.updateDescription` on blur and after 2 s without typing, with the `baseVersion` it was loaded from. On `CONFLICT` (SPEC-011) the editor keeps the text and shows a banner: "Someone changed this description since you opened it. [Copy my text] [Discard and reload]". **Discard and reload** loads the replica's current description and version. Before the content is hydrated it shows a skeleton after 150 ms; offline and never hydrated, "Available when online".
4. **Attachments** (SPEC-014) under the description, then **Activity**: history entries and comments (SPEC-013: reply, resolve, reactions, menu) in one chronological stream, oldest first, with the comment box at the end (SPEC-013 §7). History lines use SPEC-011's wording: "Ada moved from Todo to In Progress · 2h ago", "Ada self-assigned the issue", "Ada created the issue", "Ada deleted the issue", with the names stored in the entry and the full timestamp in a tooltip. An actor that is an API key or MCP shows "via API" or "via MCP". When there are more than 30 activity items, only the newest 30 show, below a "Show N earlier" button that reveals the rest from the cache (D18).
5. **Properties panel:** status, priority, assignee, labels, estimate (shown while the team uses estimates or the issue has one; an off-scale value shows as its number with an "Off scale" hint), due date, then "Created by Ada · Nov 6" and "Updated 2h ago". Each row is a PropertyPill with its picker.
6. **Pending issue:** opened at `/issue/<id>` (SPEC-011). When the number arrives the URL is replaced with `/issue/ENG-42/<title-slug>` (`history.replaceState`), focus and scroll unchanged.
7. **Not found:** an identifier that the replica doesn't hold and that `issue.get` answers with `NOT_FOUND` (item 11) shows "ENG-99 doesn't exist, or you don't have access to it." with **Go to ENG issues** (or **Go home** for an unknown team key). The same wording for a private issue (no leak, SPEC-011). While the replica is still loading, the shell's progress shows instead (SPEC-005 §3).
8. **Archived and deleted issues** open read-only (SPEC-015 §3.4). The replica doesn't hold them, so the page reads them from the server: `issue.get` for the row, description, attachments and reactions, and an in-memory `/sync/content` answer for the activity (SPEC-015 §3.4). Offline: "Available when online". There is no banner. Title and description are read-only, the properties show but don't open, and the comment box and reaction buttons are hidden. An archived issue has the breadcrumb "ENG › Archived issues › ENG-42 Title" and an **Archived** badge after the title; a deleted one has "ENG › Recently deleted issues › ENG-42 Title" and a **Deleted** badge. The ⋯ menu offers **Copy ›** and **Restore** (`#`); an archived issue also offers **Delete**, and an Admin sees **Permanently delete…** on a deleted one (SPEC-015). The other issue commands are unavailable (§3.8). There is no archive command: archiving is automatic (SPEC-015).
9. **Back to the list:** `Esc`, when no overlay is open and focus isn't in a text field or the editor, goes back to the source list (else to the issue's team list) and restores its focus (§3.3 item 8).
10. **Hydration:** opening the page requests the issue's content if it isn't hydrated (SPEC-011). Sending a comment or saving a description on an issue that isn't hydrated starts its hydration first, so the confirmed row never disappears (SPEC-011).
11. **An issue the replica doesn't hold** (a link, a pasted identifier, `Mod+K`, an issue of another team): the page calls `issue.get`. A live issue of a public team subscribes its team on demand (as §3.3 item 10), and the page renders as soon as the row is in the replica; it shows the skeleton after 150 ms until then. An archived or deleted issue opens the read-only view of item 8. `NOT_FOUND` shows item 7's page. Offline, an issue the replica doesn't hold shows "Available when online". Opening any issue of a non-member public team subscribes its team, so its comments and attachments are live while it is open (SPEC-013 §5.1).

### 3.5 Property pickers

One **Property picker** component (design-system §5.3), opened anchored to its pill, to the focused row (when invoked by shortcut on a list), or as a command-menu sub-page. Focus is in its search field; the current value is checked.

| Picker | Options | Quick keys (empty query only) | Operation |
|---|---|---|---|
| Status | The team's statuses in workflow order, Triage and Duplicate left out (SPEC-011). | `1`–`9`: the first nine, by position | `issue.update {status}` |
| Priority | No priority, Urgent, High, Medium, Low | `0`–`4` (Linear uses the same numbers) | `issue.update {priority}` |
| Assignee | "No assignee", **Me**, then the team's members, then (public teams only) other active users, by name. A private team offers only its members (SPEC-011: the assignee must be able to see the team). Matches name, display name and email. | none | `issue.update {assignee}` |
| Labels | Multi-select. Team labels, then workspace labels, each under its label group's name; archived labels are left out except those already on the issue (SPEC-010). Label ids that aren't in the store (a label deleted while its `U` deltas are on the way, SPEC-010) are skipped here and wherever labels render. Inside a group, choosing a label unchecks the group's other label (INV-07). | `Space` toggles the highlighted label | one `issue.update {addLabels, removeLabels}` with the difference |
| Estimate | "No estimate", then the scale's values with their labels (SPEC-010) | `0`: no estimate. A digit equal to a scale value picks that value (fibonacci `5` → 5; t-shirt `5` → L). Other digits do nothing. | `issue.update {estimate}` |
| Due date | DatePicker: calendar plus typed dates ("tomorrow", "next friday", "in 2 weeks", "dec 3", `2026-12-03`), "No due date" | none | `issue.update {dueDate}` |

**Key rules**

- Quick keys work only while the search query is **empty**. Once the query has text, digits and spaces are typed into it ("2nd review", "Needs design"). Quick-key hints show beside the options only while they work.
- `↑` / `↓` move the highlight. In a single-value picker, `Enter` picks the highlighted option and closes.
- In the labels picker, `Space` (empty query) toggles the highlighted label and keeps the picker open. `Enter` applies the pending toggles and closes; only when nothing is pending does it toggle the highlighted label first (design-system.md line 204, Property picker: "`Space` toggles, `Enter` applies"). So `Space` then `Enter` never undoes the last toggle. Closing in any way (`Enter`, `Esc`, a click outside) applies all toggles as one `issue.update`; there is no cancel, as in Linear, where toggles take effect at once.
- A picker opened by a shortcut on a list row returns focus to that row when it closes.

Every change is optimistic; a rejection rolls back and shows the server's message as a toast (NFR-08). Estimate on a team whose scale is `off`: `Shift+E` shows "ENG doesn't use estimates. Turn them on in team settings." and opens nothing.

### 3.6 M1 shortcut map

Every M1 key of every M1 spec, in one table, so the conflict test (SPEC-005 AC-7) is checked once. The keys are **Linear's own**, taken from its shortcut panel (D3); a key for a command Surface doesn't have yet stays reserved (below). All are registry entries with a command (shortcuts §1 rule 6) and show in the `?` overlay. "Typing" says whether the binding fires while focus is in a text field or the editor (§4.2). `Ctrl` is the literal Control key, never `Mod`.

| Keys | Scope | Action | Typing | Owner |
|---|---|---|---|---|
| `C` | global | Create issue (context-prefilled) | no | this spec |
| `G` `E` | global | All issues of the current team (route team, else home team, else first member team; else the hint "Join a team to see its issues") | no | this spec |
| `G` `M` | global | My issues → Assigned | no | this spec |
| `G` `D` | global | Drafts | no | this spec |
| `G` `X` | global | Team archive of the current team (same team rule as `G` `E`) | no | SPEC-015 |
| `Ctrl+Shift+1…9` | global | Issues of the n-th team in the sidebar (matched on `Digit1`…`Digit9`) | yes | this spec |
| `Mod+Z` | global | Restore the issue you just deleted (§3.11); does nothing when there is none | **no** | this spec |
| `Esc` | global (existing `ui:escape`) | Adds one step to the chain: on the issue page, back to the source list (§3.4 item 9) | yes | this spec |
| `J` / `↓`, `K` / `↑` | list | Next / previous row or group header | no | this spec |
| `Enter` | list | Open the focused issue | no | this spec |
| `T` | list | Collapse or expand the focused group header | no | this spec |
| `Alt+T` | list | Collapse or expand all groups | no | this spec |
| `S` · `P` · `A` · `L` | issue | Status · priority · assignee · labels picker | no | this spec |
| `Shift+E` · `Shift+D` | issue | Estimate · due date picker | no | this spec |
| `Mod+Shift+D` | issue | Remove the due date | yes | this spec |
| `I` | issue | Assign to me (does nothing if already assigned to me) | no | this spec |
| `Shift+R` | issue | Rename (focus the title; on a list, open the issue with the title in edit mode) | no | this spec |
| `Mod+.` | issue | Copy ID | yes | this spec |
| `Mod+Shift+,` | issue | Copy URL (matched on `Comma`) | yes | this spec |
| `Mod+Shift+.` | issue | Copy git branch name (matched on `Period`) | yes | this spec |
| `Mod+Shift+'` | issue | Copy title (matched on `Quote`) | yes | this spec |
| `Mod+Alt+C` | issue | Copy issue as Markdown (matched on `KeyC`) | yes | this spec |
| `Mod+Backspace` | issue | Delete issue: opens the confirm dialog (§3.11) | **no** | this spec |
| `#` | issue | Restore the focused issue; only on an archived or deleted issue | no | SPEC-015 |
| `J` / `K` | issue-page | Next / previous issue of the source list | no | this spec |
| `Mod+Enter` | issue-page | Save the description now | yes | this spec |
| `Ctrl+M` | issue-page | Comment on issue: focus the comment box, saving the description first (macOS only, D21) | yes | SPEC-013 |
| `Ctrl+Shift+I` | issue-page | Focus the description (macOS only, D21) | yes | this spec |
| `Mod+Shift+U` | issue-page | Attach file. With focus in the description or a comment box, the chosen file is inserted inline at the cursor (SPEC-013 §3.5, SPEC-014 §3.3); anywhere else on the page it becomes an attachment (SPEC-014 §3.1). One binding, not an `editor` one | yes | SPEC-014 |
| `Ctrl+L` | issue-page | Link any URL to the issue (macOS only: on Windows and Linux Ctrl+L is the address bar) | yes | SPEC-014 |
| `R` | comment | Reply to the focused comment | no | SPEC-013 |
| `Enter` · `Mod+Enter` | comment | Send the comment, reply or edit in this box (`Shift+Enter` is a new line; shadows `issue-page` `Mod+Enter`) | yes | SPEC-013 |
| `Mod+B` · `Mod+I` · `Mod+U` · `Mod+E` | editor | Bold · italic · underline · inline code (handled by the editor, listed) | yes | SPEC-013 |
| `Mod+Shift+X` | editor | Strikethrough | yes | SPEC-013 |
| `Mod+K` | editor | With a text selection, add or edit a link; otherwise the command menu (existing E1 shadow) | yes | SPEC-013 |
| `Alt+Shift+.` | editor | Blockquote (matched on `Period`) | yes | SPEC-013 |
| `Mod+Alt+0` · `Mod+Alt+1…4` | editor | Regular text · heading 1–4 (matched on `Digit`) | yes | SPEC-013 |
| `Mod+Shift+7` · `8` · `9` | editor | Checklist · bulleted list · numbered list (matched on `Digit7`…`9`) | yes | SPEC-013 |
| `Mod+Enter` | editor | In a checklist item only: toggle it. Elsewhere it falls through to `issue-page` or `modal` | yes | SPEC-013 |
| `Mod+Shift+\` | editor | Code block (matched on `Backslash`) | yes | SPEC-013 |
| `Alt+↑` / `Alt+↓` | editor | Move the block (the editor handles it) | yes | SPEC-013 |
| `Mod+Z` · `Mod+Shift+Z` | editor | Undo · redo text (the editor handles them; the global `Mod+Z` doesn't fire here) | yes | SPEC-013 |
| `Enter` · `E` · `Alt+↑` / `Alt+↓` · `Mod+Backspace` | settings-row | Edit · edit the label name (labels page, SPEC-010) · reorder (statuses) · delete, which opens SPEC-010's dialog | no | SPEC-010 |
| `Mod+Enter` | modal (existing `dialog.submit`) | Create the issue in the composer; confirm Delete; submit any dialog | yes | existing |

Existing keys that stay as they are (SPEC-005): `Mod+K`, `?`, `[`, `G` `S`, `Mod+,`. `Mod+/` opens the shortcut help like `?` (Linear's second key; shortcuts.md change, §12).

**Reserved for later commands.** Surface binds none of these to anything else, so the keys are free when the command arrives. Navigation: `G` `I` inbox (M4), `G` `T` triage (M4), `G` `A` active issues and `G` `B` backlog (M2 view tabs), `G` `C` cycles, `G` `V` current cycle, `G` `W` upcoming cycle, `G` `P` projects, `G` `N` initiatives, `G` `R` reviews, `O` `I` open issue, `O` `T` open team, `O` `U` open user, `O` `P` `O` `C` `O` `V` `O` `D` `O` `N` `O` `F`, `O` `W` switch workspace, `]` right sidebar, `/` search (M2), `Mod+Alt+O` open link from the last toast, `Mod+Alt+X` dismiss all toasts, `Alt+Shift+Q` log out. Issues: `V` new issue full screen, `Alt+C` new from template, `Ctrl+Alt+Shift+T` apply template, `Alt+F` favorite, `Shift+H` remind, `Mod+Shift+M` move to another team, `Shift+S` subscribe, `Mod+Shift+S` manage subscribers, `M` `B` `M` `X` `M` `R` `M` `M` relations, `Mod+Alt+P` copy as prompt, `Mod+Shift+O` create sub-issue, `Shift+C` cycle, `Shift+P` project, `Shift+M` milestone, `Mod+Shift+P` set parent, `Mod+Shift+↑` open parent, `Mod+Shift+↓` open sub-issue, `Ctrl+Shift+L` toggle links. List: `Space` peek, `X` select, `Mod+Alt+A` select group, `Mod+A` select all, `Esc` clear selection, `Mod+B` layout, `Shift+V` display options, `Mod+Shift+C` copy page URL, `Alt+Shift+↑` / `Alt+Shift+↓` top or bottom of group, `Alt+↑` / `Alt+↓` and `Alt+←` / `Alt+→` move one position or column (manual order and board, M2), `F` filters, `Alt+Shift+F`, `Shift+F`. Editor: `Mod+Shift+6` collapsible, `Mod+Shift+Enter` toggle nested checklist, `Alt+F10`, `Shift+F10`. Inbox keys (`E`, `U`, `H` and others) arrive with the inbox (M4).

**Not bound in M1, on purpose:**

- `Enter` on a group header (`T` toggles it; design-system §5.3).
- `Mod+Z` in a text field or the editor: it undoes text. Outside text, the global `Mod+Z` restores only the last issue you deleted, until M2's general undo takes the key over.
- Permanent delete: no chord. It runs only from the row or page menu, in a confirm dialog (SPEC-015).
- Linear's literal-Control keys on Windows and Linux (`Ctrl+L`, `Ctrl+M`, `Ctrl+Shift+I`), where the browser owns them (D21). Their commands run from the ⋯ menu and `Mod+K`.
- Linear's `Mod+Shift+D` is also a browser key ("Bookmark all tabs"); the binding calls `preventDefault`, and "Remove due date" stays in `Mod+K` if the browser wins.
- Keys Linear has for comments (`↑` / `↓` through comments, `E` to edit, `Mod+Backspace` to delete a comment): its panel doesn't list them, so Surface has none. Edit and delete run from the comment menu (SPEC-013).

**Scopes** (shortcuts §2, new ones marked ★):

| Scope | Kind | Active when |
|---|---|---|
| `issue-page` ★ | page | The issue page is the current page |
| `comment` ★ | component | A comment card, or something inside it, has focus |
| `settings-row` ★ | component | A row of a settings list (statuses, labels) has focus |

There are no `trash` and `archive` scopes: the rows of the team archive and Recently deleted pages set `list` and `issue` like any issue row, and `ui.available` hides the editing commands for an archived or deleted issue (§3.8), leaving `#` and the copy keys (and `Mod+Backspace` on an archived issue).

Order, most specific first: overlays (`modal`, `picker`) → `editor`, `comment`, `settings-row` → `list`, `issue` → page scopes (`issue-page`, `inbox`, `triage`) → `global`. The conflict tables (`OVERLAPPING`, `SPECIFICITY` in `apps/web/src/shortcuts/conflicts.ts`) gain these pairs: `issue-page` with `issue`, `editor` and `comment`; `comment` with `issue` and `editor`.

### 3.7 Copy actions (FR-ISS-08, 17)

The page header buttons copy the link, the ID and the git branch name. Everything is in the **Copy ›** submenu (⋯ menu, row menu, `Mod+K`).

| Action | Copies | Key | Toast |
|---|---|---|---|
| Copy ID | `ENG-42` | `Mod+.` | "Copied ENG-42" |
| Copy URL | `<location.origin>/issue/ENG-42/<title-slug>` | `Mod+Shift+,` | "Copied link to ENG-42" |
| Copy title | `Fix login redirect` | `Mod+Shift+'` | "Copied title" |
| Copy title as link | `[Fix login redirect](<URL>)` (Markdown) | none | "Copied title as link" |
| Copy issue as Markdown | `# ENG-42 Fix login redirect`, then the description as Markdown (SPEC-013), then the URL | `Mod+Alt+C` | "Copied ENG-42 as Markdown" |
| Copy git branch name | `<displayName>/eng-42-<title-slug>` (D19) | `Mod+Shift+.` | "Copied branch name" |

The URL uses the page's own origin: the client never reads server configuration (CLAUDE.md rule 7), and the app is always served from its public URL. The slug is `issueSlug(title)` (§4.1); a title with no letters or digits gives no slug (`/issue/ENG-42`). For a pending issue (no number yet) the copy actions say "Wait a moment: ENG-… has no number yet." and copy nothing. The clipboard API needs a secure context; elsewhere a fallback copies through a hidden text area. Linear's "Copy ID and title" has no counterpart in its panel, so it is dropped (D3).

### 3.8 Command menu

Commands come from SPEC-011's `ui` entries plus these client commands. Context rules per [command-menu §3.3](../05-design/command-menu.md).

| Context | Suggested commands |
|---|---|
| One issue (focused row or open page) | Change status…, Set priority…, Assign…, Assign to me, Labels…, Set estimate… (when used), Set due date…, Remove due date, Rename issue, Copy ID, Copy URL, Copy title, Copy title as link, Copy issue as Markdown, Copy git branch name, Delete issue |
| One archived issue | Restore issue, Delete issue, Copy ID, Copy URL, Copy title, Copy title as link, Copy issue as Markdown, Copy git branch name (the editing commands are unavailable) |
| One deleted issue | Restore issue, Copy ID, Copy URL, Copy title, Copy title as link, Copy issue as Markdown, Copy git branch name (the editing commands are unavailable) |
| Team page or team list | Create issue in ENG, Go to ENG issues, Go to archived issues in ENG, Go to recently deleted issues in ENG, Team settings |
| Nothing | Create issue…, Go to {team} issues (one per team), Go to My issues, Go to Drafts |

- **Property commands.** Change status…, Set priority…, Assign…, Assign to me, Labels…, Set estimate…, Set due date… and Remove due date are **property commands**, a new command kind (SPEC-005 §4 change, §12). Each is defined in `apps/web/features/issues` next to its picker, dispatches `issue.update` with a partial input (e.g. `{issue, status}`), opens the §3.5 picker as a sub-page (Remove due date has none), and uses the same client permission pre-check as operation commands; `appliesTo` matches the target kinds `issue` and `issues`. They exist because a registry entry has one `ui` entry, and `issue.update` has none (SPEC-011 §6.1).
- **Availability:** issue commands use the `ui.available(target, store)` predicate (SPEC-003 change, §12). Editing commands are unavailable for an archived or deleted issue (an archived issue can still be deleted, `Mod+Backspace`, SPEC-015 §3.4; a deleted one can only be restored); their shortcuts then show the hint "ENG-42 is archived. Restore it to edit it." or "ENG-42 was deleted. Restore it to edit it." (SPEC-005 §5 "not available here"). **Restore issue** is available only there.
- **Destructive commands** (Delete issue) never rank first for a query they match only by keyword; they rank first only when the query matches their title better than any other command. They always run from their own item (Linear ranked "Delete issue" first for the query "deleted"). Wording shared with SPEC-015.
- There is no "Archive issue" command: archiving is automatic (D6).
- **Issue search** in `Mod+K` covers the issues in the replica (the local index, ADR-0008). An exact identifier the replica doesn't hold (`eng-87`) still offers **Open ENG-87**, which opens the route and resolves through `issue.get` (§3.4 item 11).

### 3.9 My issues (`/my-issues`, D5)

1. `/` opens the home view (SPEC-005). With no home team preference it is My issues. M1 has two tabs: **Assigned** (`/my-issues`) and **Created** (`/my-issues/created`). Subscribed (M4) and Activity (later) stay hidden until they are built. `G` `M` opens the tab the user used last, Assigned at first.
2. **Assigned** holds the user's issues that are not archived, deleted, completed or canceled, across all teams the user can see. **Created** holds the issues the user created that are not archived or deleted, completed and canceled included. Both render from the replica and work offline: it holds every live issue assigned to or created by the user, in any team they can see (`user:` groups, SPEC-011 §5.7).
3. Grouped by **status**: issues whose status has the same name and category share a group, because statuses belong to teams; each row shows its own status. Groups follow category order, then the lowest status position, then name. Each GroupHeader shows the StatusIcon, name, count and a `+`; Completed and Canceled groups start collapsed. The `+` opens the composer with that status when the context team has one by that name, and with the assignee set to the user on Assigned. Within a group: priority, then `updatedAt` newest first, then identifier.
4. The same IssueRow, keys, row menu, focus memory and pickers as the team list (§3.3). The identifier column always shows the team key.
5. Empty Assigned: "Nothing is assigned to you. Issues assigned to you show up here." with **Create issue** (`C`). Empty Created: "You haven't created any issues yet." with **Create issue**.

### 3.10 Team archive and Recently deleted (placement only)

SPEC-015 owns what these pages do. This spec gives them the list machinery.

1. `G` `X`, the sidebar's team **Archive** item and "Go to archived issues in ENG" open `/team/:key/archive`, titled "Archived issues", with two tabs: **Issues** (archived) and **Recently deleted issues** (`/team/:key/archive/recently-deleted`, command "Go to recently deleted issues in ENG"). The command titles are SPEC-015's (§7). There is no workspace-level page of deleted issues (D6).
2. Rows are the IssueRow of §3.3, grouped by status, with the same focus model. They are read from the server, not the replica (SPEC-015 §3.3), so the page shows "Loading…" first and "Available when online" offline. On Recently deleted the date column shows the deletion day instead of the created date.
3. The row menu has **Copy ›** and **Restore** (`#`). Nothing else edits these issues (§3.4 item 8). `Enter` opens the issue page.
4. `#` restores the focused issue from either tab, or the open page. Restore is one command for both states (SPEC-015 decides the operation). After a restore the row leaves the list and focus moves to the next row (E2), with a toast "Restored ENG-42" and **Open**.

### 3.11 Delete and restore

1. `Mod+Backspace` (not while typing), **Delete** in the ⋯ or row menu, or "Delete issue" in `Mod+K` opens a confirm dialog: title `Delete "ENG-42 – Fix login redirect"?`, body "Deleted issues are available in the "Recently deleted" view for 30 days, before they are permanently deleted.", buttons **Cancel** and **Delete**. Focus starts on **Delete**, so `Mod+Backspace` then `Enter` deletes by keyboard, and `Mod+Enter` also submits. There is no Undo toast (D8).
2. Confirming dispatches `issue.delete`, whose optimistic removes the issue from the replica (SPEC-015 §6.2). On the issue page, the page stays and shows the deleted state, starting from the row it had (SPEC-015 §3.1, §3.4). On a list, the row leaves at once and focus moves to the next row (E2). A polite live region announces "ENG-42 deleted".
3. The client remembers the **last issue the user deleted** in this session (memory only). `Mod+Z` outside text restores it with `issue.restore`. The replica doesn't hold the deleted issue, so the toast says "Restoring ENG-42…" until the mutation is confirmed, then "Restored ENG-42". It doesn't wait for a packet: the connection may not subscribe to the issue's team. If the team isn't subscribed, the open page refetches with `issue.get` (SPEC-015 §3.1). The memory clears after the restore, after the next delete (it then holds that one), and on reload. The key is free for M2's general undo, which replaces this rule.
4. **Restore from the lists and pages** is `#` (§3.10). It works on archived and deleted issues alike.
5. If the issue has sub-issues (M3), SPEC-015's M3 rule adds them to the dialog: `Delete "TUN-28 – …" and 3 sub-issues?`.

### 3.12 Sign-out deletes the local replica (Q3)

1. **Log out** in the avatar menu (SPEC-005) is an explicit sign-out. The client calls `POST /auth/logout`, closes its socket, then deletes the replica database `surface-<workspaceId>-<userId>` (SPEC-002 §3.1: rows, hydration marks, the subscription set and the mutation queue) and goes to the sign-in page.
2. **Unsent changes:** when the mutation queue isn't empty, Log out first asks "N changes haven't been sent yet. Signing out discards them." with **Cancel** and **Log out**. Offline, that is the only way the queue can be non-empty, and Log out still deletes the database after the dialog (the server session ends at its next contact or expiry).
3. **Other tabs** of the app close their database connection when they see the session end, so the delete isn't blocked; they then show the sign-in page.
4. A session that expires or is revoked (not an explicit Log out) deletes nothing: the next sign-in of the same user reuses the replica and sends the queue.
5. The next sign-in finds no database and bootstraps fresh (SPEC-002 §3.1 cold start). Drafts come back from the server (§3.2).

*Added 2026-11-16 (PLAN-012 S7a review), what "ends at its next contact" means in item 2.* Logging out when the server can't be reached ends the session here and sets a non-secret flag in `localStorage` (`surface.logout-pending`), because the session cookie is HttpOnly and nothing else would end it: the next page load, the `online` event and a sign-in each send `POST /auth/logout` first, treating the session as ended until it succeeds, then clear the flag; other tabs end their session when the `storage` event shows the flag. The unsent-changes count (item 2) covers every tab's queue, because the delete removes them all. If the delete of the replica fails after the logout, the user is signed out, the database name is remembered (`surface.pending-replica-deletes`) and the delete is retried at the next load.

## 4. Domain & client changes

One new synced model, `Draft`, and two new operations, `draft.save` and `draft.discard` (§4.3). Everything else uses existing operations.

### 4.1 Pure functions in `packages/domain` (unit and property tested)

- `issueSlug(title)` (defined in SPEC-011 §4.1, used here): ASCII-folded, lowercase, non-alphanumerics to `-`, collapsed, trimmed, at most 60 characters, empty when nothing is left. It makes the issue URL (D1) and the branch name.
- `gitBranchName(displayName, identifier, title)`, built on `issueSlug`.
- `compareIssuesInGroup` and `statusGroups(team)` (team list), `namedStatusGroups` (My issues, §3.9), shared with M2's display options later.
- `parseDueDate(text, today)`: a small fixed English grammar (today, tomorrow, weekday names, "next <weekday>", "in N days/weeks/months", "end of week/month", month and day, ISO dates) to a calendar date (`YYYY-MM-DD`, no time zone, domain-model §1). Weeks start on Monday in M1.
- `estimateForDigit(scale, digit)` (§3.5).

### 4.2 Shortcut engine (`apps/web/src/shortcuts/`, SPEC-005 §5 change)

1. **`whileTyping` per binding.** Today every `Mod` chord fires while typing (`engine.ts`, `#accepts`). A binding may now set `whileTyping: false`. Chords that edit text in a field must set it, and the registry refuses to load otherwise: `Mod+Backspace`, `Mod+Delete`, `Mod+Z`, `Mod+Shift+Z`, `Mod+A`, `Mod+C`, `Mod+X`, `Mod+V`, `Mod+←`/`→`/`↑`/`↓`. Without this, ⌘⌫ ("delete to line start" on macOS) and Ctrl+Backspace ("delete previous word" on Windows and Linux) in a title or comment would delete the issue.
2. **Digits, punctuation and Alt with modifiers.** `toChord` today rejects `Shift` or `Alt` with a non-letter, and matches non-letters on `event.key` (`chord.ts:158-160`). From this spec, `event.code` matching applies to **digits, to every chord that includes `Alt`** (letters too: Option+T types "†" on macOS, so `Alt+T` and `Mod+Alt+C` need the physical key), **and to chords that include `Shift` with a non-letter** (`Ctrl+Shift+1`, `Mod+Shift+.`, `Mod+Shift+,`, `Mod+Shift+'`, `Mod+Shift+7`, `Mod+Shift+\`). Everything else keeps matching on `event.key`, including `Mod+,` and `Mod+.`, so `Ctrl+,` still opens Settings on AZERTY (where "," is on `KeyM`), as SPEC-005 E3 requires. The plain symbols `#`, `?` and `[` match on `event.key` with no `Shift` in the chord, so they work on every layout. For each event the engine tries `event.key` matches first and `event.code` matches only if none matched, so AZERTY `Ctrl+.` (typed as `Ctrl+Shift+Comma`) runs `Mod+.`, never `Mod+Shift+,`. Expected results per layout are in AC-9.
3. **A literal `Ctrl` modifier.** Chords may say `Ctrl` (the Control key on every platform), next to `Mod`. Needed for `Ctrl+Shift+1…9`, `Ctrl+M`, `Ctrl+Shift+I` and `Ctrl+L` (Linear's keys). A binding may be limited to a platform (`platform: 'mac'`); the macOS-only keys of §3.6 use it, and the registry shows them only there.
4. **New scopes** `issue-page`, `comment`, `settings-row` (§3.6), with the overlap and specificity tables.
5. **`Esc` chain** (`ui:escape`): editor popover → leave the text field or editor (title: cancel the edit) → M2 selection → on the issue page, back to the source list.
6. **Last-delete memory** for the global `Mod+Z` (§3.11): one slot in the web app's memory, set by `issue.delete`, read by the command; it is not engine state.
7. *As built (PLAN-012 S1):* **fall-through.** If the most specific binding's command is unavailable, the engine runs the next binding (by scope order) whose command is available, and shows the "not available here" hint only when none is. `whileTyping: true` lets a plain key fire in a text field (`Enter` in a comment, `Alt+Shift+.` and `Alt+↑`/`↓` in the editor); `false` blocks any chord there; unset keeps the default.

### 4.3 The `Draft` model and its operations

A synced model in the user's own sync group `user:<id>`, so only its owner ever receives it (rule 4; the leak test is AC-3).

| Field | Type | Note |
|---|---|---|
| `id` | UUIDv7 | client-generated |
| `userId` | id | the owner; set by the server from the actor |
| `kind` | `composer` \| `comment` | |
| `teamId` | id or null | for `composer`: the draft's team. One per user and team |
| `issueId` | id or null | for `comment`: one per user and issue |
| `data` | JSON | composer: `{title, description, statusId, priority, assigneeId, labelIds, estimate, dueDate}`; comment: `{text}`. Zod-validated; text sizes bounded by SPEC-011's description limit and SPEC-013's comment limit |
| `createdAt` | timestamp | server-set (D24) |
| `updatedAt` | timestamp | server-set; the Drafts page shows it, and the 30-day rule reads it |

- **`draft.save`** `{kind, teamId | issueId, data}`: creates the draft or replaces the one with the same key (an upsert, so a retry is safe). When a user would then hold more than 50 drafts of that kind (comment or composer, D27), the server deletes the oldest of that kind, by `updatedAt` then id. The optimistic update does the same. Optimistic.
- **`draft.discard`** `{kind, teamId | issueId}`: deletes it; deleting a missing draft succeeds.
- Both are written only through the repo layer (rule 2) and respect no team permission: a draft is the owner's own data, and the owner needs no access to the team to hold or delete one. The server doesn't resolve `teamId` or `issueId` into anything visible, so a draft never reveals a private team's content to anyone else. The registry rules of SPEC-003 §11 apply (names, `optimistic`, input and output schemas).
- **Table** `drafts`: partial unique indexes on `(user_id, team_id) where kind = 'composer'` and `(user_id, issue_id) where kind = 'comment'`, and a CHECK that a composer draft has `team_id` and no `issue_id`, and a comment draft the reverse. **No foreign keys** to `teams` or `issues`: a draft must not block a purge (SPEC-015 §4.5), and its insert must not reveal whether a team or issue exists. A draft whose issue is gone is hidden by the Drafts page (E18) and expires with the 30-day rule.
- The client (`apps/web/src/features/issues/`, the draft adapter) reads `Draft` rows from the store and writes through `dispatch`. No new storage in `packages/sync-client`: there is no `drafts` object store.

### 4.4 Components (`packages/ui`) and features (`apps/web`)

| Where | What |
|---|---|
| `packages/ui` (presentational: plain props, domain types only, stories with axe and visual baselines) | StatusIcon, PriorityIcon, PropertyPill, PropertyPicker, LabelChip, DatePicker, GroupHeader, IssueRow, EditableTitle, VirtualList |
| `apps/web/src/features/issues/` (bound to the store and `dispatch`, unit tested) | IssueListPage, MyIssuesPage (Assigned and Created), DraftsPage, IssuePage, Composer, DeleteIssueDialog, the bound pickers, the list focus model, the draft adapter |

`@surface/ui` moves `@surface/domain` from `devDependencies` to `dependencies` (the boundary already allows `ui → domain`). `apps/web` gets no Storybook: what needs a story lives in `packages/ui`.

**No new dependencies.**

- **Virtualisation:** built in-house as `VirtualList`. Rows and group headers have fixed heights (design-system §2.5), so the window is arithmetic, with nothing measured during render. That is about a hundred lines and a few tests, smaller than learning a library's grouping and focus quirks.
- **Dates:** `parseDueDate` covers the grammar of §4.1 in-house, and the calendar uses `Intl.DateTimeFormat` for month and weekday names. Due dates are calendar dates without time zones, so a date library adds little. Other languages are later.

## 5. Sync & permissions

- The views render from the replica: eager Issue (with `labelIds`), statuses, labels and users. Description and history come from content hydration (SPEC-011): opening an issue page requests its content if it isn't hydrated; the list prefetches the content of visible issues it holds (debounced, SPEC-011). An issue open in any tab is never evicted from the content cache (SPEC-011).
- **Partial issue loading** (SPEC-011 §5.7). The replica holds the live issues of the teams the client subscribes to and the user's own issues, never an archived or deleted one. A non-member public team's list or issue subscribes the team on demand (§3.3 item 10, §3.4 item 11). Server reads, online only: `issue.get` for an issue not held, `issue.count` for "N archived issues", and SPEC-015's archive queries. Each refreshes on the relevant packets and on focus.
- All edits are SPEC-011 operations with `optimistic`, so they work offline and queue (sync-protocol §5.3). Drafts use `draft.save` and `draft.discard` the same way.
- `Draft` rows arrive only in the owner's `user:<id>` group (§4.3). The leak checklist (permissions.md §5) gains: another user's drafts never reach a replica, and a draft for a team the user left holds nothing the user couldn't already see.
- Any user who can see a team can create and edit its issues (SPEC-011). A private team's issues never reach a non-member's replica, so their identifiers show "not found" (§3.4), and the assignee picker of a private team offers only members (§3.5).

## 6. API

Two new operations, `draft.save` and `draft.discard` (§4.3). Uses `issue.create`, `issue.update`, `issue.updateDescription` (SPEC-011), `issue.delete`, `issue.restore` (SPEC-015; there is no `issue.archive` for users), and the comment and attachment operations (SPEC-013, SPEC-014). The `issue.update` commands in `Mod+K` are property commands (§3.8), not registry `ui` entries; their pickers are the components of §3.5 used as command-menu sub-pages.

## 7. UI

### 7.1 Screens

| Screen | Route | Components |
|---|---|---|
| Team issue list | `/team/:key/issues` | PageHeader, GroupHeader, IssueRow, VirtualList, PropertyPicker, EmptyState |
| My issues | `/my-issues` (Assigned), `/my-issues/created` | the same as the team list, grouped by status name |
| Drafts | `/drafts` | PageHeader, a list of rows (composer drafts, unsent comments), EmptyState "No drafts. Close the composer with **Save** to keep one here." |
| Team archive | `/team/:key/archive`, `/team/:key/archive/recently-deleted` | the team list's components (§3.10); SPEC-015 owns the content |
| Issue page | `/issue/:identifier/:slug?` (and `/issue/:id` while pending) | PageHeader, EditableTitle, editor (SPEC-013), properties panel of PropertyPills, activity stream, attachments area (SPEC-014) |
| Composer | overlay (not in the URL, SPEC-005 §3) | Dialog `lg`, team chip, PropertyPills, Switch, Button; the "Save as draft?" dialog |
| Delete dialog | overlay | Dialog `sm` (§3.11) |
| Sidebar | shell | Team ▸ **Issues** and **Archive** items; **My issues**; **Drafts**; **New issue** button next to search (SPEC-005 §7 said it arrives in M1) |

Routes join the shell router (`apps/web/src/app/router.tsx`) under the session guard; the team list replaces the reserved `/team/:key/issues` (SPEC-005 §3). Issue UI plugs into the shell through `features/hosts.ts` (`SHELL_HOSTS` for the composer and its commands).

### 7.2 States

| State | Shown |
|---|---|
| Replica loading | The shell's bootstrap progress (SPEC-005). Eager data is never shown as loading after that (design-system §4). |
| Another team's list, loading | "Loading…" (skeleton after 150 ms) until its partial bootstrap is applied (§3.3 item 10) |
| Another team's list, offline and never loaded | "Available when online" |
| Issue not in the replica, loading | Skeleton after 150 ms while `issue.get` and the team's load run (§3.4 item 11) |
| Issue not in the replica, offline | "Available when online" |
| Archive pages, archived or deleted issue, offline | "Available when online" (SPEC-015 §3.3, §3.4) |
| Team with no issues | EmptyState: "No issues in ENG yet. Create one with `C`." with **Create issue** |
| Nothing assigned, nothing created, no drafts | §3.9 item 5, §7.1 |
| No visible team | §3.1 item 3; `G` `E` shows "Join a team to see its issues" |
| Content loading | Skeleton after 150 ms in the description and activity |
| Offline, content never hydrated | "Available when online" in the description and activity; properties stay editable |
| Offline | Edits queue; the shell's offline banner shows the pending count (SPEC-005 §8) |
| Rejected change | Rolled back, toast with the server's message |
| Not found | §3.4 item 7 |
| Archived or deleted issue | Read-only, with an Archived or Deleted badge (§3.4 item 8) |

### 7.3 Small screens (NFR-20)

- **768–1279 px:** the properties panel collapses into a header button that opens it as a drawer (*clarified 2026-11-16, PLAN-012 S7a: the sidebar is a drawer below 1024 px, and the panel follows the same rule down to 768 px*).
- **< 768 px:** one column. The issue page shows the title, the properties as a wrapping row of pills under it (still editable), the description, then activity and the comment box. Lists show compact rows: priority, identifier, title, status, assignee. The composer is a full-screen dialog. Reading, commenting and changing properties work at 375 px without horizontal scrolling.

### 7.4 Accessibility (NFR-19)

- The lists are a `treegrid` (*changed 2026-11-12, PLAN-012 S2: axe allows `aria-expanded` on rows of a `treegrid`, not of a `grid`, and group headers expand and collapse; see D22*) with `aria-rowcount` (all rows, with virtualisation) and `aria-rowindex` on every rendered row. Group headers are rows (`aria-level` 1) with `aria-expanded` and an accessible name that includes the count ("In Progress, 12 issues, collapsed"). Focus uses a roving `tabindex`; the focused row stays mounted (§3.3 item 9). `aria-selected` arrives with selection (M2).
- Pills are buttons named "Status: In Progress, change". Pickers use the combobox pattern of the command menu (command-menu §5). A picker opened from a row returns focus to it.
- The disabled Create button is `aria-disabled` with a reason in its tooltip and in `aria-describedby`.
- The activity stream is a list of `article`s with the actor and time in each label. History changes are text, never colour alone.
- The composer traps focus and returns it to the trigger on close.
- A polite live region announces "Created ENG-42", rejections, "ENG-42 deleted", "Restored ENG-42", and "ENG-42 was removed" (E2).
- Every component story passes axe in light and dark; keyboard-only creation, editing and navigation work end to end (AC-14).

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | The focused row's issue changes group (someone moved its status) | The row moves; focus follows it and scrolls it into view. |
| E2 | The focused row is deleted, archived or moved out of the list by someone else, or by you (delete, restore) | Focus moves to the next row (or the previous at the end); a polite announcement says "ENG-42 was removed". |
| E3 | An issue page is open when someone deletes the issue (or the auto-archive job archives it) | The packet removes the issue from the replica (SPEC-011 §5.7), and the page switches to the read-only state of §3.4 item 8 (badge, no banner), fed by `issue.get`; until it answers, or offline, it shows the row it had. The issue commands become unavailable (§3.8); the page doesn't navigate away. An open picker for it closes. Edits already sent get `CONFLICT` ("ENG-42 was deleted. Restore it to edit it.") and roll back. |
| E4 | The title is being edited when a remote title change arrives | The local edit wins on save (last writer); until then the input keeps the user's text. |
| E5 | The description is being edited when a remote description save arrives | The editor keeps the user's text; the next save gets `CONFLICT` and shows the banner of §3.4. |
| E6 | `C` pressed while the composer is already open | Nothing: focus stays in the composer. |
| E7 | `C` pressed with a draft for a team the user can no longer see | `C` opens a fresh composer for the default team (the draft is only on the Drafts page, where opening it uses the default team and a note). |
| E8 | The composer's team uses estimates and the user switches to a team that doesn't | The estimate pill disappears and the value is dropped, with the note. |
| E9 | A pending issue is opened, then its create is rejected | While the rejection is held (the store keeps the last 20, in memory), the page shows "This issue couldn't be created: <reason>." with **Restore in composer**. After a reload it is no longer held, and `/issue/<id>` shows the not-found page. |
| E10 | Previous / next at the ends of the source list | The button is disabled; `J` / `K` do nothing. |
| E11 | The source list changes while stepping (an issue was added or removed) | Stepping uses the list's current order at the time of the key press. |
| E12 | An old link `/issue/ENG-42` for an issue that moved team (M3) | Redirects through aliases (SPEC-003 `IssueRef`); before M3 this can't happen. |
| E13 | Two tabs or devices edit the same draft | Last write wins on the server; the other device's replica updates from the delta. |
| E14 | `Alt+T` or `Mod+Alt+C` on macOS types a character (Option+T is "†") | Alt chords match on `event.code` (§4.2), so Option doesn't matter; inside inputs `Alt` chords don't fire (they count as plain keys while typing). |
| E15 | The user confirms Delete on an issue someone else just deleted | The server's answer is shown as a toast (SPEC-015); the page or row shows the deleted state. |
| E16 | ⌘⌫ or Ctrl+Backspace in the title, description or a comment | Deletes text as the platform does; nothing is deleted (`whileTyping: false`). |
| E17 | Digits typed in a picker after a letter ("v2") | They go into the search query; no quick pick. |
| E18 | A comment draft exists for an issue that was deleted or permanently deleted | Kept until it expires (30 days) or is the oldest of 50. For a draft whose issue isn't in the replica, the Drafts page asks `issue.get` (online): a live issue shows with its identifier and title; an archived or deleted one, or `NOT_FOUND`, is hidden, and is asked about again when the page regains focus, so it shows again once the issue is restored. Any other answer, and offline, shows such a draft as "Issue not loaded". (Clarified 2026-11-13, PLAN-012 S5 review.) |
| E19 | A draft is saved offline | `draft.save` queues like any operation. On another device it appears after the queue is sent. |
| E20 | A create is rejected while "Create more" is on and the user is typing the next issue | The rejection toast waits until the composer closes: a toast never appears for the first time over a modal (D26). If the composer is open again while that toast shows (`C` after it appeared), **Restore in composer** asks before replacing what is in the composer; Cancel keeps it (§3.1 item 9). Changed 2026-11-13 (D26). |
| E21 | A user presses `Space` on a label, then `Enter` | The label is toggled once and applied; `Enter` doesn't toggle it back (§3.5). |
| E22 | `#` on an issue that isn't archived or deleted | Nothing happens; the command isn't available. |
| E23 | `Mod+Z` with no deleted issue remembered, or in a text field | Nothing happens (the field undoes its text). |
| E24 | `Mod+Z` restores an issue that someone else already restored or permanently deleted | The server's message shows as a toast (SPEC-015); the memory clears. |
| E25 | The user closes the composer with content and picks **Discard** | The content is dropped, and the team's existing draft, if any, stays untouched. |
| E26 | An old issue link without a slug, with a wrong slug, or with a slug for an old title | It resolves, and the address is replaced with the current slug (§3.4 item 1). |
| E27 | A link to ENG-42, in a public team the user isn't in and doesn't subscribe to, is opened | `issue.get` answers; the client subscribes to ENG on demand; the page renders when the row is local (§3.4 item 11). |
| E28 | The user opens a sixth non-member team's list | The least recently opened on-demand team is dropped (SPEC-011 E31). Its issues leave the replica except the user's own; opening it again loads it again. |
| E29 | `eng-87` is typed in `Mod+K` and ENG-87 isn't in the replica | **Open ENG-87** is still offered and resolves through `issue.get`; a wrong identifier gives the not-found page (§3.8). |
| E30 | Log out with unsent changes | The dialog of §3.12 item 2; **Cancel** keeps the session and the queue. |
| E31 | The "N archived issues" count is asked for offline | The footer line is hidden; it appears after reconnecting (§3.3 item 6). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)); they are marked ⏸ and checked by hand, recorded in the slice's "As built". **Story tests** (axe and keyboard, `pnpm --filter @surface/ui test:storybook`) need Playwright's Chromium and are not part of `pnpm check`: as in PLAN-005, they are the UI slices' local Definition of Done.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `C` opens the composer prefilled from context (§3.1 item 2); `Mod+Enter` creates the issue with the chosen properties, closes and clears the team's draft; with "Create more" it stays open, clears title and description, and keeps the properties. With no visible team the composer doesn't open and the toast of §3.1 item 3 shows. | unit (prefill, payload, no-team) + e2e ⏸ |
| AC-2 | Changing the composer's team (or restoring a draft) drops status, team labels, an invalid estimate and an assignee who isn't a member of a private target team, keeps the rest, and says what was dropped. | unit |
| AC-3 | Drafts: closing the composer with content asks "Save as draft?"; **Save** sends `draft.save`, **Discard** sends nothing; an empty composer closes silently; `C` restores the team's draft; creating or discarding clears it (`draft.discard`); the Drafts page lists composer drafts and unsent comments and opens them; a comment draft shows in the issue's comment box; unresolvable values are dropped with a note; the 51st comment draft drops the oldest; the client discards drafts older than 30 days. `draft.save` is an upsert (a retry makes no duplicate). **Leak:** another user's drafts never reach a replica or a delta (sync groups), and a draft never carries data the owner couldn't see. | unit (draft adapter, fake dispatcher) + leak test (Postgres allowed: permission leak test) |
| AC-4 | The team list groups by status in workflow order, hides empty groups, collapses Completed and Canceled by default, and orders each group by priority, then `updatedAt` desc, then number desc. Assigned holds exactly the user's open issues across teams and Created the user's non-archived, non-deleted issues, both grouped by status name in category order; the tabs Subscribed and Activity are hidden. | unit + property (ordering is total) |
| AC-5 | Focus model: focus stays on the same issue across live re-sorts; moves to the neighbour when the issue leaves the list; is restored (issue and scroll) when the route is revisited. | unit (focus model) |
| AC-6 | The virtual window renders only the rows in view plus a fixed overscan, whatever the list's length, and keeps the focused row mounted; at 10,000 issues scrolling stays at 60 fps. | unit (window arithmetic) + perf ⏸ |
| AC-7 | Each picker offers exactly the options of §3.5 (Triage/Duplicate excluded; archived labels only when applied; a private team's assignee picker lists only members; estimate values per scale) and sends one `issue.update` with the right fields. Quick keys work only with an empty query; estimate digits pick by value; labels keep one per group, and closing applies all toggles in one update. | unit + story |
| AC-8 | Every binding of §3.6 is registered with a command, shows in `?`, passes the conflict and reserved-keys tests, and acts on the focused row, the open issue or the focused comment. Every key is the one in Linear's panel (shortcuts-2026-11-12), and none of the reserved keys is bound. Issue commands are unavailable for an archived or deleted issue; `#` is available only there. | unit (registry, conflicts, availability) |
| AC-9 | Engine: a `whileTyping: false` binding doesn't fire in an input, textarea or contenteditable; the registry refuses a text-editing chord without it; per layout (US, AZERTY, QWERTZ, Russian), `Ctrl+Shift+1` and `Mod+Shift+7` match on `event.code`; `Alt+T` and `Mod+Alt+C` match on `event.code` even when macOS Option changes `event.key`; `#` matches on `event.key`; `Mod+,` opens Settings on every layout (AZERTY: the `KeyM` key with Ctrl); `Mod+.` matches the key that types "." (AZERTY: Ctrl+Shift+Comma), and that same event never runs `Mod+Shift+,`; `Mod+Shift+.`, `Mod+Shift+,` and `Mod+Shift+'` match the US physical keys (`Period`, `Comma`, `Quote`) with Shift. `Ctrl` is distinct from `Mod` (on macOS `Ctrl+M` doesn't fire on Cmd+M), and a `platform: 'mac'` binding isn't registered elsewhere. | unit (engine, chord, a table of synthetic events per layout) |
| AC-10 | Copy actions put the exact text of §3.7 on the clipboard (ID, slugged URL, title, title as link, issue as Markdown, branch name); the slug and the git branch name are lowercase ASCII, ≤ 60 characters, and stable for a given title; pending issues copy nothing. | unit + property (slug, branch name) |
| AC-11 | The issue page renders title, properties and activity from the replica; history lines use SPEC-011's wording and the stored names; reactions show under the description; an off-scale estimate shows as off-scale; more than 30 activity items show the newest 30 and "Show N earlier". | unit + story |
| AC-12 | The description saves after 2 s idle or on blur with its `baseVersion`; a `CONFLICT` keeps the user's text and shows the conflict banner; "Discard and reload" loads the replica's version. | unit (save controller with a fake dispatcher) |
| AC-13 | A pending issue's page at `/issue/<id>` switches to `/issue/ENG-42/<slug>` when the number arrives, without losing focus or scroll. `/issue/ENG-42`, `/issue/ENG-42/anything` and `/issue/ENG-42/<old-slug>` all open the issue, and the address is replaced with the current slug; a title edit replaces it again. | unit (router helper) + e2e ⏸ |
| AC-14 | Keyboard only: create an issue with status, priority, assignee and labels; open it from the list; change each property; rename it; copy its identifier; go to the next issue; `Esc` back to the list with the row focused. Each action is also reachable from `Mod+K`. | e2e ⏸ (checked by hand) |
| AC-15 | Unknown and invisible identifiers show the same not-found page; nothing on it names a private team or issue. | unit |
| AC-16 | Command menu: the suggestions of §3.8 per context; Delete issue never ranks first for a keyword-only match. Delete (`Mod+Backspace`, menu or command) opens the dialog of §3.11 with the issue's identifier and title and sends `issue.delete` only on **Delete**; there is no Undo toast; `Mod+Z` outside text restores the last deleted issue once and does nothing after that, in a field, or after a reload. | unit (ranking, contexts, delete dialog, last-delete memory) |
| AC-17 | Previous / next follow the source list's current order, are disabled at the ends (E10, E11), and are hidden without a source list. | unit |
| AC-18 | The live region announces creation, rejection, deletion, restoring and removal of the focused row (E2). | unit (announcer) + story |
| AC-19 | Every new `packages/ui` component has stories in light and dark that pass axe and have visual baselines; the list (a `treegrid`, §7.4) exposes `aria-rowcount`, `aria-rowindex` and the group header names of §7.4. | story (axe) + visual |
| AC-20 | At 375 px the issue page, lists and composer work without horizontal scrolling (§7.3). | story (viewport) + manual ⏸ |
| AC-21 | Offline: properties stay editable and queue; a draft saved offline sends after reconnecting; an issue whose content was never hydrated shows "Available when online"; a hydrated one shows its description from IndexedDB. | unit (store states) + e2e ⏸ |
| AC-22 | `parseDueDate` returns the right calendar date for each form of §4.1 and never throws on any string. | unit + property |
| AC-23 | Opening a hydrated issue renders in < 100 ms; a property change paints in < 16 ms after the key press (NFR-01). | perf ⏸ (checked by hand) |
| AC-25 | The team archive routes show the two tabs "Issues" and "Recently deleted issues" with the IssueRow; the deleted tab's date column shows the deletion day; `#` and the row menu's **Restore** restore from either tab and from an open archived or deleted issue, and are unavailable elsewhere; no editing command or key works on those issues; there is no archive command. | unit (list model, availability) |
| AC-26 | An archived or deleted issue's page is read-only: properties don't open, there is no banner, the archived page has the "Archived" badge and the breadcrumb "Archived issues", and the deleted page has the "Deleted" badge and the breadcrumb "Recently deleted issues". | unit + story |
| AC-27 | A non-member public team's list subscribes the team on open, shows "Loading…" until its partial bootstrap is applied, then renders from the replica; offline and never loaded, it shows "Available when online"; a sixth team drops the least recently opened (E28). My issues renders from the replica, offline too. | unit (list data source with the fake hub, `sync-react` load-state hook) |
| AC-28 | An issue not in the replica is read with `issue.get`: a live public-team issue subscribes its team and renders when the row is local; an archived or deleted one opens read-only (§3.4 item 8); `NOT_FOUND` gives the not-found page; offline shows "Available when online". The `Mod+K` identifier fast path offers an identifier the replica doesn't hold (E27, E29). | unit (route loader with a fake dispatcher and fake hub, command source) |
| AC-29 | Explicit Log out deletes the replica database and the next sign-in bootstraps fresh; with unsent changes it asks first; a session expiry deletes nothing (§3.12). | unit (`fake-indexeddb`: sign-out deletes the database, a later sign-in bootstraps fresh) |
| AC-30 | The "N archived issues" footer reads `issue.count` (archived only, the team), is hidden offline and until it answers, and refreshes on focus (§3.3 item 6). | unit (footer with a fake dispatcher) |
| AC-24 | Labels picker: `Space` toggles; `Enter` applies the pending toggles and closes, and toggles the highlighted label only when nothing is pending (E21). Restore in composer asks before replacing a non-empty composer (E20). A rejected comment's text goes back into the issue's comment draft only when that draft is empty, else the toast offers Copy text (§3.2). | unit + story |

## 10. Metrics & performance

- Composer opens in < 50 ms after `C`; an issue created by keyboard appears on a teammate's screen in < 150 ms p95 (FR-ISS key criteria, NFR-02).
- Issue page from a hydrated cache < 100 ms; property change paint < 16 ms (NFR-01).
- List of 10,000 issues: first paint < 200 ms from the replica, 60 fps scrolling (NFR-04).
- Draft writes debounced to at most one per 500 ms per key.
- No new log events.

## 11. Open questions

None. The proposed defaults were accepted at the M1 gate on 2026-11-12 and moved to the Decisions table (D13–D21).

## Decisions

| # | Decision | Date |
|---|---|---|
| D10 (was Q4) | The composer description uses SPEC-013's editor; SPEC-012 is built after it (specs README build order). No plain-text stopgap. | 2026-11-12 |
| D11 (was Q13) | List rows show a relative time column, as design-system §5.3 lists it. Superseded by D2 (the column is now the created date). | 2026-11-12 |
| D1 (was Q1) | Copy Linear: issue URLs are `/issue/ENG-42/<title-slug>`. Any slug, or none, resolves to the issue and the address is replaced with the current slug. Copy URL copies the slugged URL. Replaces "identifier only". | 2026-11-12 |
| D2 | Copy Linear: the list's date column shows the **created** date by default ("Nov 6"), not a relative "updated" time. The row menu follows Linear's order (§3.3 item 5). | 2026-11-12 |
| D3 | Copy Linear: the shortcut map is Linear's own panel, key by key, for every M1 command (§3.6). Keys for later commands are reserved. `Ctrl+Shift+1…9` replaces `Alt+1…9` (this also settles the Firefox tab clash, old Q16). Copy keys follow Linear (`Mod+.` ID, `Mod+Shift+,` URL, `Mod+Shift+.` branch name, `Mod+Shift+'` title, `Mod+Alt+C` Markdown). "Copy ID and title" is dropped because Linear's panel has no such command. Comment keys Linear doesn't list (`↑` / `↓`, `E`, `Mod+Backspace` on a comment) are dropped. `Mod+Shift+U` (attach) stays, as in Linear; the IBus question is gone. | 2026-11-12 |
| D4 (was Q2) | Copy Linear: drafts are saved on the server and synced to every device, as the model `Draft` with `draft.save` and `draft.discard`. Closing the composer with content asks "Save as draft?" (Save, Discard); there is a Drafts page (`G` `D`). This replaces the silent local draft, the "composer is a dialog exception" and the IndexedDB `drafts` store. | 2026-11-12 |
| D5 (was Q14) | Copy Linear: My issues has tabs Assigned, Created, Subscribed and Activity, grouped by status with counts and `+`. M1 ships Assigned and Created; Subscribed (M4) and Activity (later) stay hidden. Replaces "Assigned only, grouped by category". | 2026-11-12 |
| D6 | Copy Linear: archiving is automatic only (SPEC-015); the page has no archive command, key or menu entry. "Trash" becomes **Recently deleted**, a tab of the team archive page (`G` `X`), with no `/trash` page and no workspace Trash item. `#` restores an archived or deleted issue. Archived and deleted issues are read-only (SPEC-015 §4.3). | 2026-11-12 |
| D7 | Copy Linear: reactions also sit on the issue, under the description. Custom emoji: later. Underline (`Mod+U`) exists in the editor (SPEC-013). | 2026-11-12 |
| D8 | Copy Linear: Delete opens a confirm dialog, `Delete "ENG-42 – <title>"?`, with Cancel and Delete. No Undo toast. `Mod+Z` right after a delete restores the last deleted issue (this session only) until M2's general undo. Replaces "no dialog, Undo toast" (old D3). Shared with SPEC-015. | 2026-11-12 |
| D9 | Linear embeds YouTube, Loom and Figma links, shows external images and unfurls links. **Not copied**: they need outbound network calls (CLAUDE.md rule 5). | 2026-11-12 |
| Q3 | Explicit sign-out deletes the user's local replica database (IndexedDB), scheduled in M1 (§3.12, PLAN-012 S7a). Nothing deleted it before (no `deleteDatabase` in `apps/web` or `sync-client`), so issue data and drafts stayed on a shared device. A session expiry deletes nothing. User decision; changes SPEC-002 (§12). | 2026-11-12 |
| D12 | Copy Linear, through partial issue loading (SPEC-011 §5.7, ADR-0020): member teams' lists and My issues stay local and offline; another public team's list subscribes on open ("Loading…", offline "Available when online"); an issue not held is read with `issue.get`, then its team is subscribed; archived and deleted issues and the archive tabs read from the server; "N archived issues" comes from `issue.count`; prefetch covers held issues only. | 2026-11-12 |
| D13 (was Q5) | The composer has no single-letter property shortcuts (focus is usually in a text field). Pills are reachable with `Tab`; each picker opens with `Enter` or `Space`. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D14 (was Q6) | `J` / `K` on the issue page step through the source list, in the page scope `issue-page` (§3.6). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D15 (was Q7) | `Ctrl+Shift+1…9` goes to that team's issue list (Linear's "go to team"; the team's most-used page in M1). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D16 (was Q8) | Completed and Canceled groups start collapsed (Duplicate stays expanded), per team and device; the user's toggle is remembered. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D17 (was Q9) | Fixed order within a group in M1: priority (Urgent → Low, then No priority), then most recently updated, then number. Manual order and other orders arrive with display options (M2). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D18 (was Q10) | Long activity streams show the newest 30 items; "Show N earlier" reveals the rest from the cache. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D19 (was Q11) | Git branch names are `<displayName>/<identifier lowercased>-<title slug>`: ASCII-folded, lowercase, non-alphanumerics to `-`, collapsed, trimmed, with `ß ø æ œ đ ł þ` transliterated first (ss o ae oe d l th) because NFKD leaves them alone. At most 60 characters in total, cutting the slug on a word boundary (the prefix is never cut unless it alone is too long). A display name with no Latin letters or digits drops the `<displayName>/` prefix. `foldToSlug` is the one folding function; `issueSlug` (PLAN-011 S4) must use it. No setting in M1. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D20 (was Q12) | Destructive commands in `Mod+K` never rank first for a query they match only by keyword, always run from their own item, and are hidden where `ui.available` is false. Delete opens its confirm dialog (§3.11). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D21 (was Q16) | Linear binds `Ctrl+L`, `Ctrl+M`, `Ctrl+Shift+I` and `Ctrl+Shift+1…9` on every platform. Surface binds `Ctrl+L`, `Ctrl+M` and `Ctrl+Shift+I` on macOS only, because on Windows and Linux the browser owns them (address bar, Firefox mute tab, DevTools); the commands stay in the ⋯ menu and `Mod+K`. `Ctrl+Shift+1…9` is bound on every platform: it is Linear's only key for going to a team, and no browser we know binds it (Chrome, Edge and Firefox use `Ctrl+1…9` for tabs; Firefox on Linux uses `Alt+1…9`). PLAN-012 S7b checks all of these by hand in Chrome, Edge and Firefox and records the result in its "As built" note. If `preventDefault` wins for a macOS-only key, it may be bound everywhere; if a browser takes `Ctrl+Shift+1…9`, it becomes macOS only. Either outcome is a dated change to this row. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D22 | A list is a `treegrid`, not a `grid`: group headers carry `aria-expanded`, which axe (`aria-conditional-attr`) accepts only on `treegrid` rows. Headers are level 1 and issue rows level 2. Found when the PLAN-012 S2 stories ran axe; the visible behaviour and the keys don't change. | 2026-11-12 |
| D23 | `draft.save` and `draft.discard` take `teamId`, `issueId` and the ids inside `data` (status, assignee, labels) as plain UUIDs, not reference types, so the executor resolves none of them: resolving would check that the actor can see the team or issue, and §4.3 says a draft needs no access and must not reveal whether a team or issue exists. `defineOperation` gains `opaqueIds` (the input paths that are deliberately not references), and `registry:lint` rule 4 accepts a UUID field only when it is a reference type or listed there, and flags a stale entry. Only `draft.save` and `draft.discard` may use `opaqueIds` (`OPAQUE_ID_OPERATIONS`, pinned by a lint test), recorded in SPEC-003 §3.1 and §11 and in [ADR-0025](../04-architecture/adr/0025-opaque-draft-ids.md) (2026-11-13, PLAN-012 S5 review). Found when PLAN-012 S5 registered the operations. | 2026-11-13 |
| D24 | A `Draft` row has `createdAt` as well as `updatedAt` (§4.3; like every synced table, and the Drafts page could show either), and a draft's title is bounded at 10,000 characters, not SPEC-011's 255: the composer must be able to save whatever was typed, and the title rule is applied when the issue is created ("Title is required.", the length message). `draft.discard` is not `destructive` in the registry: it removes the user's own unsent text, which the user asked for, and is never offered in `Mod+K`. PLAN-012 S5. | 2026-11-13 |
| D25 | **Save** never replaces another saved draft silently (§3.2). When the composer's team has a saved draft the composer didn't open (after a team change, or a hidden team's draft opened in the default team, E7), Save asks "Replace the ENG draft?" (**Replace**, **Cancel**); Replace moves this content into the team's draft and discards the one the composer opened; Cancel and `Esc` return to the composer. Coordinator decision in the PLAN-012 S5 review; before it, Save overwrote the other draft. | 2026-11-13 |
| D26 | Toasts never appear for the first time over a modal (design-system §5.1, the overlay manager), so with "Create more" on, "Created ENG-…" and a rejection's toast with **Restore in composer** show once the composer closes. E20's replace prompt applies when the composer is open again while that toast shows. Linear shows toasts over its composer; copying it was tried and left for a `packages/ui` change: Radix gives `Esc` only to the newest layer (a toast mounted over the composer would take the `Esc` meant for a picker or the composer), the modal's focus trap keeps `F8` and `Tab` from reaching the toast's action (mouse only, which a keyboard-first product can't accept), and the modal hides the rest of the page from assistive technology. Needs an overlay-manager change (route `Esc` to the top overlay, let the toast region escape the focus trap and `aria-hidden`), checked in a browser. | 2026-11-13 |
| D27 | At most 50 composer drafts per user, like comment drafts: saving a 51st deletes the oldest composer draft (by `updatedAt`, then id), on the server and in the optimistic update. Drafts of the other kind never count (§4.3). Coordinator decision in the PLAN-012 S5 review. | 2026-11-13 |
| D28 | The command menu's property commands open real sub-pages for status, priority, assignee, estimate and labels, with the options of §3.5. The labels sub-page toggles one label per pick (each pick is one `issue.update`, the page closes), because a command-menu page takes one choice; the anchored picker keeps §3.5's one update on close. **Set due date…** closes the menu and opens the due-date picker anchored to the issue (the page's pill, else the focused row), because a calendar and a typed date don't fit a list page. PLAN-012 S6. | 2026-11-16 |
| D29 | An archived issue can be deleted from its page by key (`Mod+Backspace`), menu or command, as SPEC-015 §3.4 says its ⋯ menu offers **Copy ›**, **Restore** and **Delete**; a deleted issue offers **Restore** and the copy commands only. §3.8's "editing commands are unavailable" never covered Delete on an archived issue. PLAN-012 S6 review. | 2026-11-16 |
| D30 | The properties panel is a header drawer from 768 to 1279 px, not 1024 to 1279 px (§7.3, design-system §3 Breakpoints): the sidebar is a drawer below 1024 px, and 768 to 1023 px has no separate layout, so the panel follows the same rule down to the single column. Below 768 px the panel is not a drawer: it sits in the text column under the title as a wrapping row of editable pills, and an open drawer is dropped when the window narrows to that width. Found in PLAN-012 S7a; the coordinator's call in its review. | 2026-11-16 |
| D31 | Issue page details settled in PLAN-012 S4b. (1) **Activity:** history entries and comment threads interleave oldest first by `createdAt` (a history entry before a comment at the same instant, then by id); the newest 30 show under "Show N earlier" (D18). A history item is an `article` labelled "<actor>, <time ago>" (§7.4); an entry with no actor (`system`) is labelled "Surface". Lines are SPEC-011 §4.4's `activityLines`, used unchanged; its provisional lines (title, priority, labels, estimate, due date, description) are still to be confirmed by the user, and a change there needs no change here. (2) **Description conflict:** only the stale-base refusal (`CONFLICT` with SPEC-011's stale-description message) shows the banner "Someone changed this description since you opened it." with **Copy my text** and **Discard and reload**; every other refusal (deleted, too long, offline) is a toast and keeps the text. While the banner shows, nothing more is saved. A description is saved as typed: blank paragraphs are not normalised to an empty document. **Never on a predicted version:** while another change to the description is unconfirmed in this tab's queue (an earlier visit's save, a save from before a reload, or the issue's create), the page keeps what is typed and sends nothing; once it is confirmed or refused, saves continue from the server's version when its text is the one the page built on; with nothing typed since, the page shows the server's text (E5); otherwise the banner shows (the earlier save was refused, or someone saved after it), with the refusal's own message when it was refused for another reason (too long, the issue deleted). What is typed is kept after the page closes: it is sent once the earlier change is confirmed, or after the save in flight. **Text held only in memory:** text that waits like this (typed after a save still in flight, or while an earlier change is unconfirmed, for example offline) is in no queue until it is sent, only in the tab's memory: a reload or a closed tab loses it. The page also saves when the tab is hidden or closed, but one save is in flight at a time and nothing runs after the tab is gone, so text typed after an in-flight save is lost then; if that in-flight save is refused after the page closed, the refusal is reported in the next session as any other. **Nothing is dropped silently after the page closes:** when the text can't be sent there is a toast naming the issue. If the earlier change turns out overwritten: "Someone changed the ENG-42 description, so your latest changes weren't saved. Open ENG-42 and add them again." If it was refused for another reason, or a save sent after the page closed is refused or conflicts while later text waits behind it: "Your latest changes to the ENG-42 description weren't saved. Open ENG-42 and add them again." The refused save's own message is the shell's toast. **One saver per issue:** opening the issue again while its text is still being saved takes that save back: the editor shows the text it holds and the same save continues, so two never race. **The store goes away** (the session changes, or another tab takes this tab's queue over) with a save unanswered or text unsent: the save is abandoned, nothing more is sent, and a toast says "Surface stopped saving the ENG-42 description, so your latest changes may not be saved. Reload the page and check ENG-42." (once; also when the user types into a page left open). A failed resync is not this: it retries, and the queue keeps the save. (3) **Server-backed view:** it reads again when the window regains focus (`issue.get` and the content), as well as when the issue comes back into the replica; while the server is asked again the last answer stays shown. When the activity can't be read online: "Couldn't load the activity. Try again in a moment." (4) **After a delete or restore from this page:** the page shows the issue as Deleted at once while its delete is unconfirmed (from its last row, or over an archived issue's earlier answer) and asks `issue.get` only after the server confirms the change, because an earlier answer could predate it. | 2026-11-16 |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| SPEC-005 | §5 Shortcut engine | Add: bindings have `whileTyping` (default: `Mod` chords fire while typing, plain keys don't); text-editing chords (`Mod+Backspace`, `Mod+Delete`, `Mod+Z`, `Mod+Shift+Z`, `Mod+A/C/X/V`, `Mod+arrows`) must set `whileTyping: false`, checked when the registry loads. Add a literal `Ctrl` modifier next to `Mod`, and an optional `platform` on a binding (§4.2). Dated "Changed (SPEC-012)". | No |
| SPEC-005 | E3 | Add (dated): digits, every chord with `Alt`, and chords with `Shift` and a non-letter match on `event.code`; everything else, including `Mod+,` and `Mod+.`, keeps matching on `event.key`; `event.key` matches are tried before `event.code` matches. Plain symbols (`#`, `?`, `[`) match on `event.key`. The existing AZERTY test for `Mod+,` stays. | No |
| SPEC-005 | §3 routes | `/team/:key/issues`, `/my-issues`, `/my-issues/created` and `/drafts` are live (no longer reserved). The issue page's `/issue/:identifier/:slug?` is SPEC-011's row, and the archive routes (`/team/:key/archive`, `/team/:key/archive/recently-deleted`) are SPEC-015's. | No |
| SPEC-005 | §7 Sidebar | Team items **Issues** and **Archive**; workspace items **My issues** and **Drafts**; no workspace-level deleted-issues item. | No |
| SPEC-005 | §4 | Commands get `ui.available(target, store)` for context-dependent availability (shared with SPEC-015; SPEC-003 change below). | No |
| SPEC-005 | §4 | Add a third command kind, **property commands**: defined in the web app next to a picker, each dispatches one operation with a partial input and a picker sub-page, with the operation's permission pre-check and `appliesTo` by target kind (§3.8). | No |
| SPEC-003 | §3.1 `ui` entry | Add the optional `available(target, store)` predicate. | No |
| SPEC-003 | §3.1 (operation domains) | Add the `draft` domain with `draft.save` and `draft.discard` (§4.3). domain-model §7 lists the same ops. | No |
| domain-model.md | entities | Add `Draft` (§4.3): owner `userId`, `kind`, `teamId` or `issueId`, `data`, `updatedAt`; unique per user and team (composer) and per user and issue (comment). | No |
| sync-protocol.md / permissions.md | sync groups, leak checklist | `Draft` rows sync only in `user:<id>`. Leak checklist: another user's drafts never reach a replica. | No |
| sync-protocol.md | §10, §11 | The `Draft` model joins the sync property suite (concurrent saves and discards converge); it changes the `schemaHash` (a new eager model), so connected clients re-bootstrap once. No protocol version bump. | No |
| glossary.md | terms | Add **Draft** (synced, per user). Add **Recently deleted** for deleted issues (SPEC-015). | No |
| shortcuts.md | §1 rule 2 | Add: "except bindings marked `whileTyping: false`, which never fire while typing". Add the literal `Ctrl` modifier and platform-limited bindings. | No |
| shortcuts.md | §2 | Add the scopes `issue-page`, `comment`, `settings-row` (§3.6) and the new order. No `trash` or `archive` scope. | No |
| shortcuts.md | §3 (all keys) | Rebuild to Linear's panel as in §3.6 of this spec: new or changed keys are `G` `D`, `G` `X`, `Ctrl+Shift+1…9` (was `Alt+1…9`), `Shift+E`, `Shift+R`, `Mod+Shift+D`, `Mod+Shift+,` (URL), `Mod+Shift+.` (branch), `Mod+Shift+'`, `Mod+Alt+C`, `#`, `Mod+Z` (last delete), `Alt+T`, `Ctrl+M`, `Ctrl+Shift+I`, `Ctrl+L`, `Mod+/`. `G` `M` (My issues) and the `list`-scope `T` (collapse or expand the focused group) move M2 → M1; `G` `T` (triage) stays reserved for M4. `O` is dropped from "Open the focused issue". The reserved keys of §3.6 are marked reserved. `Mod+Backspace`: add "not while typing". `Mod+Enter` row moves to the `issue-page` scope. | No |
| shortcuts.md | §3.7 | `Mod+U` underline is kept (SPEC-013 adds the mark). Editor keys follow §3.6. `Mod+Shift+7/8/9` are matched on `event.code`. | No |
| command-menu.md | §3.1 Ranking | Destructive commands never rank first for a keyword-only match. | No |
| command-menu.md | §3.3 Contexts | Add the "one archived or deleted issue" context of §3.8 and the commands "Go to archived issues in {team}" and "Go to recently deleted issues in {team}" (SPEC-015 §7). | No |
| design-system.md | §4 principle 5 and Destructive actions | Issue delete no longer runs at once with an Undo toast: it opens a confirm dialog (§3.11), as Linear does, and only the last issue delete can be undone, with `Mod+Z`, until M2. Settings deletes also confirm (SPEC-010). Removing an attachment keeps the Undo toast and no dialog (SPEC-014 §3.5, D8). | No |
| design-system.md | §5.1 Toast | Replace "Actions are reachable with `Mod+Z` for undo" with "Actions are reachable with `F8`; `Mod+Z` is the app's undo (M2)". | No |
| design-system.md | §5.3 GroupHeader | "collapse (`T` on hover)" → "collapse (`T` when focused or hovered; click)". Date column of IssueRow: created date. | No |
| PRD | FR-ISS-08 | Copy ID, URL, title, title as link, issue as Markdown (no "ID + title"). | No |
| PRD | FR-ISS-11 | "Local unsaved draft" → drafts saved on the server and synced to all devices, with a Drafts page. | No |
| PRD | FR-NAV-01 | Replace the workspace-level deleted-issues item with team **Archive** (with Recently deleted) and **Drafts**. | No |
| PRD | FR-NAV-10 | Note: Assigned and Created ship in M1 (D5). | No |
| SPEC-002 | §3 (flows: add "sign-out"), §5.1 (storage), Decisions | Explicit sign-out deletes the replica database `surface-<workspaceId>-<userId>`, its mutation queue included, after a warning when changes are unsent; a session expiry keeps it (Q3, §3.12). Dated "Changed (SPEC-012)". | No |
| SPEC-005 | §7 (avatar menu) | Log out deletes the local replica and warns about unsent changes (§3.12). | No |
