# Surface: Design System (foundations & core components)

Status: **Draft v0.2** · Date: 2026-11-25 (v0.1: 2026-11-06) · Package: `packages/ui` · Related: [shortcuts](shortcuts.md), [command menu](command-menu.md), [Linear UI gap audit](audits/2026-11-linear-ui-gap-audit.md), [PLAN-016](../07-plans/PLAN-016-ui-polish.md), [SPEC-005](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md)

> Surface borrows Linear's *product model*, not its visual identity. Its colours, type, iconography, and layout are its own.
>
> *Changed 2026-11-25 (PLAN-016, D-a): Surface still keeps its own identity (the teal accent, its own palette and logo), and now also adopts Linear-grade craft: layering, hairlines, type weights, density, motion and states. It does not copy Linear's branding or colours. v0.2 records the values this needs. The measurements behind them are in the [gap audit](audits/2026-11-linear-ui-gap-audit.md).*

---

## 1. Design principles

1. **Instant feedback.** Every local action renders in the same frame. No spinners for local work; skeletons appear only while content loads on first open.
2. **Keyboard first, mouse friendly.** Every interactive element can be reached by keyboard, shows a visible focus ring, and advertises its shortcut in a tooltip or menu.
3. **Quiet chrome, loud content.** Neutral surfaces with one accent colour. Colour is reserved for meaning: status, priority, labels, health.
4. **Dense but calm.** Work tools show a lot of rows. A 13 px base, a 4 px grid, and generous line height keep density readable.
5. **Undo over confirm.** Reversible actions (property changes, removing an attachment) happen immediately and show an "Undo" toast. Deleting an issue or a settings item, and irreversible actions (purge, revoke), ask for confirmation. *Changed (SPEC-012 §3.11, SPEC-015 D3): deleting an issue used to run at once with an Undo toast. Now Delete opens a confirm dialog. Only the last delete can be undone, with `Mod+Z`, until M2's undo stack.*
6. **One pattern per job.** One picker component for every property, one menu for every list of actions, one modal for every create flow.
7. **Accessible by default.** WCAG 2.1 AA (NFR-19). Colour is never the only signal; icons and text accompany it.

---

## 2. Tokens

Tokens are **CSS custom properties** generated from `packages/ui/tokens/*.ts`, in three layers:

```
primitive  (--gray-1 … --gray-12, --teal-1 … --teal-12, --red-*, …)
   ↓
semantic   (--bg-panel, --text-secondary, --accent, --border-subtle, …)   ← components use ONLY these
   ↓
component  (--row-height, --sidebar-width, …)
```

Themes switch by setting `data-theme="light|dark"` on `<html>`. `system` follows `prefers-color-scheme`. A **token test** checks the contrast of every text/background pair (§2.3).

### 2.1 Semantic colour tokens (proposed values)

