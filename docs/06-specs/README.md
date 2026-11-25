# Feature Specs: Index

Template: [METHODOLOGY §2, Phase 5](../METHODOLOGY.md#phase-5-feature-specs). Status flow: Draft, then Review, then Accepted, then Implemented.

## M0: Foundations
| Spec | Title | Implements | Status |
|---|---|---|---|
| [SPEC-001](SPEC-001-workspace-auth-members-teams.md) | Workspace setup, authentication, members & teams | FR-AUTH-01–05, 07–09 · FR-MEM-01–02 · FR-TEAM-01–04 | Accepted |
| [SPEC-002](SPEC-002-sync-engine-v0.md) | Sync engine v0 | ADR-0002 · NFR-01–03, 06–09 | Accepted |
| [SPEC-003](SPEC-003-operation-registry-executor.md) | Operation Registry & executor | FR-API-01 · ADR-0005, 0011 | Accepted |
| [SPEC-004](SPEC-004-packaging-ops-baseline.md) | Repository, CI & self-host packaging baseline | FR-OPS-01–04, 07, 09 · ADR-0001, 0013 | Accepted |
| [SPEC-005](SPEC-005-app-shell-command-menu-shortcuts.md) | App shell, command menu & shortcut registry | FR-NAV-01–03 · FR-AUTH-10 · NFR-18–21 | Accepted |

## M1: Core issues
| Spec | Title | Implements | Status |
|---|---|---|---|
| [SPEC-010](SPEC-010-workflow-labels-estimates.md) | Workflow statuses, labels & estimates | FR-WF-01–07 · FR-TEAM-04 | Accepted |
| [SPEC-011](SPEC-011-issues-core.md) | Issues core: create, properties, history, IDs | FR-ISS-01–05, 08 · content models (sync-protocol §4.2) | Accepted |
| [SPEC-012](SPEC-012-issue-page-list-view.md) | Issue page, composer & list view | FR-ISS-02, 04, 08, 11, 17 · FR-VIEW-02 (list) · FR-NAV-01 (Issues, Archive, Drafts items), 02, 03 · FR-NAV-10 (Assigned, Created tabs) | Accepted |
| [SPEC-013](SPEC-013-comments-reactions-editor.md) | Comments, reactions & rich editor | FR-COL-01, 02, 04 · ADR-0009 | Accepted |
| [SPEC-014](SPEC-014-attachments-files.md) | Attachments & files | FR-ISS-06, 07 · FR-OPS-10 · NFR-15 · ADR-0014 | Accepted |
| [SPEC-015](SPEC-015-trash-archive.md) | Recently deleted & archive | FR-ISS-10 · FR-WF-08, 09 (pulled into M1) · FR-NAV-01 (archive entry) · INV-21 | Accepted |

## M2: Views & navigation
| Spec | Title | Implements | Status |
|---|---|---|---|
| [SPEC-020](SPEC-020-display-options-board.md) | Display options and board | FR-VIEW-02 (board), 03–07, 14 | Draft |
| [SPEC-021](SPEC-021-filters-views-favorites.md) | Filters, custom views and favorites | FR-VIEW-01, 08–11 · FR-NAV-01 (Views, Favorites) · FR-NAV-08 | Draft |
| [SPEC-022](SPEC-022-selection-bulk-undo.md) | Multi-select, bulk edit, undo/redo, context menu and peek | FR-NAV-05–07, 11 | Draft |
| [SPEC-023](SPEC-023-search-navigation.md) | Global search and navigation | FR-NAV-04 · FR-NAV-10 · FR-ISS-10 (archived in search), 13 · FR-MEM-04 · FR-AUTH-10 | Draft |

New ADRs these drafts name (numbers assigned by the coordinator on 2026-11-25; written at the M2 acceptance gate): ADR-0026 shared manual order (SPEC-020), ADR-0027 views pin the teams they show (SPEC-021), ADR-0028 bulk issue operations and ADR-0029 undo/redo as inverse operations (SPEC-022), ADR-0030 search across a partial replica (SPEC-023).

## Build order inside M1
`SPEC-010 (workflow)` → `SPEC-011 (issues, content models)` → `SPEC-013 (editor, comments)` and `SPEC-014 (files)` → `SPEC-012 (issue UI)` → `SPEC-015 (recently deleted, archive)`. SPEC-012 can start on SPEC-011 alone, with the editor and comment areas added as SPEC-013 lands.

## Build order inside M0
`SPEC-004 (repo + docker skeleton)` → `SPEC-003 (registry/executor)` → `SPEC-002 (sync v0)` → `SPEC-001 (auth, members, teams)` → `SPEC-005 (shell)`
SPEC-001 is written first because it defines the first real models the sync engine carries. It is built after the engine exists.
