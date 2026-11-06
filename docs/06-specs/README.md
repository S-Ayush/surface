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

## M1: Core issues (planned)
SPEC-010 Workflow statuses, labels & estimates · SPEC-011 Issues core (create, properties, history, IDs) · SPEC-012 Issue page & list view · SPEC-013 Comments, reactions & rich editor · SPEC-014 Attachments & files · SPEC-015 Trash & archive

## Build order inside M0
`SPEC-004 (repo + docker skeleton)` → `SPEC-003 (registry/executor)` → `SPEC-002 (sync v0)` → `SPEC-001 (auth, members, teams)` → `SPEC-005 (shell)`
SPEC-001 is written first because it defines the first real models the sync engine carries. It is built after the engine exists.
