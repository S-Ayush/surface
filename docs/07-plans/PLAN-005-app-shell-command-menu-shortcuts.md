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
> - **Not in `pnpm check`:** `test:storybook` needs Playwright's Chromium (`pnpm --filter @surface/ui exec playwright install chromium`), and `test:visual` needs Docker. Both are handed to session B as CI jobs. `pnpm test` stays Node-only: 436 ui unit tests, including the inventory guard (every S2 component has stories), helper tests and a render-cost check (best of 3, < 1 ms per instance, server-rendered).
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
| AC-12 | `e2e/a11y.spec.ts` + `pnpm test:storybook` (addon-vitest + addon-a11y, both themes) |
| AC-13 | `packages/ui/visual/stories.visual.ts` (`pnpm test:visual`, pinned Playwright image) |
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
