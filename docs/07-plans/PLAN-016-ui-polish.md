# PLAN-016: Linear-grade UI polish

Implements: [design-system v0.2](../05-design/design-system.md) (decisions D-a to D-f in its §8) · [command-menu v0.2](../05-design/command-menu.md) · decisions SPEC-005 D4 and SPEC-012 D32 · Source: the [2026-11 Linear UI gap audit](../05-design/audits/2026-11-linear-ui-gap-audit.md) (reference, not a spec) · Status: **Ready** · Date: 2026-11-25
Order: **S0 and S1 first, in parallel.** S2 and S3 after S1. S4 after S3. S5 after S2. S6, S7 and S8 after S1 to S3. Runs **before M2 build work** (D-b, the user's decision of 2026-11-25).

---

## 1. Problem & goal

M1 works, but it does not yet feel finished next to Linear. The audit found three kinds of gap:

- **Visible bugs:** default purple breadcrumb links, three focus rings on one text field, a ring that leaks into the command menu, and an issue title that sits off the description's left edge.
- **Missing craft:** no layering (content is painted straight on the app layer), a 1 px line under every row, flat type weights, single-blur shadows, overlays that vanish instead of fading out, and states (hover, focus, selection) that look alike.
- **Missing patterns:** a command menu with a heavy backdrop, keyboard pickers that open as popovers, an issue page that reads like a form, and settings pages with no shared layout.

The goal is to adopt Linear's **craft** while keeping Surface's own identity (D-a): its teal accent, palette and logo stay. Contrast stays at AA, tested. Where Linear is weaker, Surface keeps its edge: focus that is distinct from hover (D-f), tested contrast, reduced motion, the command-menu footer of key hints.

**Not in scope** (product work, not polish; the audit lists them so this plan does not assume them): view tabs, filter and display controls in the header, multi-select with `X` and its bulk bar, and peek. They belong to M2 (SPEC-020 to SPEC-023). This plan only readies the tokens they will use.

## 2. Modules touched

| Area | Paths |
|---|---|
| Tokens and base styles | `packages/ui/tokens/{primitives,semantic,component}.ts`, the generated `packages/ui/src/styles/tokens.css` and `src/tokens.gen.ts`, `packages/ui/src/styles/base.css`, `packages/ui/src/internal/control.module.css` |
| Components | `packages/ui/src/components/{Dialog,Menu,Popover,Tooltip,Toast,Kbd,PropertyPicker,IssueRow,GroupHeader,LabelChip,PropertyPill,VirtualList,EditableTitle,EmptyState,Skeleton}/*`, new `Settings*` primitives |
| Web app | `apps/web/src/shell/*`, `apps/web/src/command-menu/*`, `apps/web/src/features/issues/*`, `apps/web/src/features/comments/*`, `apps/web/src/pages/*`, `apps/web/src/app/{router.tsx,settings.ts}`, the settings feature CSS modules |
| Editor | `packages/editor/src/editor.css` |
| Docs | `docs/05-design/*`, SPEC-005 and SPEC-012 decision rows (done with this plan) |

No server, sync, operation or schema changes. No new dependencies.

## 3. Migration & rollback

CSS and component changes only: no data, schema, wire or operation change. Each slice is one PR, so rollback is reverting that PR. The generated `tokens.css` is committed, so a revert restores it with the token sources. Users see no stored-data difference. Any layout preference kept in `localStorage` (sidebar width and collapse) keeps its meaning.

## 4. Slices

**Rules for every slice** (from the audit §5):
- One branch and one PR, named `p016-sN-<topic>`, with a green `pnpm check`.
- A token change also updates design-system §2 in the same PR. If a proposed value fails `pnpm test:tokens`, correct it in the token source and record the corrected value in the design-system note and in "As built".
- **Testing hold ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)):** no new browser, e2e, visual or integration tests. Verification is unit tests (token values, `contrast.test.ts`, CSS source checks), jsdom component tests (classes, `data-state`, focus behaviour), the **existing** Storybook story tests where the gate already runs them (`pnpm test:storybook`, axe, both themes), and **by-hand headless screenshots** (a local Playwright capture, never the Chrome extension) checked by eye and recorded in "As built". They are not committed as tests. Re-baselining the existing `pnpm test:visual` snapshots is a by-hand step, also noted in "As built".
- **Fixing a bug starts with a test that fails without the fix** (CLAUDE.md).
- Components use semantic tokens only (Stylelint rejects raw hex and px outside token files).

