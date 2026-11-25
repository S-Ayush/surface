# SPEC-023: Global search & navigation

Status: **Draft** · Milestone: **M2** · Date: 2026-11-25
Implements: FR-NAV-04 (global search) · FR-NAV-10 (the Subscribed tab: how M2 handles it) · FR-ISS-13 (pre-filled create URL) · FR-MEM-04 (members directory) · FR-AUTH-10 (what M2 adds to preferences) · FR-ISS-10 (archived issues become searchable) · NFR-05, 06, 14, 16, 18, 19
Depends on: SPEC-011 (issues, `issue_search_text`, partial issue loading §5.7, `issue.get`/`list`/`count`), SPEC-013 (`comment_search_text`, comment links), SPEC-015 (archived and deleted issues, read-only pages), SPEC-012 (IssueRow, My issues, composer, issue page, not-held issues), SPEC-005 (command menu, shortcut engine, preferences, routes), SPEC-003 (read operations, visibility in SQL), SPEC-001 (users, memberships)
Coordinates with (drafted in parallel, M2): SPEC-020 (board, display options), SPEC-021 (filters, custom views, favorites), SPEC-022 (multi-select, bulk edit, undo, context menu, peek)
Related: [ADR-0008](../04-architecture/adr/0008-search.md) (superseded on acceptance, §12) · [ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md) · [command-menu](../05-design/command-menu.md) · [shortcuts](../05-design/shortcuts.md) · [permissions §4, §5](../03-domain/permissions.md)

---

## 1. Problem & goal

People can't find an issue in Surface unless they know its identifier or it is in a list they can scroll. M2 adds **global search**, copied from Linear: `/` opens Search, and `Mod+K` finds issues, people and teams as you type. Matching on identifiers and titles is instant and works offline. Matching on descriptions and comments, and on issues this device doesn't hold, comes from the server a moment later. Archived issues become searchable (FR-ISS-10).

The PRD says search runs "on the local replica", but since ADR-0020 the replica holds only the live issues of the user's teams plus their own issues, and descriptions and comments are loaded per issue on demand. So this spec splits search in two, as ADR-0008 already sketched and Linear does: **instant local results** over what the replica holds, and a **server search operation** (`issue.search`) over every issue the user can see. The central constraint is rule 4: search is a read path over private data, so it must never leak a private team's issue through results, counts, snippets or ranking.

The spec also covers five smaller navigation items: **recents** that follow the user across devices, like Linear's, a **members directory** with member profiles (FR-MEM-04), the **pre-filled create URL** (FR-ISS-13), how M2 handles the **Subscribed** tab of My issues (FR-NAV-10), and the M2 additions to **preferences** (FR-AUTH-10).

## 2. Scope

**In scope**

