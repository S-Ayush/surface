# Architecture Decision Records

| ADR | Title |
|---|---|
| [0001](0001-monorepo-typescript.md) | Monorepo & TypeScript |
| [0002](0002-sync-strategy.md) | Sync strategy (full metadata replica clause superseded by 0020) |
| [0003](0003-client-state-mobx.md) | Client state with MobX |
| [0004](0004-web-stack.md) | Web application stack |
| [0005](0005-api-surface.md) | API surface |
| [0006](0006-postgres-drizzle.md) | PostgreSQL + Drizzle |
| [0007](0007-auth.md) | Authentication |
| [0008](0008-search.md) | Search |
| [0009](0009-editor-tiptap.md) | Rich text editor |
| [0010](0010-jobs-pg-boss.md) | Background jobs (queue list superseded by 0024) |
| [0011](0011-operation-registry.md) | Operation Registry |
| [0012](0012-mcp-shape.md) | MCP shape |
| [0013](0013-deployment-docker.md) | Deployment & packaging |
| [0014](0014-file-storage.md) | File storage (superseded by 0021) |
| [0015](0015-client-model-immutability.md) | Client model immutability (supersedes the enforcement clause of 0003) |
| [0016](0016-sync-simulation-harness.md) | Where the sync simulation harness lives (`tests/sync-sim`) |
| [0017](0017-sync-react-package.md) | Where the sync inspector and UI hooks live (`@surface/sync-react`) |
| [0018](0018-offline-start.md) | Opening the app while the server can't be reached (remembered session) |
| [0019](0019-offline-app-cache.md) | Keeping the app's own files in the browser (offline app cache) |
| [0020](0020-partial-issue-sync.md) | Partial issue sync: your teams up front, other issues on demand (supersedes the full-metadata clause of 0002) |
| [0021](0021-issue-files.md) | Issue files: claiming, background previews and the byte protocol (supersedes 0014) |
| [0022](0022-purge-content-unlogged.md) | Purging an issue logs no `D` for its content rows (exception to architecture rule 2) |
| [0023](0023-document-migration-unlogged.md) | Document schema migrations rewrite synced rows without logging them (exception to architecture rule 2) |
| [0024](0024-job-queues.md) | Job queue names and the M1 queues (supersedes the queue list of 0010) |
| [0025](0025-opaque-draft-ids.md) | Opaque ids in draft operations (exception to registry rule 4) |
| [0026](0026-open-source-mit.md) | Surface is open source under MIT |

Format: context → options → decision → consequences. An accepted ADR is never edited in substance; a new ADR supersedes it.
