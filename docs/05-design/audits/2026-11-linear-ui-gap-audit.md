# Surface vs Linear: UI craft gap audit

Date: 2026-11-25 · Status: reference for [PLAN-016](../../07-plans/PLAN-016-ui-polish.md)

> **This is a dated audit, not a spec.** It records what was measured on 2026-11-25 and what was proposed then. The decisions that came out of it live in [design-system.md](../design-system.md) §8 and in PLAN-016. Where they differ from this file, they win. Linear was measured read-only: computed styles and screenshots only, with no changes made to any Linear data. This file holds no Linear workspace content.

**Sources**
- Linear, measured in Chrome (signed in, dark theme only): the shell and sidebar (auditor), plus the list, selection, command menu, keyboard picker, context menu, peek, issue page, tooltips, display popover and settings (coordinator). The raw notes are not kept in the repo.
- Linear, measured headless with no sign-in: the public app stylesheet and the `:root` tokens in both colour schemes. These are Linear's real type, motion, shadow and hairline tokens.
- The few Linear values that remain unmeasured are marked **(est.)**.
- Surface: 107 screenshots and computed styles from headless Chromium against the live instance (the account preference was dark, so the light run also rendered dark). Both were working files and are not kept in the repo. Code references are `file:line` on `main` at `bcd968c`.

**Scope:** copy Linear's *craft* (density, rhythm, layering, hairlines, motion, states) and keep Surface's identity: the teal accent, its own palette and logo. The design-system.md §2.3 contrast contract stays binding. That is where Surface can beat Linear.

---

## 1. Executive summary

1. **Surface has no layering.** Linear puts the sidebar on the darkest layer and the work area in an inset card: 8px margin, 12px radius, 0.5px hairline and a soft shadow. Surface paints content straight onto `--bg-app`, with a 1px rule beside a sidebar that is *lighter* than the content. This is the opposite hierarchy, and the single biggest "feels unfinished" cue.
2. **Lines everywhere.** Surface draws a 1px `--border-subtle` under every row, group header and the page header. Linear uses almost no row separators. Where it needs a line, the line is 0.5px. Removing them and moving to hairlines does more for calm than any colour change.
3. **States are heavy and uniform.** Hover, keyboard focus and group headers all use the same `--bg-hover` (`#1F2329`). Focus adds a 2px teal outline round the whole 1200px row. Linear uses one quiet fill for hover and focus (+4 L over the panel, on an 8px-radius inset row), turns it on instantly and fades it out over 150ms. Selection gets an accent-tinted fill, a 1px ring and a floating bulk bar. Surface should copy the quietness but keep focus distinct from hover: Linear doesn't, and that is an accessibility win for Surface.
4. **The type is flat.** Every label in Surface is 13px/400. Linear's "normal" weight is **450**. Nav labels and titles use 500, and section labels are 12px/500. Surface's sidebar items are 36px high where Linear's are 28px. The description editor renders at 13px, below Surface's own spec of 14/22 and Linear's 15px at line-height 1.6.
5. **Overlays open well but vanish.** Dialog, menu, popover and toast all have enter animations (100–160ms). None has an exit: Radix unmounts them at once. Linear animates both. Shadows are a single blur (`0 4px 16px`), where Linear stacks 3–5 layers. Focus rings are drawn inside the command menu's and pickers' search inputs.
6. **Real bugs a user will see:**
   - The issue page breadcrumb renders as browser-default purple underlined links.
   - The shortcut-help search field draws three focus rings.
   - The command menu input shows a 2px ring that its CSS tries to remove.
   - The editable title sits about 5px off the description's left edge.
   - Checklist boxes do not line up with their text.
7. **The issue page reads like a form, not a document.** The properties are a right-aligned list of 12px grey text. Linear uses 28px round property pills (13/500, transparent until hover) under 13/500 section headings, a 15/450/24 body and an 8px-radius hairline comment card. Activity is plain lines with no icons or rail, and the comment box is a bare 32px field.
8. **Settings has no shared layout.** The inner nav sits inside the app shell, with no page title or description and no grouped-list pattern. Linear swaps the sidebar for the settings nav and uses 60px rows in 10px-radius groups (measured tokens).
9. **Missing chrome compared with Linear:** view tabs (28px pills), filter and display controls in the header, multi-select with `X` and its floating bulk bar, and peek (a floating 416px card). These are product scope, not polish, and are listed so PLAN-016 doesn't assume them.
10. **Where Surface already beats Linear, and should keep it:**
    - The command-menu footer of key hints.
    - Kbd chips in every menu and picker.
    - Tested AA contrast.
    - Reduced-motion tokens.
    - A visible keyboard focus everywhere.
    Polish must not trade these away.

---

## 2. Foundations

The proposed values keep Surface's teal identity. Neutrals stay cool slate (Surface's current hue), not Linear's blue-violet hue of 272. Every text pair below was checked with the WCAG formula Surface uses (`tokens/contrast.ts`). `pnpm test:tokens` stays the authority.

### 2.1 Surfaces and layers (P0)

