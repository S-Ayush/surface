# Surface: End-to-End Build Methodology

> Surface is a fast, keyboard-first, local-first issue and project tracker, heavily inspired by Linear.
> This file describes **how** we take Surface from an idea to a shipped system: which documents we write, in what order, what each must contain, and the order we build features in.
> Reference research: [`00-research/linear-product-map.md`](00-research/linear-product-map.md)

---

## 0. Guiding principles

1. **Docs before code, but only just enough.** Every feature passes through *spec → plan → code*. Specs are short and concrete (the Linear Method: "write issues, not user stories").
2. **Speed is a feature.** Every interaction reads from the local store. Perf budgets are requirements, not nice-to-haves.
3. **Keyboard-first and opinionated defaults.** Every action is reachable from `Cmd+K` and from a shortcut. Configuration exists, but the defaults should be good enough that most teams never need to change them.
4. **One data model, many views.** Lists, boards, timelines, inboxes, and search are all projections of the same synced object graph.
5. **Vertical slices.** Each milestone ships an end-to-end usable slice (DB → sync → UI → tests), never a "backend only" layer.
6. **Dogfood early.** From Milestone 1 onward, Surface's own build is tracked inside Surface.

---

## 1. The artifact ladder

Each rung feeds the next. A rung is "done" only when its exit criteria are met.

```
 Research  →  Vision  →  PRD  →  Domain Model  →  Architecture + ADRs
                                                         │
     Release notes ← Code + Tests ← Tasks ← Impl. Plans ← Feature Specs ← Design System
```

| # | Artifact | Lives in | Answers | Exit criteria |
|---|---|---|---|---|
| 0 | **Research map** | `docs/00-research/` | What does a product in this class do? | Feature inventory + conceptual model written ✅ (done) |
| 1 | **Vision & principles** | `docs/01-vision/VISION.md` | Why Surface? For whom? What is our wedge vs Linear? Non-goals? | One page: problem, audience, 3–5 principles, explicit non-goals |
| 2 | **PRD (product requirements)** | `docs/02-product/PRD.md` | Which capabilities, in which release tier? | Every feature area from the map tagged **v1 / v2 / later / never**; personas; success metrics |
| 3 | **Glossary + Domain model** | `docs/03-domain/` | What are the nouns, their invariants, their lifecycles? | ERD, invariants list, state machines, ID scheme, permission model |
| 4 | **Architecture + ADRs** | `docs/04-architecture/` | How is it built? What did we choose and why? | System diagram, sync protocol spec, ADRs 0001–00NN accepted |
| 5 | **Design system & interaction model** | `docs/05-design/` | How does it look and feel? | Tokens, core components, shortcut registry, command-menu spec, layout shells |
| 6 | **Feature specs** | `docs/06-specs/SPEC-NNN-*.md` | Exactly what does feature X do? | Template filled; edge cases; acceptance criteria; reviewed |
| 7 | **Implementation plans** | `docs/07-plans/PLAN-NNN-*.md` | How do we build spec X, in what slices? | Slices, files/modules touched, migrations, test plan, risks |
| 8 | **Tasks / issues** | Surface itself (after M1) | Who does which concrete step? | Each task fits in ≤1 day and links to its plan |
| 9 | **Code + tests** | `apps/`, `packages/` | — | CI green, perf budgets met, acceptance criteria demoed |
| 10 | **Release notes / changelog** | `docs/CHANGELOG.md` | What shipped? | Written for every milestone |

### Repository layout for docs

```
docs/
  METHODOLOGY.md                ← this file
  00-research/linear-product-map.md
  01-vision/VISION.md
  02-product/PRD.md, personas.md, metrics.md
  03-domain/glossary.md, domain-model.md, state-machines.md, permissions.md, events.md
  04-architecture/architecture.md, sync-protocol.md, mcp-design.md, adr/0001…0014 + README.md
  05-design/design-system.md, shortcuts.md, command-menu.md
  06-specs/SPEC-001-workspace-auth.md …
  07-plans/PLAN-001-workspace-auth-members-teams.md …
  CHANGELOG.md
```

---

## 2. Phases, step by step

### Phase 1: Vision & scope (≈ 1–2 days)
1. Write `VISION.md`: the problem, the target user (e.g. small product engineering teams), why Surface and not Linear, and non-goals.
2. Copy the feature inventory (§4 below) into `PRD.md` and give every row a tier: **v1 / v2 / later / never**.
3. Define success metrics. For example: time to create an issue under 2s by keyboard, p95 local interaction under 50ms, cold start under 1.5s, and the team using Surface daily from M1.