### S0: Visible-bug hotfix · S · ✅ Done 2026-11-25
Same-day PR ahead of S1, so users stop seeing the bugs. Audit rows 6, 18 (the ring), 24 and 26 (the offset). Each fix starts with a failing test at unit or jsdom level.

- **Breadcrumb links (row 6):** issue-page crumbs render as browser-default purple underlined links. `.crumbs a { color: inherit; text-decoration: none }`, hover to `--text-primary`.
- **Triple focus ring on text inputs (row 24):** the `Input` control draws a border in the accent, an outline, and the native input's global ring. Add `.native:focus-visible { outline: none }` inside `control`, so the wrapper draws the one ring (it keeps 3:1).
- **Leaked command-menu input ring (row 18):** `CommandMenu.module.css:38-40` loses to the global `:focus-visible` rule in `base.css:45`. Raise the specificity so `.input:focus-visible { outline: none }` wins.
- **Issue title offset (row 26):** the `2px 4px` padding in `EditableTitle.module.css` sets the title about 5 px right of the description. Compensate with `margin-inline: calc(-1 * var(--space-4))`. (The size change to `text-2xl` is S6.)
- **Files:** `apps/web/src/shell/Shell.module.css`, `packages/ui/src/internal/control.module.css`, `apps/web/src/command-menu/CommandMenu.module.css`, `packages/ui/src/components/EditableTitle/EditableTitle.module.css`.
- **Dependencies:** none.
- **Verify:** the four failing-first unit tests in the test plan (§5); `pnpm check`; by-hand headless capture of an issue page, shortcut help and the command menu.

> **As built (2026-11-25).** All four bugs reproduced in the CSS source and are fixed in the four planned files; `base.css` is untouched. (1) `.crumbs a` inherits colour with no underline, hover `--text-primary`. (2) `.native:focus-visible { outline: none }` in `control.module.css` (a bare `.native` only tied the global rule at (0,1,0)); the wrapper's `:has()` rule still draws the single accent ring. (3) `.input:focus-visible { outline: none }` in `CommandMenu.module.css`. (4) `EditableTitle` `.text` gets `margin-inline: calc(-1 * (var(--space-4) + var(--border-width)))` and `width: calc(100% + 2 * (space-4 + border))`: the plan's `-space-4` alone leaves 1 px from the transparent border, and the width must be widened explicitly because buttons and inputs do not stretch with `width: auto`; the readOnly span aligns the same way. Tests (CSS-source, since jsdom does not compute CSS Modules): `web/test/shell-css.test.ts`, `web/test/command-menu-css.test.ts`, `ui/test/control-focus.test.ts`, `ui/test/editable-title-css.test.ts`; each failed before its fix. Not checked by hand in a browser (no headless capture of this worktree).

### S1: Foundation tokens · M · ✅ Done 2026-11-25
- **Changes:**
  - New tokens: `--hairline` (0.5 px under `min-resolution: 2dppx`, else 1 px), `--border-hairline`, `--bg-group`, `--weight-regular: 450`, `--weight-ui: 500`, `--tracking-tight`, `--tracking-id`, the `text-label` style, `--radius-group`, `--radius-kbd`, `--shadow-e0` to `--shadow-e3` as stacked layers, `--dur-highlight-in`, `--dur-highlight-out`, `--dur-exit`, `--nav-item-height`, `--header-height`, `--settings-column`, `--settings-row-min-height`, `--command-menu-top`.
  - New surface values (`--bg-app`, `--bg-sidebar` = app, `--bg-panel`, `--bg-elevated`, `--bg-hover`, `--bg-active`) and `text-md` at 15/24, per design-system §2.1 and §2.4. The command-menu width (about 720) as a component token. The row heights stay 36/32 here: S4 changes them to 44/36 together with the inset, borderless rows, so the list never shows tall rows with separators in between.
  - Global fixes: `button, input, select, textarea { font: inherit; letter-spacing: inherit }` (audit row 38) in `base.css`.
  - The `text-md` change reaches the editor and comments in S6, not here, so S1 leaves screens as they are except for the new surface colours.
- **Files:** `packages/ui/tokens/{primitives,semantic,component,contrast}.ts`, `packages/ui/src/styles/{tokens.css,base.css}` (generated and hand-written), `packages/ui/src/tokens.gen.ts`, `docs/05-design/design-system.md` §2.
- **Dependencies:** none (S0 touches different files).
- **Verify:** `pnpm test:tokens` extended to the new surfaces, `--bg-group` and the focus bar on `--bg-active`; `tokens-generated.test.ts`; a unit test that `--hairline` resolves to 1 px without the `2dppx` query; the Stylelint test still rejects raw hex outside token files; by-hand capture to confirm no screen regresses.