| | Linear (measured) | Surface now | Proposed for Surface |
|---|---|---|---|
| Model | Window and sidebar share the darkest layer. Content is an **inset card**: `margin: 8px 8px 8px 0`, `radius 12px`, `0.5px` border, shadow `0 .5px 1px 1px #0000004c`. Light theme reverses it (sidebar `#efeff0`, content `#f9f9fa`) | Content is painted on `--bg-app` (`#0E1013`). The sidebar is *lighter* (`--bg-sidebar #111316`), split by a 1px `--border-subtle` (`Shell.module.css:40-41`). `--bg-panel` exists but the main area doesn't use it. Rows paint `--bg-app` (`IssueRow.module.css:7`) | Adopt the inset-card model: the sidebar sits on `--bg-app` with no border, and `.main` becomes a card on `--bg-panel` with `--radius-lg`, a hairline border and `--shadow-e0`. Rows and group headers become transparent and inherit the panel |
| Dark values | app L2.6, panel L5.5, selected nav L13.8 (LCH) | app `#0E1013`, sidebar `#111316`, panel `#14171B` (unused), hover `#1F2329`, active `#252B32` | `--bg-app #0B0D0F` · `--bg-sidebar` = `--bg-app` · `--bg-panel #121518` · `--bg-elevated #1A1E22` · `--bg-hover #1A1E23` · `--bg-active #22272D` · `--bg-selected #123130` (unchanged teal). `--text-tertiary #8C94A1` measures 6.36 on app, 5.99 on panel, 5.48 on elevated and hover, 4.55 on selected. All pass 4.5 |
| Light values | sidebar `#efeff0`, content `#f9f9fa`, border `#e2e2e2` | app `#FAFBFC`, sidebar `#F4F5F7`, panel `#FFFFFF` | `--bg-app #F3F4F6` · `--bg-panel #FCFCFD` · `--bg-elevated #FFFFFF` · `--bg-hover #EFF1F3` · `--bg-active #E6E9ED`. Tertiary `#5F6676` measures 5.23 on app, 5.08 on hover and 4.73 on active. Accent text `#0A7A77` measures 4.70 on app and 4.56 on hover; it is not allowed on active by the §2.3 contract |
| New tokens | n/a | n/a | `--bg-group` for the group header band (between panel and hover: dark `#16191D`, light `#F7F8F9`) and `--shadow-e0` for the panel |

### 2.2 Borders and hairlines (P0)

| | Linear | Surface now | Proposed |
|---|---|---|---|
| Width | `0.5px` hairlines (`--editor-hairline`, the panel border, inline chips, the `0 0 0 .5px` ring). 1px only for focus and settings separators | `--border-width: 1px` everywhere (`component.ts:69`) | Add `--hairline: 0.5px` under `@media (min-resolution: 2dppx)`, falling back to `1px`. Use it for decorative borders: the panel, header, chips, menus and dividers. Keep `--border-width 1px` for controls, whose edge is their outline and needs 3:1 (`--border-control`, §2.3) |
| Row separators | none. Rows are 8px-radius fills on the panel | 1px `--border-subtle` under every row and group header (`IssueRow.module.css:6`, `GroupHeader.module.css:4`) | Remove them. Rhythm comes from row height and the hover tint. Keep a hairline under sticky group headers only while they are stuck |
| Decorative colour | dark `#212224` / `#232325`, light `#e2e2e2` / `#dedede` | `--border-subtle` dark `#1F2329`, light `#ECEDF1` | Keep the hue. Add `--border-hairline` (dark `#262B31`, light `#DCDFE4`), slightly stronger to make up for the half width. Decorative borders are exempt from §2.3 |

### 2.3 Typography (P0 for weights, P1 for the rest)

| | Linear (measured tokens) | Surface now | Proposed |
|---|---|---|---|
| Base weight | `--font-weight-normal: 450` | 400 (`component.ts:51`) | `--weight-regular: 450` (Inter Variable supports it, so no new font). The same contrast with more ink: small text reads crisper on dark |
| UI label weight | 500 for nav items, row titles, breadcrumbs, property pills and tabs. **450** for identifiers, dates, menu items and body copy. 600 only for the issue title and activity heading | 400 everywhere except headings | Add `--weight-ui: 500` for nav items, row titles, breadcrumbs, pills, tabs and buttons. Everything else gets the 450 regular |
| Scale | 11 / 12 / **13** / 15 / 18 / 20 / 24 / 36 | 11 / 12 / 13 / 14 / 16 / 20 / 24 | Keep 11–13. Make `md` **15/24** for editor body and comments (Linear 15px, line-height 1.6). Keep `lg 16/24`, `xl 20/28`, `2xl 24/32` |
| Letter-spacing | `-0.0067em` on 15px and up: the title is −0.16px at 24px and the body −0.1px at 15px. Identifiers are −0.26px at 13px (about −0.02em) | none | `--tracking-tight: -0.0067em` for 15px and up, `--tracking-id: -0.02em` for identifiers. None elsewhere |
| Section label | 12px / 500 / muted (sidebar "Workspace") | 11px / 500 / tertiary (`Shell.module.css:191-197`) | Add the type style `text-label`: 12/16, weight 500, `--text-tertiary`. Use it for the sidebar, command-menu groups, settings sections and properties |
| Editor body | 15px / 450 / 1.6 | **13px** (`packages/editor/src/editor.css:13` uses `text-base`; design-system §2.4 says `md` 14/22) | Point the editor and comments at `text-md`, which becomes 15/24 at weight 450 |
| Issue title | 24px / 600 / 32px, −0.16px (measured) | 20px (`EditableTitle.module.css:3` uses `text-xl`; §5.3 says `text-2xl`) | `text-2xl` 24/32, weight 600, `--tracking-title` |

### 2.4 Spacing and sizing (P1)

| | Linear | Surface now | Proposed |
|---|---|---|---|
| Sidebar item | 28px high on a 30px pitch, padding `0 9px 0 8px`, 6px icon gap, 14px icon, radius 8 | 36px (`--row-height`, `Shell.module.css:125`), 8px gap | Add `--nav-item-height: 28px`, 2px gap between items, 6px icon gap. Keep the 14px icon and radius 8 |
| Sidebar width | 244px | 240px (resizable 200–360) | Keep 240 and the resizing. Add a 12px inner gutter |
| Header | 44px. Breadcrumb 13px / 500. View tabs are 28px round pills | 48px with a 1px rule | 44px (`--header-height`) inside the panel, hairline below |
| List row | **44px** with an 8px-radius fill, inset in the panel | 36px, compact 32, full-bleed | **Decision for the user:** match Linear at 44/36 (comfortable/compact), or keep the spec's 36/32 as Surface's density edge. Either way, inset rows by 8px and give them `--radius-md` fills |
| Group header | 36px, an inset band with an 8px radius, fill `lch(9.2)` (the same as the row hover), label 13/500, muted count, `+` on the right | 32px, full-bleed, the hover colour, 1px rule | 36px, inset with `--radius-md`, on `--bg-group`. Surface makes it distinct from hover, which Linear doesn't |
| Settings | its own sidebar (28px items). Centred **640px** column. Title 24/500, section 15/500. Grouped cards with a 10px radius, rows about 65px (padding 16) | the inner nav nested in the app shell (36px items), no page title, ad-hoc cards per feature | Add `--settings-column: 640px`, `--settings-row-min-height: 60px` and `--radius-group: 10px` |

