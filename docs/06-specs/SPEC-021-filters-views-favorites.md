# SPEC-021: Filters, custom views and favorites

Status: **Draft** · Milestone: **M2** · Date: 2026-11-25
Implements: FR-VIEW-01 (default team views All issues, Active, Backlog), FR-VIEW-08 (filters on every issue property), FR-VIEW-09 (filters in the URL), FR-VIEW-10 (custom issue views: workspace or team scope, an owner, editable by anyone with access), FR-VIEW-11 (personal display overrides versus "Set as default for everyone"), FR-NAV-08 (favorites), FR-NAV-01 (the sidebar's Views and Favorites entries, and the team's Views item) · NFR-01, NFR-04, NFR-14, NFR-19
Depends on: SPEC-020 (view state, the list and board, moves), SPEC-012 (the team list, routes, focus model, pickers), SPEC-011 (partial issue loading §5.7, `issue.list` filters), SPEC-003 (filter semantics §7.4, `ViewRef`), SPEC-005 (shell, sidebar, command menu, shortcut engine), SPEC-010 (statuses, labels, label groups)
Related: SPEC-022 (selection, bulk edit, undo, context menu, peek) · SPEC-023 (global search over views, My issues tabs, the `/new?…` create URL, the default home view) · [ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md) · [permissions §2–§5](../03-domain/permissions.md)

---

## 1. Problem & goal

M1 shows every live issue of a team in one list. People need to narrow it: "my bugs", "what's in review", "everything urgent across teams". This spec adds Linear's **filters** (`F`), the team's three **default views** (All issues, Active, Backlog), **filters in the URL** so a filtered list can be shared, **custom views** that save filters and display options under a name for the workspace, a team or oneself, and **favorites** that pin issues and views to the sidebar. It also decides who sees what: a user's display changes are personal until they press **Set as default**, and a view of a private team never reaches, or names anything of, that team to non-members.

Surface's client doesn't hold every issue (ADR-0020). This spec decides how a view that spans teams the client doesn't hold gets its issues (§5.4).

## 2. Scope

**In scope**

- The team **Issues** page with the tabs **All issues**, **Active** and **Backlog** (FR-VIEW-01), the team's saved views as further tabs (D6), their routes and `G` `E` / `G` `A` / `G` `B`.
- The **filter bar**: the filter menu (`F`), filter chips with operators, quick filters by typing a value, "no value" filters, relative dates, clearing (FR-VIEW-08). Filter chips are the client side of the existing Filter tree (domain-model §5, SPEC-003 §7.4), evaluated by `filterIssues` (`packages/domain/src/issue-filter.ts`).
- **Filters in the URL** (FR-VIEW-09).
- **Custom issue views** (FR-VIEW-10): the `CustomView` model and the `view.*` operations; create (`Alt+V`, New view, Duplicate), edit, delete, copy URL, owner; the view page; the Views pages (workspace and team).
- **Display defaults** (FR-VIEW-11): personal overrides (`ViewPreference`), "Set as default" for built-in team views (`ViewDefault`) and custom views, "Reset to default".
- **Favorites** (FR-NAV-08): the `Favorite` model and operations, the sidebar section, `Alt+F`, `O` `F`, reordering by drag.
- The **sidebar** entries Views (workspace), Favorites, and the team item Views (FR-NAV-01).
- **Reordering teams in the sidebar** by drag (SPEC-005 §7, D2). *Still to be specified.*
- **Where a view's issues come from** under partial issue loading (§5.4).
- The leak tests these models need (permissions.md §5).

**Out of scope**

