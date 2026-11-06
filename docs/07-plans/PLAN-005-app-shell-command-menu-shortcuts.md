# PLAN-005: App shell, command menu & shortcuts (+ design-system foundations)

Implements: [SPEC-005](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md) · Design: [design-system](../05-design/design-system.md), [shortcuts](../05-design/shortcuts.md), [command-menu](../05-design/command-menu.md) · Status: **Ready**
Order: **S1–S3 run in parallel from week 1** (after PLAN-004 S1). **S4–S8 run after** PLAN-002 S8 and PLAN-001 S3.

---

## 1. Slices

### S1: Token pipeline & themes · M
- `packages/ui/tokens/{primitives,semantic,component}.ts` is the source. `pnpm ui:tokens` generates `tokens.css` (`:root[data-theme=light|dark]`) and typed constants.
- Bundled fonts (Inter variable, JetBrains Mono) served from the app, with `font-display: swap`. No external requests.
- Theme bootstrap script (inline, CSP-hashed) sets `data-theme` before first paint from the cached preference or `prefers-color-scheme`, to avoid a flash.
- **Contrast test** `pnpm test:tokens`: every text/background pair in both themes, ≥ 4.5:1 for text and ≥ 3:1 for meaningful icons (AC-11).
- **Stylelint rule:** no hex or rgb colours and no raw px outside the token files (AC-11, lint part).

### S2: Primitives & Storybook · L
- Components: Button, IconButton, Input, Textarea, Checkbox, Switch, SegmentedControl, Tabs, Kbd (platform-aware), Tooltip, Avatar/AvatarGroup, Badge, Spinner, Skeleton, ProgressBar, EmptyState, ColorPicker.
- Storybook 8 with a theme toolbar, the a11y addon, and keyboard interaction tests (play functions).
- **Visual regression:** Playwright screenshots of every story in both themes, with baselines committed and review required on change (AC-13).
- Per the component checklist in design-system §5.4.

### S3: Overlays & overlay manager · M
- Popover, Menu, ContextMenu, Dialog (sm/md/lg, dirty-close guard), Toast (stack of 3, action, `aria-live`), Banner. All on Radix.
- `OverlayManager`: a single modal stack, focus restoration, `Esc` routing (top-most first), and toast and banner queues with an imperative API (`toast()`, `banner.show(id)`).
- Stories plus visual and a11y tests.

### S4: Shell layout & routing · L *(needs PLAN-001 S3 auth, PLAN-002 S8 store)*
- TanStack Router route tree per SPEC-005 §3: public routes outside the shell, and guarded routes inside it (setup, auth, store-ready, admin).
- **Layout:** resizable and collapsible sidebar (`[`), sticky header (breadcrumb and actions slot), `<main tabindex=-1>` with focus on navigation, a skip link, and responsive drawer mode < 1024 px.
- **Sidebar M0 content** (SPEC-005 §7), live from the store: user's teams with expandable sections, "Browse teams", Settings, and the avatar menu (Profile, Theme, Keyboard shortcuts, Log out).
- **Pages:** team home placeholder, My Issues empty state, not-found, a Settings layout hosting the PLAN-001 screens.
- `ShellStore`: focus/selection context API for pages (`useCommandContext(ctx)`), sidebar width and collapse persisted in `localStorage`.
- **Tests:** AC-15 (guards), AC-16 (375 px drawer), E5 (lost team access → redirect and toast).

### S5: Shortcut engine & help overlay · M
- `apps/web/src/shortcuts/`: the registry (`shortcut({...})`), a single document `keydown` listener, scope stack (overlay, then component, then page, then global), input suppression (`isComposing`, editable targets, `[data-shortcuts=off]`), and sequences with a 1 s timeout and hint toast.
- Key matching: `event.key` for printable keys, and `event.code` for `Mod+letter` (E3; tested with AZERTY and QWERTZ via synthetic events).
- A **conflict and reserved-keys test** run in CI (AC-7).
- The `?` help overlay is generated from the registry, grouped, searchable, and filtered by build milestone (AC-8).
- M0 bindings: `Mod+K`, `?`, `[`, `Mod+,`, `Alt+Shift+T`, `Esc`, `G S`, `O T`.
- **Tests:** AC-5, AC-6, AC-7, AC-8.

