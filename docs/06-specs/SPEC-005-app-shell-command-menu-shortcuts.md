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
- Theme preference (light / dark / system, synced as a user preference), density and font size preferences
- System banners: offline, reconnecting, outdated client, live updates unavailable
- Placeholder pages: team home ("Issues arrive in M1"), My Issues (empty state), Settings (hosts the SPEC-001 screens)

**Out of scope (later)**
Search sources and recent items in the command menu (M2) · Peek panel (M2) · list/board components (M1/M2) · Inbox, Triage, Cycles, and Projects pages (their milestones) · Favorites (M2) · undo/redo (M2).

## 3. Routing & URLs

| Route | Page |
|---|---|
| `/setup`, `/login`, `/forgot`, `/reset`, `/invite/:token`, `/auth/magic` | Public (SPEC-001). Rendered without the shell. |
| `/` | Redirects to the user's home preference (default: My issues) |
| `/my-issues` | My issues (empty state in M0) |
| `/team/:key` | Team home (placeholder) |
| `/team/:key/issues`, `/team/:key/active`, `/team/:key/backlog` | Reserved for M1/M2 |
| `/issue/:identifier` | Reserved for M1. Old identifiers redirect. |
| `/settings/...` | Settings (account, members, workspace, teams), with the sub-routes of SPEC-001 §7. `/settings` and `/settings/account` open `/settings/account/profile`. |
| `*` | Not found page with a "Go home" action |

**Guards:** setup incomplete → `/setup`. Unauthenticated → `/login?next=…`. Store not ready → shell with a bootstrap progress bar (SPEC-002 §7). Admin-only routes for Members → not-found (don't reveal they exist).

*As built (PLAN-005 S4, 2026-11-07):* the guards run before a route loads and again when the session changes (logout, a revoked session). `next` is the whole address, query included; only a same-origin path is followed (not `//host`, `/\host`, control characters or the login page itself), otherwise home. `/setup` is sent away once setup is done: to `/` when signed in, else `/login`. Admin-only routes are Members and Workspace (🛡 in SPEC-001 §7); a Member doesn't see them in the settings nav, and their URLs show not-found, decided in the page because the role comes from the store (with a spinner until the user's row is there). If the server can't be reached, an error page says so instead of redirecting. An unknown address inside the shell shows not-found in the shell; one that matches no route at all shows it without the shell (also before setup, when the server already sends every page to `/setup`). After the user's own logout the next login starts at home (`/login` without `next`); a revoked or expired session keeps `next`. Paths match in any case, the login page included.
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
- `CommandContext` = `{ route, target, actor, store, navigate?, teams }`, maintained by the shell (§6). `target` merges the focused entity and the selection: `{ kind: "global" }` or `{ kind: "team" | "issue" | "issues" | "project", ids, label }`, where `label` is the context chip text ("ENG", "3 selected issues"). Navigation commands are hidden while `navigate` is absent.
- Titles that depend on the context ("Set priority for 3 issues…") arrive with the commands that need them (M1); until then `title` is a string.

### 4.2 Ranking
`score = fuzzy(query, title + keywords) × (appliesToContext ? 2 : 1) × frecencyBoost`. Frecency is stored per user in `localStorage` (a convenience only). With an empty query: Suggested (context) first, then Navigation. Suggested holds the commands whose `appliesTo` is true: on a team page the team commands, with no target the global ones (AC-3). Section placement takes precedence over the score, and every command in Suggested has the ×2, so in M0 the boost changes no order; it is kept for the M2 search sections, where context results compete with search results (noted 2026-11-07, PLAN-005 S6).

### 4.3 Behaviour
As specified in [command-menu.md](../05-design/command-menu.md) §3–4. The identifier fast path is built in M1 with issues (changed 2026-11-07, PLAN-005 S6: nothing to open in M0, so it is not wired up early).

## 5. Shortcut engine

