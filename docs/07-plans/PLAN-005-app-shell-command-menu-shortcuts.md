# PLAN-005: App shell, command menu & shortcuts (+ design-system foundations)

Implements: [SPEC-005](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md) · Design: [design-system](../05-design/design-system.md), [shortcuts](../05-design/shortcuts.md), [command-menu](../05-design/command-menu.md) · Status: **Ready**
Order: **S1–S3 run in parallel from week 1** (after PLAN-004 S1). **S4–S8 run after** PLAN-002 S8 and PLAN-001 S3.

---

## 1. Slices

### S1: Token pipeline & themes · M · ✅ Done 2026-11-06
- `packages/ui/tokens/{primitives,semantic,component}.ts` is the source. `pnpm ui:tokens` generates `tokens.css` (`:root[data-theme=light|dark]`) and typed constants.
- Bundled fonts (Inter variable, JetBrains Mono) served from the app, with `font-display: swap`. No external requests.
- Theme bootstrap script (inline, CSP-hashed) sets `data-theme` before first paint from the cached preference or `prefers-color-scheme`, to avoid a flash.
- **Contrast test** `pnpm test:tokens`: every text/background pair in both themes, ≥ 4.5:1 for text and ≥ 3:1 for meaningful icons (AC-11).
- **Stylelint rule:** no hex or rgb colours and no raw px outside the token files (AC-11, lint part).

> **As built:** Stylelint 18, Fontsource `@fontsource-variable/inter` 5.3 and `@fontsource-variable/jetbrains-mono` 5.3 (OFL, `wght` axis, `font-display: swap`, per-script `unicode-range` subsets bundled by Vite), tsx 4 for the generator.
> - **Structure:** sources `packages/ui/tokens/{primitives,semantic,component,contrast}.ts`; generator `packages/ui/scripts/build-tokens.ts` (`pnpm ui:tokens`; output is Prettier-formatted) writes `src/styles/tokens.css` and `src/tokens.gen.ts` (both committed; staleness is checked by `test/tokens-generated.test.ts`, which is the only check, as the generator has no `--check` mode). The generator also rejects a name declared in two layers. Global CSS is `@surface/ui/styles.css` (`src/styles/{fonts,tokens,base,index}.css`); `apps/web/src/styles/app.css` imports it and `main.tsx` imports that.
> - **Token naming:** primitives `--gray-1…12`, `--teal-*`, `--red-*`, `--amber-*`, `--green-*`, `--blue-*`, `--hue-<hue>` (theme-dependent, never used by components). Semantic colours as in design-system §2.1, plus `--border-control` (3:1 edge for inputs, checkboxes and switches), `--danger-hover`, `--on-danger`, `--{danger,warning,success,info}-subtle` (banner/toast surfaces) and `--label-<hue>` for the 12-hue palette. `--font-features` is `cv11, ss01`; use `--font-features-numeric` (adds `tnum`) for tables, counts and estimates. Component tokens: `--space-<px>` (0…64), `--text-<xs…2xl>-{size,line,weight}` (rem of the 13 px root, so the S7 font-size preference only changes `html { font-size }`), `--control-{sm,md,lg}`, `--row-height[-compact]`, `--radius-{xs,sm,md,lg,full}`, `--border-width`, `--focus-ring-{width,offset}`, `--icon-{sm,md,lg}`, layout widths, `--z-*`, `--dur-*`, `--ease-{in,out}`, `--motion-{shift,scale}`, and themed `--shadow-e{1,2,3}` / `--backdrop`. TS: `token.bgApp === 'var(--bg-app)'`, `LABEL_HUES`, `THEMES`.
> - **Themes:** `:root, [data-theme='light']` and `[data-theme='dark']`, so any subtree can opt into a theme (use this for side-by-side Storybook snapshots in S2); with no `data-theme`, `prefers-color-scheme` applies. `base.css` sets body font/colour/background and `:focus-visible` rings. `tokens.css` overrides `--motion-shift: 0px` and `--motion-scale: 1` under `prefers-reduced-motion` (from `reducedMotionTokens`; a test keeps the units, because a unitless 0 breaks `calc()`). Components must animate movement only through these tokens, so reduced motion leaves only the opacity fade.
> - **Theme bootstrap:** one inline script in `apps/web/index.html`, the canonical copy being `THEME_BOOTSTRAP_SCRIPT` in `@surface/ui` (behaviour tested with `node:vm` against `resolveTheme()`; `apps/web/src/styles/theme-bootstrap.test.ts` checks index.html carries it verbatim, before any stylesheet or module). Preference cache: `localStorage['surface.theme']` = `light|dark|system` (`THEME_STORAGE_KEY`); S7 writes it. Vite keeps the script byte-identical in `dist/index.html`. The server's CSP must allow it by sha256 (handoff to session A). Hash the bytes served in `dist/index.html`, not the `THEME_BOOTSTRAP_SCRIPT` constant: their whitespace differs. The web test only checks the script is in `<head>`; S2's Playwright run should assert it precedes the injected stylesheet and module on the built page.
> - **Contrast test** (`pnpm test:tokens`, also part of `pnpm test`): `USAGE` in `test/contrast.test.ts` is a complete `Record<SemanticColor, …>`, so every new semantic colour must declare its text/icon pairs or an allowed exemption before it compiles. The usage contract it encodes is in design-system §2.3: `--warning/--success/--info/--label-*` are never text, and `--accent`/`--danger` are text only on the listed surfaces.
> - **Stylelint:** root `stylelint.config.js`, `pnpm lint:css` (now part of `pnpm lint`). Rejects hex, named colours, colour functions, `px` (allowed in media queries) and physical units (`pt`, `mm`, …); the generated `tokens.css` is ignored. Tested in `packages/ui/test/stylelint.test.ts`. **Gap for S2:** inline `style={{…}}` in TSX is not linted; keep component styles in CSS Modules, or add an ESLint rule if inline styles appear.
> - **Deviations:** (1) the contrast test forced light-theme colour changes: accent `#0E8A87` → `#0A7A77` (white on it was 4.2:1), accent-hover → `#086A67`, focus ring `#2BB0AC` → `#16908C` (2.7:1), tertiary text `#666D7C` → `#5F6676` (4.3:1 on `bg-active`), and `gray-9` (`--text-disabled`, `--border-control`) darkened to light `#858B98` / dark `#68707C` for the 3:1 control edge; `bg-selected` now shares `accent-subtle`'s value and dark `bg-hover` is `#1F2329` (both within 2 RGB steps), recorded in design-system §2.1. (2) No `<link rel="preload">` for fonts: Vite does not rewrite a preload href in dev, and the stylesheet is render-blocking in `<head>`, so fonts are discovered early anyway; `swap` avoids invisible text. (3) The real-browser check (no flash, no external requests) was done by inspecting the built `dist/` only; an automated Playwright check comes with S2's visual tests.

### S2: Primitives & Storybook · L · ✅ Done 2026-11-06
- Components: Button, IconButton, Input, Textarea, Checkbox, Switch, SegmentedControl, Tabs, Kbd (platform-aware), Tooltip, Avatar/AvatarGroup, Badge, Spinner, Skeleton, ProgressBar, EmptyState, ColorPicker.
- Storybook 8 with a theme toolbar, the a11y addon, and keyboard interaction tests (play functions).
- **Visual regression:** Playwright screenshots of every story in both themes, with baselines committed and review required on change (AC-13).
- Per the component checklist in design-system §5.4.