### Phase 2: Domain modeling (≈ 2–3 days)
The most important thinking step. Get it wrong here and everything above it is wrong too.
1. **Glossary:** one definition per noun (Workspace, Team, Issue, Status, Status Category, Cycle, Project, Milestone, Initiative, View, Label, Comment, Notification, Subscription, Customer, Request, Agent…).
2. **Entity relationship diagram** with cardinalities. Examples: an issue has exactly one team; an issue has at most one project and at most one cycle; projects and teams are many-to-many with exactly one lead team.
3. **Invariants:** rules that must never break. For example, each status category has at least one status; issue IDs are unique per team and never reused; old IDs redirect after a team move.
4. **State machines:** issue status categories, triage actions, cycle lifecycle (upcoming → active → cooldown → completed, with rollover), project status, and archive / soft-delete / restore.
5. **Permission model:** roles × resources matrix, private teams, guests. This becomes the **sync-group** design in Phase 3.
6. **Events catalogue:** every domain event (`issue.created`, `issue.status_changed`…). The same catalogue drives history, notifications, webhooks, and automations.

### Phase 3: Architecture & ADRs (≈ 3–5 days)
Write one ADR per decision (format: context → options → decision → consequences). Expected ADRs:

| ADR | Decision | Recommended starting point |
|---|---|---|
| 0001 | Monorepo & language | TypeScript everywhere; pnpm workspaces + Turborepo |
| 0002 | **Sync strategy** (the core decision) | **Decided** ([ADR-0002](04-architecture/adr/0002-sync-strategy.md)): a custom engine with a full metadata replica plus lazy content, intent-level operations with optimistic rebase, a commit-ordered `lastSyncId`, WebSocket deltas, and sync groups. |
| 0003 | Client state | MobX-style observable models with a registry, lazy loading, and an object pool |
| 0004 | Web framework | React + Vite SPA; desktop shell later (Electron or Tauri) |
| 0005 | API surface | RPC-style operations generated from the Operation Registry (`/api/ops/:name`, plus a generated OpenAPI doc); sync endpoints for bootstrap and deltas. GraphQL is not planned (ADR-0005). |
| 0006 | Database & migrations | **PostgreSQL** (decided, VISION D4), bundled in compose, any `DATABASE_URL` accepted; typed query layer (Drizzle or Kysely) |
| 0007 | Auth | **Email + password and magic link** (decided, VISION D2). No SSO of any kind. |
| 0008 | Search | Local in-memory search for synced data plus a server full-text index (Postgres FTS first) |
| 0009 | Rich text editor | ProseMirror or TipTap, stored as Markdown/JSON |
| 0010 | Background jobs | **pg-boss** (runs on Postgres, so no extra container) for cycles, reminders, webhooks, and auto-archive |
| 0011 | **Operation Registry** | Every query and mutation is defined once (name, description, Zod schema, permission, handler). It powers the client, `Cmd+K`, the internal API, and MCP. |
| 0012 | MCP shape | Two structured tools, `search_operations` (MiniSearch over the registry) + `execute_operation` (validated JSON). No code execution and no sandbox. ([design](04-architecture/mcp-design.md)) |

Then write `sync-protocol.md`, the contract the whole app relies on:
- Model registry and schema hash. Load strategies: **eager** (all metadata) and **content** (lazy, per parent).
- Bootstrap: full (streamed NDJSON), then incremental deltas from the last `lastSyncId`.
- Transaction lifecycle: create → queue (persisted) → execute (batched) → wait for `lastSyncId` → confirm or roll back.
- Delta packet format (Insert / Update / Archive / Delete / Unarchive / SyncGroup change).
- Sync groups as the permission boundary.
- Offline replay; undo and redo as inverse transactions.
- Server-side side effects (history, notifications) emitted as additional deltas.

### Phase 4: Design system & interaction model (in parallel with Phase 3)
1. Tokens (color, type, spacing, radius, motion), light and dark themes.
2. Core components: list row, board card, property pills (status, priority, assignee, label, estimate), popover pickers, modal composer, sidebar, tabs, toasts, context menu.
3. **Shortcut registry:** one global table (key → command → context). Every command is also registered in the `Cmd+K` menu.
4. App shell: sidebar (Inbox, My Issues, Favorites, Teams → Triage / Issues / Cycles / Projects / Views), main pane, detail pane, peek.
5. Virtualized list and board that handle 10k+ items.