> *Changed 2026-11-25 (PLAN-016, D-a): the surface layers move to Linear's model. The sidebar sits on the app layer, and the content is an inset card on `--bg-panel` (§3). The values marked ◆ below are new proposals from the audit §2.1. Like every value here, `pnpm test:tokens` validates them. If one fails, PLAN-016 S1 corrects it and records the change in its "As built" note. The cool slate hue stays.*

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-app` | `#F3F4F6` ◆ | `#0B0D0F` ◆ | Window and sidebar background (the lowest layer) |
| `--bg-sidebar` | = `--bg-app` ◆ | = `--bg-app` ◆ | Sidebar (no longer a separate layer) |
| `--bg-panel` | `#FCFCFD` ◆ | `#121518` ◆ | The inset content card, and the rows on it |
| `--bg-elevated` | `#FFFFFF` | `#1A1E22` ◆ | Popovers, menus, modals |
| `--bg-hover` | `#EFF1F3` ◆ | `#1A1E23` ◆ | Hovered row or item |
| `--bg-elevated-hover` | `#EEF0F3` ◆ | `#272C33` ◆ | Hovered or highlighted item inside an overlay on `--bg-elevated` (menus, pickers, date and emoji pickers, editor bubble). Added 2026-11-25 (PLAN-016 S1). |
| `--bg-active` | `#E6E9ED` ◆ | `#22272D` ◆ | Pressed, the current nav item, and the keyboard-focused row (§4) |
| `--bg-group` | `#F7F8F9` ◆ | `#16191D` ◆ | Group header band (between panel and hover; never the hover colour) |
| `--bg-selected` | `#E2F3F2` | `#123130` | Selected rows (multi-select) |
| `--border-subtle` | `#ECEDF1` | `#1F2329` | Quiet dividers. *No longer drawn under rows or group headers (§2.5).* |
| `--border-hairline` | `#DCDFE4` ◆ | `#262B31` ◆ | Decorative hairlines (§2.5): panel, header, chips, menus. Slightly stronger to make up for the half width. |
| `--border-default` | `#DFE2E7` | `#2A2F36` | Inputs, cards |
| `--border-strong` | `#C7CCD4` | `#3B414A` | Emphasis, dividers in menus |
| `--border-control` | `#858B98` | `#68707C` | Boundary of inputs, checkboxes and switches (≥ 3:1, WCAG 1.4.11) |
| `--text-primary` | `#16181D` | `#ECEEF1` | Titles, body |
| `--text-secondary` | `#4A5060` | `#B2B8C3` | Labels, metadata |
| `--text-tertiary` | `#5F6676` | `#8C94A1` | Hints, timestamps (must still pass 4.5:1) |
| `--text-disabled` | `#858B98` | `#68707C` | Disabled controls (exempt from contrast) |
| `--accent` | `#0A7A77` | `#2EC4BF` | Primary buttons, links, focus, selection |
| `--accent-hover` | `#086A67` | `#4ED2CD` | |
| `--accent-subtle` | `#E2F3F2` | `#123130` | Accent backgrounds |
| `--on-accent` | `#FFFFFF` | `#04201F` | Text on the accent colour |
| `--focus-ring` | `#16908C` | `#4ED2CD` | 2 px ring with a 2 px offset |
| `--on-label` | `#16181D` | `#0E1013` | Avatar initials on a `--label-<hue>` fill |
| `--danger` / `--warning` / `--success` / `--info` | `#CC3636` ◆ / `#B86E0C` / `#2B9255` / `#3569D4` | `#F06868` / `#EBA33F` / `#4FC47D` / `#6E9EF6` | Feedback, and semantic icons |

> **Corrections (2026-11-06, PLAN-005 S1):** the contrast test failed four light-theme proposals: `--accent` `#0E8A87` (white text on it was 4.2:1, and as link text 4.2:1), `--focus-ring` `#2BB0AC` (2.7:1), and `--text-tertiary` `#666D7C` (4.3:1 on `--bg-active`); `--accent-hover` darkened with the accent. `--bg-selected` was merged with `--accent-subtle` and dark `--bg-hover` with `--border-subtle` (each within 2 RGB steps) so the primitive scales stay at 12 steps. Added tokens: `--danger-hover`, `--on-danger`, `--{danger,warning,success,info}-subtle`, `--label-<hue>`, and `--border-control` (inputs need a 3:1 edge, WCAG 1.4.11; `--text-disabled` shares its new, darker value). `tnum` is applied only where numbers align (`--font-features-numeric`), not to all text. The source of truth is `packages/ui/tokens/*.ts`.

> **Changed 2026-11-25 (PLAN-016 S1):** one proposal failed the contrast test. Light `--danger` `#D03A3A` was 4.39:1 on the new `--bg-app` `#F3F4F6` (field error text needs 4.5:1), so it is now `#CC3636` (4.60:1 on app, 5.06:1 on white). `--danger-hover` `#B32E2E` stays darker. Every other ◆ value passes as proposed. In the token source the new surfaces are a `surface` primitive scale (`--surface-1` app, `-2` panel, `-3` elevated, `-4` hover, `-5` active, `-6` group, `-7` hairline), so the gray scale and everything built on it did not move. `--bg-elevated-hover` was added after review: dark `--bg-hover` `#1A1E23` is one RGB step from dark `--bg-elevated` `#1A1E22`, so hover vanished inside menus. Overlay items use the new fill (text-tertiary 5.04 / 4.59:1, accent text 4.53 / 6.53:1, light / dark; elevated vs hover fill 1.14 / 1.19:1). `--bg-hover` stays the quiet hover on the panel. Dark `--bg-active` `#22272D` is only 1.07:1 from it, so an overlay item that is both pressed and highlighted barely changes; accepted, as press is momentary. `--header-height` is 44 as of S3 (the shell and `IssueList` size from it). `--command-menu-top` is 87 px.

### 2.2 Domain colours