- `Mod+K` entity results (§3.1): issues held in the replica (identifier and title), people, teams; prefix modes (`i `, `u `, `t `); a **Recent** section; an **Advanced search** action (`Mod+/`) that hands over to the Search page.
- The **Search page** `/search?q=…&includeArchived=true` opened by `/` (§3.2): the tabs All and Issues, local results first, then server results over title, description and comments, with filters (SPEC-021's filter bar), an order menu, an Include archived toggle, snippets and highlights.
- The query language (§3.3), the ranking (§3.4), offline behaviour (§3.6).
- **Recents synced across the user's devices**, like Linear (§3.5, D19): the user-scoped synced model `Recent` and the operations `recent.record` and `recent.remove`, with their leak tests.
- The read operation `issue.search` (§6) and its storage: full-text vectors on the server-only search text tables, title indexes (§4.2).
- The client search index in a Web Worker (§4.1).
- **Members directory** `/members` and **profiles** `/profiles/:username` with Assigned and Created tabs (§3.7).
- My issues: the **Subscribed** tab stays hidden until M4 subscriptions (§3.8, Q11).
- **Pre-filled create URL** `/new?…` and `/team/:key/new?…`, and "Copy pre-filled create issue URL" (§3.9).
- **Home view** preference: the fixed pages that exist in M2 (My issues, All issues, Active issues) are the home choices (§3.10).
- Shortcuts `/`, `Mod+/` (in the command menu), `O` `I`, `O` `U` and the Search page keys (§3.11).
- Private-team leak tests for every new read path (§5.3, AC-14 to AC-17).

**Out of scope**

- Projects, documents, cycles and initiatives in search: they don't exist yet. M3 adds `project.search`, a Projects section and the Projects tab (and profile tab); M4 adds `document.search`, a Documents section and tab. §3.2 item 9 and §4.1 keep room for them, and §11 Q22 lists the plan.
- Filters, saved views, favorites and the filter bar itself (SPEC-021); display options and the board (SPEC-020); multi-select, bulk edit, undo, peek and the context menu (SPEC-022). The Search page reuses their components where §3.2 says so.
- Find in the current view (`Mod+F`): a view feature; not in this spec (Q21).
- Searching issue history, attachment names or file contents. Linear's docs name ID, title, description and comments only.
- Subscriptions (M4), so the Subscribed tab's content (§3.8).
- Natural-language search, "did you mean" suggestions, synonyms and semantic search: no built-in AI (CLAUDE.md out-of-scope list), and suggestions drawn from other people's text could leak (§5.3).
- An external search service (Meilisearch, Elasticsearch, Typesense): Surface is one image plus Postgres (CLAUDE.md, VISION D4).

## 3. User flows

### 3.1 Search in the command menu (`Mod+K`)

The command menu keeps its sections (command-menu §1). With a query, entity results join them as a **Quick results for "…"** section of issue rows, then **People** and **Teams** sections, after Create and before Settings (D5). Everything in this section is local in M2: it never waits for the network and works offline.

1. **Quick results** are issue rows from the client search index (§4.1) over the issues the replica holds: the identifier and the title, matched fuzzily by word, as Linear's are (D5). At most 8 show, ranked by §3.4. Where Linear's quick results come from (its server or a local index) couldn't be seen, so that stays tied to Q1–Q3; the default there is the local index. Each row shows the status icon, the identifier, the title with the matched characters highlighted, and the assignee avatar. `Enter` opens the issue page.
2. The **identifier fast path** stays (SPEC-012 §3.8, command-menu §3.1): `eng-87` (and `eng87`, Linear's shorthand) puts **Open ENG-87** first even when the replica doesn't hold it; the page resolves it through `issue.get`.
3. **People** come from the replica's users (every user is in the `workspace` group): name, display name and email. `Enter` opens the profile (§3.7). At most 5.
4. **Teams** come from the replica's teams the user can see. `Enter` opens the team's issue list. At most 5. (The existing "Go to ENG issues" commands stay; a team result is the same target found by name.)
5. **Advanced search** (D5). Whenever the query has 2 or more characters, the last item of the list is the action **Advanced search**, with `Mod+/` as its key while the menu is open (`Mod+Enter` is not taken over: it keeps "run and keep open"). It opens the Search page with the query (§3.2), where descriptions, comments and issues this device doesn't hold are searched. When nothing matches, the menu says **No results found** with **Go to advanced search**. In M2 `Mod+K` makes no server request (Q1–Q3).
6. **Prefix modes** (Linear's command-menu prefixes): a query that starts with `i `, `u ` or `t ` (a letter, then a space) limits the menu to issues, people or teams. The prefix becomes a chip in the input ("Issues"); `Backspace` on an empty query removes the chip. Linear's `p `, `d `, `l ` and `f ` arrive with projects (M3), documents (M4), and labels and favorites (Q18, SPEC-021).
7. **Empty query:** a **Recent** section (§3.5) shows first, above Suggested: the last 10 items opened (issues, profiles) and the last 5 commands run, on any of the user's devices (D19).
8. While the client index is still being built (a cold start, §4.1), the Issues section shows one row "Indexing issues…"; the fast path, people and teams already work.

### 3.2 The Search page (`/`, `/search`)

1. `/` (global, not while typing), the sidebar's **Search** button, **Advanced search** (`Mod+/`) in `Mod+K`, and "Search" in `Mod+K` open the Search page at `/search` (with `?q=` when there is a query), as Linear's `/` does (D4). Focus goes to the query field, whose placeholder reads "Search issues…" (Linear's is "Search issues, projects, and documents…"; the other types arrive with M3 and M4). The page is a normal route, so the back button returns to where the user was. Its tabs are Linear's: **All**, **Issues**, **Projects**, **Documents** (item 9).
2. **Empty query:** **Recent searches** (the last 5 queries run on this device, §3.5) and **Recent issues** (the last 10 opened, on any of the user's devices). `Enter` on a recent search runs it.
3. **Typing:** the address follows the query and the display toggle, as `/search?q=login&includeArchived=true` (`history.replaceState`, so typing doesn't add history entries). Results come in two steps:
   - **Local, at once:** the client index's matches (§4.1) render within one frame of the keystroke.
   - **Server, after 150 ms without typing:** `issue.search` with the query, the filters, the order and `includeArchived` from the toggle (item 7). A newer keystroke aborts the request in flight (command-menu §3.1 item 3). Queries under 2 characters (after trimming) stay local.
   When the server answers, its list replaces the local one: it is complete and authoritative. The row the user is pointing at keeps focus if it is still in the list (SPEC-012 §3.3 item 4's rule); otherwise focus stays in the query field.
4. **Results** are a flat list (no grouping) of **SearchResultRows**: SPEC-012's IssueRow plus, when the match is not in the identifier or title, a second line with the snippet and where it matched: "Description: …the **login** redirect fails when…" or "Comment by Ada: …". Matched words are highlighted in the title and the snippet (Linear highlights the term in the title). An archived issue (shown while Include archived is on) shows an **Archived** badge. A row whose issue the replica holds renders from the replica and stays live; any other row renders from the server's `IssueSummary` (§6).
5. **Opening a result:** `Enter` or a click opens the issue page. A match in a comment opens `/issue/ENG-42#comment-<id>`, which scrolls to the comment and highlights it (SPEC-013 §7). An issue the replica doesn't hold opens through SPEC-012 §3.4 item 11 (`issue.get`, an on-demand subscription for a public team's live issue, the read-only page for an archived one).
6. **Filters:** the page has SPEC-021's filter bar and Filter menu (`F`), including its Advanced filter builder (nested AND/OR groups, SPEC-021 §3.11, D12); `issue.search` takes the whole tree. Typing `@` in the query opens SPEC-021's quick filter picker (team, assignee, creator, status, priority, label), and the chosen value becomes a filter chip, not query text (Linear's "@-mention to filter"). Filters apply to local and server results alike, through the shared Filter model (domain-model §5, SPEC-003 §7.4).
7. **Display options** (a menu in the header, as Linear's for search; D6): **Ordering**: **Most relevant** (default, §3.4), **Last updated**, **Last created**; and **Include archived**, a toggle that is **on by default** and is also written in the address (`includeArchived=true`; off is `includeArchived=false`, and an address without it reads as the default, on). Off, archived issues leave the server results. Both choices are remembered per device.
8. **Paging:** the server returns 50 results per page; scrolling near the end loads the next page, up to **500** results (Linear's cap). At the cap a footer says "Showing the first 500 results. Add words or filters to narrow them." The header shows the count ("23 results", or "500+ results"), from the server's `totalCount` (§6), only once the server has answered.
9. **Tabs** (D4): Linear's page has the tabs **All**, **Issues**, **Projects** and **Documents**. In M2 only issues exist, so the page shows **All** and **Issues**, and both list issues. **Projects** (M3) and **Documents** (M4) tabs appear with their features, and All then mixes the types (Q22).
10. **Editing from the results:** the row's property keys, row menu and (with SPEC-022) selection work on rows the replica holds, as in any list. On a row it doesn't hold, the first property key or menu action loads the issue as opening it would (§3.2 item 5: an on-demand subscription for a live issue of a public team) and opens the picker once the row is local, with the skeleton after 150 ms; an archived issue's row is read-only (SPEC-015) (Q10).
11. **`Esc`:** in the query field with text, clears the query; with an empty query, goes back (the previous route). On a focused result, moves focus to the query field.
12. **No results:** "No results for "login redirect"." with, when filters are on, **Clear filters**.

### 3.3 The query

The same parser runs on the client and the server: `parseSearchQuery(text)` in `packages/domain` (§4.3).

- **Words** are matched with stemming and without common English stop words ("the", "and", "of"), as Linear does for unquoted text ("searches may also include results for similar terms").
- **`"quoted text"`** matches that exact phrase.
- **The last word, while typing,** also matches as a prefix ("redir" finds "redirect"), so results are useful before a word is finished.
- **Identifiers:** `ENG-123`, `eng-123` and `eng123` (Linear's shorthand) match that issue's identifier exactly. An identifier is also an ordinary word, so a title that mentions "ENG-123" matches too.
- **Typos in titles:** on the server, a title that is close to the query (trigram similarity, `pg_trgm`) matches even with a typo ("redriect"); locally, a word of 4 or more characters tolerates one edit, 8 or more two (§4.1). Descriptions and comments match on stems, not on typos (Q3).
- **Case and accents:** case never matters. Accents matter in M2 ("resume" doesn't find "résumé"; Q20).
- The query is at most **200 characters** (the field stops there; the server answers longer input with `INVALID_INPUT`).

### 3.4 Ranking (Most relevant)

Copied from Linear's docs: "showing unstarted and in progress issues first, then backlog, completed, canceled, and archived issues". One comparator, `compareSearchHits` in `packages/domain`, orders local and server results, so the two steps of §3.2 item 3 agree as far as their data allows:

1. An **exact identifier** match first.
2. Then the **state bucket**: started and unstarted → backlog → completed → canceled (Duplicate counts as canceled) → archived (any category). Triage (M4) joins backlog until M4's triage spec says otherwise.
3. Then the **field tier**: a match in the title before a match only in the description, before a match only in comments.
4. Then the **text score** within the tier: on the server, `ts_rank_cd` (with length normalisation) for words and `word_similarity` for title typos; locally, the index's score (§4.1).
5. Then `updatedAt`, newest first, then `id`. The order is total (AC-7).

**Every input to the comparator is a property of the row itself** (§5.3): no score depends on how many other rows match or on statistics over the table, so a private team's issues can't move a visible issue up or down.

**Last updated** and **Last created** sort by `updatedAt` or `createdAt`, newest first, then `id`, among the matching issues.

### 3.5 Recents

Recents follow the user across devices, like Linear (D19): opening ENG-42 on the laptop puts it first in Recent on the desktop too. They are a synced, user-scoped model, `Recent` (§4.5), written only through operations (CLAUDE.md rule 1) and only by the repo (rule 2).

1. **What is shown:** **recent items** (`Mod+K` with an empty query, `O` `I`, the Search page with an empty query): the last 10 issues and profiles the user opened on any device, newest first; **recent commands** (`Mod+K`): the last 5 commands run from `Mod+K` on any device; **recent searches** (Search page): the last 5 queries that reached the server **on this device** (item 7, Q24).
2. **When something is recorded:** opening an issue page (`/issue/:identifier`, from anywhere) or a profile (`/profiles/:username`) dispatches `recent.record {target: {issue}}` or `{user}`; running a command from `Mod+K` dispatches `recent.record {target: {command}}` with the command's id. A target opened again moves to the top (the row's `openedAt` is updated, no new row). Archived and deleted issues' read-only pages are not recorded (Search finds archived ones). The client sends at most one `recent.record` per target per 10 seconds per tab, so `J`/`K` through issue pages and repeated commands don't flood the queue.
3. **Silent:** `recent.record` and `recent.remove` are optimistic, so the list updates at once and works offline (the mutations queue). A refusal (the issue became invisible before an offline record was sent) shows no toast: the client dispatches them with `reportRejection` answering false (sync-client `DispatchOptions`), and the overlay rolls back.
4. **What a row holds: ids only.** An issue id, a user id, or a command id, and when it was opened. Never a title, a name, a query or any other text (§4.5). A recent issue renders from the replica; one the replica doesn't hold renders from `issue.get` when online (at most 10 calls per opening of the menu or page, cached in memory for the tab) and is left out offline. A user renders from the replica (users are eager). A command renders only if a command with that id is registered and available now (`ui.available`); otherwise it is left out (the role changed, the entity it names is gone or invisible).
5. **Targets the user can no longer open** (§5.3 item 10): a recent issue that answers `NOT_FOUND`, or is archived or deleted, is hidden and removed with `recent.remove` (silent). An issue of a team the user left leaves the replica and answers `NOT_FOUND` on `issue.get`, so it is hidden and removed the same way. Purging an issue deletes every user's recents of it on the server (§4.5). So nothing about an issue the user can no longer see survives in recents, and no row ever reaches anyone but its owner.
6. **Sign-out:** explicit sign-out deletes the local replica (SPEC-012 §3.12, Q3), recents included, so nothing stays on a shared device. The rows stay on the server, like drafts, and return with the next sign-in's bootstrap. The device's recent searches (item 7) are cleared too.
7. **Recent searches stay on the device** (Q24): the query text is user content that SPEC-023 never logs (§5.3 item 9) and, by this default, never stores on the server either. They are kept in `localStorage` per user and device (`surface.recentSearches.<userId>`, the last 5 queries that reached the server), cleared on explicit sign-out.
8. **Caps:** at most **50** recent items (issues and users together) and **20** recent commands per user are stored; recording a new one past the cap deletes the oldest of that kind (by `openedAt`, then id), on the server and in the optimistic update, as drafts do (SPEC-012 D27). More are stored than shown, so items hidden by item 5 leave room.

### 3.6 Archived, deleted, held and offline

| Case | Local results (`Mod+K`, Search page step 1) | Server results (Search page step 2) |
|---|---|---|
| Live issue of a subscribed team, or the user's own | ✓ identifier, title | ✓ identifier, title, description, comments |
| Live issue of a public team not subscribed | — | ✓ |
| Archived issue (any visible team) | — (never in the replica, SPEC-011 §5.7) | ✓ while Include archived is on (the default, D6), ranked last, **Archived** badge (FR-ISS-10) |
| Deleted issue (Recently deleted) | — | — (Q8): found only on the team's Recently deleted tab |
| Private team's issue, user not a member | — (never in the replica) | — (never: §5.3) |
| Deleted comment | — | — (its search text is deleted, SPEC-013 §4.1) |

**Offline** (NFR-06): `Mod+K` works fully (it is local). The Search page shows the local results under a banner: "You're offline. Showing issues on this device. Descriptions, comments and other issues are searched when you're back online." When the connection returns, the server query runs for the current query. A server error (not offline) keeps the local results and shows inline "Search couldn't reach the server. Showing issues on this device." with **Try again**.

### 3.7 Members directory and profiles (FR-MEM-04)

1. **`/members`** ("Members"; `Mod+K` "Go to members"; Q12): every active user of the workspace, sorted by name, with avatar, name, `@displayName`, email (SPEC-001 Q2: visible to all), an **Admin** badge, and the **teams** each belongs to as chips. A search field at the top filters the list locally (name, display name, email). `J`/`K` move, `Enter` opens the profile. Rendered from the replica, so it is instant and works offline. Admin actions (invite, roles, reset links) stay in Settings → Members (SPEC-001); an Admin sees a **Manage members** link to it.
2. **Teams on a row and a profile** are the TeamMembership rows in the replica: public teams, and private teams the viewer is a member of. A private team the viewer isn't in is never shown, because its memberships never reach the viewer (permissions §2). Deactivated users (M7) appear under a "Deactivated" heading with a badge, as Linear keeps suspended users' profiles viewable.
3. **`/profiles/:username`** (Linear's `/profiles/<username>`, D7; the segment is the user's unique handle, `User.displayName`, the @mention handle, and never the full name): a header with avatar, name, `@displayName`, email, Admin badge, team links and the favorite star (a user favorite, SPEC-021 §3.7, D16 there), then two tabs: **Assigned** (`/profiles/:username`) and **Created** (`/profiles/:username/created`; a Projects tab joins in M3), with the same meaning as My issues (SPEC-012 §3.9 item 2): Assigned = not archived, deleted, completed or canceled; Created = not archived or deleted. Grouped by status name like My issues, with the same IssueRow, keys and focus model. Each tab shows its count.
4. **Where the issues come from:**
   - **The viewer's own profile** renders from the replica, exactly like My issues (which holds all of them, SPEC-011 §5.7).
   - **Another member's profile** is a **server-backed list**: `issue.list` with the filter `assignee = X` and the open categories (Assigned), or `creator = X` (Created), ordered by `updatedAt` desc, in pages of 100, up to 500 (then "Showing 500 of N issues." with N from `issue.count`). Rows the replica holds render from it and stay live; the others render from the server's `IssueSummary`. The list asks again on window focus and, throttled to 1 s, on packets of the subscribed teams (SPEC-015 D24's rule). Offline it shows the replica's matching rows with the note "You're offline. Showing only issues on this device."
5. Reaching a profile: People results in `Mod+K` (`u `, `O` `U`), the directory, and the person's name where it is text, not a control: "Created by Ada" on the issue page and a comment's author name. Assignee pills keep opening the picker.
6. **Unknown username** (or a user renamed since the link was made): "No member is named @bob." with **Go to members**.

### 3.8 My issues: Subscribed (FR-NAV-10)

Assigned and Created shipped in M1 (SPEC-012 D5). **Subscribed** lists issues the user is subscribed to, and subscriptions (auto-subscribe on create, assign and mention; `Shift+S`) arrive with the inbox in M4 (METHODOLOGY §3). M2 keeps the tab **hidden**; it appears with M4's subscription spec, which owns its content. M2 does not approximate it (for example with "assigned or created or commented"): Linear's tab is the subscription set, and a stand-in would change meaning in M4 (Q11). PRD FR-NAV-10's milestone becomes "M1, M4" (§12).

### 3.9 Pre-filled create URL (FR-ISS-13)

Copied from Linear's "Create a new issue URL" (linear.app/docs/creating-issues).

1. **Routes:** `/new?…` and `/team/:key/new?…`. Opening one (signed in) shows the underlying page (the home view for `/new`; the team's issue list for `/team/:key/new`) with the **composer open over it as a modal**, prefilled, as Linear's does over the current page (D8). The address is then replaced with the underlying page's (`history.replaceState`), so a reload or the back button doesn't reopen the composer. Nothing is created until the user presses **Create issue**: the URL only opens UI, so it is not a write (rule 1) and needs no CSRF token.
2. **Signed out:** the login page with `next` set to the whole address (SPEC-005 §3 guard); after sign-in the composer opens.
3. **Parameters** (Linear's names, confirmed in its web app on 2026-11-25 for title, description, priority and status by name, `assignee=me` and comma-separated labels; `estimate` wasn't observed there; values URL-encoded, `+` for a space; names case-sensitive, values case-insensitive where they are names):

| Parameter | Accepts | Notes |
|---|---|---|
| `team` | team key (`ENG`) or id | `/team/:key/new` sets it from the path; a `team` parameter then is ignored |
| `title` | text | cut to the title limit (SPEC-011) |
| `description` | Markdown | converted with the editor's Markdown parser (`@surface/editor/schema`, SPEC-013), as the API does |
| `status` | status name or id in the team | |
| `priority` | `urgent`, `high`, `medium`, `low` (and `none`) | Linear documents names only |
| `assignee` | `me`, display name, name, or id | an assignee who can't see a private team is dropped (SPEC-012 §3.1 item 4) |
| `estimate` | a number on the team's scale | t-shirt scales by point value, as Linear (SPEC-010 scale) |
| `labels` (or `label`) | comma-separated label names | team labels of the chosen team, then workspace labels |

   `cycle`, `project`, `projectMilestone` (M3), `template` (M4) and `links` (Q14) are read once their features exist; until then they are ignored with the note below.
4. **Values that don't resolve** are dropped and named under the header, like a team change (SPEC-012 §3.1 item 4): "Not applied from the link: assignee "bob", label "flaky"." A team that is unknown or invisible gives the same note ("team "SEC"") and the composer uses the default team (SPEC-012 §3.1 item 2): a private team the user isn't in reads exactly like an unknown key (§5.3). Resolution uses only the replica, so it works offline and never asks the server.
5. **Drafts:** the link's values win over the team's saved draft; the draft is untouched, and **Save** asks before replacing it (SPEC-012 D25).
6. **"Copy pre-filled create issue URL"** (`Mod+K`, context: one issue; Linear's command; Q15) copies `<origin>/team/ENG/new?title=…&description=…&status=…&priority=…&assignee=…&estimate=…&labels=…` from the focused or open issue. When the URL would exceed 8,000 characters, the description is left out and the toast says "Copied without the description: it's too long for a link." Toast otherwise: "Copied create issue URL".

### 3.10 Preferences (FR-AUTH-10)

Theme, font size and home view shipped in M0 (SPEC-005 §6, PLAN-005 S7). Linear's "Default home view" offers **fixed pages only** (Inbox, My issues, All issues, Active issues, Current cycle, Projects, …) and **no team or custom views** (checked in its web app on 2026-11-25; D9). M2 copies that:

- **Home view** choices are the fixed pages that exist in M2: **My issues** (default), **All issues** and **Active issues**. Inbox (M4), Current cycle and Projects (M3) and the others join with their milestones. Custom views and a team's saved views are not home choices; neither is Backlog.
- **All issues** and **Active issues** open the home team's page: the team chosen in the preferences' home team while the user can see it, else the first team they belong to (SPEC-012's team rule), else My issues. They are the `/team/:key/all` and `/team/:key/active` pages of SPEC-021.
- Stored in the same `UserPreferences.values`: a new `home` value, `'my-issues' | 'all-issues' | 'active-issues'`. The M0 `homeTeamId` stays and names the team those two pages use; a `homeTeamId` with no `home` is read as `all-issues` until the user saves; `user.updatePreferences` accepts `home` and keeps accepting `homeTeam` (Q16, D9).
- A home page whose team the user can no longer see (a private team they left) falls back to My issues, silently, as today (SPEC-005 §3): no message names it.
- Nothing else changes in M2. Linear's other preferences (display full names, first day of week, emoticons, comment submit key) are not in FR-AUTH-10.

### 3.11 Shortcuts

| Keys | Scope | Action | Typing | Note |
|---|---|---|---|---|
| `Mod+/` | command menu | Advanced search: open the Search page with the menu's query | yes | Linear's key (D5). It applies only while the command menu is open; elsewhere `?` and `Mod+/` stay keyboard-shortcut help (shortcuts §3.1) |
| `/` | global | Open the Search page (§3.2) | no | Was reserved (`/` search, M2). Matched on `event.key`, like `?`. In the editor `/` keeps opening the slash menu (editor scope, while typing) |
| `O` `I` | global | Open issue: `Mod+K` in issue mode (`i `), with recent issues first | no | Linear's quick issue search (title and ID only). Was reserved |
| `O` `U` | global | Open user: `Mod+K` in people mode (`u `) | no | Was reserved |
| `↓` | search-query | From the query field, focus the first result | yes | |
| `J`/`K`, `↑`/`↓`, `Enter` | list | Move and open, as every list (SPEC-012 §3.6) | no | The results list sets the `list` scope |
| `Esc` | global (`ui:escape`) | Search page: clear the query, then go back (§3.2 item 11) | yes | One step added to the chain |
| `F` | list | Filter menu (SPEC-021) | no | SPEC-021's key; listed for completeness |

New scope `search-query` (component): the Search page's query field has focus. `O` `T` (open team) stays as in M0. The conflict test (SPEC-005 AC-7) runs over the updated map.

## 4. Domain & client changes

One new user-scoped synced model, `Recent` (§4.5, D19), with two mutations; no change to any existing synced table's columns. New also: server-only columns and indexes (§4.2), one read operation (§6), pure functions (§4.3), a Web Worker (§4.1), a preference value (§3.10).

### 4.1 The client search index (`apps/web`, a Web Worker)

- **What it holds:** for each Issue in the replica: `id`, `identifier`, `title`, `teamId`, the status category, `updatedAt`. For each User: `id`, `name`, `displayName`, `email`, active. For each visible Team: `id`, `key`, `name`. Labels only if Q18 keeps them. Nothing from content (descriptions, comments are never in the replica's eager rows).
- **Built** in a dedicated worker from the replica once it is ready, then **kept in step** with it: the store posts batched changes (adds, updates, removals) after each applied packet, each partial bootstrap and each removal (unsubscribe ack, team purge, archive, delete). A row that leaves the replica leaves the index in the same batch, so a team the user leaves stops matching at once (AC-10).
- **Never persisted**: it is rebuilt from the replica on each start. It is memory only, owned by the tab.
- **Library:** an in-memory full-text index with prefix and edit-distance matching. Proposed: **MiniSearch** (Q2; ADR-0030). The command menu's own fuzzy matcher (`apps/web/src/command-menu/fuzzy.ts`) keeps ranking commands; the worker ranks entities.
- **Queries** go to the worker with an id; an answer for an older id is dropped. Results return ids and highlight ranges; the main thread renders rows from the replica.

### 4.2 Server search storage (migration, server-only)

- `issue_search_text` gains `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', description_text)) STORED` with a GIN index. `comment_search_text` gains the same over `text`. Both are server-only tables (db README), so the columns are allowed; generated columns mean no handler change, and the migration fills existing rows.
- `issues` gains an **expression** GIN index on `to_tsvector('english', title)`. An index adds no column, so the synced table still holds only its model's fields (db README). The existing trigram index `issues_title_trgm_idx` (`lower(title COLLATE "und-x-icu") gin_trgm_ops`, migration 0013) serves title typos.
- The text search configuration is `english` (stemming and stop words, matching Linear's described behaviour). No new extension: `pg_trgm` is already required (migration 0000). (Q3, Q20.)
- No writes to synced tables: rule 2 is untouched.

### 4.3 Pure functions (`packages/domain`, unit and property tested)

- `parseSearchQuery(text)` → `{identifier?, words[], phrases[], prefix?}`: never throws; trims; quotes may be unbalanced (an unclosed quote runs to the end); at most 200 characters. The server builds its `tsquery` from this result (a prefix word as `word:*`), never by passing user text to `to_tsquery`.
- `parseIdentifierQuery(text)`: `ENG-123`, `eng-123`, `eng123` → `{key, number}` (the key is 2–5 letters, SPEC-001).
- `searchBucket(issue)` and `compareSearchHits(a, b)` (§3.4): a total order.
- `parsePrefillParams(search, store)` (§3.9) → the composer's initial values plus the list of dropped parameters; resolves only against the given store.
- `prefillUrl(issue, store)` (§3.9 item 6).

### 4.4 Shared pieces

- **Server-backed issue list** (§3.7 item 4; also the Search page's rows not held): rows the replica holds render from it; others from a server answer; refresh on focus and on subscribed-team packets (throttled 1 s); offline shows the replica's matching rows with a note. SPEC-015's archive page already does the server half; SPEC-021's views of a team the client doesn't hold may need the same. The plan builds it once (§12 coordination note).
- **SearchResultRow** (`packages/ui`): IssueRow plus an optional snippet line and highlight ranges. **MemberRow** and **ProfileHeader** (`packages/ui`).

### 4.5 `Recent` (user-scoped, synced; D19)

| Field | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | client-generated on the first record of a target; kept when the target is recorded again |
| `userId` | User | the owner, server-set from the actor |
| `target` | `issue` \| `user` \| `command` | M3+ may add `project`, M4 `document`, with their specs |
| `issueId` | Issue? | for `issue`; resolved as `IssueRef` when recorded |
| `targetUserId` | User? | for `user` (the profile opened; `userId` is the owner); resolved as `UserRef` with `allowInactive` |
| `commandId` | string? | for `command`: the command menu's id of the command run (1–200 characters, `^[a-z][a-z0-9-]*(:[A-Za-z0-9.-]+)*$`, as `nav:team-issues:<uuid>` or `op:issue.create`); stored as given, not resolved (item below) |
| `openedAt` | timestamp | server-set (`ctx.now`) at every record; the optimistic update uses the device clock until the delta arrives |

- **Unique** per user and target (partial unique indexes per `target`, like `drafts`). `recent.record` of a target the user already has updates that row's `openedAt` instead of inserting.
- **Caps:** 50 rows of `issue` and `user` together, 20 of `command`, per user. Recording past a cap deletes the oldest row of that kind (by `openedAt`, then `id`) in the same transaction, through the repo (`D` to the owner only); the optimistic update does the same (§3.5 item 8).
- **Sync group:** `user:<userId>` only. **Eager** (sync-protocol §2's user-scoped list). It joins the `schemaHash`, so clients re-bootstrap once on upgrade (no protocol version bump).
- **Ids only** (§3.5 item 4): no title, name, query or snippet is ever stored. An issue id and a user id are resolved when recorded, so a user can only record what they can see. A `commandId` may embed an entity id (`nav:team-issues:<teamId>`); it is the user's own row, holding an id they had just used, so it reveals nothing new to them, and the client shows it only while that command is available (§3.5 item 4). The server never reads or resolves it.
- **No foreign keys.** Purging an issue deletes its Recent rows through the repo in the purge's transaction, each `D` only to its owner (permissions §6, §12). Users are never purged; commands aren't rows.
- **Not removed when a user leaves a private team**: the client hides those recents and removes them with `recent.remove` once `issue.get` answers `NOT_FOUND` (§3.5 item 5). The row held only an id the user had seen.
- **Written only** by `recent.record` and `recent.remove` (§6) through the repo, which logs `sync_log` rows in the same transaction (CLAUDE.md rules 1 and 2).

## 5. Sync & permissions

### 5.1 Models and groups

| Model | Load | Groups |
|---|---|---|
| Recent (new, §4.5) | eager | `user:<userId>` only |

No new sync group and no codec change: `Recent` is one more user-scoped model, like Draft and Favorite, and changes the `schemaHash` (a re-bootstrap on upgrade). The client index (§4.1) holds a copy of what the replica holds and nothing more. Recents hold ids (§3.5 item 4). Server-only search columns never travel (they are not model fields).

### 5.2 Operations and who may call them

`issue.search` is a **query** (read-only transaction, SPEC-003 §3.1). Any active user may call it; it returns only issues the actor can see. An API key needs the `read` scope; its `teamIds` narrow the results in SQL. Sessions are exempt from the query rate limit (SPEC-003 §9); API keys use the query bucket (600/min).

`recent.record` and `recent.remove` act on the actor's own rows only (permissions §3.4, "Personal data" 👤). `recent.record`'s target must be visible to the actor, after an API key's `teamIds` narrowing: an invisible issue is `NOT_FOUND`, identical to an unknown one. `recent.remove` takes a `RecentRef`, which resolves only the actor's own rows. An API key needs `read_write`, and `allowDestructive` for `recent.remove` (a `remove` verb, registry lint rule 5).

### 5.3 Leak rules (rule 4)

Search reads private text, so it follows these rules, which extend permissions §4's "Search (server-side)" row:

1. **Visibility in SQL, before matching is ranked, limited or counted:** `issues.sync_groups && visibleGroups(actor)` (SPEC-011 §5.6, never the socket's groups), `deleted_at IS NULL`, `archived_at IS NULL` unless `includeArchived`, and the key's `teamIds`. A comment matches only through its issue's visibility.
2. **Results, counts and pages** come from visible rows only. `totalCount` counts visible matches (capped at 500).
3. **Ranking uses only the row's own properties** (§3.4): no corpus statistics (no IDF, no BM25 over the table, no "popularity" across users). So adding or removing a private team's issues never changes the visible results or their order (AC-15, a property test).
4. **Snippets** are cut from the matched row's own text (the visible issue's description or a comment on it) and sent as plain text with highlight ranges, never HTML.
5. **No suggestions** ("did you mean", autocomplete of words) drawn from stored text.
6. **Identifiers:** a query for a private team's identifier (`SEC-12`) by a non-member gives the same answer as an identifier that doesn't exist. Team keys being taken stays SPEC-001 D2's accepted exception, and search adds nothing to it.
7. **Errors** never name a row: invalid input is about the input; a timeout is about the query.
8. **Timing:** the answer time can depend on how many invisible rows match before the visibility filter drops them. Surface accepts this residual channel, as it does for `issue.list` with a filter (Q9): it is coarse, needs many probing queries, and reveals a count at most, never text. The statement timeout (§6) bounds it.
9. **Logs:** the query text is never logged (it is user content and may hold anything). The log line has the operation, the query's length, the result count, the duration and the outcome.
10. **Client:** the index, recents, the Search page's rows not held and profile lists drop a team's rows when the replica purges the team (leaving a private team, an unsubscribe), in the same batch (AC-10). A recent whose issue the replica no longer holds is shown only after `issue.get` answers it (§3.5 item 4), so a private team's issue the user left never shows again.
11. **Pre-filled URLs and profiles** resolve only against the replica, which never holds a private team's rows for a non-member, so an invisible team, its labels, statuses and memberships read like unknown ones (§3.7 item 2, §3.9 item 4).
12. **Recents** (§4.5): a `Recent` row reaches only its owner (bootstrap, catch-up, deltas; it is in `user:<id>` only). `recent.record` of a private team's issue by a non-member, of an unknown issue, and of another team's issue through a key narrowed by `teamIds` are `NOT_FOUND`, identical, and write nothing. A `RecentRef` to another user's row is `NOT_FOUND`, identical to an unknown id. Purging an issue deletes every user's recents of it, each `D` only to its owner. A row holds ids only, never query text, titles or names, so nothing about a target is stored beyond what the owner opened.

### 5.4 Offline

Local search, the members directory, the user's own profile and recents work offline from the replica. The Search page's server step, another member's full profile lists and recent issues not held need the network (§3.6, §3.7). `recent.record` and `recent.remove` are the only writes in this spec: optimistic, so they queue offline and are sent in order when the connection returns (sync-protocol §5.3).

## 6. API

**Three new operations:** the query `issue.search` and the recents mutations `recent.record` and `recent.remove` (D19). It also uses `issue.get`, `issue.list`, `issue.count` (SPEC-011), `user.updatePreferences` (SPEC-005, gaining `home`) and the composer's `issue.create`.

| Operation | Kind | Input → output, notes | Optimistic |
|---|---|---|---|
| `issue.search` | q | `{query: string (2–200 characters after trimming), filter?: Filter (the Issue model, as issue.list), team?: TeamRef, includeArchived?: boolean (default false), orderBy?: 'relevance' \| 'updatedAt' \| 'createdAt' (default relevance), limit?: 1–50 (default 25), cursor?: string, withTotal?: boolean}` → `{nodes: SearchHit[], pageInfo, totalCount?, totalCountCapped?}`. | — |
| `recent.record` | m | `{id?: uuid (a create's own id, for a new row), target: {issue: IssueRef} \| {user: UserRef} \| {command: string}}` → `{recent: {id}}`. Upserts the actor's row for the target with `openedAt = now`; evicts past the caps (§4.5). The user ref allows deactivated users. A `command` must match §4.5's pattern, else `INVALID_INPUT`. `ui`: none (the shell dispatches it). | yes |
| `recent.remove` | m | `{recent: RecentRef}` → `{}`. Deletes the actor's row. `destructive` (registry lint rule 5). `ui`: none. | yes |

- **New reference type** `RecentRef` (uuid only; the actor's own row, else `NOT_FOUND`), like SPEC-021's `FavoriteRef`. The `recent` domain is new in SPEC-003 §3.1 (domain-model §7, "personal"). Both mutations have a summary, keywords (recent, history, recently opened), examples against the seed fixture and a permission; `pnpm registry:lint` passes.
- `recent.record`'s `optimistic` upserts the row with the device clock as `openedAt`, moves it first and applies the same eviction, so rebuilding it twice gives the same rows (AC-29).

- `SearchHit` = `{issue: IssueSummary, matchedIn: 'identifier' | 'title' | 'description' | 'comment', snippet: {text, highlights: [[start, end], …]} | null, comment: {id, author: {id, name}} | null, titleHighlights: [[start, end], …]}`. A hit is one per issue: when several fields match, `matchedIn` is the best tier (§3.4) and the snippet comes from it; for comments, the best-scoring comment.
- **Paging:** keyset over the sort tuple (SPEC-003 §7.1's cursor rules: opaque, tied to the query, the filter and the order; a cursor from another query is `INVALID_INPUT`). At most 500 hits in total: after 500, `hasNextPage` is false. `totalCount` (with `withTotal`) is at most 500, with `totalCountCapped: true` when more match.
- It is not a `list*` operation, so registry lint rule 6 doesn't apply, but it keeps the connection shape. `ui`: none (the search UI calls it; no command). Keywords: search, find, full text, query, text. Examples run on the seed fixture. `destructive`: no.
- **Errors:** `INVALID_INPUT` "Type at least 2 characters to search." / "Search text can be at most 200 characters." / a filter or cursor error as `issue.list`. A query that runs past the statement timeout (**3 s**, `SET LOCAL statement_timeout` in its read-only transaction) is `INTERNAL` with the message "Search took too long. Try more specific words or add a filter." (Q19). Visibility errors don't exist: invisible rows are simply absent.
- The web client calls it over `POST /api/ops/issue.search` (SPEC-003 §9), like its other reads.

## 7. UI

### 7.1 Screens

| Screen | Route | Components |
|---|---|---|
| Search page | `/search?q=&includeArchived=` | PageHeader (title "Search", tabs, display options, count), query Input, SPEC-021 filter bar, VirtualList of SearchResultRow, recents (empty query), Banner (offline), EmptyState |
| Command menu sections | overlay | existing CommandMenu; Issues, People, Teams, Recent sections; mode chip |
| Members | `/members` | PageHeader, search Input, VirtualList of MemberRow, EmptyState |
| Profile | `/profiles/:username`, `/profiles/:username/created` | ProfileHeader, Tabs, the My issues list (GroupHeader, IssueRow) |
| Pre-filled create | `/new`, `/team/:key/new` | the underlying page plus the composer (SPEC-012) with the "Not applied from the link" note |
| Preferences | `/settings/account/preferences` | the Home view select offers My issues, All issues and Active issues (§3.10) |
| Sidebar | shell | the Search button opens the Search page (SPEC-005 §7 said it opens the command menu) |

### 7.2 States

| State | Shown |
|---|---|
| Search: empty query | Recent searches and recent issues; with none, "Search issues by ID, title, description or comment." |
| Search: local results only (typing, under 2 characters, waiting for the server) | Local rows; no count; no spinner (design-system §4: no spinner for local data) |
| Search: server answered | Server rows, count |
| Search: offline | Local rows and the offline banner (§3.6) |
| Search: server error or timeout | Local rows and the inline message with **Try again** (§3.6, §6) |
| Search: no results | §3.2 item 12 |
| Search: 500 cap | §3.2 item 8 footer |
| `Mod+K`: index building | "Indexing issues…" row (§3.1 item 8) |
| Profile of another member: loading | Replica rows first, then the full list; skeleton after 150 ms only when the replica has none |
| Profile: offline | Replica rows with the offline note (§3.7 item 4) |
| Profile: unknown name | §3.7 item 6 |
| Members: no match for the filter | "No members match "…"." |
| Pre-filled link: values dropped | The note under the composer header (§3.9 item 4) |

### 7.3 Small screens (NFR-20)

Below 768 px the Search page is one column: the query field, the filter chips on a scrolling row, then compact SearchResultRows (identifier, title, status, snippet line). The Members page shows avatar, name and team chips; the profile header stacks. The composer opened by a pre-filled link is full screen (SPEC-012 §7.3).

### 7.4 Accessibility (NFR-19)

- The query field is a `combobox` controlling the results `listbox` only in `Mod+K`. On the Search page the field is a `searchbox`, and the results are SPEC-012's list (`treegrid` with `aria-rowcount`). A polite live region announces "23 results" when the server answers, "No results", and "Showing issues on this device" when offline. It doesn't announce on every local update.
- Highlights are `<mark>` elements, so they are not colour alone; the snippet line names where it matched ("Comment by Ada").
- Members and profile lists use the same `treegrid` pattern; the profile tabs are `tablist`.
- Every new component has stories in light and dark that pass axe.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | An issue is both in the local results and the server's | One row: the server list replaces the local one (§3.2 item 3), and the row renders from the replica. |
| E2 | The server answers after the user typed more | The answer is for an aborted request and is dropped; only the newest query's answer applies. |
| E3 | A result's issue is changed by someone while the page is open | A held row updates live; a row not held keeps the server's values until the next search or window focus (the page asks again on focus). |
| E4 | A result's issue is deleted or archived while the page is open | A held row leaves the replica; the row stays in the results with its last values and the **Deleted** or **Archived** badge, read-only; opening it shows SPEC-012 §3.4 item 8's page. |
| E5 | The user leaves a private team, or an on-demand team is dropped, while results show its issues | The team's rows leave the index, the replica and the results list in the same batch (§5.3 item 10). Server-answer rows of a private team the user left are removed by `teamId`. |
| E6 | The query is only stop words ("the of") | No word terms remain; a title can still match by trigram; otherwise "No results". |
| E7 | `"login` (unclosed quote) | The phrase runs to the end of the query (§4.3). |
| E8 | `eng-87` where ENG-87 is in a private team the user isn't in | No result, and **Open ENG-87** opens the not-found page, exactly as for an identifier that doesn't exist (SPEC-012 AC-15). |
| E9 | `abc123` where ABC is no team key | Treated as an ordinary word. |
| E10 | A word appears only in a deleted comment | No match: the comment's search text was deleted (SPEC-013). |
| E11 | A match only in a comment on an archived issue | Found while Include archived is on (the default), ranked in the archived bucket, opens the read-only page at the comment. |
| E12 | A very common word matches thousands of issues | The first 500 by the chosen order; the cap footer (§3.2 item 8). |
| E13 | The server takes longer than 3 s | `INTERNAL` with the timeout message; local results stay (§3.6). |
| E14 | `/` while focus is in a text field or the editor | Types "/" (or opens the editor's slash menu at a line start). |
| E15 | The Search page is opened offline, then the connection returns | The server step runs for the current query; the banner goes away. |
| E16 | A search before the client index is built | `Mod+K`: "Indexing issues…" (§3.1 item 8). Search page: the server step still runs online. |
| E17 | A recent issue was deleted, archived or became invisible | Not held → `issue.get`: deleted, archived or `NOT_FOUND` hides it and removes it with `recent.remove`, silently (archived and deleted issues are not "recent items" to reopen from here; Search finds archived ones). |
| E18 | Snippet text contains `<script>` or Markdown | Rendered as text; highlights are ranges, never HTML (§5.3 item 4). |
| E19 | An API key limited to team A searches | Only team A's issues, even public team B's (§5.2). |
| E20 | A pre-filled link names a team the user can't see | Same note as an unknown key; the default team is used (§3.9 item 4). |
| E21 | A pre-filled link sets an assignee who isn't a member of the chosen private team | Dropped with the note (SPEC-012 §3.1 item 4). |
| E22 | A pre-filled link is opened twice in a row, or reloaded | The address was replaced after the first open, so a reload shows only the underlying page. |
| E23 | A pre-filled link's description is invalid Markdown or holds an external image | The editor's Markdown conversion handles it as the API does (an external image becomes a link, SPEC-012 D9, SPEC-013). |
| E24 | A pre-filled link carries `cycle=` or `template=` in M2 | Ignored, named in the note. |
| E25 | A profile link uses an old username | §3.7 item 6's not-found state. |
| E26 | The viewer and the member share a private team | The team shows on the profile; issues of that team appear in the profile lists (the viewer can see them). |
| E27 | The home view preference is All issues or Active issues and the home team is one the user left or can't see | My issues, silently (§3.10). |
| E28 | `i want to…` typed in `Mod+K` | Issue mode starts (Linear's rule); `Backspace` on the empty query removes the chip and the text "i " is not restored. |
| E29 | Two tabs search at once | Each has its own worker and requests; recents are shared through the replica, and recent searches through `localStorage` (last write wins). |
| E30 | A search for text in a non-subscribed public team's issue | Found by the server step; opening it subscribes the team on demand (SPEC-012 §3.4 item 11). |
| E31 | `Mod+/` while the command menu is closed | Opens keyboard-shortcut help, as before (§3.11). |
| E32 | The user opens ENG-42 on the laptop, then opens `Mod+K` on the desktop | ENG-42 is first under Recent on the desktop once the delta arrives (§3.5). |
| E33 | The user opens issues offline, then reconnects | The recents show at once on this device (optimistic); the queued `recent.record`s are sent in order; the server sets `openedAt` at commit, so the other devices' order follows commit order. |
| E34 | An offline `recent.record` of a private team's issue is sent after the user was removed from the team | Refused `NOT_FOUND`; no toast (§3.5 item 3); the overlay rolls back, so the row disappears. |
| E35 | The user leaves a private team whose issues are in their recents | The issues leave the replica; each is asked with `issue.get`, answers `NOT_FOUND`, is hidden and removed with `recent.remove`. Offline, they are left out until online. No other user ever receives the rows. |
| E36 | A recent issue is purged | The server deletes every user's Recent rows of it in the purge transaction; each `D` reaches only its owner. |
| E37 | A recent command is entity-bound ("Go to DES issues") and the user can no longer see DES | The command isn't registered or available, so it is left out (§3.5 item 4); the row stays in the user's own group until evicted by the cap. |
| E38 | The 51st recent item is recorded | The oldest issue or user recent is deleted in the same transaction (§4.5); the optimistic update does the same. |
| E39 | Explicit sign-out on a shared computer, then a different user signs in | The replica, recents included, was deleted with the sign-out, and the recent searches of the first user were cleared; the second user sees only their own recents (§3.5 item 6). |
| E40 | `J`/`K` through 30 issue pages in 10 seconds | Each issue is recorded at most once per 10 seconds per tab (§3.5 item 2), so at most one mutation per issue. |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)) and are marked ⏸. **Not held:** unit and property tests, the sync property suite (AC-29), and the private-team **leak tests** (AC-14 to AC-17, AC-28), which may use Postgres. AC-6 and AC-8 rely on Postgres behaviour beyond leaks; the user granted a testing-hold exception for them (D2), as SPEC-011 Q13 had for filter conformance.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `Mod+K` with a query shows a "Quick results for …" section (held issues by identifier and title, fuzzy by word, at most 8), People (at most 5) and Teams (at most 5) sections, ranked by §3.4, with highlights; `Enter` opens the issue, profile or team list; the identifier fast path still puts **Open ENG-87** first for an identifier not held; **Advanced search** is the last item from 2 characters, opens `/search?q=`, and is bound to `Mod+/` while the menu is open; with no match the menu says "No results found" with **Go to advanced search**; `Mod+K` makes no server request. | unit (sources with a fake worker, ranking) + story |
| AC-2 | Prefix modes `i `, `u `, `t ` limit the menu and show a chip; `Backspace` on an empty query removes it; with an empty query, Recent shows first (10 items, 5 commands). | unit |
| AC-3 | Search page: `/` (not while typing) and the sidebar button open it with focus in the query; local results render on every keystroke; the server is called once per 150 ms pause, from 2 characters, and older requests are aborted and their answers dropped; the server list replaces the local one and keeps focus on the same issue when present; the address follows the query and `includeArchived` without new history entries; the tabs are All and Issues; Include archived is on by default, is sent as `includeArchived`, and off removes archived hits; `Esc` clears, then goes back. | unit (page model with a fake dispatcher and fake timers) + e2e ⏸ |
| AC-4 | A result matched in the description or a comment shows the snippet line with its source ("Comment by Ada"); title and snippet highlights match the server's ranges; archived results show the badge; a comment match opens `/issue/ENG-42#comment-<id>`. | unit + story |
| AC-5 | `parseSearchQuery` and `parseIdentifierQuery` never throw on any string, handle quotes (balanced or not), the trailing prefix word, `ENG-123`/`eng-123`/`eng123`, and the 200-character limit. | unit + property |
| AC-6 | `issue.search` matches identifiers, title words (stemmed, prefix on the last word, and typos by trigram), description and comment words (stemmed) and quoted phrases; leaves out deleted issues and deleted comments; includes archived issues only with `includeArchived`; one hit per issue with the best tier; at most 500 hits; `totalCount` capped with `totalCountCapped`; keyset pages never repeat or skip; the cursor is bound to its query, filter and order; the 2- and 200-character limits answer `INVALID_INPUT` with §6's messages. | integration (`issue-search.int.test.ts`, D2's exception, not held) + unit (tsquery builder, cursor codec) |
| AC-7 | `compareSearchHits` is a total order and implements §3.4: exact identifier, then bucket (started/unstarted, backlog, completed, canceled, archived), then tier, then score, then `updatedAt` desc, then id. Last updated and Last created sort as §3.4 says. | unit + property |
| AC-8 | The server order follows the same rule as AC-7 for relevance, and its SQL uses only per-row features. | integration (`issue-search.int.test.ts`, D2's exception, not held) + unit (SQL builder snapshot: no aggregate over other rows) |
| AC-9 | The client index holds exactly the replica's issues, users and visible teams: an applied packet, a partial bootstrap, an archive, a delete, an unsubscribe ack and a private-team purge update it in the same batch; it is never written to IndexedDB. | unit (store → worker adapter with the fake hub; a property: index ids = replica ids after any sequence) |
| AC-10 | After leaving a private team (or an unsubscribe ack), no search surface shows the team's issues: `Mod+K`, the Search page (held and server-answer rows), recents and profile lists. | unit (fake hub, fake dispatcher) |
| AC-11 | Recents (§3.5): opening an issue page or a profile, and running a `Mod+K` command, dispatch `recent.record` (at most once per target per 10 s per tab; archived and deleted issue pages are not recorded); Recent shows the 10 newest items and 5 newest commands from the replica, whichever device recorded them; a not-held recent renders from `issue.get` online and is left out offline; `NOT_FOUND`, deleted and archived answers hide it and dispatch `recent.remove`; a command no longer available is left out; refusals show no toast; recent searches stay in `localStorage` per user and device; explicit sign-out deletes the replica and clears recent searches. | unit (shell recorder with fake timers and a fake dispatcher; recents source with the fake hub) |
| AC-12 | Offline: `Mod+K` works fully; the Search page shows local results and the banner, and runs the server step when the connection returns; a server error or timeout keeps local results with the inline message and **Try again**. | unit (fake connectivity, fake dispatcher) + e2e ⏸ |
| AC-13 | The Search page's filter bar and `@` quick filter add Filter-model conditions that apply to local and server results alike; the ordering menu switches between Most relevant, Last updated and Last created, remembered per device. | unit (local filter through the domain evaluator, request payload) |
| AC-14 | **Leak:** for a non-member, `issue.search` never returns, counts, pages or snippets a private team's issue or a comment on one, archived or not, for any query (title words, description words, comment words, its identifier); the answer to a query that matches only private rows is identical (apart from `correlationId`) to the answer to a query that matches nothing. A Member and an Admin outside the team get the same. | integration (leak test, not held): `search-leak.int.test.ts` |
| AC-15 | **Leak (property):** for random workspaces and queries, the visible results of `issue.search` (ids, order, `matchedIn`, snippets, highlights and `totalCount`) are the same with and without a private team's matching issues and comments present. | integration property (leak test, not held, `full: true`): `search-leak.int.test.ts` |
| AC-16 | **Leak:** an API key with `teamIds=[A]` gets only team A's issues from `issue.search`, never public team B's; `issue.search` on a deleted private issue's text answers like no match; `GET /api/ops` examples for `issue.search` name no private row. | integration (leak test, not held): `search-leak.int.test.ts` |
| AC-17 | **Leak (client):** profiles and the members directory show a private team and its memberships only to its members; a pre-filled link naming a private team, its status, label or member reads exactly like an unknown value for a non-member. | unit (replica fixtures with and without the private groups) |
| AC-18 | Members directory lists active users with name, display name, email, Admin badge and visible teams, filters locally, opens profiles with `Enter`, and shows **Manage members** to Admins only. | unit + story |
| AC-19 | Profile tabs: the viewer's own profile renders from the replica like My issues; another member's Assigned and Created come from `issue.list` (assignee or creator, the open categories for Assigned) in pages up to 500 with the count note, held rows render live, the list refreshes on focus and on subscribed-team packets (throttled 1 s), offline shows replica rows with the note; an unknown username shows §3.7 item 6. | unit (server-backed list with a fake dispatcher and fake hub) |
| AC-20 | Pre-filled URL: `/new` and `/team/:key/new` open the composer as a modal over the underlying page with every §3.9 parameter applied, replace the address, survive sign-in through `next`, never create an issue on their own, drop unresolvable values with the note, and leave the team's draft untouched. | unit (`parsePrefillParams`, route handler) + e2e ⏸ |
| AC-21 | "Copy pre-filled create issue URL" copies a URL that `parsePrefillParams` turns back into the same team, title, description, status, priority, assignee, estimate and labels; over 8,000 characters it leaves out the description and says so. | unit + property (round trip) |
| AC-22 | Home view: the Preferences select offers My issues, All issues and Active issues only (no team or custom views); `/` redirects to the chosen one (the home team's `/all` or `/active`); an old `homeTeamId` alone reads as All issues; an invisible home team falls back to My issues with no message. | unit |
| AC-23 | The Subscribed tab of My issues is not shown in M2. | unit |
| AC-24 | Shortcuts `/`, `Mod+/` (command menu only; elsewhere it stays help), `O` `I`, `O` `U`, the `search-query` scope and the `Esc` step are registered with commands, show in `?`, and pass the conflict and reserved-key tests; `/` doesn't fire while typing. | unit (registry, conflicts) |
| AC-25 | `issue.search` logs never contain the query text: the log line has the operation, query length, result count, duration and outcome. | unit (handler with a captured logger) |
| AC-26 | Every new `packages/ui` component (SearchResultRow, MemberRow, ProfileHeader) has stories in light and dark that pass axe; the live region announces §7.4's messages. | story (axe) |
| AC-27 | Performance: §10's budgets hold at the reference scale. | perf ⏸ (checked by hand; the server budget read from its duration metric) |
| AC-28 | **Leak (recents):** a `Recent` row reaches only its owner (bootstrap, catch-up, deltas, including the cap eviction's `D`); `recent.record` of a private team's issue by a non-member (Member and Admin), of an unknown issue, and of another team's issue through a key with `teamIds=[A]` answer `NOT_FOUND` identically and write nothing; `recent.remove` with another user's `RecentRef` answers like an unknown id; purging an issue deletes every user's recents of it, each `D` only to its owner; no `Recent` row ever holds text (title, name, query). | leak test (not held, Postgres allowed): `recent-leak.int.test.ts` |
| AC-29 | `Recent` syncs in `user:<id>` only, joins the `schemaHash`, and `recent.record`'s and `recent.remove`'s `optimistic` predict the rows the server commits: the upsert of `openedAt`, the move to first and the eviction past 50 items or 20 commands (rebuilding twice gives the same rows). | unit (handlers with a fake repo; caps) + **sync property suite** (recents join the generator; not held) |
| AC-30 | `recent.record` validates its target: `IssueRef` and `UserRef` (deactivated users allowed) resolve, a `command` outside §4.5's pattern is `INVALID_INPUT`; `recent.remove` is `destructive`; both pass `pnpm registry:lint`. | unit (operation definitions, registry lint) |

## 10. Metrics & performance

- **Local search** (NFR-05): `Mod+K` and the Search page's local step answer in **< 50 ms** after a keystroke, p95, with **40,000 issues** in the replica (the SPEC-011 §10 worst case), on the reference laptop; the worker's query itself **< 10 ms**. The command list keeps its own budget (< 16 ms for ~300 commands, command-menu §5).
- **Index build:** **< 1 s** for 40,000 issues and 50 users, off the main thread; the main thread posts rows in chunks of at most 4 ms each. Incremental updates **< 1 ms per row**. Index memory **≤ 15 MB** at 40,000 issues, measured separately from the 35 MB replica budget.
- **Server search** (NFR-05): `issue.search` first page **p95 < 300 ms** on a LAN at the reference scale (100,000 issues, 500,000 comments and history entries, NFR-10), for one- to three-word queries, with the 3 s statement timeout as the hard stop. The executor's per-operation duration (SPEC-003 step 14) is the metric.
- **Migration:** filling the generated `tsvector` columns at the reference scale takes **< 2 minutes** on the minimum VM (NFR-12) and needs no manual step (NFR-23).
- **Requests:** at most one `issue.search` per 150 ms of typing per tab, aborted when superseded.
- **Profile lists:** first page **p95 < 200 ms** on a LAN (it is `issue.list`).
- **Logs:** `issue.search` logs as every operation does (SPEC-003 step 14) plus the query length and result count, never the text (§5.3 item 9). No new log events otherwise.
- **Recents:** at most one `recent.record` per target per 10 s per tab; each is one small row (about 150 bytes) and one `U` to the user's own devices. At most 70 Recent rows per user in the replica (50 items, 20 commands). Recent shows from the replica in the same frame as `Mod+K` opens (no request), except recent issues not held, which render after their `issue.get` (online only).

## 11. Open questions

Each has a proposed default, so they can be accepted in bulk. Q1–Q3 are the decisions for ADR-0030 (§12).

| # | Question | Options | Proposed default |
|---|---|---|---|
| Q1 | **Decided, see D10.** **How does search work over a partial replica?** (ADR-0030) | (a) **Local only**, over held issues: instant and offline, but misses other teams, archived issues, descriptions and comments, so it fails FR-NAV-04 and FR-ISS-10. (b) **Server only**: complete, but nothing is instant and nothing works offline, against NFR-05 and Linear. (c) **Hybrid**: a local index over held issues, people and teams for instant results and offline; a server read operation over everything visible for full text and completeness; the server's list replaces the local one when it arrives. (d) Load more into the replica (all titles of all visible issues as a slim eager model): instant title search over everything, but reverses ADR-0020's budget for every client and still needs the server for full text. | **(c)**, as ADR-0008 sketched and as Linear behaves (title/ID instant, full text from the server). PRD FR-NAV-04's "run on the local replica" is reworded (§12). |
| Q2 | **Decided, see D11.** **Client index library** (ADR-0030) | (a) **In-house**: a token prefix index plus the existing subsequence matcher; no dependency, but typo tolerance and scoring are ours to build and test. (b) **MiniSearch** (MIT, no dependencies, ~7 kB gzip, prefix and edit-distance search, field boosts, incremental add/remove); the same library ADR-0008 already chose for MCP `search_operations`, so one search library in the repo. (c) **FlexSearch** (Apache-2.0; ADR-0008's choice for the client): faster on very large corpora, but typo tolerance is weaker and its incremental update API is less direct. | **(b) MiniSearch**, in a Web Worker. 40,000 short titles are well within its range; it makes no network call (rule 5). Justification goes in the change summary. |
| Q3 | **Decided, see D12.** **Server engine and text configuration** (ADR-0030) | (a) **Postgres FTS (`english`) for title, description and comments + `pg_trgm` for title typos**, generated `tsvector` columns on the server-only tables. (b) `pg_trgm` only: typo-tolerant everywhere but no stemming or stop words, and trigram indexes over 500,000 comments are large and slow for common words. (c) FTS with the `simple` configuration: language-neutral, but no stemming (Linear's "similar terms"). (d) An external engine: a second service, against "one image + Postgres". | **(a)**. It needs no new extension, matches Linear's described behaviour (stems, stop words, quoted phrases), and keeps typo tolerance where people type most (titles). |
| Q4 | **Decided, see D4.** What does `/` open? | (a) **The Search page** (`/search`): Linear's docs describe search with filters, display options (sort by relevance, last updated, last created) and a 500-result cap, which fits a page. (b) The command menu in search mode (shortcuts.md's current line). | **(a)**, confirmed in Linear's web app on 2026-11-25. |
| Q5 | **Decided, see D5.** Does `Mod+K` show server full-text results? | (a) **No**: `Mod+K` is local and instant; "Search for "…"" hands over to the Search page. (b) Yes, in their own section, arriving asynchronously (command-menu §2's current design). | **(a)**, with Linear's wording: a "Quick results for …" section and an **Advanced search** action (`Mod+/`). Whether quick results are local or from the server stays with Q1–Q3. command-menu.md changes (§12). |
| Q6 | **Decided, see D13.** Ranking | (a) **Linear's**: state bucket first (started/unstarted, backlog, completed, canceled, archived), then match quality. (b) Match quality first, state as a tie-break. | **(a)**, as Linear documents. |
| Q7 | **Decided, see D6.** Archived issues | Included by the UI always, ranked last with a badge; the API keeps SPEC-003's `includeArchived: false` default. Alternative: a display option to hide them. | The Search page has an **Include archived** display toggle, on by default and in the address; the API default stays false. |
| Q8 | **Decided, see D14.** Deleted issues (Recently deleted) | (a) **Not searchable**; found on the team's Recently deleted tab. (b) Searchable with a badge. | **(a)**. Linear's docs list archived, not deleted, in search order. |
| Q9 | **Decided, see D1.** The timing channel (§5.3 item 8) | (a) **Accept** as a residual risk, with the mitigations listed; record it next to SPEC-001 D2 in permissions §5. (b) Pad every answer to a fixed time (slower for everyone, and still imperfect under load). | **(a)**. |
| Q10 | **Decided, see D15.** Editing rows the replica doesn't hold (Search page, profiles) | (a) **Like Linear, edit anywhere**: the first property key or menu action loads the issue as opening it would (on-demand subscription for a public team's live issue) and opens the picker when the row is local. (b) Read-only, with the hint "Open ENG-42 to edit it." | **(a)**. It can evict an on-demand team (the 5-team limit, SPEC-011 §5.7); that is the same cost as opening the issue. |
| Q11 | **Decided, see D16.** Subscribed tab (FR-NAV-10) | (a) **Hidden until M4** subscriptions; PRD milestone M1, M4. (b) An approximation now (assigned, created or commented). | **(a)**. |
| Q12 | **Decided, see D17.** Where is the members directory? | (a) **A new page `/members`** for everyone ("Go to members" in `Mod+K`, no sidebar item); Settings → Members stays Admin-only (SPEC-001 unchanged). (b) Open Settings → Members read-only to Members, hiding Admin controls (changes SPEC-001 §7 and AC-14). (c) Also a sidebar item. | **(a)**. Linear's docs describe Settings → Members as admin management and the profile page as where a member's issues are seen. |
| Q13 | **Decided, see D7.** Profile URL | **`/profiles/:username`**, as Linear's; or `/members/:displayName`. | **`/profiles/:username`**. |
| Q14 | **Decided, see D8.** Pre-filled URL parameters in M2 | Linear's set that M2 can resolve (team, title, description, status, priority, assignee, estimate, labels/label); M3/M4 parameters once their features exist. `links` (link attachments, which SPEC-014 has) needs a link area in the composer, which it lacks. Priority as numbers too? | **Linear's names only** (case-insensitive, plus `none`); `links` later, when the composer can hold link attachments. |
| Q15 | **Decided, see D18.** "Copy pre-filled create issue URL" command | Include (Linear has it, `Mod+K` only) or leave out. | **Include**, `Mod+K` only, no key. |
| Q16 | **Decided, see D9.** Home view in M2 | (a) Extend to team views and custom views. (b) Keep M0's choices. (c) Linear's fixed pages only. | **(c)**: My issues, All issues and Active issues; no team or custom views (§3.10). |
| Q17 | **Decided, see D19.** Recents storage | (a) **`localStorage`**, per user and device, ids only, cleared on sign-out. (b) A synced user-scoped model (follows the user across devices, like Linear's). | **(a)**: no new synced model, and recents are a per-device convenience. |
| Q18 | **Decided, see D20.** Labels in `Mod+K` (`l `) and NFR-05's "search by label" | (a) **Label results open the current team's (else the home team's) issue list filtered by the label**, using SPEC-021's URL filters; left out of M2 if SPEC-021 has no URL filters. (b) Not in M2. | **(a)**. |
| Q19 | **Decided, see D21.** Error for a search timeout | (a) **No new error code**: 3 s statement timeout, `INTERNAL` with the specific message (§6). (b) A new code (`TIMEOUT`, 503/504) in SPEC-003. | **(a)**. |
| Q20 | **Decided, see D22.** Accent folding (`unaccent`) | (a) **Not in M2** (one less required extension; hosted Postgres variants differ). (b) Add `unaccent` now. | **(a)**; revisit if dogfooding shows a need. |
| Q21 | **Decided, see D3.** Find in view (`Mod+F`, Linear) | Here, in SPEC-021 (views), or later. | **Not in this spec**; offered to SPEC-021. |
| Q22 | **Decided, see D23.** Projects and documents in search | M3 adds `project.search`, a Projects section in `Mod+K` (`p `) and the Search page type switch; M4 adds `document.search` and Documents (`d `). Same leak rules (§5.3). | **As stated**; each spec names its leak test. |
| Q23 | **Decided, see D2.** Testing hold for search SQL | AC-6 and AC-8 can only be tested on Postgres. (a) **Grant an exception** for `issue-search.int.test.ts` (matching, ranking, archived, deleted, paging, snippets), as SPEC-011 Q13 did for filter conformance. (b) Keep held; only the leak tests cover the SQL. | **(a)**: without it, ranking and matching would ship with only unit tests of the SQL builder. |
| Q24 | **Recent searches:** synced with the other recents, or kept on the device? Synced recents hold ids only (§4.5). A synced recent search would store the query text on the server, in the user's own group and in `sync_log`, which §5.3 item 9 keeps out of logs because it may hold anything. Linear's docs say only that "you'll be shown recent searches". | (a) **On the device** (`localStorage`, the last 5, cleared on sign-out), so query text never leaves the `issue.search` request. (b) Synced: `Recent` gains a `search` target with the query text, never logged, deleted with the row. | **(a)**: the user's other recents follow them across devices, their searches don't. |

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Q9: the timing channel | **Decided by the user on 2026-11-25:** accepted as a residual risk, recorded beside SPEC-001 D2. Every other channel in §5.3 (results, counts, ranking, snippets, suggestions, logs) stays leak-tested. |
| D2 | Q23: testing hold for search SQL | **Decided by the user on 2026-11-25:** exception granted for `issue-search.int.test.ts` against real Postgres, like SPEC-011 Q13. README §6 lists it at the acceptance gate. |
| D3 | Q21: find in view (`Mod+F`) | **Decided by the user on 2026-11-25:** not in M2. It goes into the PRD as a Later item at the acceptance gate. |
| D4 | Q4: what `/` opens | **Decided by the user on 2026-11-25** ("we want same as Linear"): `/` opens the Search page at `/search`, with the tabs All, Issues, Projects and Documents, a query field (Linear's placeholder: "Search issues, projects, and documents…") and the address `/search?q=…&includeArchived=true`. This is the spec's default. Checked in Linear's web app on 2026-11-25. In M2 the Projects and Documents tabs wait for their milestones. |
| D5 | Q5: `Mod+K` and full text | **Decided by the user on 2026-11-25** ("we want same as Linear"): `Mod+K` with typed text shows a "Quick results for …" section of issue rows (fuzzy, word-level) and an **Advanced search** action bound to `Mod+/`; with no match it says "No results found · Go to advanced search". `Mod+/` hands over to the Search page. Whether Linear's quick results come from the server couldn't be seen, so local versus server stays tied to Q1–Q3 (the default there: the local index). Checked in Linear's web app on 2026-11-25. |
| D6 | Q7: archived issues in search | **Decided by the user on 2026-11-25** ("we want same as Linear"): the Search page has an **Include archived** display toggle, on by default and also in the address (`includeArchived=true`); its ordering options include "Most relevant". Checked in Linear's web app on 2026-11-25. |
| D7 | Q13: profile URL | **Decided by the user on 2026-11-25** ("we want same as Linear"): `/profiles/:username`, Linear's username and not the full name (in Surface the username is `User.displayName`, the unique @handle), with the tabs Assigned and Created (Projects joins in M3). Checked in Linear's web app on 2026-11-25. |
| D8 | Q14: pre-filled `/new` parameters | **Decided by the user on 2026-11-25** ("we want same as Linear"): confirmed in Linear: title, description, priority by name, status by name, `assignee=me` and comma-separated labels; estimate was not observed (kept from Linear's docs). The composer opens as a modal over the current page. Checked in Linear's web app on 2026-11-25. |
| D9 | Q16: home view | **Decided by the user on 2026-11-25** ("we want same as Linear"): Linear's "Default home view" offers fixed pages only (Inbox, My issues, All issues, Active issues, Current cycle, Projects, …) and no team or custom views. M2 offers the fixed pages that exist (My issues, All issues, Active issues); the others arrive with their milestones. Checked in Linear's web app on 2026-11-25. |
| D10 | Q1: search over a partial replica (ADR-0030) | **Decided by the user on 2026-11-25:** accepted the proposed default: (c) hybrid, a local index over held issues, people and teams for instant and offline results, plus the server operation `issue.search` over every visible issue, whose list replaces the local one when it arrives. |
| D11 | Q2: client index library (ADR-0030) | **Decided by the user on 2026-11-25:** accepted the proposed default: (b) MiniSearch, in a Web Worker. |
| D12 | Q3: server engine and text configuration (ADR-0030) | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) Postgres full-text search with the `english` configuration for title, description and comments, plus `pg_trgm` for title typos, in generated `tsvector` columns on the server-only tables. |
| D13 | Q6: ranking | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) Linear's, state bucket first (started and unstarted, backlog, completed, canceled, archived), then match quality. |
| D14 | Q8: deleted issues in search | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) not searchable; found on the team's Recently deleted tab. |
| D15 | Q10: editing rows the replica doesn't hold | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) edit anywhere, like Linear; the first property key or menu action loads the issue as opening it would. |
| D16 | Q11: the Subscribed tab | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) hidden until M4 subscriptions; the PRD milestone becomes M1, M4. |
| D17 | Q12: where the members directory is | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) a new page `/members` for everyone, with "Go to members" in `Mod+K` and no sidebar item; Settings → Members stays Admin-only. |
| D18 | Q15: "Copy pre-filled create issue URL" | **Decided by the user on 2026-11-25:** accepted the proposed default: include it, in `Mod+K` only, with no key. |
| D19 | Q17: recents storage | **Decided by the user on 2026-11-25:** recents are synced across the user's devices, like Linear, not kept in `localStorage`. Specified in §3.5, §4.5 and §6: a user-scoped synced model `Recent` (in `user:<id>` only, ids only, 50 items and 20 commands per user) written by `recent.record` and `recent.remove`, with the leak test AC-28. Recent searches stay on the device by the proposed default of the new Q24. |
| D20 | Q18: labels in `Mod+K` | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) label results open the current team's (else the home team's) issue list filtered by the label, through SPEC-021's URL filters. |
| D21 | Q19: error for a search timeout | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) no new error code; a 3 s statement timeout answers `INTERNAL` with the specific message of §6. |
| D22 | Q20: accent folding | **Decided by the user on 2026-11-25:** accepted the proposed default: (a) not in M2; revisit if dogfooding shows a need. |
| D23 | Q22: projects and documents in search | **Decided by the user on 2026-11-25:** accepted the proposed default: as stated, M3 adds `project.search` and M4 `document.search`, each with its own leak test under §5.3's rules. |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| ADR | new ADR-0030 (the next free number at the M2 gate; other M2 specs may take numbers first) | "Search across a partial replica": Q1–Q3 with the chosen options, the leak rules of §5.3 and the ranking rule of §3.4 (per-row features only). | **Yes: supersedes ADR-0008** |
| ADR-0008 | status line only | "Superseded by ADR-0030". | — |
| adr/README.md | index | Add ADR-0030; mark 0008 superseded. | No |
| architecture.md | §2 stack table (Search row), §6 client workers | Point to ADR-0030; "Client: MiniSearch in a Web Worker over the held issues, people and teams" (per Q2). | No |
| PRD | FR-NAV-04 | "Global search (`/` or `Cmd+K`) over issues (ID, title, description, comments) and people; projects (M3) and documents (M4) join when they exist. Identifier and title results are instant and local over the issues the device holds; full text and every other visible issue come from the server. Includes archived issues." | No |
| PRD | FR-NAV-10 | Milestone "M1–M2" → "M1, M4": Subscribed arrives with subscriptions (§3.8). | No |
| PRD | FR-MEM-04, FR-ISS-13, FR-AUTH-10 | Note the routes (`/members`, `/profiles/:username`, `/new`, `/team/:key/new`) and that FR-AUTH-10's theme, font size and home view shipped in M0, with M2 adding the home choices All issues and Active issues (D9). | No |
| permissions.md | §4 enforcement, "Search" row | Add §5.3 items 1–5 and 9: visibility before ranking, limits and counts; per-row ranking only; snippets from visible rows as text; no stored-text suggestions; query text never logged. | No |
| permissions.md | §5 leak checklist | Add **Search** (AC-14–AC-16, `search-leak.int.test.ts`), **client search surfaces** (AC-10, AC-17) and **Recents** (§5.3 item 12, AC-28, `recent-leak.int.test.ts`), as unticked checks. Record the timing channel as an accepted exception next to SPEC-001 D2 (Q9). | No |
| permissions.md | §2 sync groups (`user:<id>` row) | Add "recents (`Recent`, SPEC-023)" to what belongs to `user:<id>`. | No |
| permissions.md | §6 purge | Purging an issue also deletes every user's `Recent` rows of it, through the repo, each `D` to its owner only. | No |
| domain-model.md | §1 Rich text; §7 operations | Server-only `search_vector` columns on `issue_search_text` and `comment_search_text`. `issue.search` is already listed in §7; no change there. §7 "personal" gains `recent.record` and `recent.remove`. | No |
| domain-model.md | §2 entity index, §4.15 | Personal, user-scoped: add **Recent**. §4.15: `Recent`: `userId`, `target` (`issue` \| `user` \| `command`), `issueId?`, `targetUserId?`, `commandId?`, `openedAt`; ids only; unique per user and target; 50 items and 20 commands per user, the oldest evicted (SPEC-023 §4.5). | No |
| sync-protocol.md | §2, §6, §10, §11 | §2: `Recent` joins the eager user-scoped list (beside Draft and Favorite). §6: Recent rows are in `user:<id>` only. §10: recents join the convergence generator (record, re-record, eviction, remove, purge). §11: a change-log row (no codec change; `schemaHash` changes). | No |
| SPEC-003 | §3.1 domains, §4 refs | Add the `recent` domain and `RecentRef` (uuid only, the actor's own row). | No |
| SPEC-015 | purge (§4.5) | `issue.purge` also deletes the issue's Recent rows (as its Favorite rows, SPEC-021). Dated "Changed (SPEC-023)". | No |
| apps/server/src/db/README.md | sync scope table | `issue_search_text`, `comment_search_text`: "plus a generated `search_vector` (SPEC-023)". (A code-doc, updated by the plan slice.) | No |
| SPEC-011 | §5.7 "What stays local" table; §6.1 | Row "Title and ID search in `Mod+K`" → "The local index over held issues (SPEC-023 §4.1); full text and issues not held through `issue.search` (SPEC-023 §6)". Add `issue.search` to §6.1 by reference to SPEC-023. | No |
| SPEC-012 | §3.8 last bullet; §3.9 item 1; §3.12 | Issue search in `Mod+K` is SPEC-023 §3.1. Subscribed stays hidden until M4 (not M2). Explicit sign-out's replica deletion covers recents (synced `Recent` rows, which stay on the server like drafts), and it also clears this device's recent searches (`surface.recentSearches.<userId>`, SPEC-023 §3.5 items 6–7). | No |
| SPEC-005 | §3 routes | Add `/search`, `/members`, `/profiles/:username`, `/profiles/:username/created`, `/new`, `/team/:key/new`. | No |
| SPEC-005 | §6 preferences | The home value becomes `home` (`my-issues`, `all-issues`, `active-issues`, §3.10); `homeTeamId` is still read and names the team of the last two. | No |
| SPEC-005 | §7 sidebar | The Search button opens the Search page (D4). | No |
| command-menu.md | §1 sections, §2 sources, §3.1 | Sections: Recent (empty query), then Suggested …, "Quick results for …" (issues), People, Teams, … , and the **Advanced search** action (`Mod+/`) with the "No results found · Go to advanced search" empty state. Sources: Local search = held issues, people, teams (projects M3, documents M4, views and labels with SPEC-021); **Server full-text is not in `Mod+K`** (Q5); Recent as §3.5. §3.1: prefix modes `i `, `u `, `t `. | No |
| shortcuts.md | §3, reserved list | Bind `/` (Search page), `Mod+/` in the command menu (Advanced search; §3.1's `?` / `Mod+/` help row gains "when the menu is closed"), `O` `I`, `O` `U`; remove them from the reserved list; add the `search-query` scope and the `Esc` step (§3.11). | No |
| design-system.md | §3 sidebar, §5 components | Sidebar Search opens the Search page; add SearchResultRow, MemberRow, ProfileHeader; the Search page's tabs and display options (Ordering, Include archived). | No |
| glossary.md | terms | Add **Search page**, **Recent items** (synced across the user's devices; recent searches stay on the device), **Profile**, **Members directory**, **Pre-filled create URL**. | No |
| plans README | §6 testing hold | Add the exception for `issue-search.int.test.ts` (D2). | No |
| (coordination) | SPEC-020, SPEC-021, SPEC-022 | SPEC-021: the filter bar with its Advanced filter builder, quick filter (`@`) and URL filters are reused here (§3.2 item 6, Q18); the profile header carries SPEC-021's favorite star (user favorites, SPEC-021 D16); views are not home choices (D9); the server-backed issue list (§4.4) may be shared. SPEC-022: selection and peek on Search results. SPEC-020: nothing shared beyond IssueRow. | No |