### 2.5 Radii (P2)

Linear (measured): floating overlays, the panel and the command menu 12. Settings cards 10. Rows, group headers, tooltips, comment cards, nav items and select buttons 8. Key caps 3–4. Pills, view tabs, toggles, property pills and header icon buttons fully round. Surface's `xs 4 / sm 6 / md 8 / lg 12 / full` already matches. Add `--radius-group: 10px` and `--radius-kbd: 3px`. Change Menu, Popover and the picker from `md 8` to `lg 12`. Make property pills, header icon buttons and view tabs `full`.

### 2.6 Elevation (P1)

Linear stacks shadows: two to five layers, each with low alpha. Surface uses one ring and one blur (`component.ts:159-170`). Proposed:

| Token | Dark | Light |
|---|---|---|
| `--shadow-e0` (panel, new) | `0 0 0 var(--hairline) var(--border-hairline), 0 .5px 1px 1px rgb(0 0 0/.3)` | `0 0 0 var(--hairline) var(--border-hairline), 0 1px 1px rgb(0 0 0/.04), 0 3px 6px -2px rgb(0 0 0/.02)` |
| `--shadow-e1` (menus, popovers, tooltips: Linear's 3-layer recipe, measured) | `0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0/.12), 0 2px 5px rgb(0 0 0/.12), 0 3px 8px rgb(0 0 0/.12)` | `0 0 0 var(--hairline) rgb(22 24 29/.10), 0 1px 1px rgb(0 0 0/.04), 0 3px 9px rgb(0 0 0/.04), 0 6px 18px rgb(0 0 0/.02)` |
| `--shadow-e2` (command menu, dialogs, submenus, peek: Linear's 5-layer recipe, measured) | `0 0 0 var(--hairline) var(--border-default), 0 1px 1px rgb(0 0 0/.12), 0 2px 8px rgb(0 0 0/.12), 0 3px 12px rgb(0 0 0/.12), 0 3px 20px rgb(0 0 0/.12), 0 4px 40px rgb(0 0 0/.10)` | `0 0 0 var(--hairline) rgb(22 24 29/.10), 0 1px 1px rgb(0 0 0/.04), 0 6px 24px rgb(0 0 0/.10), 0 9px 48px rgb(0 0 0/.08)` |
| `--shadow-e3` (toasts) | the same as e2 | the same as e2 |

The dark ring stays, as design-system §2.5 requires, but at hairline width. Elevated surfaces also get a 1px top inner highlight in dark (`inset 0 1px 0 rgb(255 255 255/.04)`, est. from Linear's raised buttons). It is optional and cheap.

### 2.7 Motion (P0 for exit and hover, P1 for the rest)

| | Linear (measured tokens and keyframes) | Surface now | Proposed |
|---|---|---|---|
| Hover highlight | **in 0s, out 150ms** (`--speed-highlightFadeIn/Out`) | rows: no transition. Buttons: 100ms both ways | `--dur-highlight-in: 0ms`, `--dur-highlight-out: 150ms`. Pattern: `transition: background-color var(--dur-highlight-out)` and `:hover { transition-duration: 0ms }`. Apply to rows, nav items, menu items, pills and buttons |
| Overlay enter | fade plus `translateY(2–10px)` or `scale(.96–1)`, about 150ms. Tiny popups use `scale(.7–.8)` plus a blur | enter exists: Menu and Popover 100ms, Dialog 160ms, Toast 160ms. Shift `--motion-shift 4px`, scale `.98` | Keep. Tune the Popover and Menu direction to the side they open from (Radix `data-side`). Tooltip: 100ms fade with a 2px shift |
| Overlay **exit** | present (`opacity → 0`; dialog `scale(1.06)` plus blur; other fade-outs) | **none.** The comments in `Dialog.module.css:8`, `Menu.module.css:18` and `Popover.module.css:13` choose an instant unmount | Add `[data-state='closed'] { animation: exit var(--dur-exit) var(--ease-in) }` with `--dur-exit: 80ms`, opacity plus a 2px shift (shorter than enter, as §2.6 requires). Radix Presence waits for `animationend`. Reduced motion keeps only the opacity. Check that the overlay-manager tests (`overlay-manager.test.ts`) don't depend on synchronous unmount: jsdom has no animations, so Presence unmounts at once |
| Durations | 100 / 150 / 250 / 350 | 0 / 100 / 160 / 240 | Keep Surface's set and add `--dur-highlight-out 150ms` and `--dur-exit 80ms` |
| Easing | Penner `ease-out-quad` and `ease-out-quint` (`cubic-bezier(.23,1,.32,1)`) | `cubic-bezier(0.2,0.8,0.2,1)` | Keep Surface's curve. It is close to ease-out-quint |

### 2.8 Focus and selection (P0)

| | Linear | Surface now | Proposed (keeps AA: 2.4.7 visible focus, 1.4.11 3:1) |
|---|---|---|---|
| Control focus | 1px ring in the accent (`--focus-ring-width: 1px`) | 2px ring with a 2px offset, everywhere (`base.css:45`) | Keep 2px for buttons and controls. Linear's 1px is weak, and this is a "beat" |
| Row focus (J/K) | the same quiet fill as hover (`lch(9.3)` on `lch(5.5)`). A `--row-keyboard-border` 1px inset ring exists in the CSS | the hover background plus a **2px outline around the whole 1200px row** (`IssueRow.module.css:19-22`) | `--bg-active` plus a 1px inset ring in `--focus-ring` and a 2px accent bar at the left edge (`box-shadow: inset 2px 0 0 var(--accent), inset 0 0 0 1px var(--focus-ring)`). The bar is a non-colour cue that passes 3:1 (dark `#4ED2CD` on `#22272D` is about 8:1) |
| Hover and focus | **shared** (one fill). Keyboard and mouse users can't tell them apart | identical (`--bg-hover` for both) | hover = `--bg-hover`, focus = `--bg-active` plus the ring. Group header = `--bg-group`, never the hover colour |
| Selection | an accent-tinted fill `lch(16 18 286)`, a 1px inset ring `lch(26 29 287)`, a 12px checkbox in the gutter, and a **floating bulk-action bar** at the bottom centre | no multi-select yet | `--bg-selected` (teal-3) plus a 1px inset `--accent` ring and a gutter checkbox. Wire it when `X` lands (product scope) |
| Text inputs inside overlays | no ring. The caret is the cue | the command-menu input shows a 2px ring (`CommandMenu.module.css:40` loses to `base.css:45`). The picker search has a ring (`PropertyPicker.module.css:24-26`). The `Input` control draws **three** (`control.module.css:18-20` border plus outline, and the native input's global ring) | Command-menu and picker search: no ring, because the focus is implied and the input is the only field. The `control` wrapper owns the ring, so add `.native:focus-visible { outline: none }`. One ring per control |

## 3. Per-surface gaps

Match = copy Linear's craft. Beat = go past Linear (usually on accessibility, keyboard or clarity). Effort S < 1 day, M 1–3 days, L > 3 days. P0 = visibly broken or the biggest perceived-quality gap, P1 = clearly below Linear, P2 = refinement. Unless marked, Linear values are Chrome measurements or Linear's public tokens.

### Shell and sidebar

| # | Surface | What Linear does | What Surface does now | Proposed change | M/B | Eff. | Pri. |
|---|---|---|---|---|---|---|---|
| 1 | App layering | Sidebar on the app layer. Content is an inset card: 8px margin, 12px radius, 0.5px border, `0 .5px 1px 1px /.3` | Content on `--bg-app`. A lighter sidebar plus a 1px rule (`apps/web/src/shell/Shell.module.css:3-6`, `:29-41`); `.main` has no surface (`:259-265`) | `.main` becomes the card (`--bg-panel`, `--radius-lg`, hairline, `--shadow-e0`, margin `8px 8px 8px 0`). The sidebar drops its border and its own background. Narrow and drawer modes keep full-bleed | Match | M | **P0** |
| 2 | Sidebar items | 28px, 13/500, 8px radius, 14px icon, 6px gap, idle `lch(60.6)`, selected white on `lch(13.8)`, `color .15s` | 36px (`--row-height`, `Shell.module.css:120-131`), 13/400, 8px gap | Use `--nav-item-height 28px`, `--weight-ui`, a 6px gap, and the highlight in/out motion. The selected item stays `--bg-active` with `--text-primary` | Match | S | P1 |
| 3 | Section labels ("Your teams") | 12/500 muted, the caret after the label | 11/500 tertiary (`Shell.module.css:191-197`) | The `text-label` style (12/16/500 tertiary) | Match | S | P2 |
| 4 | Sidebar search | an icon-only button in the top bar | a 36px bordered, input-like button with ⌘K caps (`Shell.module.css:120-140`) | Keep the ⌘K hint, which beats Linear on discoverability. Make it a 28px ghost row with a hairline and `--weight-ui` | Beat | S | P2 |
| 5 | Header | 44px, breadcrumb 13/500 `lch(90.5)`, round 28px icon buttons, view tabs | 48px with a 1px rule (`Shell.module.css:267-278`). The current crumb is 500 and the parents are 400. A bare count ("26") at the right with no label | 44px inside the panel, with a hairline. Show the count as "26 issues" in `text-sm` tertiary, not a bare number. Round 28px icon buttons | Match | S | P1 |
| 6 | **Breadcrumb links (bug)** | links in the breadcrumb colour, no underline | issue-page crumbs render as browser-default **purple underlined** links, `rgb(158,158,255)` (measured). `.crumbs` styles `ol`/`li` but not `a` (`Shell.module.css:280-311`) | `.crumbs a { color: inherit; text-decoration: none }`, with hover to `--text-primary`. Add a unit test that the class exists, and fix by hand | Match | S | **P0** |
| 7 | Team rows | a 14px coloured team icon, the name in `lch(90.2)` (brighter than items), the caret after the name | a mono key ("ENG") plus the name, a disclosure caret before it | Keep the mono key: it is Surface's identity and is useful. Brighten the team name to `--text-primary` at `--weight-ui` | Beat | S | P2 |

### Issue list

| # | Surface | What Linear does | What Surface does now | Proposed change | M/B | Eff. | Pri. |
|---|---|---|---|---|---|---|---|
| 8 | Row frame | 44px, an inset row with an 8px-radius fill, no separators | 36px, full-bleed, opaque `--bg-app` and a 1px separator (`packages/ui/src/components/IssueRow/IssueRow.module.css:1-12`) | A transparent row with no border, inset by 8px inside the list (`apps/web/src/features/issues/IssueList.module.css`), and a `--radius-md` fill on states. Row height: **user decision** (§2.4) | Match | M | **P0** |
| 9 | Hover | `lch(9.3)` on `lch(5.5)`. In 0s, out 150ms | `--bg-hover`, no transition (`IssueRow.module.css:14-17`) | Highlight in/out motion. The fill is `--bg-hover` (+3–4 L over the panel with the new values) | Match | S | **P0** |
| 10 | Keyboard focus (J/K) | the same fill as hover. Not distinguishable | the hover fill **plus a 2px teal outline round the whole row** (`IssueRow.module.css:19-22`) | `--bg-active`, a 2px accent bar on the left and a 1px inset `--focus-ring` (§2.8). Distinct from hover, and quieter than now | **Beat** | S | **P0** |
| 11 | Row typography | title 13/500. Identifier 13/450 muted, −0.26px, about 60px column. Date 12/450 muted | title 13/400. Identifier 12/400 tertiary with tnum (`IssueRow.module.css:34-41`). Date 12/400 | title `--weight-ui`. Identifier stays 12px with tnum but takes `--tracking-id`. Dates and the estimate column at 450 | Match | S | P1 |
| 12 | Label chips | outlined pills with a 0.5px border, dot plus text | 1px `--border-default` pills (`packages/ui/src/components/LabelChip/LabelChip.module.css`) | `--hairline` border, `--border-hairline` colour | Match | S | P1 |
| 13 | Group header | 36px, an inset 8px-radius band `lch(9.2)`, label 13/500, muted count, `+` right | 32px, full-bleed `--bg-panel` with a 1px rule (`packages/ui/src/components/GroupHeader/GroupHeader.module.css:1-13`). It shares `--bg-hover` with focused rows. On page load the first group header holds a visible 2px focus ring before any key press (measured) | 36px, inset, `--radius-md`, `--bg-group`, label `--weight-ui`. Show the ring only after keyboard use: focus programmatically without `focusVisible`, or gate on a `data-keyboard` flag | Match | S | P1 |
| 14 | Multi-select (X) | an accent-tinted fill and 1px ring, a 12px gutter checkbox, a floating bulk bar ("N selected · Actions ⌘ · ✕") | not built | **Product scope**, not PLAN-016. When built: `--bg-selected` plus a 1px `--accent` ring, and a bottom-centre bar on `--shadow-e2` | n/a | L | n/a |
| 15 | View tabs, filter, display | 28px round pill tabs (12/500); display popover 301px with wide pill toggles and 22×14 switches | not built (header shows only the breadcrumb) | **Product scope.** The PLAN-016 tokens (round pill, `text-sm` 500) should be ready for them | n/a | L | n/a |

### Overlays

| # | Surface | What Linear does | What Surface does now | Proposed change | M/B | Eff. | Pri. |
|---|---|---|---|---|---|---|---|
| 16 | Exit motion (all) | overlays fade out (exit keyframes in the public CSS) | **no exit**: an instant unmount by design (`Dialog.module.css:8-11`, `:30-31`; `Menu.module.css:18-20`; `Popover.module.css:13-15`; `Toast.module.css:35`) | Add `[data-state='closed']` exit keyframes, 80ms opacity plus a 2px shift, under reduced motion opacity only | Match | M | **P0** |
| 17 | Command menu: frame | 720px, top-anchored at about 87px, **no backdrop**, `lch(12.7)` fill, 0.5px border, 5-layer shadow | 640px (`component.ts` `command-menu-width`), top 12vh (108px), a 0.6 black backdrop (`Dialog.module.css:9`), a 1px ring plus one blur | 680–720px. Drop or lighten the backdrop (`--backdrop` at 0.2), keeping the focus trap. `--shadow-e2` recipe, `--radius-lg`, hairline | Match | S | P1 |
| 18 | Command menu: input and options | 40px input at 13px, no ring. Options 46px, active is a **neutral** fill `lch(20.8)`. Kbd caps 11/450 with a 0.5px border | the input is 16px with a leaked 2px focus ring (`CommandMenu.module.css:38-40` loses to `packages/ui/src/styles/base.css:45`). Options 36px, the active one **teal** `--bg-selected` (`CommandMenu.module.css:81-83`) | Remove the ring (raise specificity: `.input:focus-visible { outline: none }`). Input 15px (`text-md`). Options 40px. Active option is `--bg-active` (neutral, like the picker), keeping teal for meaning. **Keep the footer hint bar** | Match / Beat | S | **P0** (ring) / P1 |
| 19 | Keyboard pickers (S/P/A/L) | open **in the command-menu shell**: top-anchored 708px, an issue context chip, 45px options with number caps and a check. Mouse opens an anchored popover | an anchored popover at the row's left edge for keyboard too. A boxed search with a 2px ring (`packages/ui/src/components/PropertyPicker/PropertyPicker.module.css:8-26`). 28px options. Number caps and a check are already present | Keyboard invocation opens the picker as a command-menu sub-page (design-system §5.3 already allows it), with the context chip. Mouse keeps the anchored popover. Picker search: no ring, a hairline under it, no box | Match | M | P1 |
| 20 | Context menu | 180px, 12px radius, 0.5px border, a 3-layer shadow, 32px items at 13/450, 0.5px separators, submenus with the 5-layer shadow | 200px, 8px radius, a ring plus one blur, 28px items at 13/400 (`packages/ui/src/components/Menu/Menu.module.css`) | `--radius-lg`, the `--shadow-e1` recipe, hairline separators, 30px items, weight 450. Keep the Kbd caps | Match | S | P1 |
| 21 | Tooltip | 28px, 8px radius, 0.5px border, light shadow, label 11–12/450, each key its own cap (18×17, radius 4) | Radix tooltip, 500ms delay with a 300ms skip (`packages/ui/src/components/Tooltip/Tooltip.tsx:7-8`). 100ms enter, no exit | Match the geometry (28px, `--radius-md`, hairline, e1). Keep 500/300ms. Exit 80ms | Match | S | P2 |
| 22 | Kbd caps | 11/450, a 0.5px border, radius 3, padding 2–4, muted text | 11/500, a 1px `--border-default`, radius 4, a filled background (measured in menus) | 450, `--hairline` border, `--radius-kbd 3px` | Match | S | P2 |
| 23 | Toast | not measured (no toast appeared) | bottom-right card on `--shadow-e3`, 160ms enter, no exit. Can overlap the dev sync dock | Exit motion, a hairline border, `--radius-lg` | Match | S | P2 |
| 24 | **Text-field focus (bug)** | one ring | the `Input` control draws **three rings**: a border in the accent, a 1px outline, and the native input's global 2px ring (`packages/ui/src/internal/control.module.css:18-20` plus `base.css:45`; visible in shortcut help and every settings form) | `.native:focus-visible { outline: none }` inside `control`. The wrapper keeps a single ring that passes 3:1 | Match | S | **P0** |
| 25 | Peek (Space) | a floating 416px card at the top right of the panel: 12px radius, 5-layer shadow, title 18/500, a meta line, excerpt | not built (design-system §3 specifies a 480px side panel) | **Product scope.** Update design-system §3 to Linear's floating-card form when it is built | n/a | L | n/a |

### Issue page

| # | Surface | What Linear does | What Surface does now | Proposed change | M/B | Eff. | Pri. |
|---|---|---|---|---|---|---|---|
| 26 | Title | 24/600/32, −0.16px, aligned with the body | **20px** (`packages/ui/src/components/EditableTitle/EditableTitle.module.css:3`, `text-xl`; §5.3 specifies `text-2xl`). A `2px 4px` padding (`:11`) sets it about 5px right of the body's edge | `text-2xl`, 600, `--tracking-tight`. Compensate the padding with `margin-inline: calc(-1 * var(--space-4))` so the text lines up | Match | S | **P0** |
| 27 | Description and comment body | 15/450/24, −0.1px, `lch(90.8)`, accent-tinted links | **13/20** (`packages/editor/src/editor.css:13`, `text-base`; design-system §2.4 says `text-md`) | Editor and comments on `text-md` (15/24, 450, `--tracking-tight`). Re-check the heading sizes (`editor.css:45-58`) so H1 > H2 > H3 > body still holds | Match | S | P1 |
| 28 | Checklist items | not measured | the checkbox sits above the text's centre line (screenshot). `li[data-type='taskItem']` (`editor.css:128-145`) | Align the label box to the first line: `align-items: flex-start` plus `margin-top: calc((1lh - var(--checkbox-size)) / 2)` | Match | S | P1 |
| 29 | Properties panel | about 260px column, plain sections on the panel. Headings 13/500 muted. Each property is a **28px round pill** (13/500, transparent until hover). Empty values are muted ("Set priority") | a `dl` of right-aligned rows: label 12/400 secondary, value buttons 12/400 **secondary** (`apps/web/src/features/issues/issue-page.module.css:82-107`; `packages/ui/src/components/PropertyPill/PropertyPill.module.css`) | Left-aligned property pills, 28px, `--radius-full`, 13 `--weight-ui` `--text-primary`, the highlight motion, the muted placeholder when empty (already in the spec). Labels become the `text-label` style. Keep each pill's accessible name (`Status: In Progress`) | Match | M | P1 |
| 30 | Activity | heading 15/600. Event lines 12–13px with muted 12/450 timestamps | plain text lines with no icon or avatar (`apps/web/src/features/issues/activity.module.css:23-47`) | A 16px actor avatar or event icon, `text-sm` 450, the timestamp tertiary with the full date in a tooltip (already a rule in design-system §6), and a thin vertical rail joining events | Match | M | P2 |
| 31 | Comment card and composer | card `lch(9.2)`, 8px radius, 0.5px border, soft shadow | comment cards with a 1px border. The composer is a bare 32px editable line (measured 734×32, no frame) | Composer card: `--bg-elevated`-ish fill, `--radius-md`, hairline, e0 shadow, a placeholder ("Leave a comment…"), an attach icon and a round send button with a `Mod+Enter` hint | Match / Beat | M | P1 |
| 32 | Header actions | round 28px icon buttons on `lch(14.8)`. An "N / total" counter with ↑/↓ for previous and next | square ghost icons (link, #, branch, ⋯). A position line in the aside (`issue-page.module.css:121`) | Round 28px icon buttons. Move the position counter into the header with ↑/↓ (`J/K` hints in tooltips) | Match | S | P2 |
| 33 | Attachments | not measured | full-width bordered cards with a 1px border | hairline, `--radius-md`, the highlight motion on rows | Match | S | P2 |

### Settings, empty and loading states

| # | Surface | What Linear does | What Surface does now | Proposed change | M/B | Eff. | Pri. |
|---|---|---|---|---|---|---|---|
| 34 | Settings frame | **its own sidebar** ("Back to app", search, grouped nav; 28px items, 13/500 group headings). A centred **640px** column. Title 24/500/32, −0.16px. Section 15/500 | the settings nav nested *inside* the app shell next to the app sidebar (`apps/web/src/pages/Pages.module.css:58-110`, `SettingsPage.tsx`). 36px nav items. No page title or description | A shared `SettingsLayout`: the settings sidebar replaces the app nav (Esc or "Back to app" returns), a 640px column, and a page header (title `text-2xl`/500 plus a one-line description) | Match | L | P1 |
| 35 | Settings content | **grouped row cards**: `lch(9.2)` fill, 10px radius, a 0.5px ring plus a soft shadow. Rows of about 65px (padding 16) with label 13/500 plus hint 12/450 on the left and the control on the right. Selects 30px, radius 8 | each feature styles its own lists and cards (`features/members/members.module.css`, `labels.module.css`, `statuses.module.css`, `teams.module.css`, `security.module.css`, `invites.module.css`, `automations.module.css`) | Shared `SettingsGroup` / `SettingsRow` primitives in `packages/ui` (`--radius-group`, `--settings-row-min-height`). Migrate the feature modules onto them | Match | L | P1 |
| 36 | Empty states | not measured | a 20px icon, a title, "Create one with C." (plain text C), a teal primary button (`packages/ui/src/components/EmptyState`) | Render the shortcut as a `Kbd` cap ("Create one with [C]"). Put the shortcut in the button (`Button` `shortcut` prop). Icon 24px tertiary. Keep the single primary action | Beat | S | P2 |
| 37 | Loading | not measured | lazy content shows a skeleton after 150ms (spec) | Use skeleton rows with the final row geometry (36px, inset, radius) so nothing jumps. Shimmer off under reduced motion | Match | S | P2 |
| 38 | Buttons inheriting font | n/a | `IconButton` and other bare `button`s compute to **Arial 13.33px** (measured), since nothing sets `font: inherit` on buttons | `button, input, select, textarea { font: inherit; letter-spacing: inherit }` in `packages/ui/src/styles/base.css` | Match | S | P2 |

## 4. Beat Linear

Each idea stays within CLAUDE.md: no outbound network, no telemetry, no AI features, and AA contrast as the floor.

1. **Focus that is visible and distinct from hover.** Linear paints keyboard focus and mouse hover with the same fill, so a keyboard user whose mouse rests on a row sees two "current" rows. Surface uses a 2px accent bar plus a 1px ring for focus, and a plain tint for hover (§2.8, row 10). This passes WCAG 1.4.11 and 2.4.7 with margin.
2. **AA everywhere, tested.** Linear's placeholder and tertiary greys sit around `lch(42)` on `lch(12.7)` (command-menu placeholder, measured). That is about 2.7:1 and fails AA for text (placeholders count as text). Surface's `contrast.test.ts` keeps every `--text-*` at ≥ 4.5:1 on every surface, including the new layers (§2.1 numbers). Extend the test to the new tokens: `--bg-group`, the new `--bg-*` values, and placeholder text, which should use `--text-tertiary`, not a fainter grey.
3. **Shortcut teaching, everywhere and consistently.** Surface already shows Kbd caps in the command menu, menus and pickers, and a footer of key hints in the command menu (Linear has none). Go further:
   - the shortcut in every tooltip, nav item and empty state;
   - a `?` hint in the status bar;
   - "then" chords rendered the same way in every surface (one `Kbd` sequence component).
4. **Reduced motion done properly.** Linear has no visible reduced-motion mode. Surface's tokens already collapse movement to opacity (`reducedMotionTokens`). Keep every new animation, exits included, inside that system, and add a unit test that every keyframe moves only through `--motion-*` tokens.
5. **Exit motion that never blocks input.** Exits run at 80ms and are interruptible: the next overlay can open while the last one fades. Focus returns to the trigger at once, not after the animation. Surface's overlay manager already restores focus synchronously. Keep that, and test it with exits on.
6. **Light theme with the same craft.** Linear's light tokens use faint `#e2e2e2` borders (measured). Surface's light values in §2.1 hold AA and keep the inset-panel layering in both themes. Measure Linear's light theme before claiming more: it was not measured, because switching would change the user's setting.
7. **Density as a choice, not a casualty.** Keep Surface's compact preference (32px) alongside the new comfortable default, both with the same inset-row craft. Linear's 44px rows waste vertical space on a 14" laptop.
8. **Speed you can see.** Surface renders from the local replica in the same frame (design principle 1). Surface it in the UI: no spinners for local actions, and the instant-in hover so the UI feels faster than Linear.
9. **Honest offline and sync state.** Surface's banner system (offline, outdated, live updates unavailable) is explicit by spec. Give the banner region the same panel craft (hairline, radius, e1), so the extra honesty doesn't look like an error.
10. **One picker model with a visible context chip.** Linear's keyboard picker shows the issue chip. Surface's command menu already shows a context chip (`ENG`). Make the keyboard picker reuse the command-menu shell (row 19) and show the issue identifier and title in the chip, so the target of a change is never ambiguous with multi-select later.
11. **Settings that never trap the user.** The settings sidebar replaces the app nav, as in Linear, but `Esc` and `G then I` (and every global shortcut) still work from it. Each settings row has a stable anchor URL (`/settings/members#invite`), so a teammate can link straight to a setting.

## 5. Proposed PLAN-016 "UI polish" slices

**Ground rules for every slice:**
- Each slice is one branch and one PR (`p016-sN-<topic>`) with a green `pnpm check`.
- Any token change also updates design-system.md §2 in the same PR. The spec is the source of truth.
- Browser e2e and visual tests are **on hold** (`docs/07-plans/README.md` §6), so verification is:
  - unit tests (token values, `contrast.test.ts`, Stylelint rules);
  - jsdom component tests (classes and `data-state`, focus behaviour);
  - the existing Storybook stories with the a11y addon (`pnpm test:storybook`), where the gate already runs it;
  - before and after screenshots taken by hand with a headless Playwright capture, checked by eye and not committed as tests.
- Re-baselining `pnpm test:visual` snapshots is a by-hand step listed in each As built note.

### S1: Foundation tokens · M
- **Changes:** `--hairline`, `--border-hairline`, the new `--bg-*` values and `--bg-group`, `--weight-regular: 450`, `--weight-ui: 500`, `text-md` to 15/24, `--tracking-*`, the `text-label` style, `--radius-group`, `--radius-kbd`, the stacked `--shadow-e0..e3`, `--dur-highlight-out`, `--dur-exit`, `--nav-item-height`, `--settings-*`.
- **Global fixes:** `button, input, select, textarea { font: inherit }` (row 38) and the single text-field focus ring (row 24).
- **Files:** `packages/ui/tokens/{primitives,semantic,component}.ts`, the generated `packages/ui/src/styles/tokens.css`, `packages/ui/src/styles/base.css`, `packages/ui/src/internal/control.module.css`, `docs/05-design/design-system.md` §2.
- **Verify:**
  - `pnpm test:tokens` extended to the new surfaces and `--bg-group`;
  - `tokens-generated.test.ts`;
  - a new unit test that `--hairline` resolves to 1px without `2dppx`;
  - the Stylelint test still rejects raw hex outside token files.

### S2: Overlay craft: exits, shadows, radii, input rings · M (needs S1)
- **Changes:**
  - Exit animations on Dialog, AlertDialog, Menu and ContextMenu, Popover, Tooltip and Toast (`[data-state='closed']`).
  - The e1 and e2 recipes and `--radius-lg` on floating overlays.
  - Hairline separators.
  - Kbd caps at 450 with a hairline border.
  - Remove the rings from the command-menu and picker search inputs (row 18 bug).
- **Files:** `packages/ui/src/components/{Dialog,Menu,Popover,Tooltip,Toast,Kbd,PropertyPicker}/*.module.css`, `apps/web/src/command-menu/CommandMenu.module.css`.
- **Verify:**
  - jsdom tests that each overlay sets the closing `data-state` and that focus returns to the trigger synchronously;
  - `overlay-manager.test.ts` stays green;
  - a unit test that every `@keyframes` in `packages/ui` uses only `--motion-*` tokens for movement (reduced motion);
  - Storybook a11y for all overlay stories in both themes.

### S3: Shell: inset panel, sidebar rhythm, header, breadcrumb fix · M (needs S1)
- **Changes:**
  - The `.main` card.
  - The sidebar on the app layer with no border.
  - 28px nav items at `--weight-ui` with the highlight motion.
  - The `text-label` section labels.
  - A 44px header with a hairline, round icon buttons and a labelled count.
  - **The breadcrumb link fix** (row 6, P0; it could also ship alone first as a one-line fix).
  - Narrow and drawer modes keep full-bleed.
- **Files:** `apps/web/src/shell/{Shell.module.css,Sidebar.tsx,PageHeader.tsx}`, `packages/ui/tokens/component.ts`.
- **Verify:**
  - the unit test for the breadcrumb class;
  - shell tests for `aria-current`, drawer mode and resize still pass;
  - a by-hand headless capture at 1440 and 390 in both themes;
  - axe on the shell story.

### S4: Issue list: inset rows, states, group headers · M (needs S1, S3)
- **Changes:**
  - Transparent, borderless inset rows with `--radius-md` state fills.
  - Hover in 0ms and out 150ms.
  - Focus with the accent bar, the 1px ring and `--bg-active`.
  - Row typography at 500 and 450, and `--tracking-id`.
  - Hairline label chips.
  - 36px inset group headers on `--bg-group`.
  - No focus ring on first load until keyboard use (row 13).
  - Row height per the user's decision.
- **Files:** `packages/ui/src/components/{IssueRow,GroupHeader,LabelChip,PropertyPill,VirtualList}/*`, `apps/web/src/features/issues/IssueList.module.css`, `focus-model.ts`, `docs/05-design/design-system.md` §2.5 and §4.
- **Verify:**
  - `issue-components.test.tsx` and `components.perf.test.tsx` (the < 1ms per row budget, deep tier);
  - a jsdom test that hover, focus and selected render distinct `data-*` and classes;
  - a focus-model unit test for no focus-visible on mount;
  - the contrast of the focus bar against `--bg-active` added to `contrast.test.ts`.

### S5: Command menu and keyboard pickers · M (needs S2)
- **Changes:**
  - Command menu at 680–720px, a light or no backdrop, a 15px input, 40px options, and a neutral active option.
  - Keep the footer hints.
  - S, P, A and L from the keyboard open the picker as a command-menu sub-page with the issue context chip, number caps and a check. Mouse keeps the anchored popover.
  - Context menu at 30px items, weight 450, `--radius-lg`.
- **Files:** `apps/web/src/command-menu/*`, `apps/web/src/features/issues/issue-pickers.ts`, `packages/ui/src/components/{PropertyPicker,Menu}/*`, `docs/05-design/command-menu.md`.
- **Verify:**
  - `property-picker.test.tsx` and the command-menu unit tests for keyboard routing (S opens the sub-page with the chip; `Esc` returns focus to the row);
  - the registry and shortcut tests unchanged;
  - Storybook a11y.

### S6: Issue page: title, body type, properties, comments, activity · M (needs S1, S2)
- **Changes:**
  - The title at `text-2xl` and 600, aligned with the body (row 26).
  - The editor at `text-md` (15/24/450) and the checklist alignment fix.
  - The properties column as left-aligned 28px round pills with `text-label` headings and muted empty placeholders.
  - The comment composer card.
  - Activity icons and a rail.
  - Round header icon buttons and the position counter in the header.
- **Files:** `packages/ui/src/components/{EditableTitle,PropertyPill}/*`, `packages/editor/src/editor.css`, `apps/web/src/features/issues/{issue-page.module.css,IssuePage.tsx,activity.module.css,ActivityStream.tsx}`, `apps/web/src/features/comments/comments.module.css`.
- **Verify:**
  - editor unit tests (task item DOM unchanged);
  - the `ActivityStream` story with axe;
  - property pill names still announce "Status: In Progress";
  - by-hand captures of ENG-1, ENG-3 and ENG-8, wide and narrow.

### S7: Settings layout and grouped rows · L (needs S1, S3)
- **Changes:**
  - A `SettingsLayout`: the settings sidebar replaces the app nav, "Back to app", a 640px column, and a page title with a description.
  - `SettingsGroup` and `SettingsRow` primitives in `packages/ui`.
  - Migrate profile, preferences, security, members, workspace, labels, teams, workflow, estimates and automations onto them.
  - Delete the duplicated list and card CSS from the feature modules.
- **Files:** `apps/web/src/pages/{SettingsPage.tsx,Pages.module.css}`, `apps/web/src/app/{router.tsx,settings.ts}`, the new `packages/ui/src/components/Settings*`, and `apps/web/src/features/{members,labels,statuses,teams,security,invites,profile,workspace,estimates}/*.module.css`.
- **Verify:**
  - router unit tests (each settings URL renders inside the layout; `Esc` and global shortcuts work from settings);
  - the settings feature tests unchanged;
  - Storybook stories for `SettingsGroup` and `SettingsRow` with axe;
  - by-hand captures of all 13 settings pages.

### S8: Empty, loading and toast states · S (needs S1, S2)
- **Changes:**
  - Empty states with a `Kbd` shortcut in the sentence and the button, and a 24px tertiary icon.
  - Skeleton rows with the final row geometry.
  - Toast at `--radius-lg` with a hairline and exit motion (if S2 didn't cover it).
  - The not-found pages use the same empty-state pattern.
- **Files:** `packages/ui/src/components/{EmptyState,Skeleton,Toast}/*`, `apps/web/src/features/issues/IssueListPage.tsx`, `apps/web/src/pages/NotFoundPage.tsx`.
- **Verify:** component tests that the empty state renders its shortcut as `kbd` with spoken text, a skeleton-delay unit test (150ms with fake timers), and Storybook a11y.

**Order and parallelism:**
- S1 first.
- Then S2 and S3 in parallel, S4 after S3, and S5 after S2.
- S6, S7 and S8 can run in parallel once S1 to S3 are in.
- A same-day hotfix PR ahead of S1, so users stop seeing the visible bugs: the breadcrumb (6), the triple ring (24), the leaked command-menu ring (18) and the title alignment (26).

**Decisions to take before S4 and S5 (all taken by the user on 2026-11-25; see design-system.md §8, D-c to D-e):**
- Row height: decided 44/36 like Linear.
- The command-menu backdrop: decided none, like Linear.
- Keyboard pickers move into the command-menu shell: decided yes. This changes SPEC-005 and SPEC-012 behaviour text.