> **As built (2026-11-25, `p016-s1-tokens`):**
> - **One value changed.** Light `--danger` `#D03A3A` failed as field-error text on the new `--bg-app` (4.39:1). It is now `#CC3636` (4.60:1 on app, 4.47 on hover, 5.06 on white). All other proposed surface values (light and dark) pass the existing USAGE contract unchanged, including `--bg-group` on every text token. Recorded in design-system §2.1.
> - **Surfaces** are a new `surface` primitive scale (steps 1 to 7: app, panel, elevated, hover, active, group, hairline), so no gray step moved. `--bg-sidebar` is `--bg-app`. Added `--bg-group` and `--border-hairline` (exempt decorative border, in `contrast.test.ts` USAGE; `bg-group` joins SURFACES, so text, accent, focus-ring and icon colours are all checked on it).
> - **Tokens added:** `--hairline` (1 px; 0.5 px in a generated `@media (min-resolution: 2dppx)` block, via `hiResTokens` in `component.ts`), `--weight-ui`, `--tracking-tight`, `--tracking-id`, `--text-label-{size,line,weight}` (12/16/500; colour `--text-tertiary` is set by the user of the style), `--radius-group` 10, `--radius-kbd` 3, `--shadow-e0`, `--dur-highlight-in` 0, `--dur-highlight-out` 150, `--dur-exit` 80, `--nav-item-height` 28, `--settings-column` 640, `--settings-row-min-height` 60, `--command-menu-top` 87.
> - **Values changed:** `--weight-regular` 450, and `text-sm`/`text-base`/`text-md` weights 450; `text-md` 15/24; `--shadow-e1..e3` are now stacked with a hairline ring (e3 equals e2); `--command-menu-width` 720.
> - **Review follow-up: `--bg-elevated-hover`** (light `#EEF0F3`, dark `#272C33`, primitive `surface-8`) is the fill for hovered or highlighted items on `--bg-elevated`; `--bg-hover` stays the quiet panel hover. Menu, PropertyPicker, DatePicker, EmojiPicker and the editor bubble now use it (one line each). The command-menu option uses `--bg-selected`, so S5 decides it. Contrast: text-tertiary 5.04 (light) and 4.59 (dark), accent text 4.53 and 6.53; all in `contrast.test.ts`.
> - **Shadows change every overlay now:** `--shadow-e1..e3` are restacked, so every popover, menu, tooltip, dialog and toast already looks different, and e3 equals e2 (toasts are heavier). S2 and S8 should review this rather than assume the old look. Light rings use `--border-hairline`.
> - **Not changed on purpose:** `--header-height` already existed at 48 and `Shell` and `IssueList` size from it, so it stays 48 until S3 sets 44. Row heights stay 36/32 (S4). No component CSS was touched.
> - **Side effects to know about:** body text is now 450 everywhere (it uses `--text-base-weight`). Anything on `--text-md-*` (profile, security, invites, empty state, attachments, sync inspector, command-menu input weight, editor line 57) grows from 14/22 to 15/24, earlier than the plan's "editor and comments in S6"; S6 should check those screens. The command-menu dialog widens to 720 because `Dialog.module.css` reads `--command-menu-width` (S5 restyles it). Dark panel and sidebar swap order relative to before (sidebar is now the app layer), so the shell shows the new layering already.
> - **Tests added:** `ui/test/hairline-token.test.ts` ("hairline falls back to 1px without the 2dppx query", 0.5 px under it, control border stays 1 px, shadows use the hairline, reduced-motion tokens still collapse movement), `ui/test/base-css.test.ts` ("buttons and inputs inherit font"), and a "PLAN-016 S1 tokens" block in `tokens-generated.test.ts`. `contrast.test.ts` extended (bg-group, border-hairline). The Stylelint test is unchanged and green.
> - **Not done:** no by-hand headless capture was taken in this slice (token-only change); `pnpm test:visual` baselines will differ and are not re-baselined here.

### S2: Overlay craft: exits, shadows, radii, input rings · M · *(needs S1)*
- **Changes:**
  - Exit animations on Dialog, AlertDialog, Menu and ContextMenu, Popover, Tooltip and Toast, with `[data-state='closed']` for `--dur-exit` (80 ms, opacity plus a 2 px shift; opacity only under reduced motion). Enter animations follow the side the overlay opens from (Radix `data-side`).
  - The e1 and e2 shadow recipes, `--radius-lg` on menus, popovers, pickers and toasts, hairline borders and separators, menu items at 30 px and weight 450.
  - Kbd caps at weight 450, a hairline border and `--radius-kbd`.
  - Tooltip geometry (28 px, `--radius-md`, hairline, e1); delays stay 500 ms with a 300 ms skip.
  - Picker search: no ring, a hairline under it, no box.
  - Highlight motion on menu items and buttons (in 0 ms, out 150 ms).
  - Focus returns to the trigger synchronously, with exits running.