### Phase 5: Feature specs
For each feature area in the milestone, write `SPEC-NNN`. **Spec template:**

```markdown
# SPEC-NNN: <Feature>
Status: Draft | Review | Accepted   Milestone: M#   Owner:
## 1. Problem & goal         (2–4 sentences, user-facing)
## 2. Scope / non-scope
## 3. User flows             (keyboard path + mouse path)
## 4. Domain changes         (entities, fields, invariants, state machine deltas)
## 5. Sync & permissions     (which models, which sync groups, offline behaviour)
## 6. API                    (mutations, queries, webhook events)
## 7. UI                     (screens, components, shortcuts, empty/loading/error states)
## 8. Edge cases
## 9. Acceptance criteria    (testable, numbered: AC-1, AC-2 …)
## 10. Metrics / perf budget
## 11. Open questions
```

### Phase 6: Implementation plans
For each accepted spec, write `PLAN-NNN`. **Plan template:**

```markdown
# PLAN-NNN: <Feature>   (implements SPEC-NNN)
## Slices (each independently mergeable and demoable)
  1. Schema + migration + model registration
  2. Server mutation(s) + validation + side effects
  3. Client model + store + optimistic transaction
  4. UI component(s) + shortcut + command-menu entry
  5. Tests (unit / sync / e2e) + perf check
## Modules touched
## Migration & rollback
## Test plan  (map each AC-n → test)
## Risks & mitigations
```

### Phase 7: Build loop (repeated per slice)
`pick slice → branch → code + tests → self-review → PR (links PLAN + AC) → CI → review → merge → demo → update spec if reality differed`

### Phase 8: Verification & quality gates
| Gate | Check |
|---|---|
| Unit | Domain invariants, state machines, permission matrix |
| **Sync correctness** | Concurrent edits, rejected transactions rolled back, offline queue replay, `lastSyncId` gap recovery, sync-group add/remove |
| E2E (Playwright) | Each spec's acceptance criteria, driven by keyboard |
| Performance | p95 local interaction < 50ms; open issue < 100ms; bootstrap budget per 10k issues; list of 10k items scrolls at 60fps |
| Security | Authz tests per role; no data leaks across sync groups; webhook signing |
| Accessibility | Focus management, ARIA on pickers, contrast |

### Phase 9: Release & iterate
Write release notes per milestone in `CHANGELOG.md`, run a retro, then update the PRD tiers. Following the Linear Method: launch, and keep launching.

---

## 3. Build order: milestones

Ordered by dependency. Each milestone is a vertical slice that can be demoed.

```
M0 Foundations ─► M1 Core issues ─► M2 Views & nav ─► M3 Planning ─► M4 Collaboration
 (incl. Operation Registry)                                    └─► M5 Strategy & insights
                         M6 Platform: API + MCP ◄────────────────────┘
                         M7 Admin & ops              Later: integrations (GitHub, Slack, MS Teams)
```

| Milestone | Contents | Demo / exit |
|---|---|---|
| **M0 Foundations** | Monorepo, CI, Postgres, auth (email + password, magic link), **Docker packaging (image + compose + backups on a Linux VM)**, Workspace / User / Team / Membership, **sync engine v0** (full bootstrap + transactions + deltas + IndexedDB), **Operation Registry** (ADR-0011), app shell, `Cmd+K` skeleton, shortcut registry | Two browser tabs: rename a team in one and it updates in the other in under 100ms; works after an offline reload |
| **M1 Core issues** ⭐ | Issues (team key IDs), workflow statuses and categories, priority, assignee, labels, estimates, comments, reactions, activity history, issue composer, issue detail, list view, keyboard actions, drafts | **Start dogfooding:** Surface's backlog lives in Surface |
| **M2 Views & navigation** | Board layout, filters, display options (group, sub-group, order, properties), custom views, favorites, My Issues, global search, multi-select and bulk edit, undo/redo | Saved "Active" view per team; drag across board columns changes status |
| **M3 Planning** | Sub-issues and relations, cycles (schedule, rollover, auto-add, capacity, graph), projects (lead, members, teams, milestones, status, dates), project overview | Run a real 2-week cycle on Surface itself |
| **M4 Collaboration** | Subscriptions, inbox and notifications (snooze, reminders), @mentions, rich editor, documents, triage (accept / decline / duplicate / snooze, rules, rotation), templates, recurring issues | Issues from outside the team land in Triage; mentions reach the Inbox |
| **M5 Strategy & insights** | Initiatives and sub-initiatives, project and initiative updates with health and reminders, timeline view, insights and dashboards, Pulse | Weekly project update flow end to end |
| **M6 Platform: API + MCP** | Internal API generated from the Operation Registry (`/api/ops/:name`), personal API keys (read / read-write / team-scoped), outgoing webhooks (signed, retried), **MCP server with two tools: `search_operations` + `execute_operation`** ([design](04-architecture/mcp-design.md)), CSV import/export | Claude Code connected via MCP creates an issue and moves it into the current cycle; the change appears live in the web app |
| **M7 Admin & ops** | Roles (Admin / Member), **private teams** (sync-group boundary), archive / delete / restore, basic audit log, backup/restore, upgrade path. *No billing, SSO, guests, or sub-teams: see VISION §6* | A non-member never receives a private team's data; restore from backup on a fresh VM |
| *Later* | Integrations: GitHub, Slack, Microsoft Teams; importers (Jira, GitHub Issues); email intake | — |