> **As built:** Storybook **10.6.6** (`@storybook/react-vite`, addon-a11y, addon-vitest, `storybook-addon-pseudo-states` 10.6.6), Radix via the `radix-ui` 1.8 umbrella package, `lucide-react` 1.70, Vitest 5 browser mode with `@vitest/browser-playwright`, Playwright 1.65.
> - **Structure:** `packages/ui/src/components/<Name>/{Name.tsx, Name.module.css, Name.stories.tsx}` for the 17 components; shared `src/internal/{Field.tsx, control.module.css, cx.ts}`; `src/platform.tsx` (`PlatformProvider`, `usePlatform`, `detectPlatform`) and `src/keys.ts` (`parseChord`, `keyLabels`, `spokenShortcut`, `ariaKeyShortcuts`: the chord notation `"Mod+Shift+K"` / sequence `["G","I"]` from shortcuts.md, so S5's registry should reuse it; `'Mod++'` parses as Mod and `+`). Everything is exported from `@surface/ui`; React 19 is a peer dependency.
> - **Component notes:** Button defaults to `type="button"`; `loading` sets `aria-busy` and ignores clicks but stays focusable. A Button `shortcut` renders an `aria-hidden` Kbd and sets `aria-keyshortcuts` (`Mod+Enter` → `Meta+Enter` on mac, `Control+Enter` elsewhere), so the accessible name stays the label. IconButton requires `aria-label` by type. Input/Textarea are named by `label` or `aria-label`/`aria-labelledby` (a TS union), and wire hint/error through `aria-describedby` + `aria-invalid`; their edge is `--border-control`. Control hover never overrides the error border, and the focus ring follows `:has(.native:focus-visible)` (not `:focus-within`), so mouse clicks don't show it. SegmentedControl and ColorPicker are Radix **RadioGroup**s (arrow keys move and select). Kbd renders symbols `aria-hidden` plus visually hidden spoken text ("Command K", "G then S"), not `aria-label`, which axe disallows on `<kbd>`. **Tooltip needs `<TooltipProvider>` once at the app root** (500 ms delay, 300 ms skip); the S4 shell (or S3's OverlayManager) must mount it. Avatar is `role="img"` named by the person, with initials on a hashed palette hue in `--on-label` (initials are surrogate-safe); AvatarGroup passes its `size` to children through context. Skeleton fades in after 150 ms via CSS (no timers). ProgressRing (§5.1) is not built: not in the S2 list.
> - **Tokens added:** `--on-label` (text on palette fills; contrast-tested on all 12 hues), component sizes (`--avatar-{xs,sm,md,lg}`, `--presence-size`, `--checkbox-size`, `--switch-{width,height,thumb}`, `--kbd-height`, `--swatch-size`, `--progress-height`, `--spinner-stroke`, `--tooltip-max-width`, `--empty-state-max-width`, `--avatar-{xs,sm}-font`), motion (`--dur-spin`, `--dur-loop`, `--skeleton-delay`) and themed `--pressed-shade`. Component CSS has no magic numbers left.
> - **Reduced motion:** Spinner keeps its arc and pulses opacity instead of rotating; Switch thumb, ProgressBar and Skeleton stop transitioning or pulsing.
> - **Inline styles:** a shared ESLint rule (`packages/config/eslint.js`, additive) rejects hex, `px` and colour functions in `style={…}` in `apps/web`, `packages/ui` and `packages/editor` TSX, closing the S1 Stylelint gap.
> - **Storybook:** `pnpm storybook` (port 6006, telemetry, crash reports and update checks off). Toolbar globals `theme` (light/dark, sets `<html data-theme>`) and `platform` (mac/other). `parameters.a11y.test = 'error'`. Hover/active/focus states use the pseudo-states addon through `<StateCell>` and `PSEUDO_STATES` in `src/stories/helpers.tsx`.
> - **Story tests (keyboard + axe, AC-12 part):** `pnpm test:storybook` runs every story in headless Chromium twice, as Vitest projects `storybook-light` and `storybook-dark` (78 tests). Play functions cover keyboard use for Button, IconButton, Input, Textarea, Checkbox, Switch, SegmentedControl, Tabs, Tooltip, ColorPicker, plus accessible names for Kbd, Avatar, Spinner and ProgressBar. No setup file: the axe gate comes from `parameters.a11y.test = 'error'` (checked by mutation in both themes). Radix radio groups move focus on the next tick and select only while the arrow key is held, so those tests hold the key (`press()` in the story).
> - **Visual regression (AC-13):** `pnpm test:visual` builds Storybook to `packages/ui/dist/storybook` and runs `packages/ui/visual/stories.visual.ts` inside `mcr.microsoft.com/playwright:v1.65.0-noble` (**linux/amd64**, emulated on Apple silicon, about 1 minute) via `visual/run-in-docker.sh`. It snapshots every story without a play function in both themes (25 stories, 50 baselines in `visual/__screenshots__`), with animations disabled, `maxDiffPixels` 10, `threshold` 0.05 and bundled fonts (a lost Switch focus ring, about 150 px, fails). A guard test fails if a directory in `src/components` has no snapshotted story. Update with `pnpm --filter @surface/ui test:visual:update`, then review the PNG diff in the PR. Inside a container that already is the image (CI), run `pnpm --filter @surface/ui test:visual:run`.
> - **Not in `pnpm check`:** `test:storybook` needs Playwright's Chromium (`pnpm --filter @surface/ui exec playwright install chromium`), and `test:visual` needs Docker. Both were requested from session B as CI jobs; deferred by the user (2026-11-06), so for now they run only locally. `pnpm test` stays Node-only: 436 ui unit tests, including the inventory guard (every S2 component has stories), helper tests and a render-cost check (best of 3, < 1 ms per instance, server-rendered).
> - **Deviations:** visual tests live in `packages/ui/visual/` (session C's area), not `e2e/visual/` (test plan updated). Stories with play functions are not snapshotted; every component also has a static story. Primary and danger buttons gained a pressed state (inset shade). The Storybook build and Playwright output go to `packages/ui/dist/`, so no shared ignore file changed.

### S3: Overlays & overlay manager · M · ✅ Done 2026-11-06
- Popover, Menu, ContextMenu, Dialog (sm/md/lg, dirty-close guard), Toast (stack of 3, action, `aria-live`), Banner. All on Radix.
- `OverlayManager`: a single modal stack, focus restoration, `Esc` routing (top-most first), and toast and banner queues with an imperative API (`toast()`, `banner.show(id)`).
- Stories plus visual and a11y tests.

> **As built:** no new dependencies (Radix Popover, DropdownMenu, ContextMenu, Dialog, AlertDialog and Toast come from the `radix-ui` 1.8.1 umbrella already installed in S2).
> - **Structure:** `packages/ui/src/overlays/{manager.ts, layer.tsx, OverlayProvider.tsx}` and `src/components/{Popover, Menu, Dialog, Toast, Banner}/`. ContextMenu lives in `Menu/`: both render one `MenuEntry[]` list (`item`, `checkbox`, `submenu`, `label`, `separator`), so the `⋯` menu and right-click always offer the same items (FR-NAV-11). Items show shortcuts as an `aria-hidden` `<Kbd>` plus `aria-keyshortcuts`; type-ahead matches the label (`textValue`).
> - **Overlay manager:** `overlayManager` (an `OverlayManager` instance) holds the layer stack (`modal` / `popover` / `menu`), the toasts and the banners; React reads it with `useSyncExternalStore`. `toast(message | options)` returns an id (`toast.dismiss(id)`); reusing an `id` updates the toast in place and remounts it (announced again, timer restarted); generated ids never collide with chosen ones. `banner.show(id, { tone, message, action?, dismissible?, priority? })` / `banner.hide(id)`. Every Popover, Menu (and submenu), ContextMenu, Dialog and the discard confirm registers a layer while open.
> - **Stacking:** popovers, menus and dialogs share one z-index, `--z-overlay` (50), and stack in the order they open (each portals to `<body>`), so a picker or menu opened inside a dialog sits above it. The proposed popover 40 / modal 50 / command menu 60 levels put such a menu *behind* the dialog; design-system §2.5 is corrected (the `--z-popover`, `--z-modal` and `--z-command-menu` tokens are replaced by `--z-overlay`). Toasts 70 and tooltips 80 stay above.
> - **Focus restoration (`overlays/layer.tsx`):** each open layer records where focus returns: an anchored layer its Radix trigger (found by `aria-controls`), or, without one (a picker anchored to a row, a context menu), what was focused when it opened; a dialog what was focused when it opened. When that element is inside an open menu or popover (a dialog opened from a menu item), the dialog borrows that layer's target, because the item is gone once its menu closes. On close, focus goes there, or to `<main>` if it was removed (SPEC-005 §6). After an outside click focus stays where the user clicked.
> - **Esc routing:** Radix attaches `Esc` to the newest dismissable layer only, so the top-most overlay closes first. Toasts are Radix layers too, so (1) a toast raised while any overlay is open waits in the queue until it closes (otherwise it would mount above the overlay and take its `Esc`); toasts already on screen stay; (2) a toast ignores a close caused by an `Esc` pressed outside it, without `preventDefault`, so `Esc` in a focused toast closes that toast and page-level `Esc` is untouched. `overlayManager.isOverlayEscape(event)` says whether an `Esc` belonged to an overlay: `<OverlayProvider>` records it from a **window capture** listener, which runs before Radix closes the overlay. In a submenu `←` closes the submenu and `Esc` closes the whole menu (Radix, as on macOS).
> - **Dialog:** `open`/`onOpenChange` controlled, `title` required, optional `description`, `footer`, `trigger`. `dirty` routes every close (Esc, outside click, close button, `<DialogClose>`) through a "Discard changes?" AlertDialog stacked on top; its `Esc` and default focus are "Keep editing"; it closes with the dialog if the owner closes it. The close button is last in the DOM (shown top-right), so Radix's first-focusable autofocus lands on the first field. Header and footer are `div`s (a `<header>`/`<footer>` would be page landmarks). Top-aligned at 12vh so it does not jump as content grows. `Mod+Enter` submit is the S5 registry's job.
> - **Toast:** 5 s, 8 s with an action, `Infinity` allowed; at most 3 visible, the rest queue FIFO; tones neutral/success/danger (icon only, text stays `--text-primary`). Radix Toast `type="background"` = `aria-live="polite"`; the timer pauses on hover and focus; `F8` focuses the toast region (Radix default).
> - **Banner:** one shown at a time: the highest `priority`, then the oldest. Priority defaults to the tone (`BANNER_PRIORITY`: info 1, warning 2, danger 3); a banner that blocks syncing (outdated client) passes `blocking` (4). `<BannerRegion>` keeps a `role="status"` and a `role="alert"` region mounted and swaps only their content (a live region inserted with its text is often not announced); danger goes in the alert. Dismissing moves focus to `<main>`.
> - **Menus are non-modal** (`modal={false}`): a modal Radix menu marks the page `aria-hidden` while its trigger stays focusable, which axe fails (`aria-hidden-focus`). `Esc` and selecting an item return focus as before; an outside click also reaches the control clicked, and focus stays there. (A Radix modal Dialog over focusable content passes axe; checked.)
> - **Tokens:** added `--dialog-{sm,md,lg}`, `--menu-min-width`, `--popover-max-width`, `--toast-width`, `--z-overlay`; removed `--z-popover`, `--z-modal`, `--z-command-menu`. Enter animations apply only in `[data-state='open']`, so a closing overlay unmounts at once (no exit animation; design-system §2.6 "exit shorter than enter").
> - **Tests:** 20 unit tests for the manager (`test/overlay-manager.test.ts`). Story tests in both themes: Popover (keyboard, focus return, outside click, anchor-only), Menu (arrows, type-ahead, submenu, checkbox, disabled, select returns focus, context menu by pointer and keyboard, submenu open for axe), Dialog (focus trap, restore without a trigger, menu inside a dialog is on top and clickable, stacked Esc, discard confirm by Esc/close/outside click/Cancel, the question axe-checked, closed by its owner while asking, opened from a menu item, `<main>` fallback), Toast (queue of 3, polite announcement, action, page Esc untouched and not an overlay Esc, Esc in a non-newest focused toast, update re-announced, held while a dialog is open) and Banner (persistent live regions, priority, roles, dismiss focus). Each review fix was mutation-checked (undoing it fails its story); so were focus restore, the toast hold and toast Esc scoping. Visual: 7 static overlay stories × 2 themes = 14 baselines (64 in all); the spec waits for the root to be *attached*, because overlay stories render into portals. Totals: 456 ui unit tests, 136 story tests, 65 visual tests.
> - **For S4:** mount `<OverlayProvider>` once at the root (it includes `TooltipProvider`, the toast region and the `Esc` listener), place `<BannerRegion>` above the content, and give the content `<main tabIndex={-1}>` (the focus fallback). Show the outdated-client banner with `priority: BANNER_PRIORITY.blocking`. **For S5:** run page-level `Esc` only when `!overlayManager.isOverlayEscape(event)`; do not use `topLayer()` or `defaultPrevented` for this (on a real key press the overlay has already closed by the time a document listener runs). Use `topLayer()` for scope resolution of other keys: `modal` → modal scope, `popover`/`menu` → picker scope. Register `F8` ("Focus notifications") for the help overlay, and wire `Mod+Z` to the latest Undo toast when undo lands (M2). **For S6/S7:** a toast raised while an overlay stays open (command menu run with `Mod+Enter`, an open picker) appears only when it closes; show errors for an overlay that stays open inline in it.

### S4: Shell layout & routing · L *(needs PLAN-001 S3 auth, PLAN-002 S8 store)*
- TanStack Router route tree per SPEC-005 §3: public routes outside the shell, and guarded routes inside it (setup, auth, store-ready, admin).
- **Layout:** resizable and collapsible sidebar (`[`), sticky header (breadcrumb and actions slot), `<main tabindex=-1>` with focus on navigation, a skip link, and responsive drawer mode < 1024 px.
- **Sidebar M0 content** (SPEC-005 §7), live from the store: user's teams with expandable sections, "Browse teams", Settings, and the avatar menu (Profile, Theme, Keyboard shortcuts, Log out).
- **Pages:** team home placeholder, My Issues empty state, not-found, a Settings layout hosting the PLAN-001 screens.
- `ShellStore`: focus/selection context API for pages (`useCommandContext(ctx)`), sidebar width and collapse persisted in `localStorage`.
- The web client's store registers `PRODUCTION_MODELS` (`@surface/domain/model`), so its schema hash matches the server's (session E handoff, PLAN-001 S1).
- **Tests:** AC-15 (guards), AC-16 (375 px drawer), E5 (lost team access → redirect and toast).

> **As built (in progress, 2026-11-07; not Done until PLAN-001 S3):** everything except real sign-in. The server has no sessions yet, so the app runs signed out: `preAuthClient` reads the setup state from `GET /setup/status` (PLAN-001 S2), reports no session, and every shell route leads to `/login`. The HTTP auth client, the login page, `?next=` after a real login and the 401 redirect are the web half of PLAN-001 S3, which session A's split of S3 (relayed 2026-11-07) gives to this session; they are added when A's server half lands.
> - **Dependencies (justified):** `@tanstack/react-router` (^1.170.46, ADR-0004) and `lucide-react` (^1.70.0, the version `packages/ui` already uses; one copy in the lockfile) in `apps/web`.
> - **Structure:**
>   - `app/router.tsx`: the code-based route tree (SPEC-005 §3, SPEC-001 §7). Public routes under the root, without the shell; the rest under the pathless `shell` route. Paths are literal in each `createRoute` so the tree keeps its types. The guards run in `beforeLoad` after `auth.ready()`, redirecting with a relative `href` (`throw: true`, so no thrown non-Error). `createAppRouter(app, environment?)` takes a memory history, an origin, `isServer` and `scrollRestoration` for tests.
>   - `app/guards.ts`: the pure guard (`guard`, `adminAccess`, `safeNext`, `loginFor`). `path` is the whole address, so `next` keeps the query.
>   - `app/auth.ts`: `AuthClient` (capabilities, session, logout), `AuthState` (an observable snapshot: loading, ready or failed; `ready()` resolves to the current snapshot, so the guards see a logout), `preAuthClient`.
>   - `app/AppModel.ts`: auth, the open store, and live reads for the command menu and the shell (`actor`, `isAdmin`, `teams`, `team(key)`, `workspaceName`, `userName`). `app/workspace.ts` holds the pure parts (`myTeams`, `actorOf`, `teamByKey`, `teamPageState`).
>   - `app/ShellRoute.tsx`: one `SyncStore` per session (`PRODUCTION_MODELS`, so the schema hash matches the server's), keyed by workspace and user. `onSessionRevoked` signs out (the guards then send the user to `/login`), and `onRejected` shows a toast. `StoreGate` shows the bootstrap progress bar, or a reload prompt when the store failed or is outdated.
>   - `shell/`: `Shell` (skip link, sidebar, resize handle, `<main tabindex=-1>`, live region), `Sidebar`, `AvatarMenu`, `PageHeader` (breadcrumb, actions slot, sidebar button), `ShellStore` (width, collapse, drawer, expanded teams, announcement; persisted in `localStorage['surface.shell']`, Zod-validated), `layout.ts` (breakpoints and widths), `usePageTitle`.
>   - `pages/`: My issues (empty state), team home (sets the `team` command target; E5), not-found (in and outside the shell), `SettingsPage` (section nav, admin sections), `PublicPage`.
>   - `App.tsx` wires `<CommandMenuProvider actor store navigate teams route>` above `<RouterProvider>` (so pages can set the target) and re-runs the guards when the auth snapshot changes. `useObserved` compares structurally with `app/equal.ts`, because MobX 7 no longer exports `comparer`.
> - **PLAN-001 screens:** the router owns their URLs; the screens plug in through `features/screens.ts` (`SCREENS`, keyed by `ScreenId` in `app/screens.ts`, a new shared append-only file, sessions README §7). A route without a screen shows "… isn't available yet". `/setup` renders PLAN-001 S2's `routes/setup/SetupPage` directly (A's handoff), and `main.tsx` no longer switches on the path; the Vite proxy for `/setup/status` and `POST /setup` stays.
> - **Deviations and decisions, recorded in SPEC-005 §3, §6, §7 and E5:** admin-only routes are Members and Workspace, decided in the page because the role comes from the store. E5 fires when the team leaves the replica while its page is open (a public team the user leaves stays). The drawer is a non-modal overlay. Titles are announced when the page sets them. The sidebar has no logo, `New` or `[+]` in M0, and teams are sorted by name. `/` always opens My issues until S7 adds the home preference.
> - **Tests (unit; web 233 before the review, 248 after):**
>   - `shell-guards.test.ts`: AC-15 rules, `safeNext`, `next` with a query.
>   - `app-router.test.tsx`: AC-15 through the real route tree with a memory history: `next` with the query, setup redirects, a signed-in login page following a safe `next`, defaults for `/` and `/settings`, guards re-run after logout, the error page when auth fails, the setup wizard and a public page without the shell.
>   - `app-auth.test.ts`: `preAuthClient`.
>   - `shell-layout.test.ts`: AC-16 layout modes, clamping, `[` per mode, persistence and bad storage, announcements.
>   - `shell-workspace.test.ts`: `myTeams`, `actorOf`, `teamByKey`, E5 `teamPageState`.
>   - `app-equal.test.ts` and `theme-toggle.test.ts` (theme preference).
>
>   AC-15 and AC-16 e2e are ⏸ held. The App skeleton test is gone with the skeleton page.
> - **Checked by hand in Chromium** (dev server with a temporary fake session and an in-memory store, reverted):
>   - `/` → My issues; the sidebar lists only the user's teams.
>   - Disclosure and active links; focus on `<main>` after navigation, with the new title announced.
>   - E5: removing ENG while on `/team/ENG` goes home with the toast, and the sidebar updates.
>   - Settings nav: as a Member, Workspace and Members disappear and `/settings/members` shows not-found, applied live on a role change.
>   - Not-found in and outside the shell.
>   - `[` collapses, and "Show sidebar" brings the sidebar back.
>   - Avatar menu: the Theme submenu applies, and Log out goes to `/login?next=%2Fmy-issues`.
>   - `Mod+K` on a team page shows the ENG chip.
>   - At 375 px (an iframe; the window could not be resized): no horizontal scroll, the drawer opens with focus inside, Esc closes it and focus returns to the button, navigating from it focuses `<main>`, and the settings nav becomes a row.
>   - No console errors.
> - **Not checked:** a real bootstrap against the server (no session before S3), the store's progress and failure states, and the setup wizard in the browser through the router (covered by the router test and A's tests).
> - **Review (slice-reviewer, 0 blockers, 3 majors, 9 minors, 7 nits), all fixed except one nit (follow-up below):**
>   - **M1:** the Member → not-found clause of AC-15 was only tested on the pure guard. The settings sections are now one table (`app/settings.ts`, `SETTINGS`: screen, title, admin flag, nav link) read by the router and the nav (`settingsNav`). `settings-page.test.tsx` server-renders `SettingsPage` in a one-route memory router: a Member gets not-found on Members and Workspace, an Admin gets the section, an unknown role a spinner, and a Member's nav lists no admin section.
>   - **M2:** E5's "seen" tracking is the pure `observeTeam(previous, key, present)` with `lostTeamMessage(key)`, tested as sequences (lost after shown, never visible, moving between teams, key case).
>   - **M3:** the auth reaction is `followAuth(app, router)` (`app/router.tsx`). The router test changes only the auth state: a revoked session lands on `/login?next=…`, an explicit logout on `/login`. The first load does not re-run the guards. The avatar menu no longer invalidates the router itself.
>   - **Minors:**
>     - m1: the login page is matched in any case, in the guard and in `safeNext`.
>     - m2: when the sidebar appears or goes and focus went with the removed control ("Show sidebar", the resize handle), focus moves into the sidebar or onto the header's sidebar button.
>     - m3: dragging previews the width and saves it once, on pointer-up, cancel or lost capture (`previewWidth`/`commitWidth`).
>     - m4: after an explicit logout the guards send the user to `/login` without `next` (`loggedOut` in the auth snapshot); a revoked session keeps `next`.
>     - m5: the command menu gets `navigate` only while signed in.
>     - m6: `gateView` (`app/gate.ts`) shows the progress, failure and outdated screens only before the first `ready`, so a resync keeps the page. An outdated store after that raises the persistent "Surface was updated. [Reload]" banner (`blocking` priority). `<BannerRegion>` is mounted at the top of `<main>`. The other §8 banners are S7.
>     - m7: a test reads `DRAWER_QUERY` as a browser would and checks it switches where `layoutMode` does.
>     - m8: these docs, and SPEC-005 Q1.
>     - m9: `'admin'` left `Access`; `adminAccess` is the admin check.
>   - **Nits:** the first auth load does not invalidate; the drawer closes when the layout becomes full, and when any link in it is clicked (focus to `<main>`); teams sort with the `en` locale; the standalone not-found and error pages' `<main>` take focus.
>   - **Follow-up, not changed:** the avatar menu's Theme items are checkbox items for a one-of-three choice; `packages/ui` `Menu` needs a radio item type (S7 or S8). Before setup, an address that matches no route shows not-found rather than `/setup`; the server already sends every page to `/setup` until setup is done (PLAN-001 S2).
>   - Mutation-checked: 17 mutants, all caught.
>   - Rechecked by hand in Chromium (iframes at 1100 and 375 px, temporary fake session, reverted):
>     - "Show sidebar" focuses the sidebar; `[` on the resize handle focuses "Show sidebar";
>     - the drawer stays closed after a resize to full width and back;
>     - a drawer link to the current page closes the drawer with focus on `<main>`, and one to Settings navigates;
>     - logout lands on `/login`;
>     - on `/login` the command menu offers no navigation.
>   - Web tests 248.
> - **Feature hooks (2026-11-07, after the merge, for session E's PLAN-001 S8 web half):** `features/hosts.ts`, shared and append-only (README §7), with `SHELL_HOSTS` (mounted once by `Shell` through `FeatureHosts`) and `TEAM_MENU` (the team page header's ⋯ through `TeamMenuSlot`). The catalog has `form:create-team` ("Create team…"), and the sidebar shows its `+` (`CreateTeamButton`) only while a handler is registered. Tests: `web/test/shell-hosts.test.tsx`.
> - **Open until S3:** the HTTP `AuthClient` (`/auth/capabilities`, a current-session endpoint, `/auth/logout`), the login page and its `next`, the 401 redirect, a real bootstrap, then ✅ Done.