- **Files:** `packages/ui/src/components/{Dialog,Menu,Popover,Tooltip,Toast,Kbd,PropertyPicker}/*.module.css`, `apps/web/src/command-menu/CommandMenu.module.css`.
- **Dependencies:** S1.
- **Verify:** jsdom tests that each overlay sets the closing `data-state` and that focus returns to the trigger synchronously; `overlay-manager.test.ts` stays green; a unit test that every `@keyframes` in `packages/ui` moves only through `--motion-*` tokens; the existing Storybook a11y tests for all overlay stories in both themes.

### S3: Shell: inset panel, sidebar rhythm, header · M · *(needs S1)* · ✅ Done 2026-11-25
- **Changes:**
  - `.main` becomes the content card (`--bg-panel`, `--radius-lg`, hairline, `--shadow-e0`, margin `8px 8px 8px 0`). The sidebar sits on the app layer with no border and no background of its own. Narrow and drawer modes (< 1024 px) keep full-bleed.
  - Sidebar items 28 px at `--weight-ui` with the highlight motion, 6 px icon gap, `text-label` section labels, the team name at `--text-primary`. The sidebar search stays a ⌘K-hinted row, as a 28 px ghost row with a hairline.
  - Header 44 px with a hairline, round 28 px icon buttons, and a labelled count ("26 issues") in `text-sm` tertiary instead of a bare number.
- **Files:** `apps/web/src/shell/{Shell.module.css,Sidebar.tsx,PageHeader.tsx}`, `packages/ui/tokens/component.ts`.
- **Dependencies:** S1.
- **Verify:** existing shell tests for `aria-current`, drawer mode and resize stay green; a unit test that the narrow and drawer breakpoints drop the card's margin and radius; axe on the shell story; by-hand headless capture at 1440 and 390 px in both themes.

> **As built (2026-11-25, `p016-s3-shell`):**
> - **Card:** `.main` is the card (`--bg-panel`, `--radius-lg`, `--hairline` in `--border-hairline`, `--shadow-e0`, margin `8 8 8 0`). It scrolls itself (`height: calc(100dvh - 2 * inset)`, `overflow-y: auto`), so the sticky header stays inside the rounded corners. New token `--shell-inset` (8); `.shell[data-mode='drawer']` sets it to 0 and drops margin, radius, border and shadow (drawer mode is below 1024 px, narrow included). The drawer sidebar gets a hairline on its right edge, since it has no neighbour card.
> - **Sidebar:** on `--bg-sidebar` (app) with no border; items `--nav-item-height` 28, 6 px icon gap, `--weight-ui`, 12 px gutter (6 sidebar + 6 item), highlight motion (in 0, out 150 ms), current item `--bg-active` with primary text, section labels in the text-label style, search as a transparent row with a hairline. The resize handle is unchanged and still shows on hover and focus.
> - **Header:** `--header-height` 44 (regenerated `tokens.css`), hairline below, `--bg-panel`. The Issues list count now reads "26 issues" (`IssueListPage`). The sidebar-toggle button in the header is round.
> - **Touched outside the shell (minimal):** `IssueList.module.css` `.area` height now subtracts `2 * --shell-inset`, or the list would overflow the card by 16 px and give it a stray scrollbar.
> - **Notes for S4:** rows and group headers still paint their own backgrounds; make them transparent on the card. Check `IssueRow` and the other pages' sizing against the card (anything using `100dvh` should subtract `--shell-inset`). Only the Issues list shows a count; other headers have none.
> - **Notes for S7:** settings pages sit inside the card; check their `min-height`/`100dvh` assumptions.
> - **Tests:** `web/test/shell-css.test.ts` (CSS-source: card, full-bleed drawer, sidebar no border, nav items use `--nav-item-height` and `--weight-ui`, current item fill, label style, header 44 + hairline). Existing shell tests unchanged and green.
> - **Not done:** no by-hand headless capture (no dev server was run from this worktree); no axe or visual baselines re-run. The sidebar-search `⌘K` row and the narrow (< 768) mode are checked only by CSS source.