- Display options themselves, the board, ordering, moves: **SPEC-020**.
- Multi-select and bulk edit of a view's issues, undo, the right-click menu, peek: **SPEC-022**.
- Global search (`/`) and finding views by name there; My issues tabs and whether they take filters; the create URL `/new?…`; the members directory; the default home view preference: **SPEC-023**. This spec's view targets include My issues so SPEC-023 can store display preferences for its tabs (§4.3).
- **Project views** and initiative views (FR-VIEW-10's "project views"): M3+, with projects. The `CustomView` model reserves `model: 'issue' | 'project'`; M2 accepts only `issue`.
- Filters on M3+ fields: project, cycle, milestone, parent and sub-issues, relations ("has blockers"), and on M4's subscribers (§3.2 table, last rows).
- View subscriptions (FR-VIEW-12, v2), favorites folders (FR-NAV-09, v2), Linear's label views, user profile views, view sidebars, dashboards and insights, "Filter with AI" (built-in AI is out of scope, CLAUDE.md).
- Sidebar items for features that don't exist yet (Inbox M4, Projects M3, Initiatives M5): not shown.

## 3. User flows

Linear's behaviour is copied and cited as [Linear: Filters](https://linear.app/docs/filters), [Linear: Custom views](https://linear.app/docs/custom-views), [Linear: Favorites](https://linear.app/docs/favorites), [Linear: Team pages](https://linear.app/docs/default-team-pages) and [Linear: Display options](https://linear.app/docs/display-options).

### 3.1 The team Issues page and its default views (FR-VIEW-01)

1. The team's **Issues** page has three tabs in its header (design-system §3, "view tabs"): **All issues**, **Active**, **Backlog**. Routes: `/team/:key/all` (All issues, Linear's route; M1's `/team/:key/issues` redirects to it, D3), `/team/:key/active`, `/team/:key/backlog` (reserved by SPEC-005 §3 for M2). The team's saved views follow as more tabs (item 6).
2. What each holds ([Linear: Team pages](https://linear.app/docs/default-team-pages), "Issues", "Active", "Backlog"):

   | Tab | Issues | Built-in filter (not shown as a chip) |
   |---|---|---|
   | All issues | every live issue of the team, completed and canceled included | none |
   | Active | issues in the Unstarted or Started categories | `status.category in [unstarted, started]` |
   | Backlog | issues in the Backlog category | `status.category eq backlog` |

   Archived and deleted issues are never in them (SPEC-015; the team archive is `G` `X`).
3. **Keys:** `G` `E` opens All issues (SPEC-012), `G` `A` Active, `G` `B` Backlog, each for the current team by SPEC-012's team rule (route team, else home team, else first member team; else the hint "Join a team to see its issues"). Linear uses the same keys ("Navigate to your team's active issues by hitting G then A"). The tabs are also reachable with the sidebar's team **Issues** item (All issues), and "Go to ENG active issues" / "Go to ENG backlog" in `Mod+K`.
4. Each tab has its own display state (SPEC-020 §4.1) and default (§3.6); a filter applied on one tab doesn't carry to another (filters live in the URL, §3.3).
5. The header shows the count of issues the tab holds after filters ("42 issues"), from the rows the view holds (§5.4).
6. **Team views as tabs** (D6): every saved view of team scope for this team appears as a tab after Backlog, sorted by name, with the view's icon and name, as in Linear's web app. Choosing one opens the view's page (§3.4 item 3), whose header keeps the same tab strip with that tab current. Workspace and personal views are not tabs; they are on the Views pages. Tabs that don't fit collapse into a ⋯ menu at the end of the strip. A view deleted, or moved to another scope or team, leaves the strip (E23).

### 3.2 Filters (FR-VIEW-08)

1. **Open the filter menu:** `F` (list scope), the **Filter** button in the view header, or "Filter…" in `Mod+K` ([Linear: Filters](https://linear.app/docs/filters), "type F shortcut"). It opens a popover with the command menu's look: a search field and the filterable properties.
2. **Pick a property, then values.** Choosing a property opens its value list (the SPEC-012 §3.5 PropertyPicker, multi-select: `Space` toggles, `Enter` applies). Applying adds a **filter chip** to the filter bar under the header, and the list updates at once.
3. **Quick filters:** typing in the property list also searches values, so "high" offers "Priority is High", "ada" offers "Assignee is Ada" and "Created by Ada", "bug" offers "Labels include Bug", "in review" offers "Status is In Review", "des" offers "Team is DES" ([Linear: Filters](https://linear.app/docs/filters), "Quick search filters").
4. **Filterable properties in M2** (each maps to an existing field of `ISSUE_FILTER_FIELDS`, so the client and the server read the same filter; SPEC-011 AC-11's conformance test covers each):

   | Property (Linear's name) | Field | Values | Operators shown (Linear's words) → Filter |
   |---|---|---|---|
   | Status | `status` | the view's teams' statuses; in a multi-team view by name (§3.2 item 7) | is / is not (one value); is either of / is not (several) → `in` / `nin` |
   | Priority | `priority` | No priority, Urgent, High, Medium, Low | as Status (No priority is the value 0) |
   | Assignee | `assignee` | **No assignee**, Me, users | as Status. "Me" is stored as `me`. No assignee is `exists: false`; with other values it becomes an `or` of both |
   | Created by | `creator` | Me, users (deactivated ones included) | as Status |
   | Labels | `labels` | **No labels**, labels by group, and each label group as a whole (§3.2 item 7) | includes any of → `in` · includes all of → `and` of `eq` · includes neither of → `nin`; No labels → `exists: false` ("includes any, all, neither, either, or none for labels") |
   | Estimate | `estimate` | **No estimate**, the view's scale values | as Status |
   | Due date | `dueDate` | **No due date**, Overdue (before today), Today, Tomorrow, In 1 week, 1 week ago, Custom date… | before / after → `lt` / `gt` (durations from today, SPEC-003 §7.4); No due date → `exists: false` |
   | Created date, Updated date, Started date, Completed date, Canceled date | `createdAt`, `updatedAt`, `startedAt`, `completedAt`, `canceledAt` | 1 day ago, 3 days ago, 1 week ago, 2 weeks ago, 1 month ago (30 days), 3 months ago (90 days), 6 months ago (182 days), 1 year ago (365 days), Custom date… | before / after → `lt` / `gte` (durations from now; months and years are rejected by SPEC-003 §7.4, so they are fixed day counts) |
   | Team | `team` | the teams the user can see | as Status. Only in views that can hold several teams |
   | Title | `title` | typed text | contains → `contains` |
   | *Project, Cycle, Milestone, Parent, Sub-issues, Relations ("has blockers")* | — | — | **M3**, when the fields exist. Not shown in M2. |
   | *Subscriber* | — | — | **M4**. Not shown. |

5. **Chips** read "Assignee · is · Ada ×". Clicking the property does nothing; clicking the operator toggles it (is ↔ is not; with several values, is either of ↔ is not); clicking the values reopens the picker; × removes the chip ([Linear: Filters](https://linear.app/docs/filters), "Build with operators"). Adding a second value turns "is" into "is either of". **Clear** at the end of the bar removes every chip. By keyboard: `F` adds; `Tab` moves into the bar; `←`/`→` move between chip parts; `Enter` opens one; `Backspace` on a focused chip removes it.
6. **Several chips combine with AND.** The saved form is `{and: [chip, chip, …]}`. A filter the bar can't show as chips (an `or` across properties, or deeper nesting, from the API or a hand-edited URL) shows as a single **Advanced filter** chip that can be removed but not edited (Q5).
7. **Multi-team views** (workspace and personal views, §3.4): values are offered **by name**, as Linear does ("As long as labels in different teams share the same name, filtered results will show all issues across all teams that match the label"). Choosing "In Review" or the label "Bug" stores the ids of every status or label of that name among the teams the view may name (§4.4), and the chip shows the name once. **Label groups:** choosing a label group stores the ids of its labels. In both cases the ids are fixed when the chip is built: a team or label added later isn't included until the chip is edited again (Q6).
8. **Filters change only what shows.** They never change an issue. The view's built-in filter (Active, Backlog), the view's saved filter (custom views) and the bar's chips combine with AND, and the completed-issues window (SPEC-020 §3.9) applies after.
9. **Evaluation** runs on the client with `filterIssues` over the rows the view holds, with `me` = the viewer, `now` = the device clock, and the viewer's time zone for day durations (SPEC-003 §7.4), re-evaluated every minute so relative dates move. A filter that `resolveFilter` refuses (FilterError) is never evaluated: the bar shows the chip with an error state ("This filter can't be read. Remove it.").

### 3.3 Filters in the URL (FR-VIEW-09)

1. The bar's chips are written to the address as `?filter=<value>`, replacing the history entry (`history.replaceState`), so copying the address shares the filtered list. Opening such a link applies the same filters ([Linear: Filters](https://linear.app/docs/filters): "The applied filters are also reflected in the browser URL … opening the link applies the same filters"). Display options are **not** in the URL ("Only the main filters are included in the URL. View options … aren't included").
2. **Encoding** (Q4; the parameter's name `filter` matches Linear's web app, whose value encoding couldn't be read): the filter JSON (the Filter tree with ids and relative values as written), UTF-8, then base64url without padding. Ids, not names, so a link never spells out a team's or label's name. At most 4,000 characters: beyond that the address isn't updated and the bar shows "This filter is too long to share as a link. Save it as a view instead."
3. **Reading a link:** the value is decoded and checked with `FilterSchema`. An invalid value is ignored, and a toast says "This link's filters couldn't be read, so they were left out." Ids the viewer can't resolve (a private team's label, a deleted status) stay in the filter, so they match nothing, and their chips read "Unknown label" or "Unknown status", never a name. The link never reveals more than its ids.
4. **On a custom view**, `?filter` holds the view's filter **as changed by this user**, replacing the saved one while present. The bar then shows **Clear** and **Save ▾** (§3.4 item 6). Without `?filter` the view shows its saved filter. Reloading the page keeps the temporary filter, because it is in the address.
5. **Temporary:** URL filters are never stored on the server. Leaving the page and coming back through the sidebar drops them (the sidebar links have no query).

### 3.4 Custom views (FR-VIEW-10)

A custom view is a named, saved filter with display options. Linear: "Create durable filtered views of issues … that you can save and share with others in your workspace" ([Linear: Custom views](https://linear.app/docs/custom-views)).

1. **Scope** decides who sees it and where it is listed:

   | Scope | Who sees it | Its issues | Listed in |
   |---|---|---|---|
   | **Workspace** | every active user | issues of every team the viewer can see | Views page → Workspace views |
   | **Team** (one team) | everyone who can see the team (a private team: its members only) | that team's issues | Views page → Team views; the team's Views page |
   | **Personal** (Q2) | its owner only | issues of every team the owner can see | Views page → Your views |

   "To share a view across multiple teams but limit it to … issues within a specific team or teams, create an All teams view and use filters to refine the list" ([Linear: Custom views](https://linear.app/docs/custom-views), "Share views"): a workspace view with a Team filter.
2. **Create:**
   - **Save as view** (`Alt+V`, the **Save view** button next to Display options, or "Save as view…" in `Mod+K`), on any list or board **with at least one filter chip**, as in Linear ("The icon appears … after you've added at least one filter"). It opens the **Create view** dialog (Dialog `md`): Name (required), Description (optional), Icon and colour (D5), and Scope (Workspace, each team the user can see, Personal), prefilled with the page's team, else Workspace. **Create view** (`Mod+Enter`) dispatches `view.create` with the chips' filter (and the page's built-in filter, so saving from Active keeps "Active") and the page's current display state, then opens the new view.
   - **New view** on a Views page (`/views` or `/team/:key/views`) opens `/views/new` (with `?team=ENG` from a team's page): an empty view of that scope with the filter menu open and the title "New view". **Save view** opens the same dialog. Leaving with filters but unsaved asks "Discard this view?" (**Discard**, **Keep editing**).
   - **Duplicate view…** (the view's menu) opens the dialog prefilled with "<name> copy", the same scope, filters and display ([Linear: Custom views](https://linear.app/docs/custom-views), "Duplicate view…").
3. **The view page** `/view/:id/:slug?` (the slug from the name, cosmetic and replaced like an issue's, SPEC-011 §4.1). Header: breadcrumb ("Views › Bugs this week", or "ENG › Views › Bugs this week"), the view's icon and name (a click opens its menu), a star (favorite, §3.7), then the filter, layout and Display buttons (SPEC-020 §7.1). The list or board follows the view's filters and display state.
4. **The view's menu** (click on its name, ⋯, or right-click its row on a Views page): **Edit view…**, **Duplicate view…**, **Copy view URL**, **Add to favorites** / **Remove from favorites**, **Delete view…**. **Edit view…** opens the dialog with Name, Description, Icon, Scope and **Owner** (a user picker). Save dispatches `view.update`.
5. **Owner:** every view has one, by default its creator. Anyone who can edit the view can change it ([Linear: Custom views](https://linear.app/docs/custom-views), "View owners": "This field defaults to the creator of the view but can be changed to other users"). The owner shows in the Edit dialog and on the Views page.
6. **Changing a view's filters:** any change in the bar makes the filter temporary (in the URL, §3.3 item 4, so a reload keeps it) and shows **Clear** and **Save ▾** at the end of the bar, as in Linear's web app (D4). **Save ▾** is a split button: its main action dispatches `view.update {filters}`, and its menu offers **Save as new view…**, which opens the Create view dialog (§3.4 item 2). **Clear** (not "Reset") drops `?filter`, so the view shows its saved filter again. Changing display options follows §3.6 (personal until Set as default).
7. **Who may edit:** anyone who can see a shared view (FR-VIEW-10, "editable by anyone with access"; permissions §3.4). A personal view: its owner only. **Delete:** a shared view by its owner or an Admin (permissions §3.4); a personal view by its owner. Delete opens a confirm dialog, `Delete view "Bugs this week"?` (**Cancel**, **Delete**), and the view is removed for everyone, with every user's favorites and display preferences of it (Q15). Others who have it open see "This view was deleted." with **Go to views**.
8. **Copy view URL** copies the absolute `/view/:id/<slug>` URL. A link to a view the recipient can't see shows "This view doesn't exist, or you don't have access to it." with **Go to views**, worded the same for both (no leak). "Sharing a link does not automatically give anyone access to a view" ([Linear: Custom views](https://linear.app/docs/custom-views)).

### 3.5 Views pages

- **`/views`** (sidebar **Views**, `G` `U`, `Mod+K` "Go to views"): sections **Workspace views**, **Team views** (grouped by team, the user's teams first) and **Your views** (personal). Each row: icon, name, scope, owner avatar, star. Sorted by name. **New view** in the header. Empty: "No views yet. Create one to save a filtered list." with **New view**.
- **`/team/:key/views`** (the team's sidebar **Views** item; "Go to ENG views"): that team's views, with **New view**.
- Rows follow the list keys (`J`/`K`, `Enter` opens). The view menu is on each row (⋯ and right-click).
- **`O` `V`** opens "Open view…" in `Mod+K`: every view the user can see, searchable by name ([Linear: Custom views](https://linear.app/docs/custom-views), "search for views to open with O then V").

### 3.6 Personal display versus "Set as default" (FR-VIEW-11)

Copied from [Linear: Display options](https://linear.app/docs/display-options), "Saving display options":

1. **Changing display options changes only your view.** The change is saved at once as your **personal display** for that view (`viewPreference.set`), synced to your devices (Q9), and kept when you leave and come back ("Your selections will persist even if you navigate away from the current view").
2. **Set as default** (Display options footer, "Set display as default for everyone" in `Mod+K`) makes the current display state the view's default for everyone: "It will be the view they see when they first open it, but they can always apply their own preferences on top of it". For a built-in team view (All issues, Active, Backlog) it writes that tab's `ViewDefault`; for a custom view, the view's own `display`. Your personal display is then cleared, so you follow the default.
3. **Reset to default** (shown when your personal display differs from the view's default, SPEC-020 §3.1) clears your personal display (`viewPreference.reset`).
4. **Which display state a user sees:** their personal display for the view, else the view's default (the custom view's `display`, or the tab's `ViewDefault`), else `DEFAULT_VIEW_STATE` (SPEC-020 §4.1.1). Each is read with `readViewState`, so a broken value degrades field by field.
5. **A personal display is a full copy:** the first change copies the current state and changes it. A later "Set as default" by someone else doesn't change it; Reset does.
6. **Who may set a default:** anyone who can see the built-in view's team, and anyone who can edit the custom view (permissions §3.4: "Set display as default for everyone" ✅ Member; Q8).
7. **Filters are not display.** Set as default never saves filters; on a built-in view filters are always temporary, and on a custom view they are saved with Save (§3.4 item 6).

### 3.7 Favorites (FR-NAV-08)

1. **What can be a favorite in M2:** issues, custom views, and a team's built-in views (All issues, Active, Backlog). Linear's list also has projects, cycles, documents, initiatives, labels, teams and users ([Linear: Favorites](https://linear.app/docs/favorites)); projects and cycles join in M3, documents in M4, initiatives in M5 (Q10).
2. **Add or remove:** the star in the page header (an issue page, a view page, a team tab), **Add to favorites** / **Remove from favorites** in a view's or issue's menu, "Favorite" / "Unfavorite" in `Mod+K`, and `Alt+F` on the focused or open issue (issue scope; Linear: "Alt + F to toggle favorite on the focused item"; checked in Linear's web app on 2026-11-25). A toast confirms: "Added ENG-42 to favorites."
3. **The sidebar's Favorites section** appears above **Your teams** once the user has a favorite, and is hidden while they have none ([Linear: Favorites](https://linear.app/docs/favorites), "Access favorites"; the same in Linear's web app on 2026-11-25). Each item: an issue shows its StatusIcon, identifier and title; a view its icon and name; a team view the team's icon and "ENG Active". A click opens it. On hover an × removes it. The section collapses like a team section (state per device, SPEC-005 §6).
4. **Order:** new favorites go to the end. Drag an item to reorder (design-system §5.3, SidebarNavItem "drag to reorder (favorites)"). There is no menu or keyboard way to reorder, as in Linear (D9). An item's menu (right-click, or the context-menu key on the focused item) has only **Copy URL** and **Remove favorite**; so a keyboard-only user can't reorder favorites, exactly as in Linear.
5. **`O` `F`** opens "Open favorite…" in `Mod+K`: the favorites, searchable ([Linear: Favorites](https://linear.app/docs/favorites): "O then F to open favorites").
6. **A favorite the replica can't render:** an issue not held (another team's, SPEC-011 §5.7) is asked for once with `issue.get` while online and shown with its identifier and title; offline it shows "Issue not loaded". A favorite whose issue or view is `NOT_FOUND`, archived or deleted is hidden (and asked about again on focus, so a restored issue comes back), as SPEC-012 E18 does for drafts. A team view of a team the user can no longer see is hidden.
7. **At most 100 favorites per user** (Q10): adding a 101st is refused with "You have 100 favorites. Remove one to add another."

### 3.8 Sidebar (FR-NAV-01 in M2)

```
[Logo] Workspace name                         [avatar ▾]
[ Search ⌘K ]                                 [ ✎ New ]
  My issues
  Drafts
  Views
  ─────────
  Favorites                       (only with at least one)
   ★ ENG-42 Fix login
   ★ Bugs this week
  ─────────
  Your teams                                     [+]
   ▾ ENG  Engineering
       Issues
       Views
       Home
       Archive
  ─────────
  Settings
```

- **Views** (workspace) follows **Drafts** and opens `/views`. Inbox (M4), Projects (M3) and Initiatives (M5) take their places in PRD order when they arrive.
- Each expanded team lists **Issues** (All issues, §3.1), **Views** (`/team/:key/views`), then M1's **Home** and **Archive**.
- The team's **Issues** item shows as current on every tab.

### 3.9 Shortcut map (M2 keys of this spec)

All are Linear's keys, reserved in shortcuts §3.9, with a command, shown in `?`, and checked by the conflict test.

| Keys | Scope | Action | Typing |
|---|---|---|---|
| `G` `A` | global | Active issues of the current team | no |
| `G` `B` | global | Backlog of the current team | no |
| `G` `U` | global | Views (the workspace Views page, `/views`) | no |
| `F` | list | Open the filter menu | no |
| `Alt+V` | list | Save as view (available with at least one filter chip) | no |
| `Alt+F` | issue | Add or remove the focused or open issue as a favorite | no |
| `O` `V` | global | Open view… | no |
| `O` `F` | global | Open favorite… | no |

- Views is `G` `U`, as in Linear (D7). `G` `V` is **not** bound to Views: shortcuts §3.2 lists it, but §3.9 reserves it for Linear's "current cycle" (M3). Views are also reached from the sidebar, `O` `V` and `Mod+K`.
- `O` `V` and `O` `F` share the `O` prefix with `O` `T` (open team, M0); no binding is `O` alone.

### 3.10 Command menu

| Command | Context | Effect |
|---|---|---|
| Filter… | list | §3.2 item 1 |
| Clear filters | list, with chips | removes every chip |
| Save as view… | list, with chips | §3.4 item 2 |
| Create view… | any | opens `/views/new` (the current team when there is one) |
| Go to views / Go to ENG views | any | §3.5 |
| Open view… | any (`O` `V`) | a sub-page of views |
| Go to ENG active issues / Go to ENG backlog | any | §3.1 |
| Edit view… / Duplicate view… / Copy view URL / Delete view… | a view page | §3.4 |
| Add to favorites / Remove from favorites | an issue (focused, open), a view page, a team tab | §3.7 |
| Open favorite… | any (`O` `F`) | §3.7 item 5 |
| Set display as default for everyone / Reset display to default | a view page or team tab | §3.6 |

Views also appear in `Mod+K`'s local search results (command-menu §2 "Local search … views"); SPEC-023 owns search ranking.

## 4. Domain changes

Four synced models (§4.1–§4.3, §4.5), ten operations (§6), pure filter and URL functions (§4.6). No change to the Filter tree, its fields or its SQL compiler.

### 4.1 `CustomView`

| Field | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | client-generated |
| `model` | `issue` \| `project` | `issue` only in M2 (project views: M3+) |
| `name` | string | 1–80 characters after trimming |
| `description` | string | 0–255 characters |
| `icon` | string? | a Lucide icon name from a fixed list, or a single emoji, or null (design-system §2.7; D5) |
| `color` | ViewColor? | one of the nine preset swatches (a subset of the design-system §2.2 hues, chosen in the UI slice), or a custom colour as `#rrggbb` (D5) |
| `scope` | `workspace` \| `team` \| `personal` | |
| `teamId` | Team? | set exactly when `scope = team` |
| `ownerId` | User | the creator by default; any active user |
| `creatorId` | User | server-set |
| `filters` | Filter (json) | `FilterSchema`, `resolveFilter` against `ISSUE_FILTER_FIELDS`, and the scope check of §4.4. Relative values are stored as written (`me`, `-P7D`) |
| `display` | ViewState (json) | `ViewStateSchema` (SPEC-020 §4.1) and the scope check |
| `createdAt`, `updatedAt` | timestamp | server-set |

- Unique: nothing (two views may share a name; `ViewRef` by name is then ambiguous, SPEC-003 §4).
- **Sync groups:** workspace scope → `workspace`; team scope → the team's groups (a public team: `workspace`; a private team: `team:<id>`); personal → `user:<ownerId>`. A scope or owner change of a personal view changes the groups (`D` then `U`, sync-protocol §6).
- Eager (sync-protocol §2 already lists CustomView).
- Domain-model §4.15's `visibility` becomes `scope`, and its `sortOrder` is dropped: views are listed by name (§12).

### 4.2 `ViewDefault`

The shared default display of a team's built-in view ("Set as default" on All issues, Active, Backlog).

| Field | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | |
| `teamId` | Team | |
| `tab` | `all` \| `active` \| `backlog` | unique with `teamId` |
| `display` | ViewState (json) | `ViewStateSchema` and the scope check |
| `updatedById` | User | server-set |
| `createdAt`, `updatedAt` | timestamp | |

Sync groups: the team's groups (as a team-scoped view). Eager (sync-protocol §2 lists it).

### 4.3 `ViewPreference`

A user's personal display for one view (§3.6).

| Field | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | |
| `userId` | User | the owner, server-set from the actor |
| `target` | `team` \| `view` \| `myIssues` | |
| `teamId` | Team? | for `team` |
| `viewId` | CustomView? | for `view` |
| `tab` | string? | for `team`: `all` \| `active` \| `backlog`; for `myIssues`: SPEC-023's tab names |
| `display` | ViewState (json) | `ViewStateSchema` |
| `createdAt`, `updatedAt` | timestamp | |

- Unique per user and target (partial unique indexes per `target`, like `drafts`). At most **500 per user**: saving a 501st deletes the least recently updated (Q9).
- **Sync group:** `user:<userId>` only. `teamId` and `viewId` are resolved as `TeamRef` and `ViewRef` when written, so a user can only store a preference for something they see; nothing in the row is new to its owner.
- No foreign keys; a deleted view's preferences are deleted by `view.delete` through the repo (§4.5).

### 4.4 The scope check (filters and display of shared rows)

A shared view or default reaches every user of its scope, so nothing in its `filters` or `display` may name a row some of them can't see. Otherwise a private team's id, status or label would reach non-members (SPEC-002 Q6, permissions §5). The server checks every write of `CustomView.filters`, `CustomView.display`, `ViewDefault.display` and a scope change; the client checks the same with the same pure function (`viewScopeProblems`, `packages/domain`) before sending.

1. **Every id must resolve for the actor** (teams, statuses, labels and label groups, users; deactivated users allowed). An id the actor can't see, and an unknown id, give the same `NOT_FOUND`: "This view names a team, status, label or user that doesn't exist or that you can't see." with the path into the filter.
2. **Every team, status and label it names must be visible to the whole scope:**
   - workspace scope, and a public team's scope: public teams, their statuses and labels, workspace labels;
   - a private team T's scope: the above, plus T and its statuses and labels;
   - personal scope: anything the actor can see.
   Otherwise `INVALID_INPUT`: "A workspace view can't name DES, a private team. Make it a DES view or a personal view instead." (The actor is a member of DES, so the message tells them nothing new.)
3. Users can always be named (users are in `workspace`).
4. **Stale ids:** a label or status deleted after the view was saved stays in its filter and matches nothing. The client drops ids it can't resolve before it sends a change, with the note "Removed 1 filter value that no longer exists." so a later edit isn't refused by item 1.
5. The check runs on `view.create`, on `view.update` when it changes `filters`, `display` or the scope, and on `view.setDefaultDisplay`. `ViewPreference` and personal views skip item 2.

### 4.5 `Favorite`

| Field | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | |
| `userId` | User | server-set from the actor |
| `target` | `issue` \| `view` \| `teamView` | M3+ adds `project`, `cycle`, `document`, `initiative` |
| `issueId`, `viewId`, `teamId` | ids? | one set per `target` (`teamView`: `teamId` and `tab`) |
| `tab` | `all` \| `active` \| `backlog`? | for `teamView` |
| `sortOrder` | fractional key | the user's order |
| `createdAt` | timestamp | |

- Unique per user and target. **Sync group:** `user:<userId>` only. Target ids are resolved (`IssueRef`, `ViewRef`, `TeamRef`) when written, so only something the user can see can be favorited; no foreign keys.
- **Removed by the server** (repo, each `D` only in its owner's group): when an issue is purged (permissions §6's purge table gains favorites), and when a view is deleted. Not when a user leaves a private team: the client hides those favorites (§3.7 item 6; Q10).

### 4.6 Pure functions (`packages/domain`, unit and property tested)

- `chipsFromFilter(filter)` / `filterFromChips(chips)`: the chip model of §3.2 ↔ the Filter tree. Round trip: `chipsFromFilter(filterFromChips(c))` equals `c`; a tree that isn't a flat AND of chip-shaped nodes gives one `advanced` chip that keeps the tree unchanged.
- `builtInFilter(tab)`: the filters of §3.1's table.
- `viewFilter(builtIn, saved, urlChips)`: the AND of §3.2 item 8.
- `encodeFilterParam` / `decodeFilterParam` (§3.3): round trip for every valid filter; decoding never throws; decoding a value that fails `FilterSchema` gives "invalid".
- `viewScopeProblems(filters, display, scope, lookups)` (§4.4).
- `resolveDisplay(preference, viewDefault)` (§3.6 item 4).
- `teamsAViewCanMatch(view, lookups)` (§5.4).

## 5. Sync & permissions

### 5.1 Models and groups

| Model | Load | Groups |
|---|---|---|
| CustomView | eager | workspace scope → `workspace`; team scope → the team's (public: `workspace`, private: `team:<id>`); personal → `user:<ownerId>` |
| ViewDefault | eager | the team's groups |
| ViewPreference | eager | `user:<userId>` |
| Favorite | eager | `user:<userId>` |

All four are written only through the repo (rule 2), and each joins the `schemaHash` (a re-bootstrap on upgrade, no protocol version bump).

### 5.2 Permissions

| Operation | Rule |
|---|---|
| `view.create` | Workspace and personal scope: any active user. Team scope: anyone who can see the team (permissions §3.4: "Create a shared or personal custom view" ✅) |
| `view.update` | A shared view: anyone who can see it. A personal view: its owner |
| `view.delete` | A shared view: its owner or an Admin. A personal view: its owner. `destructive` |
| `view.setDefaultDisplay` | A built-in team view: anyone who can see the team. A custom view: as `view.update` |
| `viewPreference.*`, `favorite.*` | The user's own rows only |
| `view.get`, `view.list`, `favorite.list` | What the actor can see |
| API key `teamIds` | Team views and team defaults of other teams are `NOT_FOUND`. A narrowed key can read workspace views but can't create, update or delete them, or move a view to the workspace (`FORBIDDEN`), as for workspace labels (permissions §3.5) |

### 5.3 Leak checklist additions (permissions.md §5)

1. A private team's CustomView and ViewDefault rows never reach a non-member: bootstrap (full and partial), catch-up, live deltas. `view.get`, `view.list`, `ViewRef` and `view.setDefaultDisplay` answer them `NOT_FOUND`, identical to an unknown id.
2. Personal views, ViewPreference and Favorite rows reach only their owner.
3. A workspace or public-team view (or default) can never store an id of a private team or of its statuses or labels (§4.4): refused, whatever the actor's membership; an invisible id is refused like an unknown one.
4. `favorite.add`, `favorite.remove` and `viewPreference.set` naming an invisible issue, view or team are `NOT_FOUND`, identical to an unknown id.
5. Moving a view from a public team (or the workspace) to a private team sends `D` to everyone who loses it; moving it back sends `U`.
6. Deleting a view deletes every user's favorites and preferences of it, and each `D` reaches only that row's owner.
7. **M7 obligation:** when a public team turns private (`team.setPrivacy`), workspace and public-team views and defaults naming it, or its statuses or labels, would leak. M7 must refuse the flip while such views exist, or rewrite them (dropping those ids) through the repo in the same transaction. Recorded in permissions.md §5 (§12).

### 5.4 Where a view's issues come from (partial issue loading)

The client holds the live issues of the teams it subscribes to, plus the user's own (ADR-0020, SPEC-011 §5.7). A team's views are local once the team is subscribed, as SPEC-012 §3.3 item 10 already does for another public team's list. A **workspace or personal view** can match issues of teams the client doesn't hold. This needs a decision, recorded in an ADR (Q1). The proposed default:

1. **The teams a view can match** (`teamsAViewCanMatch`): a team view's team; for a workspace or personal view, the teams named by a top-level `team` condition (`eq` or `in`), else every team the user can see.
2. **The view pins them.** On open, the client subscribes to each of those public teams it doesn't hold (SPEC-011 §5.7's on-demand subscription and partial bootstrap). Teams needed by an open view are **pinned**: they don't count toward the 5 on-demand teams while the view is open. When it closes they become the most recently opened on-demand teams, and the usual limit drops the oldest. Private teams are only those the user is a member of, which are always held.
3. **While loading**, the view renders the rows it holds at once and the header shows "Loading issues from DES and OPS…" (after 150 ms) until each partial bootstrap is applied. Counts and groups grow as rows arrive.
4. **Offline**, teams never loaded are named in a banner, "Issues from DES and OPS are available when online.", and the view shows the rows it holds.
5. Every list feature (filters, display options, drags, manual order, offline edits, 60 fps) then works the same for every view, because every row is in the replica.

The alternative is a **server-backed view**: `issue.list` pages for the teams not held, `issue.groupBy` for counts, refreshed on focus and packets, with read-only or round-trip editing of rows not in the replica. It keeps ADR-0020's 5-team limit and the replica budget, but needs a second rendering path (no optimistic edits on those rows, `issue.list` ordering for every SPEC-020 ordering, paging under grouping). The proposed default supersedes ADR-0020's "up to 5 other public teams" clause, and a workspace view over every team loads every live issue of every public team, which can exceed SPEC-011's per-replica budget on a large workspace (SPEC-011 D19 already accepts this on a skewed team split).

### 5.5 Offline

- Every model here is eager and every operation is optimistic (except the queries), so creating, editing and deleting views, display changes and favorites work offline and queue (sync-protocol §5.3).
- The scope check (§4.4) also runs on the client, so most refusals show before sending; the server's refusal rolls back and shows its message.

## 6. API

| Operation | Kind | Input → output, notes | Optimistic |
|---|---|---|---|
| `view.create` | m | `{id?, name, description?, icon?, color?: ViewColor, scope: 'workspace' \| 'personal' \| {team: TeamRef}, filters, display?}` → `ViewOutput`. `display` defaults to `DEFAULT_VIEW_STATE`. Owner = actor. `ui`: **Create view…** | yes |
| `view.update` | m | `{view: ViewRef, name?, description?, icon?: string \| null, color?: ViewColor \| null, scope?, filters?, display?, owner?: UserRef}` → `ViewOutput`. A change to nothing writes nothing | yes |
| `view.delete` | m | `{view: ViewRef}` → `{id}`. Deletes its favorites and preferences in the same transaction. `destructive` | yes |
| `view.get` | q | `{view: ViewRef}` → `ViewOutput` | — |
| `view.list` | q | `listInput` plus `{scope?, team?: TeamRef}` → connection of `ViewOutput` | — |
| `view.setDefaultDisplay` | m | `{target: {team: TeamRef, tab: 'all' \| 'active' \| 'backlog'} \| {view: ViewRef}, display}` → `{display}`. Upserts the `ViewDefault`, or sets `CustomView.display`. Also clears the actor's own `ViewPreference` for the target (§3.6 item 2) | yes |
| `viewPreference.set` | m | `{target: {team: TeamRef, tab} \| {view: ViewRef} \| {myIssues: tab}, display}` → `{}`. Upsert | yes |
| `viewPreference.reset` | m | `{target}` → `{}`. Deleting a missing row succeeds | yes |
| `favorite.add` | m | `{target: {issue: IssueRef} \| {view: ViewRef} \| {team: TeamRef, tab}}` → `{favorite: {id}}`. Adding an existing favorite returns it (idempotent). Appends at the end | yes |
| `favorite.remove` | m | `{target}` → `{}`. Removing a missing favorite succeeds | yes |
| `favorite.reorder` | m | `{favorite: FavoriteRef, after?: FavoriteRef \| null, before?: FavoriteRef \| null}` → `{}`. Key between the neighbours (`keyBetween`) | yes |
| `favorite.list` | q | `{}` → the actor's favorites with their targets' summaries | — |

- `ViewOutput` = id, model, name, description, icon, color, scope, team (id, key, name) or null, owner (id, name), filters, display, url, createdAt, updatedAt.
- **New reference type** `FavoriteRef` (uuid only; the actor's own favorite, else `NOT_FOUND`). `ViewRef` exists in SPEC-003 §4 (uuid or exact name); it resolves only views the actor can see, after key narrowing.
- The `viewPreference` and `favorite` domains are new in SPEC-003 §3.1 (domain-model §7 lists `favorite.*` under "personal" and `view.*` already). Every operation has a summary, keywords, examples against the seed fixture, a permission and its `optimistic`; `pnpm registry:lint` passes.
- **API and MCP:** an API user can list views and read a view's filter, then pass it to `issue.list` to get its issues.

## 7. UI

### 7.1 Screens

| Screen | Route | Components |
|---|---|---|
| Team Issues (three tabs, then the team's views) | `/team/:key/all` (`/team/:key/issues` redirects to it), `/team/:key/active`, `/team/:key/backlog` | PageHeader, Tabs, ViewToolbar, filter bar (FilterChip), the list or board (SPEC-020) |
| Custom view | `/view/:id/:slug?` | PageHeader (icon, name, star, view menu), ViewToolbar, filter bar, list or board |
| New view | `/views/new?team=KEY` | as a custom view, with the title "New view" and **Save view** |
| Views (workspace) | `/views` | PageHeader (**New view**), sections, view rows, EmptyState |
| Team views | `/team/:key/views` | the same, one section |
| Create / Edit view | dialog | Dialog `md`: Input, Textarea, the icon and colour picker (Icons and Emojis tabs, a search field, a categorised icon grid, nine colour swatches and a custom colour), scope select, owner picker |
| Delete view | dialog | Dialog `sm` |
| Filter menu | popover | Popover with the command-menu list; PropertyPicker sub-pages; DatePicker |
| Sidebar | shell | **Views**, the **Favorites** section (FavoriteItem: drag, ×, menu), team **Views** |

New `packages/ui` components: **FilterChip** (three-part button: property, operator, values, plus remove), **FilterBar**, **FavoriteItem**, **ViewIcon**. Routes join the shell router; features plug in through `features/hosts.ts`.

### 7.2 States

| State | Shown |
|---|---|
| No issues match the filters | EmptyState: "No issues match these filters." with **Clear filters** |
| Team with no issues (All issues) | SPEC-012's empty state |
| Active or Backlog empty | "No active issues in ENG." / "Nothing in the ENG backlog." |
| Teams still loading (§5.4) | Rows held so far; "Loading issues from DES and OPS…" after 150 ms |
| Offline, some teams never loaded | The banner of §5.4 item 4 |
| View not found or not visible | "This view doesn't exist, or you don't have access to it." with **Go to views** |
| View deleted while open | "This view was deleted." with **Go to views** |
| An unreadable filter chip | The chip in its error state, "This filter can't be read. Remove it." |
| A link's filter couldn't be read | The page without it; the toast of §3.3 item 3 |
| Saving a view refused | The dialog stays open; the server's message on the field it names (SPEC-003 `issues`) |

### 7.3 Small screens (NFR-20)

- **768–1279 px:** as at full width; the filter bar wraps to two lines at most, then scrolls horizontally.
- **< 768 px:** the tabs and the filter bar stay (filters are read-only chips plus **Filter**); creating and editing views is not offered (the dialogs need room); favorites and Views pages work. Reading a view and its issues works at 375 px without horizontal page scrolling.

### 7.4 Accessibility (NFR-19)

- The filter bar is a `toolbar` named "Filters"; each chip part is a button with a full name ("Assignee is Ada, change values"); the remove button is "Remove filter Assignee is Ada". Adding or removing a chip announces "Filter added: Assignee is Ada. 12 issues." in the polite live region.
- The view tabs are Radix Tabs (arrow keys).
- Favorites are a list in the sidebar's navigation; reordering is by drag only, with no keyboard equivalent, as in Linear (D9).
- The dialogs trap focus, return it on close, and show field errors with `aria-describedby`.
- Every new component has stories in light and dark that pass axe.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | A link with a filter naming a private team's label is opened by a non-member | The chip reads "Unknown label" and matches nothing; no name or row is revealed (§3.3 item 3). |
| E2 | A workspace view is saved with a status of a private team the actor is in | Refused with §4.4 item 2's message, before sending (client check) and by the server. |
| E3 | A label in a saved view's filter is deleted | The view keeps the id and matches nothing for it; the next edit drops it with a note (§4.4 item 4). |
| E4 | Two users edit the same view's filters at once | Last write wins (`view.update` patches `filters` whole); the other user's page updates from the delta, and their unsaved URL filter stays with Clear and Save ▾. |
| E5 | A view is moved from a public team to a private team while a non-member has it open | The `D` removes it; the page shows the not-found state of §7.2. Their favorite of it is hidden. |
| E6 | A view is deleted while someone has unsaved filter changes on it | The page shows "This view was deleted."; the URL filter can still be saved as a new view with `Alt+V`. |
| E7 | "Set as default" while others have personal displays | Their personal displays stay; only users without one see the new default (§3.6 item 2). |
| E8 | A user's personal display names a label group that is later deleted | `readViewState` falls back for that field (SPEC-020 E12); Reset clears it. |
| E9 | The user adds a 101st favorite | Refused with §3.7 item 7's message. |
| E10 | A favorite issue is deleted, restored, or purged | Deleted: hidden (asked again on focus). Restored: shown again. Purged: the server deletes the favorite. |
| E11 | A favorite issue belongs to a public team the client doesn't hold | Shown after one `issue.get` (online); offline "Issue not loaded" (§3.7 item 6). Opening it subscribes its team (SPEC-012 §3.4 item 11). |
| E12 | A user leaves a private team with favorites and preferences of its views | Those rows stay in the user's group, hidden by the client: they hold nothing the user hadn't seen (Q10). |
| E13 | A workspace view with no Team filter is opened in a workspace with 9 public teams | All 9 are subscribed and pinned while it is open (§5.4); closing it leaves the 5 most recent. |
| E14 | The same view is open in two tabs and one closes | The other tab still pins its teams (pins are per tab, with the Web Lock rule of SPEC-011 §5.7). |
| E15 | A link's filter is longer than 4,000 characters | The address isn't updated; the bar shows §3.3 item 2's message. |
| E16 | `Alt+V` with no filter chips | Unavailable; the hint "Add a filter first, then save it as a view." |
| E17 | `G` `A` with no visible team | The hint "Join a team to see its issues" (SPEC-012 §3.6's `G` `E` rule). |
| E18 | Relative date filters ("updated after 1 week ago") as time passes | Re-evaluated every minute and on focus; rows leave or join the view without a delta. |
| E19 | An API key limited to ENG lists views | Workspace and personal views and ENG's views; another team's views are `NOT_FOUND` on `view.get`. Creating a workspace view is `FORBIDDEN`. |
| E20 | `?filter` on a team tab names the team's own status that is then deleted | The chip reads "Unknown status" and matches nothing. |
| E21 | A view's owner is deactivated | The owner stays; the Edit dialog shows them as deactivated, and anyone with edit access can pick a new owner. Delete falls to Admins. |
| E22 | A filter has the same chip twice ("Priority is High" twice) | Allowed; it is an AND of two identical conditions. |
| E23 | A team view that is a tab is deleted, renamed or moved to another team or scope | The tab strip updates from the delta: the tab leaves, or shows the new name. If it was the open tab, the page shows §7.2's "This view was deleted." or the not-found state. |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)); they are marked ⏸ and checked by hand. **Leak tests and the sync property suite are still written** (Postgres allowed). Story tests (axe, keyboard) are the UI slices' local Definition of Done.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | The three team tabs hold exactly the issues of §3.1's table, at their routes (`/team/:key/issues` redirects to `/all`), followed by one tab per team-scoped view of the team (sorted by name, leaving when the view is deleted or moved); `G` `E`, `G` `A`, `G` `B` open them for the current team (or show the hint); each tab keeps its own display state. | unit (built-in filters, routes, commands) |
| AC-2 | The filter menu offers exactly §3.2's M2 properties (Team only on multi-team views; nothing of M3 or M4); quick filters find values by typing; each choice produces the Filter of the table, and `filterIssues` matches it (the conformance test of SPEC-011 AC-11 already covers each field against SQL). | unit + property (generated chips evaluate the same as their Filter tree) |
| AC-3 | `chipsFromFilter` and `filterFromChips` round-trip every chip list; any other tree becomes one Advanced filter chip that keeps the tree unchanged; operators switch as §3.2 item 5 says; "No X" values compile to `exists: false` (combined with `or` when mixed with values). | unit + property |
| AC-4 | Multi-team values: choosing a status or label by name stores the ids of every same-named one the view may name; choosing a label group stores its labels' ids. | unit |
| AC-5 | The filter bar's chips are written to `?filter` as base64url JSON with `replaceState`; opening such a link applies them; an invalid value is ignored with the toast; unresolvable ids show "Unknown …" and match nothing; display options never enter the URL; more than 4,000 characters isn't written. `decodeFilterParam` never throws. | unit + property (encode/decode round trip) |
| AC-6 | Create view: `Alt+V` (available only with a chip), Save view and New view open the dialog; Create dispatches `view.create` with the page's filters (built-in filter included) and display state, then opens the view; Duplicate prefills "<name> copy". | unit (dialog model, fake dispatcher) |
| AC-7 | A custom view page renders its filters and display; changing a filter makes it temporary in the URL and shows Clear and Save ▾, and a reload keeps it; Save dispatches `view.update {filters}`, Save as new view… opens the dialog, Clear drops `?filter`. | unit |
| AC-8 | `view.create`, `view.update`, `view.delete` follow §5.2's permissions (personal: owner only; delete: owner or Admin; edit: anyone who sees it); delete removes every user's favorites and preferences of the view; a change to nothing writes nothing. | unit (handlers with a fake repo, permission matrix) + integration ⏸ |
| AC-9 | The scope check (`viewScopeProblems` and the server): an invisible or unknown id is `NOT_FOUND` with one message; a private team's team, status or label in a workspace or public-team view is `INVALID_INPUT` with §4.4's message; a private team's own rows are allowed in its own team view; personal views skip item 2. | unit + property (a generated filter passes the client check iff it passes the server's) |
| AC-10 | **Leak:** a private team's CustomView and ViewDefault never reach a non-member (bootstrap, partial bootstrap, catch-up, deltas); `view.get`, `view.list`, `ViewRef` and `view.setDefaultDisplay` answer them `NOT_FOUND`, identical to an unknown id; personal views, ViewPreference and Favorite rows reach only their owner; moving a view into a private team sends `D` to everyone else; deleting a view sends each favorite's and preference's `D` only to its owner. | leak test (Postgres allowed) |
| AC-11 | **Leak:** a workspace or public-team view or default can't store a private team's id, status id or label id, whatever the actor's membership (§4.4), and `favorite.add` / `viewPreference.set` with an invisible target are `NOT_FOUND`, identical to an unknown id. An API key limited to ENG gets `NOT_FOUND` for other teams' views and `FORBIDDEN` for workspace view writes. | leak test (Postgres allowed) |
| AC-12 | Display resolution: personal display, else the view's default, else `DEFAULT_VIEW_STATE`; any display change dispatches `viewPreference.set` with a full state; Set as default writes the tab's `ViewDefault` or the view's `display` and clears the actor's preference; Reset clears it; other users' preferences are untouched. | unit |
| AC-13 | Favorites: the star, `Alt+F`, menus and `Mod+K` add and remove (idempotent ops); the sidebar section appears with the first favorite and hides with none; items render per target (§3.7 item 3); drag dispatches `favorite.reorder` with the right neighbours (there is no keyboard or menu reorder); an item's menu has only Copy URL and Remove favorite; × removes; the 101st is refused. | unit (sidebar model, commands, fake dispatcher) + story |
| AC-14 | A favorite the replica can't render is asked for with `issue.get` once online, shows "Issue not loaded" offline, and is hidden when `NOT_FOUND`, archived or deleted, coming back after a restore on focus; a purge deletes the favorite on the server. | unit (favorite source with a fake dispatcher) + integration ⏸ (purge) |
| AC-15 | Views pages list the views of §3.5 in their sections, sorted by name, with row keys and menus; `O` `V` lists every visible view; `O` `F` lists favorites. | unit |
| AC-16 | Sidebar: **Views** after Drafts, the Favorites section above Your teams, team **Issues**, **Views**, **Home**, **Archive** in that order; Issues is current on every tab. | unit + story |
| AC-17 | Every binding of §3.9 is registered with a command, shows in `?`, matches Linear's panel, passes the conflict and reserved-keys tests; `G` `U` opens Views and `G` `V` stays unbound. | unit (registry) |
| AC-18 | View sources (§5.4, as decided in Q1): a team view of a non-member public team subscribes it; a workspace view subscribes and pins the teams it can match, renders held rows at once with the loading line, and releases the pins on close (the LRU limit then applies); offline it names the teams not loaded. | unit (view source with the fake hub, `sync-react` load state) |
| AC-19 | The four models sync in the groups of §5.1, join the `schemaHash`, and their operations' `optimistic` updates predict the rows the server commits (rebuilding twice gives the same rows). | unit + **sync property suite** (views, preferences and favorites join the generator; not held) |
| AC-20 | Filters re-evaluate relative dates every minute and on focus; a chip that `resolveFilter` refuses shows its error state and isn't evaluated. | unit (fake timers) |
| AC-21 | Accessibility: the filter toolbar, chip names, announcements, tabs and favorite moves of §7.4; every new component passes axe in light and dark. | unit (announcer) + story (axe) |
| AC-22 | Keyboard only: filter a team's list by assignee and label, save it as a team view, set its display as default, favorite it, open it with `O` `F`, and delete it. | e2e ⏸ (checked by hand) |
| AC-23 | Filtering and grouping a 10,000-issue view repaints in < 50 ms after a chip changes; the view still scrolls at 60 fps (SPEC-020 AC-17). | perf ⏸ |

## 10. Metrics & performance

- A chip change repaints a 10,000-issue view in < 50 ms (filter + group + order on the main thread; perf ⏸).
- Opening a custom view of member teams renders from the replica in < 200 ms (NFR-04).
- `viewPreference.set` is dispatched at most once per 500 ms per target while a user clicks through options (debounced, like drafts).
- The four models add at most a few hundred rows per workspace (views) and per user (preferences ≤ 500, favorites ≤ 100) to the replica.
- No new log events.

## 11. Open questions

| # | Question | Proposed default |
|---|---|---|
| Q1 | **Decided, see D1.** **Views over teams the client doesn't hold** (§5.4; needs an ADR): subscribe to and pin every public team a view can match while it is open (one rendering path; supersedes ADR-0020's 5-team limit for open views; a workspace-wide view loads every public team's live issues), or a **server-backed** path with `issue.list` / `issue.groupBy` for teams not held (keeps the limit and budget; two rendering paths, no optimistic edits on those rows)? | Pin the teams (§5.4), recorded in a new ADR, "Views pin the teams they show", which supersedes ADR-0020's on-demand limit clause for teams needed by an open view. |
| Q2 | Personal views (only their owner sees them): ship them in M2? domain-model §4.15 already plans `personal`; Linear's docs describe workspace and team views and personal dashboards, not personal views. | Ship them, as the Personal scope. |
| Q3 | **Decided, see D3.** Route of All issues: keep M1's `/team/:key/issues`, or Linear's `/team/:key/all` (with a redirect from `/issues`)? | `/team/:key/all`; `/issues` redirects to it. |
| Q4 | URL encoding: base64url JSON of the Filter tree (compact, opaque), or a readable query form (`?assignee=me&label=…`)? Linear's web app uses a `?filter=` query parameter (the name matches ours); its value's encoding couldn't be read. | base64url JSON (§3.3), the same tree the API takes. |
| Q5 | Linear's **Advanced filter** builder (AND/OR groups, nested): in M2, or later? | Later. M2 ships chips (AND) and shows any other tree as one removable Advanced filter chip. |
| Q6 | Same-named statuses and labels across teams, and label groups, in filters: expand to ids when the chip is built (a later team or label isn't included until the chip is edited), or add name-based filter fields (`status.name`, a label-group field) to `ISSUE_FILTER_FIELDS`, with SQL and conformance tests? | Expand to ids in M2; name-based fields later if people ask. |
| Q7 | **Decided, see D4.** Changing a custom view's filters: temporary, or saved at once? | Temporary, with Clear and Save ▾. |
| Q8 | Who may "Set as default for everyone" on a team's built-in views: anyone who can see the team (permissions §3.4 says ✅ Member), or team members only? | Anyone who can see the team, as permissions §3.4. |
| Q9 | Personal display: synced across the user's devices (`ViewPreference` in `user:<id>`, domain-model's plan), or per device in `localStorage`? And a cap of 500 per user, least recently updated dropped? | Synced, with the 500 cap. |
| Q10 | Favorites in M2: issues, custom views and team tabs (Linear also has teams, labels, users); 100 per user; favorites of things the user can no longer see hidden on the client (not deleted by the server when leaving a private team)? | Yes to all three; teams, labels and users not in M2 (the PRD lists issues, views, projects, cycles, docs). |
| Q11 | **Decided, see D5.** View icon: a Lucide icon plus a hue, or an emoji? | Icons and Emojis tabs; nine colour swatches plus a custom colour. |
| Q12 | **Decided, see D6.** Linear's "views attached to a team's Issues page" (they show as tabs beside All issues, Active, Backlog): in M2? | Yes, as tabs. |
| Q13 | **Decided, see D7.** `G` `V`: shortcuts §3.2 says "Views (M2)", but §3.9 reserves `G` `V` for Linear's current cycle. | Bind `G` `U` to Views; leave `G` `V` for the current cycle; fix shortcuts §3.2 (§12). |
| Q14 | Owner change: anyone who can edit the view (as Linear), or only the owner and Admins? | Anyone who can edit it. |
| Q15 | Delete: a hard delete after a confirm dialog (Linear's docs show no Recently deleted for views), or a soft delete with restore? | Hard delete with the confirm dialog. |
| Q16 | **Decided, see D8.** `/views/new` as a page (Linear's New view) or only "Save as view" from a filtered list? | Both. |
| Q17 | **Decided, see D9.** Keyboard reordering of favorites: Move up / Move down in the item's menu? | No: drag only, as Linear. |

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Q1: views over teams the client doesn't hold | **Decided by the user on 2026-11-25:** pin the view's teams. An open view subscribes to and pins every public team it can match (one local rendering path, instant and offline), recorded in ADR-0027. The guard against the 35 MB replica budget is the size-based on-demand team limit planned as an M1 follow-up (SPEC-011 D19), not a second, server-backed rendering path. |
| D2 | Scope: reordering teams in the sidebar | **Decided by the user on 2026-11-25:** SPEC-005 §7's M2 promise (drag to reorder the teams in the sidebar) belongs to this spec, which owns the sidebar. Its flows, operation, ACs and edge cases are still to be written before review (the coordinator, 2026-11-25). |
| D3 | Q3: route of All issues | **Decided by the user on 2026-11-25** ("we want same as Linear"): the team's All issues route is `/team/:key/all`, beside `/active` and `/backlog`; M1's `/team/:key/issues` redirects to it. Checked in Linear's web app on 2026-11-25. |
| D4 | Q7: editing a saved view's filters | **Decided by the user on 2026-11-25** ("we want same as Linear"): the change is temporary and lives in the URL, with a chip bar that has **Clear** (not "Reset") and **Save ▾**; a reload keeps it temporary. What Save's menu holds wasn't recorded; this spec gives it Save as new view…. Checked in Linear's web app on 2026-11-25. |
| D5 | Q11: view icon | **Decided by the user on 2026-11-25** ("we want same as Linear"): a picker with **Icons** and **Emojis** tabs, a search field, a categorised icon grid, nine colour swatches plus a custom colour. Checked in Linear's web app on 2026-11-25. The Emojis tab needs an offline emoji list (no remote fetch, CLAUDE.md rule 5); its source is settled in the UI slice. |
| D6 | Q12: team views as tabs | **Decided by the user on 2026-11-25** ("we want same as Linear"): yes, in M2. Saved views of a team appear as tabs next to All issues, Active and Backlog. Checked in Linear's web app on 2026-11-25. |
| D7 | Q13: `G` `V` and Views | **Decided by the user on 2026-11-25** ("we want same as Linear"): `G` `V` is not bound to Views; Views is `G` `U`. Checked in Linear's web app on 2026-11-25. |
| D8 | Q16: `/views/new` and Save as view | **Decided by the user on 2026-11-25** ("we want same as Linear"): both exist, the `/views/new` full page and Save as view (`Alt+V`). Checked in Linear's web app on 2026-11-25. |
| D9 | Q17: reordering favorites | **Decided by the user on 2026-11-25** ("we want same as Linear"): drag only. Linear's favorite menu has only "Copy URL" and "Remove favorite", with no menu or keyboard reorder, so Move up / Move down are dropped. A keyboard-only user can't reorder favorites, the same as in Linear. Checked in Linear's web app on 2026-11-25. |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| ADR-0027 (new) | — | **"Views pin the teams they show"** (Q1): an open view subscribes to and pins the public teams it can match; pinned teams don't count toward the 5 on-demand teams; on close they join the LRU list. Add it to `adr/README.md`; change ADR-0020's status line only ("Partly superseded by ADR-NNNN: the on-demand limit"). If Q1 picks server-backed views, the ADR records that instead and ADR-0020 is unchanged. | Supersedes ADR-0020's 5-team clause (proposed default only) |
| SPEC-011 | §5.7 | Teams needed by an open view are pinned and don't count toward the 5 on-demand teams (per the ADR). Dated "Changed (SPEC-021)". | Per the ADR |
| sync-protocol.md | §2, §6.1, §9, §10, §11 | §2: CustomView, ViewDefault, ViewPreference, Favorite are eager (already listed; "Preferences" stays). §6: their groups (SPEC-021 §5.1). §6.1 and §9: pinned teams (per the ADR). §10: the four models join the convergence generator. §11: a change-log row (no codec change; `schemaHash` changes). | No |
| domain-model.md | §4.15 | CustomView: `icon` is a Lucide name or an emoji and `color` a preset swatch or `#rrggbb` (D5); `visibility` → `scope` (`workspace` \| `team` \| `personal`), drop `sortOrder`, add `description`, `color`, `creatorId`; `filters` and `display` rules (SPEC-021 §4.1, §4.4). ViewDefault: `(teamId, tab)`, not `viewKey`. ViewPreference: `target`, `teamId`, `viewId`, `tab` instead of `viewKey`; 500 per user. Favorite: `target`, target ids, `tab`, `sortOrder`; 100 per user. | No |
| domain-model.md | §2 | CustomView (team scope) syncs in the team's groups; the personal row stays user-scoped. | No |
| domain-model.md | §7 | `view` domain: `view.create`, `view.update`, `view.delete`, `view.get`, `view.list`, `view.setDefaultDisplay`. `personal` domain: `viewPreference.set`, `viewPreference.reset`, `favorite.add`, `favorite.remove`, `favorite.reorder`, `favorite.list`. | No |
| SPEC-003 | §3.1 domains, §4 refs | Add the `view`, `viewPreference` and `favorite` domains; add `FavoriteRef` (uuid only, the actor's own); `ViewRef` narrows by API key `teamIds`. | No |
| permissions.md | §2 | `workspace`: shared workspace views and the defaults and team views of public teams. `team:<id>`: a private team's views and defaults. `user:<id>`: personal views, view preferences, favorites (already listed). Add the scope check rule (SPEC-021 §4.4). | No |
| permissions.md | §3.4 | Edit a personal view: 👤 owner. Delete a personal view: 👤. Change a view's owner: anyone who can edit it. "Set display as default for everyone": anyone who can see the team or edit the view. | No |
| permissions.md | §3.5 | A key narrowed by `teamIds` can read workspace views but not write them; other teams' views are `NOT_FOUND`. | No |
| permissions.md | §5 | Add SPEC-021 §5.3's items 1–6 as unticked checks, and item 7 as an M7 obligation of `team.setPrivacy`. | No |
| permissions.md | §6 purge | Purging an issue deletes its favorites (each `D` to its owner only). | No |
| glossary.md | terms | Add **View** (custom view: saved filters and display, with a scope and an owner), **Default view** (All issues, Active, Backlog), **Display options**, **Personal display**, **Favorite**, **Filter chip**. | No |
| shortcuts.md | §3.1, §3.2, §3.3, §3.4, §3.9 | Mark live: `G` `A`, `G` `B`, `O` `V`, `O` `F`, `F`, `Alt+V`, `Alt+F`, `G` `U`. **Change the `G` `V` "Views" row of §3.2 to `G` `U`** (D7) (§3.9 reserves `G` `V` for the current cycle, Q13). Remove those keys from §3.9's reserved list. | No |
| command-menu.md | §2 Navigation, §3.3 | Add Go to views, Go to ENG views, Go to ENG active issues, Go to ENG backlog, Open view…, Open favorite…, and the view and filter commands of SPEC-021 §3.10 with their contexts. | No |
| design-system.md | §3 Sidebar | M2 order: My issues, Drafts, Views; Favorites above Your teams; team items Issues, Views, Home, Archive. Remove "Trash" (SPEC-015 already moved it into Archive). | No |
| design-system.md | §3 view tabs, §5.3 | Team tabs: All issues, Active, Backlog, then the team's views (icon and name, overflow into ⋯). ViewIcon's picker: Icons and Emojis tabs, search, categorised grid, nine swatches plus a custom colour; FavoriteItem has no keyboard reorder. Add FilterChip, FilterBar, FavoriteItem, ViewIcon; ViewToolbar's "save-view affordance" is the Save view button (shown with at least one chip). | No |
| SPEC-012 | routes, `G` `E` | The team's All issues route is `/team/:key/all`; M1's `/team/:key/issues` redirects to it (D3). `G` `E` and the sidebar Issues item open `/all`. | No |
| SPEC-005 | §3 routes, §7 sidebar | `/team/:key/all` (`/team/:key/issues` redirects to it), `/team/:key/active`, `/team/:key/backlog`, `/views`, `/views/new`, `/team/:key/views`, `/view/:id/:slug?` are live. The sidebar gains Views, Favorites and the team's Views item. URL state: filters only (SPEC-020 §12). | No |
| PRD | FR-VIEW-08 | "has blockers" arrives with relations (M3); M2 filters cover every M2 field. Operators use Linear's words (is, is not, is either of; includes any of / all of / neither of; before / after). | No |
| PRD | FR-VIEW-10 | Scopes are workspace, team and personal (Q2); project views arrive with projects (M3). | No |
| PRD | FR-NAV-08 | M2 favorites: issues, views and team views; projects and cycles in M3, documents in M4. | No |
