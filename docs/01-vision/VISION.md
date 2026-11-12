# Surface: Vision

Status: **Draft v0.3**  ·  Date: 2026-11-06  ·  Next: PRD (`02-product/PRD.md`)

---

## 1. One-liner

**Surface is a self-hosted issue and project tracker for small teams. It is faster than any SaaS tool because it is built for one organisation, on infrastructure that organisation owns, with the workspace your work needs held on every client.**

## 2. The problem

Modern trackers (Linear, Jira, ClickUp, Asana) are built as **commercial multi-tenant SaaS**. That model costs small teams in three ways:

- **Speed.** Every tenant shares the same infrastructure. Data is partitioned, permission-checked, metered, and fetched on demand across the internet. Even Linear, the fastest of them, has to design its sync engine around very large workspaces and millions of tenants.
- **Bloat.** Roadmaps are driven by enterprise buyers: SSO tiers, seat billing, plan gating, admin consoles, upsells. A small team pays for that complexity in both money and UI.
- **Control.** Your planning data sits on someone else's servers, under their pricing, their retention rules, and their outages.

## 3. Who it's for

| | |
|---|---|
| **Primary user** | One organisation's product and engineering team. **Designed for small teams** (the sweet spot is roughly 10–50 people), with **no hard user cap**. One Surface install = one company. Every user is a full member; there are no guest accounts. |
| **Operator** | One person on that team who deploys Surface on a **Linux VM with Docker** and maintains it (target: setup under 15 minutes and roughly zero maintenance) |
| **Not optimised for** | Very large enterprises, agencies managing many client workspaces, public or commercial hosting |

Surface does not stop a team from growing. Our design choices simply assume a small team. If a workspace eventually outgrows them, we'll revisit them then rather than pay for that scale up front.

## 4. Why Surface is faster (the wedge)

Speed is the product, and our constraints are what make it possible:

1. **Your workspace's metadata on every client.** A small team produces about 10⁴–10⁵ issues over years. Every client holds **all non-issue metadata** (statuses, labels, cycles, projects, people…) and **the live issues of your teams**, plus the issues assigned to you or created by you, in IndexedDB and memory. Other teams' issues load on demand, and archived and deleted issues are read from the server ([ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md), like Linear). Every list, board, filter, and ID/title search over that replica is local, so there are **no network round-trips for those interactions**. Heavy content (descriptions, comments, history) is fetched once per issue, prefetched, and cached (ADR-0002).
2. **One tenant, one server, close to the users.** No multi-tenant routing, sharding, or noisy neighbours.
3. **Simple permissions.** Admin and Member roles, plus private teams. Fewer sync groups make sync cheaper and more predictable.
4. **No commercial overhead in the hot path.** No billing checks, plan gating, usage metering, or third-party analytics scripts.
5. **Small, opinionated scope.** We build only what a small team uses daily, and make each of those things instant.

## 5. Principles

1. **Instant or it's a bug.** Local interaction p95 < 50 ms. Opening any issue < 100 ms. Cold start < 1.5 s on a warm cache.
2. **An internal tool, forever.** Surface is never sold, metered, or multi-tenant. Every decision optimises for *the team using it*, not for a market.
3. **Docker-native, self-hosted, free to run.** One `docker compose up` on a Linux VM brings up the app *and* the database. Every required component is open source and costs nothing to host.
4. **Keyboard-first.** Every action is in `Cmd+K` and has a shortcut.
5. **One operation registry.** Every action in Surface is defined once, as a typed operation. The UI, `Cmd+K`, the internal API, and the MCP server all use that same definition.
6. **Linear's model, out of the box.** Teams, workflow statuses, cycles, projects, and initiatives come pre-configured with good defaults.
7. **Boring operations.** App container plus one database, automatic backups, and painless upgrades.

## 6. Non-goals (what Surface will *not* do)

- ❌ **No commercial version.** No billing, plans, seats, trials, licensing, or feature gating.
- ❌ **No multi-tenancy.** One install = one workspace. No workspace switcher.
- ❌ **No large-enterprise engineering.** We will not build sharding or horizontal scaling ahead of a real need, and partial sync is limited to *issues* ([ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md)): every other metadata model stays fully replicated. (Lazy loading of heavy *content* is part of the design.)
- ❌ **No SSO, SAML, OIDC, or SCIM.** Login is email and password plus magic link.
- ❌ **No guest accounts.** Everyone is a Member or an Admin.
- ❌ **No sub-teams.** Teams are flat. **Private teams** are supported.
- ❌ **No built-in AI or agents.** Surface ships no LLM features and makes no calls to AI providers. External AI tools can still connect through the MCP server (D9).
- ❌ **No third-party integrations for now.** GitHub, Slack, Microsoft Teams, and others are deferred to *later*.
- ❌ **No enterprise compliance suite.** No data residency or advanced audit/eDiscovery. (A basic audit log stays.)
- ❌ **No marketplace or public app platform.** No third-party OAuth app directory.
- ❌ **No mobile-native apps in v1.** A responsive web/PWA is enough.

## 7. What we keep from Linear