### S4: Issue list: inset rows, states, group headers · M · *(needs S1, S3)*
- **Changes:**
  - **Row height 44 px comfortable and 36 px compact (D-c)**, transparent, borderless, inset 8 px, with `--radius-md` state fills. `VirtualList` constants follow the new heights.
  - Hover: `--bg-hover`, in 0 ms and out 150 ms.
  - Keyboard focus (D-f): `--bg-active` with `box-shadow: inset 2px 0 0 var(--accent), inset 0 0 0 1px var(--focus-ring)`, replacing the 2 px outline round the whole row. Selected style prepared for M2: `--bg-selected` plus a 1 px inset `--accent` ring.
  - Group header: 36 px, inset, `--radius-md`, `--bg-group`, label at `--weight-ui`, never the hover colour. A hairline under sticky headers only while stuck.
  - Row typography: title `--weight-ui`, identifier `--tracking-id`, dates and the estimate column at 450. Hairline label chips.
  - No focus ring on first load: the first group header holds none until the first key press (audit row 13).
- **Files:** `packages/ui/src/components/{IssueRow,GroupHeader,LabelChip,PropertyPill,VirtualList}/*`, `apps/web/src/features/issues/IssueList.module.css`, `apps/web/src/features/issues/focus-model.ts`.
- **Dependencies:** S1, S3.
- **Verify:** `issue-components.test.tsx` (extended); `components.perf.test.tsx` (the < 1 ms per row budget, deep tier, run by hand); a jsdom test that hover, focus and selected render different classes and `data-*`; a focus-model unit test for no focus-visible on mount; the focus bar against `--bg-active` added to `contrast.test.ts`; by-hand capture of the list at both heights.

### S5: Command menu and keyboard pickers · M · *(needs S2)*
- **Changes:**
  - **No backdrop (D-d)**, top-anchored (`--command-menu-top`), about 720 px, `--shadow-e2`, `--radius-lg`, hairline. The focus trap and `Esc` stay, and the page behind is inert but not dimmed. Input `text-md` with no ring, options 40 px, the active option a neutral `--bg-active`. The footer of key hints stays.
  - **Keyboard pickers in the shell (D-e):** `S`, `P`, `A`, `L` and the other property shortcuts open the picker as a command-menu sub-page with the issue context chip, number key caps and a check on the current value (command-menu.md §3.5). A pill click still opens the anchored popover. One Property picker component serves both frames.
  - Context menu at 30 px items, weight 450, `--radius-lg`, hairline separators (the S2 menu styling applied to the row context menu).
- **Files:** `apps/web/src/command-menu/*`, `apps/web/src/features/issues/issue-pickers.ts`, `packages/ui/src/components/{PropertyPicker,Menu}/*`, `docs/05-design/command-menu.md`.
- **Dependencies:** S2.
- **Verify:** `property-picker.test.tsx` and the command-menu unit tests for keyboard routing (`S` opens the sub-page with the chip; a number key applies; `Esc` returns focus to the row; `Backspace` on an empty query goes back); a unit test that the menu renders no backdrop element; the registry and shortcut tests unchanged; Storybook a11y; by-hand capture.

### S6: Issue page: title, body type, properties, comments, activity · M · *(needs S1, S2)*
- **Changes:**
  - Title at `text-2xl`, weight 600, `--tracking-tight`, aligned with the body (the offset itself ships in S0).
  - Editor and comments on `text-md` (15/24, 450); heading sizes re-checked so H1 > H2 > H3 > body (`editor.css`). Checklist alignment: `align-items: flex-start` and `margin-top: calc((1lh - var(--checkbox-size)) / 2)`.
  - Properties column: left-aligned 28 px round pills (13 / `--weight-ui` / `--text-primary`), transparent until hover, `text-label` headings, muted placeholders when empty. Each pill keeps its accessible name ("Status: In Progress").
  - Comment composer as a card (placeholder, attach icon, round send button with a `Mod+Enter` hint); comment cards with a hairline and `--radius-md`.
  - Activity: a 16 px avatar or event icon, `text-sm` at 450, a tertiary timestamp with the full date in a tooltip, a thin vertical rail.
  - Round header icon buttons and the "N / total" position counter with ↑/↓ in the header. Attachment cards with a hairline and `--radius-md`.
- **Files:** `packages/ui/src/components/{EditableTitle,PropertyPill}/*`, `packages/editor/src/editor.css`, `apps/web/src/features/issues/{issue-page.module.css,IssuePage.tsx,activity.module.css,ActivityStream.tsx}`, `apps/web/src/features/comments/comments.module.css`.
- **Dependencies:** S1, S2.
- **Verify:** editor unit tests (task item DOM unchanged); the `ActivityStream` story with axe; property pill names still announce "Status: In Progress"; a CSS source test for the checklist alignment; by-hand captures of three issues, wide and narrow.

