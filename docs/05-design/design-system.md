# Surface: Design System (foundations & core components)

Status: **Draft v0.1** · Date: 2026-11-06 · Package: `packages/ui` · Related: [shortcuts](shortcuts.md), [command menu](command-menu.md), [SPEC-005](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md)

> Surface borrows Linear's *product model*, not its visual identity. Its colours, type, iconography, and layout are its own.

---

## 1. Design principles

1. **Instant feedback.** Every local action renders in the same frame. No spinners for local work; skeletons appear only while content loads on first open.
2. **Keyboard first, mouse friendly.** Every interactive element can be reached by keyboard, shows a visible focus ring, and advertises its shortcut in a tooltip or menu.
3. **Quiet chrome, loud content.** Neutral surfaces with one accent colour. Colour is reserved for meaning: status, priority, labels, health.
4. **Dense but calm.** Work tools show a lot of rows. A 13 px base, a 4 px grid, and generous line height keep density readable.
5. **Undo over confirm.** Reversible actions happen immediately and show an "Undo" toast. Only irreversible actions (purge, revoke) ask for confirmation.
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

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-app` | `#FAFBFC` | `#0E1013` | Window background |
| `--bg-sidebar` | `#F4F5F7` | `#111316` | Sidebar |
| `--bg-panel` | `#FFFFFF` | `#14171B` | Main content surfaces |
| `--bg-elevated` | `#FFFFFF` | `#1B1F24` | Popovers, menus, modals |
| `--bg-hover` | `#F0F1F4` | `#1F2329` | Hovered row or item |
| `--bg-active` | `#E8EAEE` | `#252B32` | Pressed, or the current nav item |
| `--bg-selected` | `#E2F3F2` | `#123130` | Selected rows (multi-select) |
| `--border-subtle` | `#ECEDF1` | `#1F2329` | Row separators |
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
| `--danger` / `--warning` / `--success` / `--info` | `#D03A3A` / `#B86E0C` / `#2B9255` / `#3569D4` | `#F06868` / `#EBA33F` / `#4FC47D` / `#6E9EF6` | Feedback, and semantic icons |

> **Corrections (2026-11-06, PLAN-005 S1):** the contrast test failed four light-theme proposals: `--accent` `#0E8A87` (white text on it was 4.2:1, and as link text 4.2:1), `--focus-ring` `#2BB0AC` (2.7:1), and `--text-tertiary` `#666D7C` (4.3:1 on `--bg-active`); `--accent-hover` darkened with the accent. `--bg-selected` was merged with `--accent-subtle` and dark `--bg-hover` with `--border-subtle` (each within 2 RGB steps) so the primitive scales stay at 12 steps. Added tokens: `--danger-hover`, `--on-danger`, `--{danger,warning,success,info}-subtle`, `--label-<hue>`, and `--border-control` (inputs need a 3:1 edge, WCAG 1.4.11; `--text-disabled` shares its new, darker value). `tnum` is applied only where numbers align (`--font-features-numeric`), not to all text. The source of truth is `packages/ui/tokens/*.ts`.

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

| Token | Value |
|---|---|
| UI font | **Inter** (variable, OFL), bundled locally with no CDN (FR-OPS-09) |
| Mono font | **JetBrains Mono** (OFL), used for identifiers in code contexts, code blocks, and keys |
| Features | `font-feature-settings: "cv11", "ss01", "tnum"` (tabular numbers in tables and counts) |

| Style | Size / line height | Weight | Use |
|---|---|---|---|
| `text-xs` | 11 / 16 | 500 | Badges, keyboard hints |
| `text-sm` | 12 / 16 | 400–500 | Metadata, table cells |
| `text-base` | **13 / 20** | 400 | Default UI and list rows |
| `text-md` | 14 / 22 | 400 | Editor body, comments |
| `text-lg` | 16 / 24 | 600 | Section titles, modal titles |
| `text-xl` | 20 / 28 | 600 | Page titles (project, view) |
| `text-2xl` | 24 / 32 | 600 | Issue title (editable) |

The user preference "font size" (FR-AUTH-10) scales the root by 12 / 13 / 14 px.

### 2.5 Spacing, sizing, radius, elevation

- **Spacing (4 px grid):** `0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`. The 2 px and 6 px steps are for tight icon alignment only.
- **Control heights:** `sm 24 · md 28 · lg 32`.
- **Row heights:** list row `36` (comfortable) or `32` (compact preference). Board card minimum height `72`.
- **Radius:** `xs 4` (badges, kbd) · `sm 6` (buttons, inputs, rows) · `md 8` (cards, popovers) · `lg 12` (modals) · `full` (avatars, pills).
- **Elevation:** `e1` popovers and menus · `e2` modals and the command menu · `e3` toasts. Light theme uses soft shadows. Dark theme uses a 1 px `--border-default` plus a deeper shadow, because shadows read poorly on dark backgrounds.
- **Z-index scale:** base 0 · sticky headers 10 · sidebar 20 · popover 40 · modal 50 · command menu 60 · toast 70 · tooltip 80.

### 2.6 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 0 ms | Selection, focus, property changes |
| `--dur-fast` | 100 ms | Hover, tooltip in, menu open |
| `--dur-base` | 160 ms | Modal and peek open, sidebar collapse |
| `--dur-slow` | 240 ms | Large layout transitions (rare) |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Entering elements |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving elements |

Rules: animation **never delays input**. Exit animations are shorter than enter animations. `prefers-reduced-motion` turns transitions into opacity changes only. List reordering is not animated in v1, because animation at 10k rows costs too much.

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

