# SPEC-005: App shell, command menu & shortcut registry

Status: **Accepted** (2026-11-06) · Milestone: **M0** · Date: 2026-11-06
Implements: FR-NAV-01 (skeleton), FR-NAV-02, FR-NAV-03 (engine + M0 shortcuts), FR-AUTH-10 (theme) · NFR-18, 19, 20, 21
Depends on: SPEC-002 (store), SPEC-003 (registry `ui` metadata), SPEC-001 (screens hosted by the shell)
Design references: [design-system](../05-design/design-system.md) · [shortcuts](../05-design/shortcuts.md) · [command-menu](../05-design/command-menu.md)

---

## 1. Problem & goal

Every later feature plugs into the same frame: the sidebar, header, routing, overlays, command menu, and keyboard handling. M0 builds that frame **once, correctly**, so that M1+ features add only pages, commands, and shortcuts. M0 also delivers the design-system foundations (tokens and core primitives) the frame needs.

**M0 demo:** log in → the sidebar lists teams live → `Mod+K` → "Create team" → the team appears → `?` shows shortcuts → `Alt+Shift+T` switches the theme → every step works by keyboard only.

## 2. Scope

**In scope (M0)**
- `packages/ui`: token pipeline (light/dark), the contrast test, and the primitives needed now: Button, IconButton, Input, Textarea, Checkbox, Switch, SegmentedControl, Tabs, Kbd, Tooltip, Avatar, Badge, Banner, Toast, Skeleton, Spinner, Popover, Menu/ContextMenu, Dialog, SidebarNavItem/Section, EmptyState, ColorPicker. Storybook and visual snapshots.
- App shell layout: sidebar (resizable, collapsible), header, main pane, responsive behaviour
- Routing (TanStack Router) with auth and setup guards, and URL conventions
- Overlay manager (one modal stack, popovers, toasts, banners)
- **Shortcut engine**: registry, scopes, sequences, input-suppression, conflict test, `?` help overlay
- **Command menu**: operations, navigation, and toggles sources; context chip; nested pages; ranking (fuzzy + context); permission filtering
- Theme preference (light / dark / system, synced as a user preference), density and font size preferences. *Changed 2026-11-07 (PLAN-005 S7, the user's decision): density moves to Later. FR-AUTH-10 doesn't list it, and every component has one density until list views (M1) need a compact one. M0 ships theme, font size and home view.*
- System banners: offline, reconnecting, outdated client, live updates unavailable
- Placeholder pages: team home ("Issues arrive in M1"), My Issues (empty state), Settings (hosts the SPEC-001 screens)

**Out of scope (later)**
Search sources and recent items in the command menu (M2) · Peek panel (M2) · list/board components (M1/M2) · Inbox, Triage, Cycles, and Projects pages (their milestones) · Favorites (M2) · undo/redo (M2).

## 3. Routing & URLs

| Route | Page |
|---|---|
| `/setup`, `/login`, `/login/check-email`, `/login/magic`, `/forgot`, `/reset`, `/invite/:token` | Public (SPEC-001). Rendered without the shell. |
| `/` | Redirects to the user's home preference (default: My issues) |
| `/my-issues`, `/my-issues/created` | My issues, Assigned and Created tabs (empty state in M0; live in M1, SPEC-012) |
| `/drafts` | Drafts (live in M1, SPEC-012) |
| `/team/:key` | Team home (placeholder) |
| `/team/:key/issues` | The team's issue list (live in M1, SPEC-012) |
| `/team/:key/active`, `/team/:key/backlog` | Reserved for M2 |
| `/team/:key/archive`, `/team/:key/archive/recently-deleted` | Team archive and Recently deleted (live in M1, SPEC-015) |
| `/issue/:identifier/:slug?` | The issue page (live in M1, SPEC-011, SPEC-012). The slug is optional and cosmetic: the app replaces it with the current one (SPEC-011 §4.1, D6). Old identifiers redirect. |
| `/settings/...` | Settings (account, members, workspace, teams), with the sub-routes of SPEC-001 §7. `/settings` and `/settings/account` open `/settings/account/profile`. M1 adds `/settings/teams/:key/workflow`, `/settings/teams/:key/labels`, `/settings/teams/:key/estimates` and `/settings/labels` (SPEC-010), and `/settings/teams/:key/automations` (SPEC-015). `/settings/labels` is a **Labels** entry in the settings nav for every member, before Teams (it is not admin-only); the team pages are reached from the team's settings tabs, not the nav. |
| `*` | Not found page with a "Go home" action |

**Guards:** setup incomplete → `/setup`. Unauthenticated → `/login?next=…`. Store not ready → shell with a bootstrap progress bar (SPEC-002 §7). Admin-only routes for Members → not-found (don't reveal they exist).

*As built (PLAN-005 S4, 2026-11-07):* the guards run before a route loads and again when the session changes (logout, a revoked session). `next` is the whole address, query included; only a same-origin path is followed (not `//host`, `/\host`, control characters or the login page itself), otherwise home. `/setup` is sent away once setup is done: to `/` when signed in, else `/login`. Admin-only routes are Members and Workspace (🛡 in SPEC-001 §7); a Member doesn't see them in the settings nav, and their URLs show not-found, decided in the page because the role comes from the store (with a spinner until the user's row is there). If the server can't be reached, an error page says so instead of redirecting (*changed 2026-11-07, PLAN-005 S8:* only when this device has no remembered session; see D2). An unknown address inside the shell shows not-found in the shell; one that matches no route at all shows it without the shell (also before setup, when the server already sends every page to `/setup`). After the user's own logout the next login starts at home (`/login` without `next`); a revoked or expired session keeps `next`. Paths match in any case, the login page included. *Changed 2026-11-12 (session D's SPEC-002 E14 handoff):* when the sync client gets a `401` or a `4001`, the app asks who is signed in (SPEC-001 Q11). The same session keeps its store after a mutate `401` (the sync client backs off itself); after a `4001` or another `401` it gets a new store, and a session that keeps being revoked soon after each opening waits 2, 5, 10, then 30 s between new stores (ADR-0018's schedule), so a server or proxy that disagrees with itself doesn't loop. Another user always gets a new store at once.
*As built (PLAN-005 S7, 2026-11-07):* `/` opens the home view: the team chosen in the preferences while the user can see it (a public team they aren't a member of counts), else My issues (also when that team is archived or no longer visible). The home view is read from the replica, so on a first load `/` shows the shell's progress until the replica is ready, then goes on; later visits redirect at once. Settings has a third Account page, **Preferences** (`/settings/account/preferences`: theme, font size, home view). It is this spec's screen, as SPEC-001 §7 has none for preferences.
*As built (PLAN-005 S8, 2026-11-07):* once the page has loaded, a server that can't answer for the session (a network error, a `5xx`, or no answer within 10 s) opens the shell from the replica of the session this device last had, with the sync store's banners, and checks that session again once the server answers (D2, [ADR-0018](../04-architecture/adr/0018-offline-start.md)). *Changed (PLAN-005 S9, 2026-11-07):* the page itself is now kept in the browser by a service worker ([ADR-0019](../04-architecture/adr/0019-offline-app-cache.md)), so with the single image a reload while offline or with the server stopped loads the app too, over HTTPS or on `localhost`. Over plain `http://` elsewhere browsers run no service worker, and such a reload still fails before the app runs. The page's title is its last breadcrumb, the page's one `h1`; the not-found page outside the shell has a visually hidden `h1` (axe `page-has-heading-one`).
*As built in M1 (2026-11-24):* every M1 route in the table is live: `/drafts` (PLAN-012 S5), `/my-issues` and `/team/:key/issues` (PLAN-012 S3), the issue page (PLAN-012 S4, at `/issue/$ref` and `/issue/$ref/$slug`, where `$ref` is an identifier or a pending issue's id), `/team/:key/archive` and `/team/:key/archive/recently-deleted` (PLAN-015 S4), and the M1 settings pages. `/team/:key/active` and `/team/:key/backlog` stay reserved.
URL state: filters and display (M2) are encoded in query params. Overlay state (modals) is **not** in the URL, except peek (`?peek=ENG-1`, M2).

## 4. Command menu engine

### 4.1 Command model
> **Changed 2026-11-07 (PLAN-005 S6):** `CommandContext.target` replaces `focused` and `selection`; `appliesTo` is added next to `when`; `title` is a string until context-dependent titles are needed (M1); `icon` arrives with the M1 commands that show one; the permission pre-check leaves input-dependent checks to the server; Suggested is defined in §4.2.

```ts
type Command = {
  id: string;                         // "op:team.create" | "nav:my-issues" | "toggle:theme"
  title: string;                      // "Change team color…"
  section: "navigation" | "create" | "settings" | "help"; // home section; Suggested is computed
  icon?: IconName;                    // M1: not shown in M0
  keywords?: string[]; shortcuts?: (string | string[])[];
  when?: (ctx: CommandContext) => boolean;            // context + permission filter
  appliesTo?: (ctx: CommandContext) => boolean;       // acts on the target: Suggested, ×2 (§4.2)
  run?: (ctx) => void | Promise<void>;                 // leaf command
  page?: (ctx) => CommandPage;                         // nested page (picker)
};
```
- **Operation commands** are generated from registry entries with `ui` metadata, except `internal` and `deprecated` ones. `when` combines the `ui.contexts` match with a client-side permission pre-check (the same predicate helpers, bound to the actor; a predicate that throws because it needs the operation's input does not hide the command, as the server decides). `appliesTo` is the `ui.contexts` match on the target.
- **Navigation commands** are generated from the route table plus the live store (one "Go to {team}" per team).
- `CommandContext` = `{ route, target, actor, store, navigate?, teams }`, maintained by the shell (§6). `target` merges the focused entity and the selection: `{ kind: "global" }` or `{ kind: "team" | "issue" | "issues" | "project" | "comment" | "attachment", ids, label }`, where `label` is the context chip text ("ENG", "3 selected issues"). Navigation commands are hidden while `navigate` is absent.
- Titles that depend on the context ("Set priority for 3 issues…") arrive with the commands that need them (M1); until then `title` is a string.
- *Changed (SPEC-012, SPEC-013, SPEC-014, SPEC-015, M1 gate 2026-11-12):* the target kinds `comment` (set by a focused comment) and `attachment` (set by a focused attachment row) are added. Commands get `ui.available(target, store)` for context-dependent availability (for example, editing commands are unavailable for an archived or deleted issue); the command menu filters by it, and a disabled command makes its shortcut a no-op with a hint. A third command kind, **property commands**, is defined in the web app next to a picker: each dispatches one operation with a partial input and opens a picker sub-page, with the operation's permission pre-check and `appliesTo` by target kind (SPEC-012 §3.8).
- *As built in M1 (2026-11-24):* the shell's own commands appear in the menu only while their handler is registered, and each may be limited to one target kind: `issue` (rename, the copy commands), `comment` (`comment:copy-link` "Copy link to comment", `comment:copy-markdown` "Copy content as Markdown", `comment:new-issue` "New issue from comment…"; PLAN-013 S5, PLAN-011 S6) and `attachment` (open, download, copy link; PLAN-014 S5). A focused comment card sets the `comment` target, and a focused attachment row the `attachment` target. Operation commands carry the operation's `destructive` flag, which ranking uses (§4.2). [command-menu §3.3](../05-design/command-menu.md#33-context-rules) lists the commands per context.

### 4.2 Ranking
`score = fuzzy(query, title + keywords) × (appliesToContext ? 2 : 1) × frecencyBoost`. *Added (SPEC-012 §3.8, AC-16; built in PLAN-012 S6, 2026-11-16):* a destructive command ranks first only when its title matches the query better than every other command; otherwise it leaves Suggested and ranks just under the best other match. Frecency is stored per user in `localStorage` (a convenience only). With an empty query: Suggested (context) first, then Navigation. Suggested holds the commands whose `appliesTo` is true: on a team page the team commands, with no target the global ones (AC-3). Section placement takes precedence over the score, and every command in Suggested has the ×2, so in M0 the boost changes no order; it is kept for the M2 search sections, where context results compete with search results (noted 2026-11-07, PLAN-005 S6).

### 4.3 Behaviour
As specified in [command-menu.md](../05-design/command-menu.md) §3–4. *Changed 2026-11-25 (PLAN-016, D4): the menu has no backdrop, is top-anchored at about 720 px, and a property shortcut opens its sub-page inside the menu (command-menu.md §1, §3.5).* The identifier fast path is built in M1 with issues (changed 2026-11-07, PLAN-005 S6: nothing to open in M0, so it is not wired up early).

## 5. Shortcut engine

- **One global `keydown` listener** at the document level resolves bindings in this order: active overlay scope, then focused component scope, then page scope, then `global`.
- **Input suppression:** when `event.target` is an input, textarea, contenteditable, or inside `[data-shortcuts="off"]`, only `Mod+…` and `Esc` bindings are considered. *Changed (SPEC-012 §4.2, M1 gate 2026-11-12):* each binding has `whileTyping` (default: `Mod` chords fire while typing, plain keys don't). Text-editing chords (`Mod+Backspace`, `Mod+Delete`, `Mod+Z`, `Mod+Shift+Z`, `Mod+A`/`C`/`X`/`V`, `Mod+←`/`→`/`↑`/`↓`) must set `whileTyping: false`, checked when the registry loads, so ⌘⌫ in a title can't delete an issue.
- **Chords:** *added (SPEC-012 §4.2):* a literal `Ctrl` modifier next to `Mod` (the Control key on every platform), and an optional `platform` on a binding (for example `platform: 'mac'`; the registry and the `?` overlay show it only there). `shortcuts.md` has the M1 key map.
- **Overlay capture** (added 2026-11-07, PLAN-005 S5): while an overlay is open (modal or picker scope), page scopes are inactive and `global` bindings follow the input-suppression rule (only `Mod+…` and `Esc`), so letters typed into a menu's type-ahead never start `G S`. Suppression and overlay capture apply to every key of a sequence. Component scopes inside the overlay (the editor in a dialog) stay active.
- **Sequences:** a pending-sequence state with a 1 s timeout and a hint toast listing the possible continuations.
- **Registry → help:** the `?` overlay is generated from the registry, grouped by `group`, filtered to bindings available in the current milestone build, and searchable.
- **Bindings are commands:** each binding references a command id. The same `when` guard applies, and a disabled command makes its shortcut a no-op (with a subtle "not available here" hint).
- **Platform display:** `Kbd` renders ⌘ ⌥ ⇧ on macOS, and Ctrl / Alt / Shift elsewhere.

**M0 bindings** (M1 adds its own in [shortcuts.md](../05-design/shortcuts.md) §3): `Mod+K`, `?`, `[`, `Mod+,`, `Alt+Shift+T`, `Esc`, `G S`, `O T`, plus picker and modal keys.

## 6. Shell state & focus management

| State | Owner | Persistence |
|---|---|---|
| Sidebar width / collapsed | Shell store | `localStorage` (per device) |
| Theme, font size, home view (density: Later, §2) | User preferences (`user.updatePreferences`) | Synced (`user:<id>` group) |
| Theme first-paint cache | Written whenever the theme preference changes (including from another device, via sync) | `localStorage['surface.theme']` (per device), read by the inline bootstrap in `index.html` so the first paint has no theme flash. Added 2026-11-06 (PLAN-005 S1). |
| Expanded sidebar team sections | Shell store | `localStorage` |
| Focus / selection context | Shell store, set by pages | Memory |
| Toasts, banners, modal stack | Overlay manager | Memory |

**Focus rules:** after route changes, focus moves to the main region (`<main tabindex=-1>`) and the page title is announced. Overlays trap focus and restore it to the trigger on close. Every page provides a "skip to content" link. Focus rings use `:focus-visible` only.

*As built (PLAN-005 S7, 2026-11-07):* preferences are the `values` of the user's `UserPreferences` row: `theme` (`light`, `dark`, `system`; default `system`), `fontSize` (`small`, `default`, `large`: a 12, 13 or 14 px root; default `default`) and `homeTeamId` (a team id, or null for My issues). Each field is read on its own, so a missing or unknown value falls back to its default, and a change keeps keys this version doesn't know. `user.updatePreferences` takes any subset (`homeTeam` as a key or id, or null) and is optimistic; the handler creates the row if the user has none. While the shell is open the page follows the row live: `data-theme`, the first-paint cache, and `html[data-font-size]` (removed again on sign-out). Theme ▸ in the avatar menu (now a radio group) and `Alt+Shift+T` save the preference; with no ready store (the sign-in page, a workspace still loading) they apply to this device only. "System" follows the OS live on every page, signed in or not, through the cached preference (E7). A user with no saved theme (everyone before S7) keeps the theme this device cached, and it is saved as theirs when the replica loads.

*As built (PLAN-005 S4, 2026-11-07):* the title is announced by a polite live region when the page sets it (every title after the first), since the page renders after the router's location changes. Below 1024 px the sidebar is a drawer: a non-modal overlay opened from the header's sidebar button (or `[`). Opening it moves focus to its first control; Esc, the backdrop or a navigation closes it. After Esc or the backdrop, focus returns to the header button; after a navigation it goes to `<main>`. Clicking any link in the drawer closes it, even to the page already open. The drawer closes when the window widens to full layout. With the sidebar collapsed at full width, the header shows a "Show sidebar" button; whenever the sidebar appears or goes and focus went with the control that was removed, focus moves into the sidebar or onto that header button. The sidebar is resizable from 200 to 360 px by dragging its edge or with the arrow keys on it (Shift for larger steps, Home and End); width, collapse and expanded team sections are stored in `localStorage['surface.shell']`.

## 7. Sidebar (M0 content)

```
[Logo] Workspace name                         [avatar ▾]
[ Search ⌘K ]                                 [ ✎ New ]
  My issues
  ─────────
  Your teams                                     [+]
   ▸ ENG  Engineering
   ▸ DES  Design
  ─────────
  Settings
```
- Teams the user belongs to are listed in **live** sidebar order (reorderable by drag in M2). "Browse teams" is at the end of the section.
- Each team expands to its pages. M0 shows only "Home"; more items appear as their milestones land. *Changed (SPEC-012, SPEC-015, M1 gate 2026-11-12):* M1 adds the team items **Issues** and **Archive** (Recently deleted is inside Archive), and the workspace items **My issues** and **Drafts**. There is no workspace-level deleted-issues item. *As built (PLAN-012 S5, PLAN-015 S4):* **My issues** and **Drafts** follow Search; each expanded team lists **Issues**, **Home** and **Archive**; a **New issue** button (opens the composer, like `C`) sits in the sidebar header, next to the workspace name, while the command is available.
- **The avatar menu** offers Profile, Theme ▸, Keyboard shortcuts, and Log out. *Changed (SPEC-012 §3.12, M1 gate 2026-11-12):* Log out deletes the local replica and warns about unsent changes.
- *As built (PLAN-005 S4, 2026-11-07):* the M0 sidebar has no logo, no `✎ New` button (issues arrive in M1) and a `[+]` that shows only while a feature implements `form:create-team` (the teams feature's dialog, PLAN-001 S8). Teams are sorted by name until drag reordering (M2). Search opens the command menu. Features plug in through `apps/web/src/features/hosts.ts`: `SHELL_HOSTS` (dialogs and their commands, mounted once while the shell is open) and `TEAM_MENU` (the team ⋯ menu, SPEC-001 §3.7, in the team page header). *Changed 2026-11-12 (PLAN-001 S6, session E's handoff):* the header shows the workspace logo before its name once one is uploaded (decorative, since the name follows; hidden if it can't load, as offline, where the app cache doesn't keep `/files/`), and the avatar menu shows the user's avatar (initials until it loads, and when it can't). Both try again when the app reconnects.

## 8. System banners

| Condition (from SPEC-002/004) | Banner |
|---|---|
| Socket offline | "Offline: changes will sync when you reconnect · N pending" (warning, persistent) |
| Reconnecting > 5 s | "Reconnecting…" (info) |
| `CLIENT_OUTDATED` / `resync(schema)` | "Surface was updated. [Reload]" (info, persistent) |
| 3 failed WebSocket upgrades | "Live updates unavailable: check your proxy's WebSocket settings. [Learn more]" (danger) |
| IndexedDB unavailable | "Offline mode unavailable in this browser session" (warning, dismissible) |

*As built (PLAN-005 S7, 2026-11-07):* the connection banners come from the sync store (`@surface/sync-react` hooks; rules in `apps/web/src/shell/system-banners.ts`), at most one at a time, in this order: live updates unavailable; offline (the socket is reconnecting and `navigator.onLine` is false); reconnecting (for more than 5 s with the browser online). "· N pending" shows only when changes are waiting. "Live updates unavailable" has no "Learn more" link yet: nothing in the app explains proxy settings, and the app links to nothing outside the server (CLAUDE.md rule 5). The IndexedDB banner is dismissible and comes back only if its reason changes. The sync inspector (SPEC-002 §5.4) is a folded "Sync" panel in the bottom-right corner, in dev builds (and with `?debug=sync` for Admins once roles reach the client, PLAN-001 S7).

*As built (PLAN-005 S4, 2026-11-07):* banners show at the top of `<main>`. The outdated-client banner is raised once the replica has been ready (`blocking` priority); before that, the bootstrap screen itself says "Surface was updated" with a Reload button. The other banners are PLAN-005 S7.

## 9. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | `Mod+K` pressed inside the editor with a text selection | The editor's "insert link" wins (editor scope, M1). Without a selection, the command menu opens. |
| E2 | A single-letter shortcut while an IME composition is active | Ignored (`event.isComposing`) |
| E3 | Non-US keyboard layouts (e.g. `?` needs Shift, AZERTY) | Bindings match on `event.key` (the produced character) for printable keys, and on `event.code` for `Mod+` letter combinations. Tested with AZERTY and QWERTZ. **Refined 2026-11-07 (PLAN-005 S5):** letters combined with `Ctrl` or `Alt` also match on `event.code` (Option changes `event.key` on macOS: `Alt+Shift+T` types "ˇ"); a plain letter falls back to `event.code` when the layout types a letter outside A–Z (Russian, or `é` from a dead key); for other characters Shift, Option and AltGr are part of typing them and are not compared, so a symbol binding is written as the character (`?`, never `Shift+/` or `Alt+[`), and `Mod+<symbol>` must be pressed without Option or AltGr. Also tested with a Russian layout. **Changed 2026-11-12 (SPEC-012 §4.2, M1 gate):** digits, every chord with `Alt`, and chords with `Shift` and a non-letter match on `event.code`; everything else, including `Mod+,` and `Mod+.`, keeps matching on `event.key`, and `event.key` matches are tried before `event.code` matches. Plain symbols (`#`, `?`, `[`) match on `event.key`. The AZERTY test for `Mod+,` stays. |
| E4 | A command's permission changes while the menu is open (role change via delta) | `when` re-evaluates reactively, and the item disappears |
| E5 | A team is deleted or the user leaves it while viewing it | Redirect to home with a toast "You no longer have access to ENG". *As built (S4):* this happens when the team disappears from the replica while its page is open: it was archived or deleted, or it is private and the user left. A public team the user leaves stays readable, so its page stays. A team key never visible to the user shows not-found. |
| E6 | Very narrow viewport (< 768 px) | The sidebar becomes a drawer. The command menu is full-width. Shortcuts still work with a hardware keyboard. |
| E7 | The OS-level theme changes with "system" selected | Applies live, without a reload |

## 10. Acceptance criteria

> **Held (2026-11-06): tests that need a browser, a running stack or Postgres are not written for now** (D1 in §11): criteria whose test is `e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e` or `integration` are held until the hold is lifted. Still written: unit and property tests, the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5).

| AC | Criterion | Test |
|---|---|---|
| AC-1 | **Keyboard-only M0 demo:** log in → `Mod+K` → "Create team" → fill and submit → `O T` opens the new team → `?` lists shortcuts → `Alt+Shift+T` toggles the theme, all without a mouse. | e2e |
| AC-2 | Every M0 operation with `ui` metadata appears in the command menu for permitted users only. Admin-only commands never appear for Members. (The pre-check runs without the operation's input: a predicate must check the role before reading input, or the input-dependent part is left to the server; noted 2026-11-07, PLAN-005 S6.) | e2e |
| AC-3 | Context: with a team page open, team-context commands rank in Suggested. Without a context, they don't appear in Suggested. | e2e |
| AC-4 | Nested pages: "Change team color…" opens the palette page. `Backspace` returns. `Enter` applies and closes. | e2e |
| AC-5 | Single-letter shortcuts never fire while typing in an input, textarea, or contenteditable. `Mod+K` and `Esc` do. | e2e |
| AC-6 | `G` `S` within 1 s navigates to settings. `G` alone shows the hint and times out harmlessly. | e2e |
| AC-7 | The shortcut conflict test fails CI when two bindings in overlapping scopes share keys, or when a reserved browser shortcut is used. | CI |
| AC-8 | The `?` overlay lists exactly the registered bindings available in the build, grouped and searchable. | unit + e2e |
| AC-9 | The command menu opens in < 50 ms, and filtering takes < 16 ms per keystroke with 300 commands (perf mark). | perf |
| AC-10 | The theme preference syncs: changing it in tab A updates tab B (via SPEC-002) and persists across devices. "System" follows the OS live. | e2e |
| AC-11 | Token contrast test passes for both themes. No hard-coded colours in component CSS (lint). | CI |
| AC-12 | axe reports zero serious or critical violations on shell pages, the command menu, the help overlay, settings, and all Storybook stories. | CI |
| AC-13 | Visual regression snapshots exist for every M0 component in both themes. Changes require approval. | CI |
| AC-14 | Each system banner in §8 appears under its simulated condition. | e2e |
| AC-15 | Route guards: incomplete setup → `/setup`. Logged out → `/login?next=`, and after login the user returns to `next`. A Member hitting an admin route sees not-found. | e2e |
| AC-16 | Responsive: at 375 px the sidebar is a drawer, and settings pages are usable. | e2e (mobile viewport) |

## 11. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Should the default home be My issues, or the first team's issues? | My issues (from M2). Until M2, the first team's home. *Changed 2026-11-07 (PLAN-005 S4): My issues from M0, as the shell opens before a team's issues exist (M1) and My issues is always there; PLAN-005 S7's home preference can choose otherwise.* |
| Q2 | Should frecency data sync across devices? | No: `localStorage` only (a convenience) |
| Q3 | Should the sidebar width sync across devices? | No (per device) |
| D1 | (2026-11-06) Write e2e (Playwright), smoke and integration tests now? | No, by decision of the user, for faster development; they are added later. Tests that need a browser, a running stack or Postgres (`e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e`, `integration`) are **held**: no test is written for them yet, and the slice notes in "As built" whether the behaviour was checked by hand. Not held: unit and property tests (including the unit parts listed for held criteria), the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5), which may use Postgres. Existing integration tests are kept. See [plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration). |
| D2 | (2026-11-07, PLAN-005 S8; chosen by the user) A reload while the server can't be reached showed the error page, so an offline change couldn't survive a reload (SPEC-002 AC-6, the M0 demo). Open the app offline? | Yes, from a remembered session ([ADR-0018](../04-architecture/adr/0018-offline-start.md)): the session's ids and the SMTP capability are kept in `localStorage` after each successful check and forgotten on logout or when the server says nobody is signed in. Unreachable at startup with a session remembered: the shell opens that session's replica, and the session is checked again after 2 s, 5 s, 10 s, then every 30 s (sooner on the browser's `online` event). The same session carries on with the same store; no session signs out keeping `next`; another session replaces the store. Nothing remembered, or an unexpected `4xx`: the error page, as before. This applies once the page has loaded; loading the page itself offline is D3. |
| D3 | (2026-11-07, PLAN-005 S9; direction chosen by the user, design approved by the user; amended 2026-11-12 after review) With the single image a reload while offline never loads the page, so D2 can't run. Keep the app in the browser? | Yes, with a hand-written service worker ([ADR-0019](../04-architecture/adr/0019-offline-app-cache.md)): it keeps `index.html` and the build's `assets/` and answers only page loads of the app's routes and those files, never the server's paths or `/setup`. Pages come from the server first (with navigation preload); the cached page answers when the server can't (network error, `5xx`, 10 s). A new build takes over at once, keeping the previous build's files; the outdated banner's Reload (§8) stays a plain reload, which loads the new build from the server and lets the browser install its worker. Production builds in secure contexts only: over plain `http://` (other than `localhost`) there is no worker and no offline reload. |
| D4 | (2026-11-25, PLAN-016; chosen by the user) Visual and interaction form of the command menu, taken from the Linear-grade UI polish pass ([design-system §8](../05-design/design-system.md), D-d and D-e). Backdrop? Width and position? Where do property shortcuts open their picker? | **No backdrop**: the page stays visible and is not dimmed, but focus is still trapped and `Esc` closes the menu. **Top-anchored, about 720 px** wide (was 640 px, centred in the top third), with a layered shadow and a hairline border. **Property shortcuts** (`S`, `P`, `A`, `L` and the other property keys) open their picker as a sub-page *inside the command-menu shell*, with the issue context chip, number key caps and a check on the current value (command-menu.md §3.5). The command engine (§4.1 to §4.3) does not change. |