### S7: Settings layout and grouped rows · L · *(needs S1 to S3)*
- **Changes:**
  - A `SettingsLayout`: the settings sidebar replaces the app sidebar, with "Back to app"; a 640 px column; a page header with a title and a one-line description. `Esc` and the global shortcuts still work from settings. Each settings row has a stable anchor URL (audit §4 idea 11).
  - `SettingsGroup` and `SettingsRow` primitives in `packages/ui` (`--radius-group`, `--settings-row-min-height`).
  - Migrate profile, preferences, security, members, workspace, labels, teams, workflow, estimates and automations onto them, and delete the duplicated list and card CSS from the feature modules.
- **Files:** `apps/web/src/pages/{SettingsPage.tsx,Pages.module.css}`, `apps/web/src/app/{router.tsx,settings.ts}`, the new `packages/ui/src/components/Settings*`, `apps/web/src/features/{members,labels,statuses,teams,security,invites,profile,workspace,estimates,automations}/*.module.css`.
- **Dependencies:** S1, S2, S3.
- **Verify:** router unit tests (each settings URL renders inside the layout; `Esc` and global shortcuts work from settings); the settings feature tests unchanged; Storybook stories for `SettingsGroup` and `SettingsRow` with axe; by-hand captures of every settings page. This slice may split into two PRs (layout, then migration) if it grows.

### S8: Empty, loading and toast states · S · *(needs S1, S2)*
- **Changes:**
  - Empty states: the shortcut as a `Kbd` in the sentence ("Create one with [C]") and in the button (`Button` `shortcut` prop), a 24 px tertiary icon, one primary action.
  - Skeleton rows with the final row geometry (44 / 36 px, inset, radius), shimmer off under reduced motion. The 150 ms delay stays.
  - Toast: `--radius-lg`, hairline, exit motion (if S2 did not cover it). The banner region gets the same craft (hairline, radius, e1).
  - The not-found pages use the empty-state pattern.
- **Files:** `packages/ui/src/components/{EmptyState,Skeleton,Toast}/*`, `apps/web/src/features/issues/IssueListPage.tsx`, `apps/web/src/pages/NotFoundPage.tsx`.
- **Dependencies:** S1, S2.
- **Verify:** component tests that the empty state renders its shortcut as a `kbd` with spoken text; a skeleton-delay unit test (150 ms, fake timers); Storybook a11y.

### Order and parallelism
- S0 and S1 first, in parallel (no shared files).
- S2 and S3 after S1, in parallel.
- S4 after S3. S5 after S2.
- S6, S7 and S8 after S1 to S3, in parallel with S4 and S5.

## 5. Test plan (behaviour → test)

> ⏸ Browser, e2e, visual and integration tests are held ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)). Every test below is a unit, jsdom or CSS-source test, or an existing Storybook story test. CSS-source tests read the `.module.css` text, because jsdom does not compute styles from CSS Modules. Names are proposals; the slice may adjust a file name but keeps the behaviour in the title.