- **One global `keydown` listener** at the document level resolves bindings in this order: active overlay scope, then focused component scope, then page scope, then `global`.
- **Input suppression:** when `event.target` is an input, textarea, contenteditable, or inside `[data-shortcuts="off"]`, only `Mod+…` and `Esc` bindings are considered.
- **Overlay capture** (added 2026-11-07, PLAN-005 S5): while an overlay is open (modal or picker scope), page scopes are inactive and `global` bindings follow the input-suppression rule (only `Mod+…` and `Esc`), so letters typed into a menu's type-ahead never start `G S`. Suppression and overlay capture apply to every key of a sequence. Component scopes inside the overlay (the editor in a dialog) stay active.
- **Sequences:** a pending-sequence state with a 1 s timeout and a hint toast listing the possible continuations.
- **Registry → help:** the `?` overlay is generated from the registry, grouped by `group`, filtered to bindings available in the current milestone build, and searchable.
- **Bindings are commands:** each binding references a command id. The same `when` guard applies, and a disabled command makes its shortcut a no-op (with a subtle "not available here" hint).
- **Platform display:** `Kbd` renders ⌘ ⌥ ⇧ on macOS, and Ctrl / Alt / Shift elsewhere.

**M0 bindings:** `Mod+K`, `?`, `[`, `Mod+,`, `Alt+Shift+T`, `Esc`, `G S`, `O T`, plus picker and modal keys.

## 6. Shell state & focus management

| State | Owner | Persistence |
|---|---|---|
| Sidebar width / collapsed | Shell store | `localStorage` (per device) |
| Theme, density, font size, home view | User preferences (`user.updatePreferences`) | Synced (`user:<id>` group) |
| Theme first-paint cache | Written whenever the theme preference changes (including from another device, via sync) | `localStorage['surface.theme']` (per device), read by the inline bootstrap in `index.html` so the first paint has no theme flash. Added 2026-11-06 (PLAN-005 S1). |
| Expanded sidebar team sections | Shell store | `localStorage` |
| Focus / selection context | Shell store, set by pages | Memory |
| Toasts, banners, modal stack | Overlay manager | Memory |

**Focus rules:** after route changes, focus moves to the main region (`<main tabindex=-1>`) and the page title is announced. Overlays trap focus and restore it to the trigger on close. Every page provides a "skip to content" link. Focus rings use `:focus-visible` only.

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
- Each team expands to its pages. M0 shows only "Home"; more items appear as their milestones land.
- **The avatar menu** offers Profile, Theme ▸, Keyboard shortcuts, and Log out.
- *As built (PLAN-005 S4, 2026-11-07):* the M0 sidebar has no logo, no `✎ New` button (issues arrive in M1) and no `[+]` (it appears once the create-team dialog registers its command, PLAN-001 S9). Teams are sorted by name until drag reordering (M2). Search opens the command menu.

## 8. System banners

| Condition (from SPEC-002/004) | Banner |
|---|---|
| Socket offline | "Offline: changes will sync when you reconnect · N pending" (warning, persistent) |
| Reconnecting > 5 s | "Reconnecting…" (info) |
| `CLIENT_OUTDATED` / `resync(schema)` | "Surface was updated. [Reload]" (info, persistent) |
| 3 failed WebSocket upgrades | "Live updates unavailable: check your proxy's WebSocket settings. [Learn more]" (danger) |
| IndexedDB unavailable | "Offline mode unavailable in this browser session" (warning, dismissible) |

*As built (PLAN-005 S4, 2026-11-07):* banners show at the top of `<main>`. The outdated-client banner is raised once the replica has been ready (`blocking` priority); before that, the bootstrap screen itself says "Surface was updated" with a Reload button. The other banners are PLAN-005 S7.

## 9. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | `Mod+K` pressed inside the editor with a text selection | The editor's "insert link" wins (editor scope, M1). Without a selection, the command menu opens. |
| E2 | A single-letter shortcut while an IME composition is active | Ignored (`event.isComposing`) |
| E3 | Non-US keyboard layouts (e.g. `?` needs Shift, AZERTY) | Bindings match on `event.key` (the produced character) for printable keys, and on `event.code` for `Mod+` letter combinations. Tested with AZERTY and QWERTZ. **Refined 2026-11-07 (PLAN-005 S5):** letters combined with `Ctrl` or `Alt` also match on `event.code` (Option changes `event.key` on macOS: `Alt+Shift+T` types "ˇ"); a plain letter falls back to `event.code` when the layout types a letter outside A–Z (Russian, or `é` from a dead key); for other characters Shift, Option and AltGr are part of typing them and are not compared, so a symbol binding is written as the character (`?`, never `Shift+/` or `Alt+[`), and `Mod+<symbol>` must be pressed without Option or AltGr. Also tested with a Russian layout. |
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
