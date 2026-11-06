# Surface: Command Menu (`Mod+K`)

Status: **Draft v0.1** · Date: 2026-11-06 · Implements: FR-NAV-02, FR-NAV-04 (search mode, M2) · Engine: [SPEC-005 §4](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md)

The command menu is Surface's **universal entry point**. Every action, navigation target, and (from M2) search result is reachable here. If something can be done in Surface, it can be done from `Mod+K`.

---

## 1. Anatomy

```
┌──────────────────────────────────────────────────────────────┐
│ [ENG-142 · Fix login redirect]  ← context chip (what acts on) │
│ ▸ Type a command or search…                                  │
├──────────────────────────────────────────────────────────────┤
│ SUGGESTED                                                    │
│   ◔  Change status…                                     S    │
│   ⇡  Set priority…                                      P    │
│   @  Assign to me                                       I    │
│ NAVIGATION                                                   │
│   ⌂  Go to My issues                                  G M    │
│ ISSUES                       (search results, M2)            │
│   ENG-87  Login page flickers on Safari          In Progress │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ navigate   ↵ select   ⌫ back   esc close                  │
└──────────────────────────────────────────────────────────────┘
```

- **Size:** 640 px wide, at most 60% of the viewport tall, centred in the top third. `--bg-elevated`, elevation `e2`.
- **Context chip:** shows what commands apply to: the focused issue, "3 selected issues", the current project, or nothing. `Backspace` on an empty input removes the chip, so commands apply globally.
- **Sections** (in this order, hidden when empty): Suggested (context actions), Navigation, Create, Issues / Projects / Docs / People (search, M2), Settings, Help.
- **Footer** shows key hints.

## 2. Sources

| Source | Content | Since |
|---|---|---|
| **Operations** | Every registry operation with `ui` metadata whose `contexts` match the current context ([SPEC-003 §3](../06-specs/SPEC-003-operation-registry-executor.md)). Filtered by permission: no Admin commands for Members. | M0 |
| **Navigation** | Pages: Inbox, My issues, each team's pages, Settings sections, Views, Projects | M0 |
| **Toggles** | Theme, sidebar, density, display options | M0 |
| **Local search** | Issues by identifier and title, projects, documents, people, teams, views (FlexSearch worker) | M2 |
| **Server full-text** | Description, comment, and document text matches, arriving asynchronously in their own section | M2 |
| **Recent** | The last 10 opened items and the last 5 commands, shown when the query is empty | M2 |

## 3. Behaviour

### 3.1 Query handling
1. **Identifier fast path:** input that matches `^[A-Za-z]{2,5}-\d+$` (e.g. `eng-87`) puts **Open ENG-87** first. `Enter` opens it immediately.
2. **Command matching:** fuzzy match on the title, keywords, and aliases (from the operation's `keywords`). Ranking = fuzzy score × context boost (×2 if the command applies to the current context) × frecency boost (recently and frequently used).
3. **Search** (M2): runs in parallel against the local index, with debounced server full-text (150 ms, abortable). Results stream into their sections without reordering what the user is currently pointing at.

### 3.2 Nested pages
Commands that need a value open a **sub-page** in the same menu, using the shared Property picker list:
`Change status…` → list of the team's statuses → `Enter` applies to the context → the menu closes and an Undo toast shows.
`Backspace` on an empty query goes back one level. The breadcrumb shows the path: `ENG-142 › Change status`.

### 3.3 Context rules
| Context | Example suggested commands |
|---|---|
| One issue (focused or open) | Change status, priority, assignee, labels, estimate, project, cycle, copy ID or link, delete |
| Multiple selected issues | The same as above, applied in bulk ("Set priority for 3 issues…"), plus Clear selection |
| Project page | Edit project, post update, add milestone, add issues |
| Team page | Create issue in TEAM, go to cycles, team settings |
| Nothing | Create issue, Create team, Go to…, Search |

### 3.4 Execution
- A selected command calls `dispatch(op, input)` (the same path as any UI control), then closes the menu and shows an Undo toast (M2) where an inverse exists.
- Commands that open a UI (e.g. "Create issue") close the menu and open that UI.
- Errors show as a toast. The menu does not reopen.

## 4. Keyboard

| Key | Action |
|---|---|
| `Mod+K` | Open, or close if already open |
| `↑` / `↓`, `Ctrl+N` / `Ctrl+P` | Move |
| `Enter` | Run or select |
| `Mod+Enter` | Run and keep the menu open (for chaining several actions) |
| `Backspace` (empty query) | Go back a page, or remove the context chip |
| `Esc` | Close |
| `Tab` | Jump to the next section |

## 5. Performance & accessibility

- The menu opens in **< 50 ms**. Filtering ~300 commands plus local results takes **< 16 ms** per keystroke (main thread budget). Search runs in a worker.
- The list is virtualised when it exceeds 50 items.
- **ARIA combobox pattern:** `role="combobox"` input with `aria-activedescendant` over a `role="listbox"`. Section headers are `role="presentation"` with group labels. Result counts are announced via a live region.
- Focus returns to the element that was focused before opening.

## 6. Acceptance (summarised in SPEC-005)
Every M0 operation with `ui` metadata appears. Context and permission filtering is correct. Nested picker pages work. The identifier fast path works. The keyboard table above is fully implemented. The axe audit passes.