| Slice | Required behaviour | Test |
|---|---|---|
| S0 | Breadcrumb links are styled, not browser-default (no underline, inherited colour, hover to primary) | `web/test/shell-css.test.ts`: "breadcrumb links inherit colour and have no underline" (fails before the fix) |
| S0 | A text input draws exactly one focus ring | `ui/test/control-focus.test.ts`: "the native input inside a control draws no outline of its own" |
| S0 | The command-menu input draws no ring and its rule is not out-ranked by the global one | `web/test/command-menu-css.test.ts`: "the command menu input removes the global focus ring with higher specificity" |
| S0 | The issue title's text lines up with the description's left edge | `ui/test/editable-title-css.test.ts`: "the title's negative inline margin equals its padding" |
| S1 | Every new colour token has a declared usage and passes contrast on every surface it sits on | `pnpm test:tokens` (`ui/test/contrast.test.ts`), extended |
| S1 | Generated CSS equals the token sources | `ui/test/tokens-generated.test.ts` |
| S1 | `--hairline` is 0.5 px on 2x screens and falls back to 1 px otherwise | `ui/test/hairline-token.test.ts`: "hairline falls back to 1px without the 2dppx query" |
| S1 | Raw hex and px stay out of component CSS | `ui/test/stylelint.test.ts` (unchanged) |
| S1 | Bare buttons and inputs inherit the app font | `ui/test/base-css.test.ts`: "buttons and inputs inherit font" |
| S2 | Each overlay animates its exit and stays mounted until the animation ends | `ui/test/overlay-exit.test.tsx`: "dialog, menu, popover, tooltip and toast set the closing state" |
| S2 | Focus returns to the trigger at once, with exits running | `ui/test/overlay-manager.test.ts`: "focus returns to the trigger before the exit animation ends" (extended) |
| S2 | No keyframe moves an element except through `--motion-*` tokens | `ui/test/keyframes-motion.test.ts`: "keyframes move only through motion tokens" |
| S2 | Overlay stories have no axe violations in both themes | `pnpm test:storybook` (existing) |
| S3 | The content card drops its margin and radius in narrow and drawer modes | `web/test/shell-layout.test.ts`: "the card goes full-bleed below 1024px" (extended) |
| S3 | The shell keeps `aria-current`, drawer behaviour and resizing | `web/test/shell-*.test.ts*` (existing, unchanged) |
| S3 | Sidebar items are 28 px and use the UI weight | `web/test/shell-css.test.ts`: "nav items use the nav-item height token" |
| S4 | Hover, keyboard focus and selected rows are visually distinct | `ui/test/issue-components.test.tsx`: "hover, focus and selected rows render different classes" |
| S4 | The focus bar and ring reach 3:1 on `--bg-active` in both themes | `ui/test/contrast.test.ts`: "row focus bar passes 3:1" |
| S4 | No row or group is focus-visible on first load | `web/test/focus-model.test.ts`: "nothing is focus-visible before the first key press" |
| S4 | Rows are 44 px (comfortable) and 36 px (compact); the virtual window uses them | `ui/test/virtual-list.test.tsx`: "row and header heights follow the density tokens" |
| S4 | The row stays within its render budget | `ui/test/components.perf.test.tsx` (deep tier, existing) |
| S5 | The command menu renders no backdrop and still traps focus and closes on `Esc` | `web/test/command-menu.test.tsx`: "the command menu has no backdrop and traps focus" |
| S5 | A property shortcut opens the picker as a menu sub-page with the context chip, number caps and a check | `web/test/command-menu-picker.test.tsx`: "S opens the status page with the issue chip and a check on the current status" |
| S5 | A number key applies the change; `Esc` returns focus to the row; `Backspace` on an empty query goes back | `web/test/command-menu-picker.test.tsx`: "number key applies; escape restores row focus; backspace goes back" |
| S5 | A pill click still opens the anchored popover | `ui/test/property-picker.test.tsx`: "a pill click opens the picker anchored to the pill" |
| S5 | Shortcut registry and conflict tests are unchanged | `web/test/shortcuts-conflicts.test.ts` (existing) |
| S6 | The editor and comments render at `text-md`; headings stay larger than body | `editor/test/editor-css.test.ts`: "body uses text-md and H3 is larger than body" |
| S6 | Checklist boxes align with the first line of text | `editor/test/editor-css.test.ts`: "task item checkbox aligns to the first line" |
| S6 | Property pills keep their accessible names | `ui/test/property-pill.test.tsx`: "pill name is 'Status: In Progress'" (existing, kept) |
| S6 | The title renders at `text-2xl` and 600 | `ui/test/editable-title-css.test.ts`: "title uses text-2xl and weight 600" |
| S6 | The activity stream has no axe violations | `ActivityStream` story test (existing) |
| S7 | Each settings URL renders inside `SettingsLayout`; `Esc` and global shortcuts work from it | `web/test/settings-layout.test.tsx`: "settings pages render in the layout and keep global shortcuts" |
| S7 | `SettingsGroup` and `SettingsRow` pass axe in both themes | their stories (new, run by the existing story tests) |
| S7 | The existing settings features behave as before | `web/test/settings-*.test.tsx` and feature tests (existing, unchanged) |
| S8 | The empty state shows its shortcut as a `kbd` with spoken text | `ui/test/empty-state.test.tsx`: "the shortcut renders as a kbd with spoken text" |
| S8 | A skeleton appears only after 150 ms | `ui/test/skeleton-delay.test.ts`: "skeleton shows after 150ms with fake timers" |
| All | By-hand headless captures (1440 and 390 px, both themes) | Recorded in each slice's "As built"; not committed as tests |

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Exit animations vs the overlay manager.** Radix Presence keeps an element mounted until `animationend`. jsdom has no animations, so tests see an instant unmount, and a real browser could show stacking or focus bugs the tests miss. | Focus restoration stays synchronous (the manager does it, not Presence). Test the closing `data-state` in jsdom, and check stacking and focus with exits on by hand in a headless run. `overlay-manager.test.ts` must stay green. Reduced motion keeps opacity only. |
| **0.5 px hairlines on 1x screens.** A half pixel renders as nothing or as a blurry 1 px line. | `--hairline` falls back to 1 px under `min-resolution: 2dppx`. `--border-hairline` is slightly stronger. Decorative borders are exempt from §2.3, but controls keep 1 px `--border-control`. Check on a 1x monitor by hand. |
| **Row render budget.** 44 px rows with state shadows and transitions could cost more per row, and the list must stay at 60 fps with 10,000 issues (NFR-04). | Heights are fixed constants, so the window is arithmetic (SPEC-012 §3.3 item 9). States use `background-color` and `box-shadow` only, with no layout work. Run `components.perf.test.tsx` and the list by hand in S4. |
| **Proposed token values fail contrast.** The new surface values are proposals. | `pnpm test:tokens` is the authority. S1 corrects any failing value and logs it, as PLAN-005 S1 did. |
| **Contrast on the lighter dark panel.** `--text-tertiary` on `--bg-selected` is only 4.55 in the audit's numbers. | Keep the test as the gate. Do not lower any text token to make a surface fit. |
| **Visual snapshots churn.** Most `test:visual` baselines change at once. | Re-baseline by hand per slice and note it in "As built". `test:visual` is not in `pnpm check`. |
| **Fixed-height regressions at other widths.** Inset cards and 28 px nav items change the layout at 375 px. | By-hand captures at 1440 and 390 px in each shell-affecting slice. Narrow and drawer modes keep full-bleed. |
| **Focus distinct from hover is a deliberate divergence from Linear.** | Recorded as D-f (the coordinator decided on 2026-11-25; still open for the user). If the user reverses it, only the S4 focus rule changes. |
| **Conflicts with M2 work.** SPEC-020 to SPEC-023 are drafted against the v0.1 components. | See §7. M2 builds on the v0.2 components after PLAN-016 S4 and S5. Land S4 and S5 before M2 touches rows, pickers or the command menu. |