| Domain | Mapping |
|---|---|
| **Status categories** (icon colour) | Triage `--info` · Backlog `--text-tertiary` (dashed ring) · Unstarted `--text-secondary` (empty ring) · Started `--warning` (half-filled ring; fill shows the status's position in its category) · Completed `--success` (filled with a check) · Canceled / Duplicate `--text-tertiary` (filled with an ×) |
| **Priority** | Urgent: `--danger` filled square with `!` · High / Medium / Low: 3 / 2 / 1 filled bars in `--text-secondary` · None: a dashed line |
| **Health** | On track `--success` · At risk `--warning` · Off track `--danger` · None `--text-tertiary` |
| **Labels, teams, projects** | A fixed palette of **12 hues** (gray, red, orange, amber, yellow, lime, green, teal, cyan, blue, violet, pink). Each hue has light and dark values tuned for 3:1 contrast as icon or dot colours. Users pick from the palette; there is no free hex input in v1. |

### 2.3 Contrast rules (tested)
- Every `--text-*` token except disabled reaches **≥ 4.5:1** on `--bg-app`, `--bg-panel`, `--bg-elevated`, `--bg-hover`, and `--bg-selected` in both themes.
- Icons and borders that carry meaning reach **≥ 3:1**.
- **Usage contract** (enforced by `packages/ui/test/contrast.test.ts`): `--text-*` works on every surface; `--accent` is text only on app, panel, elevated and hover; `--danger` is text only on app, panel and elevated (field errors); `--warning`, `--success`, `--info` and `--label-*` are icon and dot colours only, never text. Banner and toast text uses `--text-*`. Decorative borders (`--border-subtle/default/strong`) are exempt; a control whose edge is its only outline uses `--border-control`.
- `pnpm test:tokens` computes every pair and fails CI on a violation, so the hex values above are proposals that the test validates.

### 2.4 Typography

> *Changed 2026-11-25 (PLAN-016, D-a): regular text moves to weight 450 and UI labels to 500. `text-md` grows, letter-spacing tokens are added, and the issue title and editor body follow the scale. Inter Variable already supports these weights, so no new font is bundled.*

| Token | Value |
|---|---|
| UI font | **Inter** (variable, OFL), bundled locally with no CDN (FR-OPS-09) |
| Mono font | **JetBrains Mono** (OFL), used for identifiers in code contexts, code blocks, and keys |
| Features | `font-feature-settings: "cv11", "ss01", "tnum"` (tabular numbers in tables and counts) |
| Weights | `--weight-regular: 450` (*changed 2026-11-25: was 400*) for body, metadata, identifiers, dates and menu items · `--weight-ui: 500` for nav items, row titles, breadcrumbs, pills, tabs and buttons · 600 for headings and the issue title |
| Tracking | `--tracking-tight: -0.0067em` for text of 15 px and up (editor body, comments, titles) · `--tracking-id: -0.02em` for identifiers · none elsewhere |

| Style | Size / line height | Weight | Use |
|---|---|---|---|
| `text-xs` | 11 / 16 | 500 (key caps: 450) | Badges, keyboard hints |
| `text-sm` | 12 / 16 | 450–500 | Metadata, table cells |
| `text-label` | 12 / 16 | 500, `--text-tertiary` | Section labels: sidebar sections, command-menu groups, settings sections, property headings *(new 2026-11-25)* |
| `text-base` | **13 / 20** | 450 | Default UI and list rows |
| `text-md` | **15 / 24** *(was 14 / 22; 2026-11-25)* | 450, `--tracking-tight` | Editor body, comments, command-menu input |
| `text-lg` | 16 / 24 | 600 | Section titles, modal titles |
| `text-xl` | 20 / 28 | 600 | Page titles (project, view) |
| `text-2xl` | 24 / 32 | 600, `--tracking-tight` | Issue title (editable). *Built at `text-xl` in M1; the title now follows this row and lines up with the body's left edge (PLAN-016 S0).* |

The user preference "font size" (FR-AUTH-10) scales the root by 12 / 13 / 14 px.

### 2.5 Spacing, sizing, radius, elevation

- **Spacing (4 px grid):** `0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`. The 2 px and 6 px steps are for tight icon alignment only.
- **Control heights:** `sm 24 · md 28 · lg 32`.
- **Row heights:** list row `44` (comfortable) or `36` (compact preference). Board card minimum height `72`. Rows are inset 8 px inside the list, have no separator lines, and take a `--radius-md` fill for hover, focus and selection. *Changed 2026-11-25 (PLAN-016, D-c): was 36 / 32, full-bleed, with a 1 px rule under every row.*
- **Shell sizes:** nav item `--nav-item-height 28`, 2 px gap between items, 6 px icon gap · header `44` (`--header-height`, was 48) · group header `36`, inset, on `--bg-group` (was 32) · sidebar width stays 240 (200–360) · `--shell-inset 8`, the content card's margin (the shell sets it to 0 in narrow and drawer modes, below 1024 px; pages that size to the viewport subtract `2 * --shell-inset`). The card's hairline edge is `--shadow-e0`'s ring, not a border. *Changed 2026-11-25 (PLAN-016).*
- **Settings sizes:** `--settings-column: 640` · `--settings-row-min-height: 60` · `--radius-group: 10` (§3). *Added 2026-11-25 (PLAN-016).*
- **Property picker and issue row sizes (PLAN-012 S2):** `picker-width 280` · `picker-list-max-height 320` · `dot-size 8` · `row-id-width 64` · `row-estimate-width 40` · `row-date-width 64` · `row-created-width 80`. Group header height is `32`.
- **Radius:** `xs 4` (badges) · `kbd 3` (key caps) · `sm 6` (buttons, inputs) · `md 8` (rows, group headers, cards, tooltips) · `group 10` (settings groups) · `lg 12` (the content panel, menus, popovers, pickers, modals, the command menu, toasts) · `full` (avatars, pills, property pills, header icon buttons). *Changed 2026-11-25 (PLAN-016): `kbd` and `group` added; menus, popovers and pickers move from `md` to `lg`; rows use `md` instead of `sm`.*
- **Hairlines:** `--hairline` is `0.5px` where `min-resolution: 2dppx` holds and falls back to `1px` on 1x screens. It is the width of decorative borders: the content panel, the header, chips, key caps, menus, separators and dividers, drawn in `--border-hairline`. Controls keep `--border-width: 1px` in `--border-control`, because their edge is their outline and must reach 3:1 (§2.3). *Added 2026-11-25 (PLAN-016).*
- **Elevation:** `e0` the content panel · `e1` popovers, menus and tooltips · `e2` modals, the command menu, submenus and the peek panel · `e3` toasts. Light theme uses soft shadows. Dark theme keeps a ring in `--border-default` plus a deeper shadow, because shadows read poorly on dark backgrounds. *Changed 2026-11-25 (PLAN-016): each level is now a stack of low-alpha layers, and the ring is hairline width.*

  | Token | Dark | Light |
  |---|---|---|
  | `--shadow-e0` | `0 0 0 var(--hairline) var(--border-hairline), 0 .5px 1px 1px rgb(0 0 0/.3)` | `0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0/.04), 0 3px 6px -2px rgb(0 0 0/.02)` |
  | `--shadow-e1` | `0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0/.12), 0 2px 5px rgb(0 0 0/.12), 0 3px 8px rgb(0 0 0/.12)` | `0 0 0 var(--hairline) rgb(22 24 29/.10), 0 1px 1px rgb(0 0 0/.04), 0 3px 9px rgb(0 0 0/.04), 0 6px 18px rgb(0 0 0/.02)` |
  | `--shadow-e2` | `0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0/.12), 0 2px 8px rgb(0 0 0/.12), 0 3px 12px rgb(0 0 0/.12), 0 3px 20px rgb(0 0 0/.12), 0 4px 40px rgb(0 0 0/.10)` | `0 0 0 var(--hairline) rgb(22 24 29/.10), 0 1px 1px rgb(0 0 0/.04), 0 6px 24px rgb(0 0 0/.10), 0 9px 48px rgb(0 0 0/.08)` |
  | `--shadow-e3` | = `--shadow-e2` | = `--shadow-e2` |

  These are the proposals from the audit §2.6. The raw `rgb()` values live in the token file, not in component CSS (Stylelint).
- **Z-index scale:** base 0 · sticky headers 10 · sidebar 20 · overlays 50 (popovers, menus, modals and the command menu share one level and stack in the order they open) · toast 70 · tooltip 80.
  > **Correction (2026-11-06, PLAN-005 S3):** separate popover 40 / modal 50 / command menu 60 levels put any picker or menu opened inside a modal behind it. One overlay level relies on portal order instead (`--z-overlay`).

### 2.6 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 0 ms | Selection, focus, property changes |
| `--dur-fast` | 100 ms | Hover, tooltip in, menu open |
| `--dur-base` | 160 ms | Modal and peek open, sidebar collapse |
| `--dur-slow` | 240 ms | Large layout transitions (rare) |
| `--dur-highlight-in` | 0 ms | Hover, focus and selection fills turning on *(added 2026-11-25)* |
| `--dur-highlight-out` | 150 ms | The same fills fading out *(added 2026-11-25)* |
| `--dur-exit` | 80 ms | Overlays leaving: opacity plus a 2 px shift *(added 2026-11-25)* |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Entering elements |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving elements |

Rules: animation **never delays input**. Exit animations are shorter than enter animations. `prefers-reduced-motion` turns transitions into opacity changes only. List reordering is not animated in v1, because animation at 10k rows costs too much.

*Changed 2026-11-25 (PLAN-016, D-a):*
- **Highlights turn on at once and fade out.** Rows, nav items, menu items, pills and buttons use `transition: background-color var(--dur-highlight-out)`, with `transition-duration: var(--dur-highlight-in)` on `:hover`. A hover therefore never feels late, and moving the pointer leaves no hard edge.
- **Overlays have an exit.** Dialog, AlertDialog, Menu, ContextMenu, Popover, Tooltip and Toast animate `[data-state='closed']` for `--dur-exit` (80 ms, shorter than the 100–160 ms enter). Focus returns to the trigger at once, not after the animation, and the next overlay can open while the last one fades.
- **Reduced motion** keeps every new animation, exits included, inside the `--motion-*` token system: movement collapses to 0 and only opacity changes. A unit test checks that no keyframe moves an element except through those tokens.
- Before v0.2, overlays unmounted at once on close, by design (PLAN-005 S3).

### 2.7 Iconography
- Base set: **Lucide** (ISC licence), 16 px at 1.5 stroke by default. 14 px in dense pills, 20 px in empty states.
- **Custom domain icons:** status-category rings, priority bars, health dots, cycle (circular progress), project progress ring, and the Surface logo mark.
- Icons that carry meaning have an `aria-label`. Decorative icons are `aria-hidden`.

---

## 3. Layout

```
┌────────────┬───────────────────────────────────────────────────────────┐
│  Sidebar   │  Header: breadcrumb · view tabs · filter · display · ⋯    │
│  240px     ├───────────────────────────────────────────────────────────┤
│ (200–360,  │                                                           │
│ resizable, │   Main pane (list / board / page)                         │
│ collapsible│                                                     ┌─────┤
│  [ )       │                                                     │Peek │
│            │                                                     │480px│
└────────────┴─────────────────────────────────────────────────────┴─────┘
```

> *Changed 2026-11-25 (PLAN-016, D-a): the diagram above is the v0.1 flat frame. v0.2 uses the inset-panel model described next.*

**Layering (v0.2).** The window and the sidebar share the `--bg-app` layer, with no border between them. The main pane is an inset **content card**: `--bg-panel`, `--radius-lg`, a hairline edge in `--border-hairline` (the ring of `--shadow-e0`, so it takes no space), and a margin of `--shell-inset` (8 px) on the top, right and bottom, none on the left. `<main>` takes programmatic focus after navigation and draws no focus ring. The header lives inside the card. Rows and group headers are transparent, so they inherit the card. In narrow and drawer modes (< 1024 px) the card goes full-bleed.

- **Sidebar:** workspace switcher-free header (logo + workspace name + user menu), search and create buttons, then Inbox, My Issues, Views, Projects, Initiatives, **Favorites**, **Your teams** (expandable: Triage, Issues, Cycles, Projects, Views), then Trash and Settings at the bottom. Collapse with `[`.
- **Header (44 px, hairline below; was 48 px with a 1 px rule):** breadcrumb, view tabs (e.g. All / Active / Backlog), and right-side actions (filter, display options, view ⋯). It stays sticky.
- **Main pane:** max content width is *unbounded* for lists and boards. Long-form pages (issue, project, document) use a centred column, max 760 px of text, plus a right-hand properties panel (280 px).
- **Settings:** its own layout. The settings sidebar replaces the app sidebar (28 px items, a "Back to app" entry at the top). `Esc` and every global shortcut still work from it. The content is a centred column of `--settings-column` (640 px) under a page header with a title (`text-2xl`, weight 500) and a one-line description. Sections have a `text-label` heading over a **settings group**: an elevated fill, `--radius-group`, a hairline and `--shadow-e0`, holding rows of at least `--settings-row-min-height` (60 px) with a label (13 / 500) and hint (12 / 450) on the left and the control on the right. *Added 2026-11-25 (PLAN-016 S7, D-a).*
- **Peek:** a right-side panel with an issue preview (`Space`), 480 px, resizable. `Esc` closes it.
- **Breakpoints:** ≥ 1280 full · 768–1279 properties panel collapses into a header drawer (the sidebar overlays below 1024) · < 768 a single column for read, comment, and triage only, with the properties as a wrapping row of pills under the title (NFR-20; *changed 2026-11-16, SPEC-012 D30*).

---

## 4. Interaction patterns

| Pattern | Rule |
|---|---|
| **Hover vs focus vs selection** | One *focused* row moves with `J/K` or `↑/↓`. *Selected* rows (multi-select with `X` or shift-click) have a `--bg-selected` background. Actions apply to the selection if one exists, otherwise to the focused row. *Changed 2026-11-25 (PLAN-016):* the three states look different. **Hover** is a quiet `--bg-hover` fill on the inset row, on at once and fading out (§2.6). **Keyboard focus** is `--bg-active` plus a 2 px accent bar at the left edge and a 1 px inset `--focus-ring` (`box-shadow: inset 2px 0 0 var(--accent), inset 0 0 0 1px var(--focus-ring)`), shown only after keyboard use, not on first load. **Selection** is `--bg-selected` plus a 1 px inset `--accent` ring and a gutter checkbox. A group header uses `--bg-group`, never the hover colour. The coordinator decided on 2026-11-25 to keep focus distinct from hover (Linear uses one fill for both); still open for the user. |
| **Property editing** | Click a pill to open the **Property picker** as a popover anchored to the pill. Press a property shortcut (`S`, `P`, `A`, `L` and the others) and the picker opens **inside the command-menu shell** (§5.3, [command-menu.md](command-menu.md) §3.5): an issue context chip on top, number key caps and a check on the current value. *Changed 2026-11-25 (PLAN-016, D-e): was an anchored popover for both.* |
| **Inline text editing** | Titles are click-to-edit. `Enter` saves, `Esc` cancels, and blur saves. |
| **Create** | `C` opens the **create modal** with the current context prefilled (team, project, cycle, status of the column). `Mod+Enter` creates. "Create more" keeps the modal open. |
| **Destructive actions** | Deleting an issue and deleting a settings item (status, label, and so on) open a confirm dialog. Other reversible removals (an attachment) run at once with an Undo toast (8 s). Deleting an issue is reversible (Recently deleted, 30 days; the last delete can be undone with `Mod+Z` until M2's undo stack). Irreversible actions (permanent delete, revoke) use a confirm dialog that requires typing or a second press. *Changed (SPEC-010, SPEC-012 §3.11, SPEC-015 D3): reversible deletes no longer run at once with an Undo toast.* |
| **Empty states** | An icon, one sentence, a primary action, and its shortcut (e.g. "No issues yet. Create one with `C`"). |
| **Loading** | Eager data is never shown as loading. Lazy content shows a skeleton after 150 ms (no flash for fast loads). |
| **Command menu** | No backdrop: the page stays visible and is not dimmed. Top-anchored, about 720 px wide, `--shadow-e2`, hairline border. Focus is still trapped, and `Esc` closes it. *Changed 2026-11-25 (PLAN-016, D-d): was centred under a 0.6 black backdrop at 640 px.* |
| **Text fields in overlays** | A command-menu or picker search field draws no ring: it is the only field, so focus is implied and the caret is the cue. Every other text control draws exactly one ring, on its wrapper (§5.1). |
| **Focus rings** | Buttons and controls keep the 2 px ring with a 2 px offset (Linear's 1 px is too weak for 2.4.7 and 1.4.11). The coordinator decided on 2026-11-25 to keep it; still open for the user. |
| **Errors** | Inline for fields, a toast for actions (rejections include the server message), and a banner for system state (offline, outdated, live updates unavailable). |
| **Tooltips** | Show after 500 ms hover (instantly once one tooltip is open). Include the shortcut as `Kbd`. |

---

## 5. Core components (v1 inventory)

Built on **Radix primitives** wherever a primitive exists (ADR-0004). Every component has Storybook stories for all variants and states in both themes, plus a visual-regression snapshot (Playwright).

### 5.1 Primitives & controls
| Component | Variants / notes | Keyboard & a11y |
|---|---|---|
| **Button** | `primary · secondary · ghost · danger` × `sm · md · lg`. Optional icon and `Kbd` hint. A loading state is used only for network actions. | Native button. `aria-busy` while loading. |
| **IconButton** | `ghost · secondary`, square | `aria-label` is required (lint) |
| **Input / Textarea** | Default, error, disabled. Prefix and suffix slots. | Associated `<label>` or `aria-label`; error wired via `aria-describedby` |
| **Checkbox · Switch · Radio** | | Radix |
| **SegmentedControl** | 2–5 options (e.g. List/Board) | Arrow keys |
| **Tabs** | Header view tabs and settings tabs | Radix Tabs, arrow keys |
| **Kbd** | Renders `Mod` as ⌘ on macOS and Ctrl elsewhere. Sequences render as `G` then `I`. | Visually hidden spoken form (`aria-label` is not allowed on `<kbd>`). Inside a Button the Kbd is `aria-hidden` and the button sets `aria-keyshortcuts`. |
| **Tooltip** | Text plus optional Kbd | Radix Tooltip. Not used for essential information. |
| **Avatar · AvatarGroup** | 16/20/24/32 px. Initials fallback with a hashed palette colour. Optional presence dot. | `alt` = name |
| **Badge / Count** | Neutral or accent. For sidebar counts and tab counts. | |
| **Banner** | info · warning · danger, dismissible or persistent | `role="status"` or `role="alert"` |
| **Toast** | Message, optional action (Undo), auto-dismiss 5 s (8 s with an action). Max 3 stacked. | `aria-live="polite"`. Actions are reachable with `F8`; `Mod+Z` is the app's undo (M2). |
| **Skeleton · Spinner · ProgressBar · ProgressRing** | | `aria-busy`, and `role="progressbar"` with values |

### 5.2 Overlays
| Component | Notes |
|---|---|
| **Popover** | Anchored, flips on collision, closes on `Esc` and outside click. Returns focus to the trigger. |
| **Menu / ContextMenu** | Items with icon, label, shortcut, submenu, and checked state. Type-ahead. Right-click opens the same items as the `⋯` menu (FR-NAV-11). |
| **Dialog (Modal)** | `sm 420 · md 560 · lg 720`. Focus trap. `Esc` closes unless the content is dirty (then it asks to discard). |
| **Command menu** | See [command-menu.md](command-menu.md). No backdrop (§4). |
| **Shortcut help** | `?` overlay listing all shortcuts by group, with a search filter |

> **As built (2026-11-06, PLAN-005 S3):** Menu and ContextMenu share one item list. Menus are non-modal (a modal menu fails axe `aria-hidden-focus`). In a submenu `←` closes it and `Esc` closes the whole menu. Overlays share one z-index level and stack in opening order (§2.5). Focus returns to the trigger, or to what was focused when the overlay opened (a dialog opened from a menu item returns to the menu's trigger). The dirty-close guard is a stacked "Discard changes?" dialog whose default is "Keep editing". A toast raised while an overlay is open waits until it closes, and a toast ignores `Esc` unless focused, so `Esc` always reaches the top-most overlay. The banner region shows one banner at a time, by priority (tone by default; an outdated client outranks all), then age; its live regions stay mounted. Toasts are reachable with `F8`.

### 5.3 Domain components
| Component | Description |
|---|---|
| **StatusIcon · PriorityIcon · HealthDot · CycleIcon · ProjectIcon** | Domain icons (§2.2) |
| **PropertyPill** | Compact button showing a property value (icon + text). Variants by property: status, priority, assignee, labels, estimate, cycle, project, milestone, due date. An empty value shows a muted placeholder on hover only. |
| **Property picker** | The **single** picker for every property: search field, filtered list with icons, keyboard numbers for quick choice where it makes sense (priority `0–4`), multi-select for labels (`Space` toggles, `Enter` applies), and a "No X" option. Opens as an anchored popover for pointer use, and as a sub-page of the command menu for keyboard shortcuts (§4). |
| **LabelChip** | Colour dot plus name, removable in edit mode |
| **IssueRow** | Grid: [select] · priority · identifier · status · title (flex) · labels · project · cycle · estimate · due · assignee · created. Columns follow the display properties. Hover reveals quick pills. Heights per §2.5 (44 / 36, inset, no separators). The list is a windowed ARIA `treegrid` (group headers are expandable rows at level 1, issue rows level 2; SPEC-012 D22). |
| **GroupHeader** | Group icon, name, count or estimate sum (click toggles), collapse (`T` when focused or hovered; click), add (+). Sticky. |
| **BoardColumn · BoardCard** | Column = group. The card shows identifier, title (2 lines), and the chosen properties. Drag and drop with keyboard alternatives (`Mod+Shift+←/→` moves the focused card between columns). |
| **EditableTitle** | `text-2xl` inline title editor |
| **EmptyState** | §4 |
| **DatePicker** | Calendar plus natural-language input ("tomorrow", "next friday", "in 2 weeks") |
| **ColorPicker** | 12-hue palette grid (§2.2) |
| **EmojiPicker** | Reactions (on comments and on the issue) and icons (M1). The editor's `:name:` emoji autocomplete uses the same emoji list (SPEC-013). *As built (PLAN-013 S4, 2026-11-16):* a search field and a "Frequently used" row kept in `localStorage` on this device. The emoji data comes through a `loadEmoji` prop (the web app passes the editor's lazy loader), so the component makes no request of its own. |
| **ReactionChips · ReactionBar** | *Added (PLAN-013 S4, 2026-11-16; SPEC-013 §3.4):* one chip per emoji with its count, pressed when the viewer reacted, named like "Thumbs up, 3 reactions, including you", with a tooltip of who reacted. `ReactionBar` is the chips plus an add button that opens the EmojiPicker. Read-only chips (an archived or deleted issue) stay focusable with `aria-disabled`, so the keyboard still reaches their tooltips. |
| **SidebarNavItem · SidebarSection** | Icon, label, count, active state, drag to reorder (favorites), collapsible sections |
| **ViewToolbar** | Filter button plus active filter chips, Display options popover, and save-view affordance |

> **As built (2026-11-06, PLAN-005 S2):** SegmentedControl and ColorPicker are Radix RadioGroups. Kbd speaks shortcuts through visually hidden text ("Command K"), because `aria-label` is not allowed on `<kbd>`. A Button with a `shortcut` hides its Kbd and sets `aria-keyshortcuts` (`ariaKeyShortcuts()` in `keys.ts`). Avatar initials use `--on-label` on the palette hue. Tooltips need one `TooltipProvider` at the app root. *(Noted 2026-11-24: `OverlayProvider` already provides it, so an app inside `OverlayProvider` adds none.)* Storybook is `pnpm storybook` (not `pnpm ui:storybook`), story tests are `pnpm test:storybook`, and visual snapshots are `pnpm test:visual` (pinned Playwright Docker image).

### 5.4 Component acceptance checklist (applies to every component)
- [ ] Light and dark themes, all states (default, hover, active, focus-visible, disabled, error, loading)
- [ ] Fully keyboard operable, with a visible focus ring
- [ ] Screen-reader name, role, and state verified with axe in Storybook tests
- [ ] Uses only semantic tokens (lint: no hex values or raw px in component CSS, except in token files)
- [ ] Story plus visual snapshot
- [ ] Renders in < 1 ms per instance (rows) and avoids layout thrash (no measuring on render)

---

## 6. Content style

- **Sentence case** everywhere ("Create issue", not "Create Issue").
- **Verbs on buttons:** "Create issue", "Invite member", "Save changes".
- **Short, specific errors** that say what to do: "Team key must be 2–5 letters, like ENG".
- **Use the glossary terms** ([glossary](../03-domain/glossary.md)): "issue", not "ticket" or "task"; "cycle", not "sprint".
- **Times:** relative when recent ("3m ago", "yesterday"), absolute beyond 7 days ("Nov 6"), and the full timestamp in a tooltip.

---

## 7. Deliverables & tooling

| Deliverable | Where |
|---|---|
| Token source (`tokens/*.ts`) → generated `tokens.css` + TypeScript constants | `packages/ui/tokens` |
| Components + CSS Modules | `packages/ui/src` |
| Storybook (all stories, both themes, a11y addon) | `pnpm ui:storybook` |
| Visual regression (Playwright screenshots of stories) | CI stage 5 |
| Contrast test (`test:tokens`) | CI stage 2 |
| Icons (Lucide + custom SVG components) | `packages/ui/icons` |

---

## 8. Decisions

| # | Decision | Date |
|---|---|---|
| D-a | **Identity.** Surface keeps its own look (the teal accent, its own palette and logo) and adopts Linear's *craft*: layering, hairlines, type weights, density, motion and states. Not Linear's branding or colours. By the user. | 2026-11-25 |
| D-b | **Sequencing.** UI polish runs as [PLAN-016](../07-plans/PLAN-016-ui-polish.md), before M2 build work. By the user. | 2026-11-25 |
| D-c | **Row height.** List rows are 44 px comfortable and 36 px compact (was 36 / 32), as inset rounded rows. By the user. | 2026-11-25 |
| D-d | **Command menu.** No backdrop (the page stays visible), top-anchored, about 720 px, layered shadow, hairline border. By the user. | 2026-11-25 |
| D-e | **Keyboard pickers.** `S`, `P`, `A`, `L` (and the other property shortcuts) from the keyboard open the picker inside the command-menu shell, with the issue context chip on top, number key caps and a check on the current value. A mouse click on a pill still opens the anchored popover. By the user. | 2026-11-25 |
| D-f | **Focus rings and row focus.** Controls keep the 2 px focus ring. Row keyboard focus is distinct from hover (an accent left bar plus a 1 px inset ring on `--bg-active`), a deliberate "beat Linear" for accessibility. The coordinator decided on 2026-11-25; still open for the user. | 2026-11-25 |