### S5: Shortcut engine & help overlay · M · ✅ Done 2026-11-07
- `apps/web/src/shortcuts/`: the registry (`shortcut({...})`), a single document `keydown` listener, scope stack (overlay, then component, then page, then global), input suppression (`isComposing`, editable targets, `[data-shortcuts=off]`), and sequences with a 1 s timeout and hint toast.
- Key matching: `event.key` for printable keys, and `event.code` for `Mod+letter` (E3; tested with AZERTY and QWERTZ via synthetic events).
- A **conflict and reserved-keys test** run in CI (AC-7).
- The `?` help overlay is generated from the registry, grouped, searchable, and filtered by build milestone (AC-8).
- M0 bindings: `Mod+K`, `?`, `[`, `Mod+,`, `Alt+Shift+T`, `Esc`, `G S`, `O T`.
- **Tests:** AC-5, AC-6, AC-7, AC-8.

> **As built:** no new dependencies for the engine. A separate commit before it adds `zod` (^4.6.7, already in the lockfile) to `apps/web` for `src/zod-config.ts` (`z.config({ jitless: true })`, imported first in `main.tsx`; `src/zod-config.test.ts` checks both). That closes session A's PLAN-004 S9 handoff: no `script-src eval` report from Zod's probe under the CSP. Checked by unit test only, not on a CSP-served build.
> - **Structure:** `apps/web/src/shortcuts/`:
>   - `chord.ts`: parsing and matching;
>   - `registry.ts`: `shortcut()`, `SHORTCUTS`, `SCOPES`;
>   - `conflicts.ts`: `findConflicts`, `findReserved`, `findInvalid`, `RESERVED_SHORTCUTS`;
>   - `engine.ts`: `ShortcutEngine`, DOM-free, takes a structural key event;
>   - `milestone.ts`: `BUILD_MILESTONE = 'M0'`;
>   - `help.ts` and `ShortcutHelp.tsx`: the `?` dialog;
>   - `ShortcutProvider.tsx`: the document listener, `useCommand`, `usePageScope`, hint toasts.
>
>   Commands live in `apps/web/src/commands/`: `catalog.ts` (`COMMANDS`, id → title; ids follow SPEC-005 §4.1, e.g. `nav:settings`, `toggle:theme`) and `registry.ts` (`CommandRegistry`). The registry holds runtime handlers `{ run, when? }` at a level, `app` < `page` < `overlay`. The highest level wins, and within a level the newest registration; unmounting restores the previous handler. Precedence is explicit because React runs a child's effects before its parent's: by mount order, a page's override would lose to the shell on a deep-link load and win after in-app navigation (review M2). `useCommand(id, run, { when?, level? })` registers once per id and level; `run` and `when` are read fresh on each key press. `App.tsx` now mounts `<OverlayProvider>` and `<ShortcutProvider>` around the placeholder page.
> - **Bindings (M0):** `Mod+K`, `?`, `[`, `Mod+,`, `Alt+Shift+T`, `Esc`, `G S`, `O T`, `F8` (`native`: Radix's toast region handles it; it is listed in help and conflict-checked, but not dispatched) and `Mod+Enter` (`modal` scope, `shortcuts/dialogSubmit.ts`). It submits the form of the focused control (including a `form="id"` footer button) with that form's default submit button. It is unavailable while that button is `disabled` or `aria-busy`, as for a plain Enter, so it cannot submit twice while a request is in flight.
>   - **Working now:** `?` (help) and `Alt+Shift+T`. The theme toggle is local until S7: it flips `data-theme` and writes `localStorage['surface.theme']`, and S7 routes it through `user.updatePreferences`.
>   - **No handler yet:** the others show "<title> isn't available here" (a 2 s toast) until their slice registers one with `useCommand(id, run, { when?, level? })`. S4: `toggle:sidebar`, `nav:settings`, `ui:escape`. S6: `ui:command-menu`, `nav:open-team`. `Esc` stays silent.
> - **Engine rules:**
>   - **Scope order:** overlay (`topLayer()`: `modal` → modal, `popover`/`menu` → picker), then component scopes (`data-shortcut-scope="list"` on an ancestor of the focused element, innermost first), then page scopes (`usePageScope`, newest first), then `global`.
>   - **Suppression** applies to every key of a sequence, not just the first (review M1): `G` then `S` typed into a field is text, and a menu opened between the keys stops it. While typing (text inputs, textarea, select, contenteditable, `[data-shortcuts="off"]`), only `Mod`/`Ctrl` chords and `Esc` fire. An open overlay also disables page scopes and plain global keys (SPEC-005 §5 "Overlay capture", added here), so a menu's type-ahead cannot start `G S`.
>   - **Sequences:** 1 s timeout. A hint toast (`G… S: Go to settings`) stays until the sequence ends. A key that does not continue the sequence ends it and is then read on its own.
>   - **Ignored keys:** IME composition (`isComposing`, keyCode 229), modifier-only keys, held-down repeats, and events a component already `preventDefault`ed (this is how the M1 editor takes `Mod+K`, E1).
>   - **Page `Esc`:** runs only when `!overlayManager.isOverlayEscape(event)` (S3 handoff).
>   - **Failures:** a command that throws or rejects shows a danger toast.
> - **Key matching (E3, refined in SPEC-005):**
>   - Letters with `Mod`, `Ctrl` or `Alt` match `event.code`. `Alt` is included because Option changes `event.key` on macOS.
>   - Plain letters match `event.key`, case-insensitively, with Shift compared exactly. When the layout types a letter outside A–Z (Cyrillic, or `é` from a dead key), they fall back to `event.code`.
>   - Other characters match `event.key`. Shift, Option and AltGr are not compared, so `[` typed with AltGr+5 on AZERTY works. `toChord` therefore rejects `Shift+<symbol>` (write `?`) and `Alt+<symbol>` (it could not be told apart from the plain symbol). `Mod+<symbol>` must be pressed without Option or AltGr.
>   - Named keys match `event.key` with exact modifiers.
>   - **For M1:** `Mod+Shift+7`, `Mod+Shift+.` and `Mod+Shift+,` (shortcuts.md §3.4, §3.7) are rejected by this rule. Decide code-based matching for Mod+Shift+symbol when they land.
> - **Conflicts (AC-7):**
>   - Two bindings conflict when their scopes overlap and one's keys equal or begin the other's. The check runs on both platforms (`Mod+K` = `Ctrl+K` off macOS).
>   - Overlaps: `global` overlaps everything. The other pairs are in `OVERLAPPING`; for example, `modal` overlaps `editor` but not `list`.
>   - Page scopes (`inbox`, `triage`) overlap every component scope.
  - A deliberate override names the other binding in `shadows`, and only a less specific scope may be shadowed: global < page < component < overlay (`findInvalid`). The reserved list is checked in every chord of a sequence.
> - **Help (AC-8):**
>   - The help is a `Dialog` (lg) with a search field, focused on open, and groups in registry order (General, Navigation, Dialogs and pickers).
>   - It lists only bindings with `milestone ≤ BUILD_MILESTONE`. The engine gets the same set from `inBuild()` in `registry.ts`.
>   - Each query word must begin a word of the title or group; only the last word, still being typed, may be one letter ("go to s" finds settings, while "g s" is a key search). A query can also match the start of the keys as written, shown or spoken (`g s`, `⌘k`, `command k`).
>   - A persistent `role="status"` paragraph says when nothing matches.
> - **Tests:**
>   - 112 web unit tests in all.
>   - `test/shortcuts-engine.test.ts` covers AC-5, AC-6, E2, E3 (US, AZERTY, QWERTZ, Russian, Mac Option), scopes, the overlay rules, `Esc` and unavailable commands.
>   - `test/shortcuts-conflicts.test.ts` covers AC-7, and `test/shortcut-help.test.tsx` covers AC-8 (pure grouping plus a server render). `commands-registry.test.ts` (levels, `when`, errors), `dialog-submit.test.ts` (default button, disabled and busy), `shortcut-hints.test.ts` (hint text, quiet over an overlay) and `theme-toggle.test.ts` cover the rest.
>   - The engine tests use DOM-free fakes (`test/shortcut-fakes.ts`), since no DOM library is installed for unit tests.
>   - Mutation-checked: removing typing suppression, overlay capture, the page-scope gate, Alt-by-code, AltGr, the non-Latin fallback guard, the sequence timeout, the IME guard, quiet `Esc`, prefix conflicts, the both-platforms check, the help and engine milestone filter (`inBuild`), the gate on a sequence's second key, command levels, the last-word search rule, `Alt+<symbol>` rejection, Option on `Mod+,`, override direction, the editor/page overlap, the disabled-submit guard and the quiet hint over an overlay each fails a test. Not unit-tested (no DOM): picking the focused form and passing its submitter to `requestSubmit`.
> - **Checked by hand (e2e held):** in Chromium (headless Playwright), via a throwaway script on `pnpm --filter @surface/web dev` at port 5174:
>   - `?` opens help with focus in the search; it shows 10 rows in 3 groups.
>   - Searching "theme" leaves 1 row; "zzz" shows the empty message.
>   - `Esc` closes help.
>   - `Alt+Shift+T` flips the theme and caches it.
>   - `G` shows the hint, which goes after 1 s. `G S` and `Mod+K` show "not available here".
>   - Typing `g?[` in the search field types text only.
>   - No console errors.
> - **For S4/S6:**
>   - Register handlers with `useCommand` inside `<ShortcutProvider>`. The shell uses the default `app` level, a page that overrides a shell command passes `level: 'page'`, and an overlay passes `'overlay'`.
>   - Give focusable regions `data-shortcut-scope`, and call `usePageScope` for page scopes.
>   - S6's command model should reuse `COMMANDS` ids and `CommandRegistry.isAvailable` for `when`. `when` takes no context yet; S6 adds `CommandContext`.

### S6: Command menu · L · ✅ Done 2026-11-07
- `apps/web/src/command-menu/`: the Command model (SPEC-005 §4.1). **Sources:** registry operations with `ui` metadata (via `when` = context match plus a client-side permission pre-check using the shared predicate helpers on the store), navigation (route table plus live teams), and toggles.
- Ranking: a fuzzy matcher (in-house or a small library) × context boost × frecency (`localStorage`).
- **UI:** context chip, sections, nested pages using the shared Property-picker list, breadcrumb, footer hints, `Mod+Enter` run-and-keep-open, virtualisation over 50 items.
- ARIA combobox pattern and focus restore.
- Running a command calls `dispatch(op, input)` or opens the relevant UI. Errors go to a toast.
- **Perf marks:** open < 50 ms, and filter < 16 ms per keystroke with 300 synthetic commands (AC-9).
- **Tests:** AC-2 (permission filtering with a Member versus an Admin), AC-3 (context ranking), AC-4 (nested page: "Change team color…"), E4 (live permission change).

> **As built:** one new dependency in `apps/web`: `mobx` (^7.1.5), already in the workspace through `sync-client` and resolved to a single copy (7.1.5), so a `reaction` in the menu tracks the store's observables (E4). Fuzzy matching, frecency and virtualisation are in-house.
> - **Structure:** `apps/web/src/command-menu/`:
>   - `model.ts`: `Command`, `CommandContext`, `CommandTarget`, `CommandPage`, `SECTIONS`;
>   - `fuzzy.ts`, `frecency.ts` and `ranking.ts`: the §4.2 score;
>   - `state.ts`: a pure reducer and `keyToAction` (arrows, `Ctrl+N`/`Ctrl+P`, `Tab` per section, `Enter`, `Mod+Enter`, `Backspace`);
>   - `reactive.ts`: `watch` and `useReactive`, a MobX `reaction` that re-ranks when anything read by `when` changes (the reaction runs the ranking once more when it subscribes, to learn its reads; the `command-menu:filter` measure records whichever run came last, the same work either way);
>   - `context.ts`: `TargetStore`, `useCommandContext(target, level?)` and `useCurrentTarget()`. Precedence is by level (`page` < `focus` < `selection`), the newest winning only within a level, as for command handlers; a changed label updates the entry in place;
>   - `pages.ts`: `colorPage` (the 12 label hues);
>   - `sources/`: `operations.ts`, `navigation.ts`, `app.ts`, `shortcuts.ts`;
>   - `CommandMenu.tsx`: the view; `CommandMenuProvider.tsx`: mounts it inside `<ShortcutProvider>` and registers `ui:command-menu` (`Mod+K` toggles) and `nav:open-team` (`O T` opens on the teams page).
>
>   In `packages/ui`: `Dialog` gains `variant="command"` (title and description visually hidden, no header or close button; width from the new `command-menu-width` token, 640 px), and `VisuallyHidden` is exported.
> - **Deviations, recorded in SPEC-005 §4.1–4.2:**
>   - `CommandContext` is `{ route, target, actor, store, navigate?, teams }`. `target` merges the spec's `focused` and `selection` and carries the chip label.
>   - `Command` has `appliesTo` next to `when`. `when` decides whether the command is offered (context match and permission); `appliesTo` decides Suggested and the ×2 boost. With no target, Suggested holds the global commands.
>   - `title` is a string for now; context-dependent titles arrive with the M1 commands that need them.
>   - The permission pre-check runs the operation's predicates bound to the actor, with the references from the command's `refs(ctx)` and no input. A predicate that throws because it needs the input does not hide the command: the server decides.
> - **Operation commands** are the registry operations with `ui` metadata that are not `internal` or `deprecated` and have an entry in `OPERATION_COMMANDS` (`apps/web/src/features/commands.ts`, a shared append-only file since the review: each feature keeps its entries in `features/<feature>/commands.ts` and adds one spread line, sessions README §7). An entry gives exactly one of `run(ctx, op)`, `page(ctx, op)` or `opens: CommandId` (a form registered with `useCommand`; hidden until registered), and optionally `section` and `refs`. `checkOperationCommands` (run by a unit test on the real registry) reports an operation with `ui` and no entry, an entry naming no operation, an entity-scoped entry without `refs`, a `ui.shortcut` no binding uses, and an entry not offered in its first context to a user every permission allows. Operation shortcut hints show only keys the shortcut registry binds in this build. The map is empty in M0 because no operation with `ui` metadata is on `main` yet.
> - **Running:** `state.ts` `execute(row, keepOpen, ctx)` decides what an option does (run, open its page, or report a page that cannot be built), and the view applies it. A click runs the clicked row (`optionHandlers`), a key the selected one. `Enter` closes the menu and the command runs from the dialog's new `onClosed` (`Dialog` in `packages/ui`, called from Radix `onCloseAutoFocus` after focus is restored), so a dialog it opens returns focus to where it was, and focus it moves is not taken back. `Mod+Enter` runs it and keeps the menu open; an error then shows inline (`role="alert"`), while after `Enter` it goes to a toast. Each run is recorded for frecency (per user, `localStorage` key `surface.commandFrecency.<userId>`, `anonymous` before sign-in, validated with Zod, at most 200 entries).
> - **ARIA:** combobox input with `aria-activedescendant` and `aria-controls`, a listbox of options with `aria-setsize`/`aria-posinset` (so they stay correct when virtualised) and `aria-keyshortcuts`, a visually hidden results count (`role="status"`). Section headers are `role="presentation"` and hidden; each option names its section through `aria-describedby` (pointing at hidden labels outside the virtualised list). The selection follows the row the user pointed at (by id), so rows coming or going above it do not move it. The menu ignores keys while an IME composes (`isComposing`, `keyCode` 229), a held `Backspace` never closes a page or drops the chip, and `Ctrl+N`/`Ctrl+P` move only on macOS (command-menu.md §4 updated). Above 50 rows only the rows in view plus 8 either side are rendered (`visibleRange`).
> - **Tests (unit):** `command-ranking.test.ts` (AC-3, ranking, fuzzy), `command-operations.test.ts` (AC-2 unit part with fixture operations for Admin and Member, the `OPERATION_COMMANDS` coverage check, E4 through a MobX observable), `command-menu-state.test.ts` (keyboard table, IME and repeat, selection by id, `execute` and click handlers, AC-4 unit part with "Change team color…" including Enter applying it, E4 on an open page, `visibleRange`), `command-sources.test.ts`, `command-frecency.test.ts`, `commands-registry.test.ts` (`invoke`, handlers observed by an open menu), `command-target.test.ts` (target precedence by level, in-place relabels). A predicate that throws on the empty input is covered by a fixture (`team.archiveMany`). AC-2 and AC-4 e2e and the AC-9 perf test are ⏸ held.
> - **Checked by hand in Chromium** (dev server, Playwright script, not committed):
>   - `Mod+K` opens with focus in the input; arrows move `aria-activedescendant`; typing filters and highlights; `Enter` runs and closes with focus restored; `Mod+Enter` runs and stays open; `Mod+K` closes; "No results"; `O T` without navigation says "Open team… isn't available here".
>   - After the review fixes: with focus on `<main>`, `Enter` on "Keyboard shortcuts" opens help with focus inside it, and closing help returns focus to `<main>`; hovering "Toggle light and dark theme", pressing `ArrowDown` and clicking without moving runs the theme toggle (not help); options are described by their section ("Settings"). No console problems.
>   - With 300 synthetic teams passed in temporarily (305 commands): 17 options rendered at first and 26 after 120 × `ArrowDown`, the active option in the DOM with `aria-posinset` 121 of 305; filter 0.1–0.7 ms per keystroke; open 1.7–2.3 ms (AC-9 budgets: 16 ms and 50 ms). `O T` opens the teams page, typing and `Enter` navigates, `Backspace` returns from a page. No console errors or warnings.
> - **For S4 and session E:**
>   - S4 passes `actor`, `store`, `navigate`, `teams` (live, sidebar order) and `route` to `<CommandMenuProvider>`; navigation commands and `O T` stay hidden until `navigate` is passed. Pages call `useCommandContext(target)` to set the context chip (a team page: `{ kind: 'team', ids: [id], label: key }`); a focused component passes `'focus'` and a selection `'selection'`, so a nested view wins over its layout whatever the mount order.
>   - Session E adds entries in `features/<feature>/commands.ts` and one line in `features/commands.ts` per feature (for `team.create`, `opens` the create-team dialog's command; handoff in session-c2). The coverage test points at any that are missing. Permission predicates should check the role before reading input (SPEC-005 AC-2 note).
> - **Review (slice-reviewer, 0 blockers, 5 majors, 11 minors, 7 nits), fixed:** a click ran the selected row instead of the clicked one; Enter confirming an IME composition ran a command; the command ran before Radix restored focus; the run logic had no tests; session E could not edit the operation-commands map (moved to the shared `features/commands.ts`). Minors: selection by id, held Backspace, `Ctrl+N` outside macOS, guarded `appliesTo`/sources/page items, E4 on an open page (it closes with "… isn't available anymore."), the throwing-predicate fixture, code-point highlight indices, docs (SPEC dated note, `icon` M1, identifier fast path M1, AC-2 note), section names announced, app commands observed while open (`CommandRegistry` has a MobX revision and `invoke`). Nits: frecency keyed on the user only, `appliesTo` from `ui.contexts`, `opens` errors inline after `Mod+Enter`, scroll maths include the list padding, hue dots as an inline `var(--label-<hue>)`. Not changed: `aria-expanded` stays `true` (the listbox is always shown); the double ranking run per input change and its measure (timing the render-time run alone needs `performance.now()` during render, which the React Compiler lint rejects; the second run is the same < 1 ms of work).
> - **Second review (0 blockers, 1 major, 4 minors, 5 nits), fixed:** the command target let the newest registration win, so a layout beat the view inside it on a reload (now levels, like command handlers, with in-place relabels); the entry check above replaces a names-only test; unbound operation shortcuts are no longer shown; "No results" moved out of the listbox; tests for the 200-entry frecency cap. Nits: SPEC §4.2 says Suggested takes precedence over the ×2; a store change between render and subscription refreshes the menu (`track`); a comment on tabs overwriting each other's frecency; command-menu.md marks the identifier fast path M1; rebased onto `08f2ccd`.
> - **Gaps:** no automated check that `Dialog`'s `onClosed` runs after focus is restored (needs a DOM test environment, which `apps/web` and `packages/ui` don't have; traced in Radix 1.3.1 and checked by hand in Chromium). No Storybook story or visual snapshot for `Dialog variant="command"` (Storybook and visual tests deferred by the user; a new story without its snapshot would fail `pnpm test:visual`), so add both when those tests resume. Nested pages use the menu's own list, not a shared Property-picker list: none exists yet. The Property picker (M1) should reuse `CommandPage`/`PageItem` or replace both.

### S7: Preferences, banners & screen restyle · M
- Op `user.updatePreferences` (theme, density, font size, home view; `optimistic`; `user:<id>` group). The theme applies live, including the "system" listener (E7, AC-10).
- **System banners** wired to the PLAN-002 S10 hooks: offline (+ pending count), reconnecting, outdated (reload), live updates unavailable (3 failed upgrades), IDB unavailable (AC-14).
- Rejection toasts from `onRejected`.
- **Restyle** the PLAN-001 screens (setup, login, invite, settings) with the final components.

### S8: M0 demo, accessibility & polish · M
- ⏸ **Held (SPEC-005 D1):** the demo e2e is not written for now; run the demo by hand and record it in "As built".
- **Keyboard-only M0 demo e2e (AC-1):** log in → `Mod+K` → "Create team" → submit → `O T` opens it → `?` → `Alt+Shift+T`.
- **axe sweep** (AC-12) over every shell page, the command menu, the help overlay, settings, and all Storybook stories (CI).
- Performance pass: React profiler on the sidebar and command menu under 50 teams and 500 commands.
- The final M0 exit checklist ([plans README §5](README.md#5-m0-exit-checklist)) is run and recorded.

## 2. Modules touched
`packages/ui/{tokens,src,icons}/*`, `packages/ui/.storybook/*`, `apps/web/src/{app,routes,shell,shortcuts,command-menu,preferences}/*`, `packages/operations/user/updatePreferences.ts` and its handler, `e2e/shell-*.spec.ts`, `e2e/visual/*`, CI (Storybook build, visual, axe).

## 3. Migration & rollback
None. Preferences are the `UserPreferences` model added by PLAN-001 S1 (its own row, id = the user's id, `values` json, synced to `user:<id>`); S7 only shapes `values` in `user.updatePreferences`.

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack or Postgres are held** since 2026-11-06 (SPEC-005 D1, [plans README §6](README.md#6-testing-hold-e2e-smoke-and-integration)): rows marked held get no test for now, and the markers override the slices' "Tests:" bullets. Unit and property tests in the same row are still written, and so are the sync property suite and private-team leak tests.

| AC | Test |
|---|---|
| AC-1 | ⏸ held (e2e) `e2e/m0-keyboard-demo.spec.ts` (demo run by hand) |
| AC-2 | `web/test/command-operations.test.ts` (unit part) + ⏸ held (e2e) `e2e/command-menu-permissions.spec.ts` |
| AC-3 | `web/test/command-ranking.test.ts` (+ e2e, ⏸ held) |
| AC-4 | `web/test/command-menu-state.test.ts` (unit part) + ⏸ held (e2e) `e2e/command-menu-nested.spec.ts` |
| AC-5, AC-6 | `web/test/shortcuts-engine.test.ts` (+ `e2e/shortcuts.spec.ts`, ⏸ held) |
| AC-7 | `web/test/shortcuts-conflicts.test.ts` (CI) |
| AC-8 | `web/test/shortcut-help.test.tsx` |
| AC-9 | ⏸ held (perf) `e2e/perf/command-menu.perf.ts` (checked by hand in S6) |
| AC-10 | ⏸ held (e2e) `e2e/preferences-sync.spec.ts` |
| AC-11 | `pnpm test:tokens` + Stylelint |
| AC-12 | `pnpm test:storybook` (addon-vitest + addon-a11y, both themes) (+ `e2e/a11y.spec.ts`, ⏸ held) |
| AC-13 | `packages/ui/visual/stories.visual.ts` (`pnpm test:visual`, pinned Playwright image) |
| AC-14 | ⏸ held (e2e) `e2e/system-banners.spec.ts` (simulated conditions) |
| AC-15 | `web/test/shell-guards.test.ts`, `web/test/app-router.test.tsx`, `web/test/settings-page.test.tsx` (unit parts) + ⏸ held (e2e) `e2e/route-guards.spec.ts` |
| AC-16 | `web/test/shell-layout.test.ts` (unit part) + ⏸ held (e2e) `e2e/responsive.spec.ts` (375 × 812) |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The design system eats time before features exist | Build only the M0 inventory listed here. Later components arrive with their features. |
| Visual-regression flakiness (fonts, anti-aliasing) | Run in the pinned Playwright Docker image with bundled fonts and a small diff threshold |
| Keyboard handling bugs on non-US layouts | `key` versus `code` strategy, layout fixtures in tests, and manual checks on macOS and Windows before M0 exit |
| Radix and React 19 compatibility gaps | Pin versions. Wrap primitives in our components so swapping one is local. |