## 7. Impacts on the M2 spec drafts (SPEC-020 to SPEC-023)

Found by grepping the drafts for row height, command menu, picker and backdrop on 2026-11-25. **This plan does not edit them**: another session owns them. Whoever finalises each draft should apply the notes below.

| Draft | Impact |
|---|---|
| SPEC-020 (display options, board) | Depends on `IssueRow`, `GroupHeader` and `VirtualList`, whose heights change (rows 44 / 36, group header 36, inset, no separators). Its "compact rows" for < 768 px (SPEC-012 §7.3) are a separate layout from the 36 px compact density and need a name that does not clash. Board columns and cards should use `--bg-group`, `--radius-md` and the hairline, not 1 px rules. The Display options popover should use the S2 popover craft (`--radius-lg`, e1). |
| SPEC-021 (filters, views) | The Filter menu is "a popover with the command menu's list" and opens property pickers as sub-pages. With D-e, pickers opened from the keyboard are command-menu sub-pages, so the `F` shortcut flow should decide whether the filter menu also opens in the shell. Filter chips and view tabs should use the S1 tokens (round pill, hairline, `text-sm` at 500). |
| SPEC-022 (selection, bulk, undo, peek) | Selection and focus must follow the v0.2 states (`--bg-selected` plus a 1 px accent ring and a gutter checkbox; focus is the accent bar plus ring). Pickers on a selection ("Mixed", shared statuses) and the `Mod+K` chip "N selected issues" must work in the command-menu shell, not only as anchored popovers (SPEC-022 §3.2, D-e). The bulk bar should use `--shadow-e2`. The peek panel is specified as a 480 px side panel (design-system §3, SPEC-022 §3.8); Linear uses a floating card (audit row 25). This is **still open for the user**. |
| SPEC-023 (search, navigation) | The Search page and the command menu's Issues, People and Teams sections sit in the new frame: no backdrop, about 720 px, 40 px options, a neutral active option, a 15 px input. The prefix chip ("Issues") sits in the input beside the context chip. SPEC-023 changes the sidebar's Search button to open the Search page, and S3 restyles that button as a 28 px ghost row, so both agree. Result rows should use the 44 / 36 px row craft. |

Common rule for M2: build new components on the v0.2 tokens, and do not reintroduce row separators, raw backdrop dimming or single-blur shadows.

## 8. Slice status

None started. Each slice, when done, gets `· ✅ Done YYYY-MM-DD` in its heading and an "As built" note covering versions, deviations (including any corrected token values), the by-hand captures taken, any `test:visual` re-baseline, and anything a later slice needs.