### S6: Command menu · L
- `apps/web/src/command-menu/`: the Command model (SPEC-005 §4.1). **Sources:** registry operations with `ui` metadata (via `when` = context match plus a client-side permission pre-check using the shared predicate helpers on the store), navigation (route table plus live teams), and toggles.
- Ranking: a fuzzy matcher (in-house or a small library) × context boost × frecency (`localStorage`).
- **UI:** context chip, sections, nested pages using the shared Property-picker list, breadcrumb, footer hints, `Mod+Enter` run-and-keep-open, virtualisation over 50 items.
- ARIA combobox pattern and focus restore.
- Running a command calls `dispatch(op, input)` or opens the relevant UI. Errors go to a toast.
- **Perf marks:** open < 50 ms, and filter < 16 ms per keystroke with 300 synthetic commands (AC-9).
- **Tests:** AC-2 (permission filtering with a Member versus an Admin), AC-3 (context ranking), AC-4 (nested page: "Change team color…"), E4 (live permission change).

### S7: Preferences, banners & screen restyle · M
- Op `user.updatePreferences` (theme, density, font size, home view; `optimistic`; `user:<id>` group). The theme applies live, including the "system" listener (E7, AC-10).
- **System banners** wired to the PLAN-002 S10 hooks: offline (+ pending count), reconnecting, outdated (reload), live updates unavailable (3 failed upgrades), IDB unavailable (AC-14).
- Rejection toasts from `onRejected`.
- **Restyle** the PLAN-001 screens (setup, login, invite, settings) with the final components.

### S8: M0 demo, accessibility & polish · M
- **Keyboard-only M0 demo e2e (AC-1):** log in → `Mod+K` → "Create team" → submit → `O T` opens it → `?` → `Alt+Shift+T`.
- **axe sweep** (AC-12) over every shell page, the command menu, the help overlay, settings, and all Storybook stories (CI).
- Performance pass: React profiler on the sidebar and command menu under 50 teams and 500 commands.
- The final M0 exit checklist ([plans README §5](README.md#5-m0-exit-checklist)) is run and recorded.

## 2. Modules touched
`packages/ui/{tokens,src,icons}/*`, `packages/ui/.storybook/*`, `apps/web/src/{app,routes,shell,shortcuts,command-menu,preferences}/*`, `packages/operations/user/updatePreferences.ts` and its handler, `e2e/shell-*.spec.ts`, `e2e/visual/*`, CI (Storybook build, visual, axe).

## 3. Migration & rollback
`users.preferences jsonb` (or a separate `user_preferences` table), added in the S7 migration. Additive.

## 4. Test plan (AC → test)

| AC | Test |
|---|---|
| AC-1 | `e2e/m0-keyboard-demo.spec.ts` |
| AC-2 | `e2e/command-menu-permissions.spec.ts` |
| AC-3 | `web/test/command-ranking.test.ts` + e2e |
| AC-4 | `e2e/command-menu-nested.spec.ts` |
| AC-5, AC-6 | `web/test/shortcuts-engine.test.ts` + `e2e/shortcuts.spec.ts` |
| AC-7 | `web/test/shortcuts-conflicts.test.ts` (CI) |
| AC-8 | `web/test/shortcut-help.test.ts` |
| AC-9 | `e2e/perf/command-menu.perf.ts` |
| AC-10 | `e2e/preferences-sync.spec.ts` |
| AC-11 | `pnpm test:tokens` + Stylelint |
| AC-12 | `e2e/a11y.spec.ts` + Storybook a11y test runner |
| AC-13 | `e2e/visual/*.spec.ts` |
| AC-14 | `e2e/system-banners.spec.ts` (simulated conditions) |
| AC-15 | `e2e/route-guards.spec.ts` |
| AC-16 | `e2e/responsive.spec.ts` (375 × 812) |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The design system eats time before features exist | Build only the M0 inventory listed here. Later components arrive with their features. |
| Visual-regression flakiness (fonts, anti-aliasing) | Run in the pinned Playwright Docker image with bundled fonts and a small diff threshold |
| Keyboard handling bugs on non-US layouts | `key` versus `code` strategy, layout fixtures in tests, and manual checks on macOS and Windows before M0 exit |
| Radix and React 19 compatibility gaps | Pin versions. Wrap primitives in our components so swapping one is local. |
