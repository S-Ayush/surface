# ADR-0013: Deployment & packaging

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
- **One OCI image** (`surface`): the Node server, the built web assets, `pg_dump`/`pg_restore` clients, and the `surface` CLI (`migrate`, `restore`, `reset-password`, `create-admin`). Multi-arch (amd64, arm64). Runs as non-root.
- **`docker-compose.yml`:** `app` + `db` (postgres:17) with volumes `pgdata`, `uploads`, `backups`. Optional profile `proxy` adds Caddy with automatic HTTPS.
- The **reference platform** is a Linux VM with Docker Engine and the Compose plugin (VISION D8).
- Configuration is through environment variables only. `.env.example` is documented.
- Health checks: `/healthz` (process) and `/readyz` (DB reachable, migrations done).
- Logs: JSON to stdout. Metrics: optional `/metrics` (Prometheus), off by default.
- **Upgrades:** change the tag, then `docker compose up -d`. Migrations run automatically under an advisory lock.

## Consequences
+ Install in 15 minutes, on one machine, at zero cost.
− No high-availability story in v1. The process restarts automatically (`restart: unless-stopped`), and the backups are the recovery plan.