---

## 4. Feature inventory → milestone map (seed for the PRD)

| Area | Features | M |
|---|---|---|
| Workspace & identity | Workspaces, users, teams, invites, login | M0 |
| Sync & client core | Bootstrap, transactions, deltas, offline, undo | M0–M2 |
| Issues | CRUD, IDs, statuses, priority, estimate, labels, assignee, due date, comments, reactions, history, drafts, move team | M1 |
| Hierarchy & relations | Sub-issues, blocks / related / duplicate, convert to project | M3 |
| Views | List, board, timeline, filters, display options, custom views, favorites, My Issues | M2 / M5 |
| Search & commands | `Cmd+K`, global search, shortcut registry | M0–M2 |
| Cycles | Schedule, cooldown, rollover, auto-add, capacity, graph | M3 |
| Projects | Lead, teams, milestones, statuses, dates, dependencies, templates, documents | M3 |
| Initiatives & updates | Initiatives, sub-initiatives, health, updates, reminders | M5 |
| Intake | Triage, rules, rotation (email intake, forms, customers & requests: later) | M4 / later |
| Collaboration | Inbox, notifications, subscriptions, mentions, documents, editor, templates, recurring | M4 |
| Insights | Cycle and project graphs, dashboards, insights | M3 / M5 |
| Integrations | GitHub (PR automations), Slack, Microsoft Teams | Later |
| Platform | Operation Registry, internal API, API keys, webhooks, MCP (`search_operations` + `execute_operation`), CSV import/export | M0 / M6 |
| Admin & ops | Admin/Member roles, private teams, basic audit, Docker packaging, backups, upgrades (no billing, SSO, guests, or sub-teams) | M0 / M7 |
| AI & agents | Built-in AI / agents | **Never** (external AI clients use MCP) |

---

## 5. Working rhythm

- **Cadence:** 2-week cycles (run inside Surface from M1). Each milestone takes roughly 1–3 cycles.
- **Definition of Ready (spec):** acceptance criteria are testable, domain changes are listed, sync groups are identified, open questions are resolved.
- **Definition of Done (slice):** acceptance criteria have passing tests (held criteria excepted: since 2026-11-06, tests that need a browser, a running stack or Postgres are on hold, see [plans README §6](07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), sync tests are green, perf budget is met (measured once perf tests resume), shortcut and `Cmd+K` entries exist, the docs are updated.
- **Change control:** if a decision changes, write a new ADR that supersedes the old one. Never silently edit an accepted ADR.

---

## 6. Immediate next steps

1. ~~`docs/01-vision/VISION.md`: decide Surface's wedge and non-goals.~~ Draft v0.3 done.
2. ~~`docs/02-product/PRD.md`: tier every row in §4.~~ Draft v0.1 done.
3. ~~`docs/03-domain/`: glossary, ERD, state machines, permission matrix.~~ Draft v0.1 done (plus the events catalogue).
4. ~~`docs/04-architecture/`: architecture, sync protocol, ADRs 0001–0014.~~ Draft v0.1 done.
5. ~~All M0 specs (SPEC-001 to SPEC-005) and the design system~~ Accepted 2026-11-06, with the proposed defaults recorded as decisions.
6. ~~M0 implementation plans~~ Written: [`07-plans/`](07-plans/README.md) (PLAN-001 to PLAN-005, 42 slices, about 63 ideal days). **Next: start building M0 with PLAN-004 S1 (monorepo skeleton).** Run Track B (PLAN-005 S1–S3, PLAN-002 S1) in parallel if there are two engineers.