The conceptual model and the craft: **teams** (with their own key, workflow, cycles, labels, and triage, and optionally private), workflow statuses with categories, issues with team-key IDs (`ENG-123`), sub-issues and relations, cycles, projects and milestones, initiatives, triage, inbox, custom views (list / board / timeline), the command menu, a local-first sync engine, and the Linear Method way of working.

## 8. Decisions

| # | Topic | Decision | Notes |
|---|---|---|---|
| D1 | **User cap** | None. Designed for small teams with no hard limit. | A metadata replica (with partial issue loading, ADR-0020) is the design point (§4). |
| D2 | **Login** | **Email + password** and **magic link**, as in Linear. No SSO of any kind. | Magic link needs operator-configured SMTP (any free provider works). Without SMTP, Surface falls back to password-only login and admins share invite links. |
| D3 | **Teams** | **Linear-style flat teams.** Each team has its own key (`ENG`), workflow statuses, cycles, labels, templates, triage, and members. Issues belong to exactly one team. | |
| D4 | **Database** | **PostgreSQL**, bundled in `docker-compose.yml`. Any `DATABASE_URL` is accepted. | Free to self-host. It can also run on the free tier of a hosted Postgres service (e.g. Neon, Supabase). It provides transactions, `LISTEN/NOTIFY`, full-text search, and `pg_dump`. SQLite was considered and rejected for v1. |
| D5 | **Integrations** | **None for now.** GitHub, Slack, and Microsoft Teams are deferred to *later*. | Because of this, no public inbound URL is required. Surface can run on a private network. |
| D6 | **Guests** | **No.** | Roles are Admin and Member. |
| D7 | **AI / agents** | **Not in scope.** | No built-in LLM features. |
| D8 | **Deployment** | **Linux VM running Docker** is the reference and tested deployment. Surface is Docker-first. | Deliverables: official image, `docker-compose.yml` (app + Postgres + optional backup sidecar), `.env` config, health checks, volume layout, backup/restore and upgrade runbooks. |
| D9 | **Private teams / sub-teams** | **Private teams: yes. Sub-teams: no.** | A private team's issues, projects, and views sync only to its members. This is one sync-group boundary. |
| D10 | **MCP server** | **Two tools, structured (no code, no sandbox):** `search_operations` + `execute_operation`. | Design: [`04-architecture/mcp-design.md`](../04-architecture/mcp-design.md). The code-execution approach (Cloudflare Code Mode) was considered and rejected as too complex for about 100 operations. |

### 8.1 MCP in one paragraph (D10)

Surface exposes **one MCP endpoint with exactly two tools**:

- **`search_operations`** takes a plain-language query and returns the best-matching operations from the Operation Registry, each with a compact input schema and an example. Matching is server-side keyword and fuzzy search; there is no LLM involved.
- **`execute_operation`** takes `{ operation, input, fields? }`. The server validates the input, checks permissions, and runs the operation as the API-key owner, through the same path as the UI, so changes sync live to everyone.

The model sends **only JSON, never code**, so no sandbox is needed. Operations are designed to be task-sized: readable references like `ENG-123` and `me`, bulk updates, rich filters, and aggregates. That way two tools cover real work. This does **not** conflict with D7: Surface itself calls no AI. The MCP server only lets the team's own external AI clients (Claude Code, Cursor, and others) work with Surface.

## 9. Success metrics

| Metric | Target |
|---|---|
| Local interaction latency (p95) | < 50 ms |
| Change visible on teammates' screens | < 150 ms on the same network |
| Cold start on a warm cache | < 1.5 s |
| Time to create an issue by keyboard | < 2 s |
| Fresh Linux VM to first issue | < 15 min (`docker compose up` + create admin) |
| Hosting cost (all required components) | **$0** beyond the VM |
| MCP context footprint | Two tool descriptions only, ≤ 2k tokens, constant as operations grow |
| Adoption | The whole team uses Surface daily for its own work, starting at M1 |
| Ops burden | Under 1 hour per month of maintenance |

## 10. Implications for the build plan

These scope decisions update `METHODOLOGY.md`:

- **ADR-0002 (sync):** a *metadata* replica plus lazily loaded content. Sync groups = workspace + private team memberships. Its full-replica clause is superseded by **ADR-0020**: issues load partially (your teams up front, other issues on demand).
- **ADR-0006 (database):** PostgreSQL.
- **ADR-0007 (auth):** email + password (argon2id hashing) and magic link via SMTP. HTTP-only session cookie, rate limiting.
- **ADR-0011 (operation registry):** every mutation and query is a typed operation (name, description, Zod/JSON schema, permission). This is designed in **M0** because the UI, the API, and MCP all depend on it.
- **M0** gains Docker packaging and auth.
- **M6** = internal API + personal API keys + webhooks + **MCP server**.
- **M7** = Admin/Member roles, private teams, basic audit log, backups/upgrades.
- **M8 (Agents & AI) is removed.** Integrations move to a *Later* bucket.

## 11. Open questions

None blocking the PRD. The ADRs will settle the webhook scope.
