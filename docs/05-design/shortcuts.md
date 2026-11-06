# Surface: Keyboard Shortcut Map & Registry

Status: **Draft v0.1** · Date: 2026-11-06 · Implements: FR-NAV-03, NFR-18 · Engine: [SPEC-005 §5](../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md)

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
1. **`Mod`** = ⌘ on macOS, Ctrl on Windows and Linux. Never hard-code Cmd or Ctrl.
2. **Inside text inputs and the editor,** only `Mod+…` combinations and `Esc` fire. Single-letter shortcuts are disabled while typing.
3. **Sequences** (`G` then `I`) must be completed within 1 s. The first key shows a small hint toast ("G… I: Inbox, M: My issues…").
4. **Scope resolution:** the most specific active scope wins (modal, then picker, then focused component scope, then page scope, then global).
5. **Conflicts:** a CI test fails if two shortcuts in overlapping scopes share keys. The browser and OS reserved list (`Mod+T`, `Mod+W`, `Mod+N`, `Mod+Q`, `Mod+L`, `Mod+R`, `Mod+Shift+T`, `Mod+Tab`, `F5`, `F11`, `F12`) is blocked.
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
| `modal` / `picker` | An overlay is open (captures navigation keys) |

## 3. Shortcut map

The **M** column is the milestone in which a shortcut ships. Shortcuts arrive with their feature.

### 3.1 Global
| Keys | Action | M |
|---|---|---|
| `Mod+K` | Open command menu | M0 |
| `/` | Search (command menu in search mode) | M2 |
| `C` | Create issue (context-prefilled) | M1 |
| `Alt+C` | Create issue from template | M4 |
| `?` | Keyboard shortcut help | M0 |
| `[` | Toggle sidebar | M0 |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo | M2 |
| `Mod+,` | Settings | M0 |
| `Alt+Shift+T` | Toggle light/dark theme | M0 |
| `Esc` | Close the overlay, clear the selection, or go back from peek | M0 |

### 3.2 Navigation (`G` then …)
| Keys | Go to | M |
|---|---|---|
| `G` `I` | Inbox | M4 |
| `G` `M` | My issues | M2 |
| `G` `T` | Team triage | M4 |
| `G` `A` | Team active issues | M2 |
| `G` `B` | Team backlog | M2 |
| `G` `E` | Team all issues | M1 |
| `G` `C` | Current cycle | M3 |
| `G` `P` | Projects | M3 |
| `G` `V` | Views | M2 |
| `G` `N` | Initiatives | M5 |
| `G` `S` | Settings | M0 |
| `G` `X` | Trash | M1 |
| `O` `F` | Open favorite… | M2 |
| `O` `T` | Open team… | M0 |
| `O` `P` | Open project… | M3 |
| `Alt+1…9` | Switch to team 1–9 in the sidebar order | M1 |

### 3.3 Lists & boards (`list` scope)
| Keys | Action | M |
|---|---|---|
| `J` / `↓`, `K` / `↑` | Next / previous row | M1 |
| `Enter` / `O` | Open the focused issue | M1 |
| `Space` | Peek the focused issue | M2 |
| `X` | Toggle selection of the focused row | M2 |
| `Shift+J` / `Shift+K` | Extend the selection down / up | M2 |
| `Mod+A` | Select all in view | M2 |
| `Mod+B` | Toggle list / board | M2 |
| `Shift+V` | Display options | M2 |
| `F` | Filter | M2 |
| `Alt+V` | Save as view | M2 |
| `T` (on a group header) | Collapse or expand the group | M2 |
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
| `E` | Estimate | M1 |
| `Shift+D` | Due date | M1 |
| `Shift+P` | Project | M3 |
| `Shift+C` | Cycle | M3 |
| `Mod+Shift+P` | Set parent | M3 |
| `Mod+Shift+O` | Create sub-issues | M3 |
| `M` then `B` / `R` / `D` | Mark as blocking / related / duplicate of… | M3 |
| `Mod+Shift+M` | Move to team… | M3 |
| `Mod+.` | Copy identifier | M1 |
| `Mod+Shift+.` | Copy link | M1 |
| `Mod+Shift+,` | Copy git branch name | M1 |
| `R` | Rename (focus the title) | M1 |
| `Mod+Backspace` | Delete (to trash, with undo) | M1 |
| `Shift+S` | Subscribe / unsubscribe | M4 |
| `Alt+F` | Toggle favorite | M2 |
| `Mod+Enter` (on the issue page) | Focus the comment box, or submit the comment | M1 |

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
| `Mod+B` / `Mod+I` / `Mod+U` / `Mod+E` | Bold / italic / underline / inline code | M1 |
| `Mod+Shift+7` / `8` / `9` | Numbered list / bullet list / checklist | M1 |
| `Mod+K` (with a selection) | Insert link. (Without a selection, the command menu opens.) | M1 |
| `/` (at line start) | Slash commands | M1 |
| `@` | Mention a person | M4 |
| `Mod+Alt+C` | Code block | M1 |
| `Esc` | Leave the editor (focus returns to the page) | M1 |

### 3.8 Pickers & modals
| Keys | Action |
|---|---|
| `↑` / `↓` | Move |
| `Enter` | Choose / apply |
| `Space` | Toggle (multi-select) |
| `0–9` | Quick choose (where shown) |
| `Mod+Enter` | Submit the modal (create issue, save) |
| `Esc` | Close (asks before discarding dirty content) |