- **Sidebar:** workspace switcher-free header (logo + workspace name + user menu), search and create buttons, then Inbox, My Issues, Views, Projects, Initiatives, **Favorites**, **Your teams** (expandable: Triage, Issues, Cycles, Projects, Views), then Trash and Settings at the bottom. Collapse with `[`.
- **Header (48 px):** breadcrumb, view tabs (e.g. All / Active / Backlog), and right-side actions (filter, display options, view ⋯). It stays sticky.
- **Main pane:** max content width is *unbounded* for lists and boards. Long-form pages (issue, project, document) use a centred column, max 760 px of text, plus a right-hand properties panel (280 px).
- **Peek:** a right-side panel with an issue preview (`Space`), 480 px, resizable. `Esc` closes it.
- **Breakpoints:** ≥ 1280 full · 1024–1279 properties panel collapses into a header drawer · 768–1023 sidebar overlays · < 768 a single column for read, comment, and triage only (NFR-20).

---

## 4. Interaction patterns

| Pattern | Rule |
|---|---|
| **Focus vs selection** | One *focused* row moves with `J/K` or `↑/↓`. *Selected* rows (multi-select with `X` or shift-click) have a `--bg-selected` background. Actions apply to the selection if one exists, otherwise to the focused row. |
| **Property editing** | Click a pill or press its shortcut to open the **Property picker** anchored to the pill (or to the row or command menu when invoked by keyboard). |
| **Inline text editing** | Titles are click-to-edit. `Enter` saves, `Esc` cancels, and blur saves. |
| **Create** | `C` opens the **create modal** with the current context prefilled (team, project, cycle, status of the column). `Mod+Enter` creates. "Create more" keeps the modal open. |
| **Destructive actions** | Reversible deletes (trash) run immediately with an Undo toast (8 s). Irreversible actions use a confirm dialog that requires typing or a second press. |
| **Empty states** | An icon, one sentence, a primary action, and its shortcut (e.g. "No issues yet. Create one with `C`"). |
| **Loading** | Eager data is never shown as loading. Lazy content shows a skeleton after 150 ms (no flash for fast loads). |
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
| **Toast** | Message, optional action (Undo), auto-dismiss 5 s (8 s with an action). Max 3 stacked. | `aria-live="polite"`. Actions are reachable with `Mod+Z` for undo. |
| **Skeleton · Spinner · ProgressBar · ProgressRing** | | `aria-busy`, and `role="progressbar"` with values |

### 5.2 Overlays
| Component | Notes |
|---|---|
| **Popover** | Anchored, flips on collision, closes on `Esc` and outside click. Returns focus to the trigger. |
| **Menu / ContextMenu** | Items with icon, label, shortcut, submenu, and checked state. Type-ahead. Right-click opens the same items as the `⋯` menu (FR-NAV-11). |
| **Dialog (Modal)** | `sm 420 · md 560 · lg 720`. Focus trap. `Esc` closes unless the content is dirty (then it asks to discard). |
| **Command menu** | See [command-menu.md](command-menu.md) |
| **Shortcut help** | `?` overlay listing all shortcuts by group, with a search filter |

### 5.3 Domain components
| Component | Description |
|---|---|
| **StatusIcon · PriorityIcon · HealthDot · CycleIcon · ProjectIcon** | Domain icons (§2.2) |
| **PropertyPill** | Compact button showing a property value (icon + text). Variants by property: status, priority, assignee, labels, estimate, cycle, project, milestone, due date. An empty value shows a muted placeholder on hover only. |
| **Property picker** | The **single** picker for every property: search field, filtered list with icons, keyboard numbers for quick choice where it makes sense (priority `0–4`), multi-select for labels (`Space` toggles, `Enter` applies), and a "No X" option. Opens anchored, or as a sub-page of the command menu. |
| **LabelChip** | Colour dot plus name, removable in edit mode |
| **IssueRow** | Grid: [select] · priority · identifier · status · title (flex) · labels · project · cycle · estimate · due · assignee · updated. Columns follow the display properties. Hover reveals quick pills. Heights per §2.5. |
| **GroupHeader** | Group icon, name, count or estimate sum (click toggles), collapse (`T` on hover), add (+). Sticky. |
| **BoardColumn · BoardCard** | Column = group. The card shows identifier, title (2 lines), and the chosen properties. Drag and drop with keyboard alternatives (`Mod+Shift+←/→` moves the focused card between columns). |
| **EditableTitle** | `text-2xl` inline title editor |
| **EmptyState** | §4 |
| **DatePicker** | Calendar plus natural-language input ("tomorrow", "next friday", "in 2 weeks") |
| **ColorPicker** | 12-hue palette grid (§2.2) |
| **EmojiPicker** | Reactions and icons (M1) |
| **SidebarNavItem · SidebarSection** | Icon, label, count, active state, drag to reorder (favorites), collapsible sections |
| **ViewToolbar** | Filter button plus active filter chips, Display options popover, and save-view affordance |

> **As built (2026-11-06, PLAN-005 S2):** SegmentedControl and ColorPicker are Radix RadioGroups. Kbd speaks shortcuts through visually hidden text ("Command K"), because `aria-label` is not allowed on `<kbd>`. A Button with a `shortcut` hides its Kbd and sets `aria-keyshortcuts` (`ariaKeyShortcuts()` in `keys.ts`). Avatar initials use `--on-label` on the palette hue. Tooltips need one `TooltipProvider` at the app root. Storybook is `pnpm storybook` (not `pnpm ui:storybook`), story tests are `pnpm test:storybook`, and visual snapshots are `pnpm test:visual` (pinned Playwright Docker image).

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
