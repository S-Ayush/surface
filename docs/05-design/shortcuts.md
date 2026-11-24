# Surface: Keyboard Shortcut Map & Registry

Status: **Draft v0.1** · Date: 2026-11-06 · M1 keys changed 2026-11-12 (M1 gate, SPEC-012 §3.6) · Implements: FR-NAV-03, NFR-18 · Engine: [SPEC-005 §5](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md)

---

## 1. Registry model

Every shortcut is declared **once**, in `apps/web/src/shortcuts/registry.ts`:

```ts
shortcut({
  id: "issue.setPriority",
  keys: ["P"],                       // single key, "Mod+K", or sequence ["G","I"]
  scope: "issue",                    // where it is active (see §2)
  command: "issue.setPriority",      // command-menu command it triggers
  group: "Issue actions",            // for the ? help overlay
  milestone: "M1",
});
```

**Rules**
1. **`Mod`** = ⌘ on macOS, Ctrl on Windows and Linux. Never hard-code Cmd or Ctrl. *Added (SPEC-012 §4.2):* a chord may say **`Ctrl`**, the literal Control key on every platform, for the few Linear keys that use it (`Ctrl+Shift+1…9`, `Ctrl+M`, `Ctrl+Shift+I`, `Ctrl+L`). A binding may be limited to one platform (`platform: 'mac'`), and the registry and the `?` overlay show it only there.
2. **Inside text inputs and the editor,** only `Mod+…` combinations and `Esc` fire. Single-letter shortcuts are disabled while typing, except bindings marked `whileTyping: false`, which never fire while typing (`Mod+Backspace`, `Mod+Z` and the other text-editing chords: the registry refuses to load if one of them lacks the flag). The same applies to `global` bindings while an overlay is open (SPEC-005 §5, added 2026-11-07). *Changed (SPEC-012 §4.2).*
3. **Sequences** (`G` then `I`) must be completed within 1 s. The first key shows a small hint toast ("G… I: Inbox, M: My issues…").
4. **Scope resolution:** the most specific active scope wins (modal, then picker, then focused component scope, then page scope, then global).
5. **Conflicts:** a CI test fails if two shortcuts in overlapping scopes share keys, or if one's keys begin another's (`G` against `G S`). A binding that deliberately overrides one in a less specific scope names it in `shadows` (E1: the editor's `Mod+K`). The browser and OS reserved list (`Mod+T`, `Mod+W`, `Mod+N`, `Mod+Q`, `Mod+L`, `Mod+R`, `Mod+Shift+T`, `Mod+Tab`, `F5`, `F11`, `F12`) is blocked.
6. **Every shortcut maps to a command-menu command,** so everything a shortcut does is also discoverable through `Cmd+K`.
7. **Not user-rebindable in v1.** The registry design allows it later.

## 2. Scopes

| Scope | Active when |
|---|---|
| `global` | Always (except while typing, per rule 2) |
| `list` | An issue list or board has focus |
| `issue` | An issue is focused or selected in a list, open on its page, or in peek |
| `inbox` | The Inbox is the current page |
| `triage` | The Triage page, or a triage issue is focused |
| `editor` | The rich-text editor has focus |
| `issue-page` | The issue page is the current page (page scope; M1, SPEC-012) |
| `comment` | A comment card, or something inside it, has focus (component scope; M1, SPEC-012, SPEC-013) |
| `settings-row` | A row of a settings list (statuses, labels) has focus (component scope; M1, SPEC-010, SPEC-012) |
| `modal` / `picker` | An overlay is open (captures navigation keys) |

**Order, most specific first:** overlays (`modal`, `picker`), then `editor`, `comment` and `settings-row`, then `list` and `issue`, then page scopes (`issue-page`, `inbox`, `triage`), then `global`. The conflict test's overlap and specificity tables gain `issue-page` with `issue`, `editor` and `comment`, and `comment` with `issue` and `editor`. There are no `trash` or `archive` scopes: the rows of the team archive and Recently deleted pages set `list` and `issue` like any issue row, and commands that don't apply to an archived or deleted issue are unavailable (SPEC-012 §3.8, SPEC-015).

## 3. Shortcut map

The **M** column is the milestone in which a shortcut ships. Shortcuts arrive with their feature.

### 3.1 Global
| Keys | Action | M |
|---|---|---|
| `Mod+K` | Open command menu | M0 |
| `/` | Search (command menu in search mode) | M2 |
| `C` | Create issue (context-prefilled) | M1 |
| `Alt+C` | Create issue from template | M4 |
| `?` / `Mod+/` | Keyboard shortcut help (`Mod+/` is Linear's second key) | M0 / M1 |
| `[` | Toggle sidebar | M0 |
| `Mod+Z` | Restore the issue you just deleted (does nothing when there is none). Not while typing: in a text field it undoes text | M1 |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo (take over `Mod+Z` from the line above) | M2 |
| `Mod+,` | Settings | M0 |
| `Alt+Shift+T` | Toggle light/dark theme | M0 |
| `Esc` | Close the overlay, clear the selection, or go back from peek | M0 |
| `F8` | Focus notifications (the toast region; handled by the component, listed in help). Added 2026-11-07, PLAN-005 S3/S5 | M0 |

### 3.2 Navigation (`G` then …)
| Keys | Go to | M |
|---|---|---|
| `G` `I` | Inbox | M4 |
| `G` `M` | My issues (opens Assigned) | M1 |
| `G` `D` | Drafts | M1 |
| `G` `T` | Team triage | M4 |
| `G` `A` | Team active issues | M2 |
| `G` `B` | Team backlog | M2 |
| `G` `E` | All issues of the current team (route team, else home team, else first member team) | M1 |
| `G` `C` | Current cycle | M3 |
| `G` `P` | Projects | M3 |
| `G` `V` | Views | M2 |
| `G` `N` | Initiatives | M5 |
| `G` `S` | Settings | M0 |
| `G` `X` | Team archive of the current team (same team rule as `G` `E`; Recently deleted is inside it) | M1 |
| `O` `F` | Open favorite… | M2 |
| `O` `T` | Open team… | M0 |
| `O` `P` | Open project… | M3 |
| `Ctrl+Shift+1…9` | Issues of team 1–9 in the sidebar order (literal Control on every platform; matched on `Digit1`…`Digit9`. It replaced `Alt+1…9`, which Firefox on Linux uses for tabs) | M1 |

### 3.3 Lists & boards (`list` scope)
| Keys | Action | M |
|---|---|---|
| `J` / `↓`, `K` / `↑` | Next / previous row | M1 |
| `Enter` | Open the focused issue | M1 |
| `Space` | Peek the focused issue | M2 |
| `X` | Toggle selection of the focused row | M2 |
| `Shift+J` / `Shift+K` | Extend the selection down / up | M2 |
| `Mod+A` | Select all in view | M2 |
| `Mod+B` | Toggle list / board | M2 |
| `Shift+V` | Display options | M2 |
| `F` | Filter | M2 |
| `Alt+V` | Save as view | M2 |
| `T` (on a focused group header) | Collapse or expand the group | M1 |
| `Alt+T` | Collapse or expand all groups | M1 |
| `Mod+Shift+←` / `→` (board) | Move the card to the previous / next column | M2 |
| `Alt+↑` / `Alt+↓` | Move the issue up / down (manual order) | M2 |

### 3.4 Issue actions (`issue` scope: focused, selected, or open)
| Keys | Action | M |
|---|---|---|
| `S` | Set status | M1 |
| `P` | Set priority (then `0–4` inside the picker) | M1 |
| `A` | Assign… | M1 |
| `I` | Assign to me | M1 |
| `L` | Labels | M1 |
| `Shift+E` | Estimate | M1 |
| `Shift+D` | Due date | M1 |
| `Mod+Shift+D` | Remove the due date | M1 |
| `Shift+P` | Project | M3 |
| `Shift+C` | Cycle | M3 |
| `Mod+Shift+P` | Set parent | M3 |
| `Mod+Shift+O` | Create sub-issues | M3 |
| `M` then `B` / `R` / `D` | Mark as blocking / related / duplicate of… | M3 |
| `Mod+Shift+M` | Move to team… | M3 |
| `Mod+.` | Copy ID | M1 |
| `Mod+Shift+,` | Copy URL (matched on `Comma`) | M1 |
| `Mod+Shift+.` | Copy git branch name (matched on `Period`) | M1 |
| `Mod+Shift+'` | Copy title (matched on `Quote`) | M1 |
| `Mod+Alt+C` | Copy issue as Markdown (matched on `KeyC`) | M1 |
| `Shift+R` | Rename (focus the title; on a list, open the issue with the title in edit mode) | M1 |
| `Mod+Backspace` | Delete: opens a confirm dialog. Not while typing | M1 |
| `#` | Restore the issue. Only on an archived issue, or a deleted one before its `purgeAfter` (SPEC-015 §3.4); on an archive row or an archived or deleted issue's page | M1 |
| `Shift+S` | Subscribe / unsubscribe | M4 |
| `Alt+F` | Toggle favorite | M2 |

### 3.4a Issue page (`issue-page` scope)
| Keys | Action | M |
|---|---|---|
| `J` / `K` | Next / previous issue of the source list | M1 |
| `Mod+Enter` | Save the description now | M1 |
| `Ctrl+M` | Comment on the issue: focus the comment box, saving the description first (macOS only) | M1 |
| `Ctrl+Shift+I` | Focus the description (macOS only) | M1 |
| `Mod+Shift+U` | Attach file | M1 |
| `Ctrl+L` | Link any URL to the issue (macOS only: on Windows and Linux `Ctrl+L` is the browser's address bar, so it is unbound there; the command stays in the ⋯ menu and `Mod+K`) | M1 |

`Ctrl+M` and `Ctrl+Shift+I` are macOS only because the browser owns them elsewhere (Firefox mute tab, DevTools). `Esc` on the issue page goes back to the source list as the last step of the existing chain.

### 3.4b Comments (`comment` scope)
| Keys | Action | M |
|---|---|---|
| `R` | Reply to the focused comment | M1 |
| `Enter` / `Mod+Enter` | Send the comment, reply or edit in this box (`Shift+Enter` is a new line; shadows `issue-page` `Mod+Enter`) | M1 |

Linear lists no keys to move through comments, edit or delete one, so Surface has none: those run from the comment menu.

### 3.4c Settings lists (`settings-row` scope)
| Keys | Action | M |
|---|---|---|
| `Enter` | Edit the focused row | M1 |
| `E` | Edit the label name (labels page) | M1 |
| `Alt+↑` / `Alt+↓` | Reorder: move one position (statuses; never leaves the category) | M1 |
| `Mod+Backspace` | Delete (opens a confirm dialog). Not while typing | M1 |

### 3.5 Inbox (`inbox` scope)
| Keys | Action | M |
|---|---|---|
| `J` / `K` | Next / previous notification | M4 |
| `U` | Mark read / unread | M4 |
| `Alt+U` | Mark all read | M4 |
| `H` | Snooze… | M4 |
| `Backspace` | Delete notification | M4 |
| `Shift+Backspace` | Delete all read | M4 |

### 3.6 Triage (`triage` scope)
| Keys | Action | M |
|---|---|---|
| `1` | Accept | M4 |
| `2` | Decline | M4 |
| `3` | Mark as duplicate… | M4 |
| `H` | Snooze… | M4 |

### 3.7 Editor (`editor` scope)
| Keys | Action | M |
|---|---|---|
| `Mod+B` / `Mod+I` / `Mod+U` / `Mod+E` | Bold / italic / underline / inline code (the editor handles them) | M1 |
| `Mod+Shift+X` | Strikethrough | M1 |
| `Mod+Alt+0` / `Mod+Alt+1…4` | Regular text / heading 1–4 (matched on `Digit`) | M1 |
| `Mod+Shift+7` / `8` / `9` | Checklist / bulleted list / numbered list (matched on `Digit7`…`9`) | M1 |
| `Alt+Shift+.` | Blockquote (matched on `Period`) | M1 |
| `Mod+Shift+\` | Code block (matched on `Backslash`) | M1 |
| `Mod+Enter` | In a checklist item only: toggle it. Elsewhere it falls through to `issue-page` or `modal` | M1 |
| `Alt+↑` / `Alt+↓` | Move the block up / down (the editor handles it) | M1 |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo text (the editor handles them; the global `Mod+Z` doesn't fire here) | M1 |
| `Mod+K` (with a selection) | Add or edit a link. (Without a selection, the command menu opens: the E1 shadow.) | M1 |
| `/` (at line start) | Slash commands | M1 |
| `@` | Mention a person | M4 |
| `Esc` | Leave the editor (focus returns to the page) | M1 |

`Mod+Shift+U` is one `issue-page` binding (§3.4a): with focus in the description or a comment box it inserts the file inline; elsewhere it adds an attachment. Shortcuts that include `Alt`, a digit, or `Shift` with a non-letter match on the physical key (`event.code`; SPEC-005 E3).

### 3.8 Pickers & modals
| Keys | Action |
|---|---|
| `↑` / `↓` | Move |
| `Enter` | Choose / apply |
| `Space` | Toggle (multi-select) |
| `0–9` | Quick choose (where shown) |
| `Mod+Enter` | Submit the modal (create issue, save) |
| `Esc` | Close (asks before discarding dirty content) |

### 3.9 Reserved keys
Linear's keys for commands Surface doesn't have yet. Nothing else is bound to them, so they are free when the command arrives (SPEC-012 §3.6). Where a row above gives a different key for the same command, the reserved key below is the one to use when the command arrives, and that row changes with it.

- **Navigation:** `G` `I` inbox (M4), `G` `T` triage (M4), `G` `A` active issues and `G` `B` backlog (M2 view tabs), `G` `C` cycles, `G` `V` current cycle, `G` `W` upcoming cycle, `G` `P` projects, `G` `N` initiatives, `G` `R` reviews, `O` `I` open issue, `O` `T` open team, `O` `U` open user, `O` `P`, `O` `C`, `O` `V`, `O` `D`, `O` `N`, `O` `F`, `O` `W` switch workspace, `]` right sidebar, `/` search (M2), `Mod+Alt+O` open the link from the last toast, `Mod+Alt+X` dismiss all toasts, `Alt+Shift+Q` log out.
- **Issues:** `V` new issue full screen, `Alt+C` new from template, `Ctrl+Alt+Shift+T` apply template, `Alt+F` favorite, `Shift+H` remind, `Mod+Shift+M` move to another team, `Shift+S` subscribe, `Mod+Shift+S` manage subscribers, `M` `B` / `M` `X` / `M` `R` / `M` `M` relations, `Mod+Alt+P` copy as prompt, `Mod+Shift+O` create sub-issue, `Shift+C` cycle, `Shift+P` project, `Shift+M` milestone, `Mod+Shift+P` set parent, `Mod+Shift+↑` open parent, `Mod+Shift+↓` open sub-issue, `Ctrl+Shift+L` toggle links.
- **Lists:** `Space` peek, `X` select, `Mod+Alt+A` select group, `Mod+A` select all, `Esc` clear selection, `Mod+B` layout, `Shift+V` display options, `Mod+Shift+C` copy page URL, `Alt+Shift+↑` / `Alt+Shift+↓` top or bottom of group, `Alt+↑` / `Alt+↓` and `Alt+←` / `Alt+→` move one position or column (manual order and board, M2), `F` filters, `Alt+Shift+F`, `Shift+F`.
- **Editor:** `Mod+Shift+6` collapsible, `Mod+Shift+Enter` toggle nested checklist, `Alt+F10`, `Shift+F10`.
- **Inbox:** `E`, `U`, `H` and the others arrive with the inbox (M4).

### 3.10 Not bound in M1, on purpose
- `Enter` on a group header: `T` toggles it.
- `Mod+Z` in a text field or the editor: it undoes text. Outside text, the global `Mod+Z` restores only the last issue you deleted, until M2's general undo takes the key over.
- Permanent delete: no chord. It runs only from a deleted issue's page (its ⋯ menu) or "Permanently delete…" in `Mod+K`, for Admins, in a confirm dialog (SPEC-015 §3.4). The archive page's rows have Copy › and Restore only. There is also no archive, unarchive or purge binding.
- `Ctrl+L`, `Ctrl+M` and `Ctrl+Shift+I` on Windows and Linux, where the browser owns them. Their commands run from the ⋯ menu and `Mod+K`.
- `Mod+Shift+D` is also a browser key ("Bookmark all tabs"). The binding calls `preventDefault`, and "Remove due date" stays in `Mod+K` if the browser wins.
- Linear's comment keys (`↑` / `↓` through comments, `E` to edit, `Mod+Backspace` to delete a comment): its panel doesn't list them. Edit and delete run from the comment menu.
