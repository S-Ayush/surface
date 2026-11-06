# ADR-0005: API surface

Status: **Accepted (draft)** · Date: 2026-11-06

## Context
The UI, scripts, and MCP all need to call the same operations.

## Options
1. **RPC from the Operation Registry**: `POST /api/ops/:name` with a JSON body
2. GraphQL
3. A hand-written REST API

## Decision
Option 1. Every operation is callable at `POST /api/ops/:name` with `Authorization: Bearer <api key>` (or a session cookie plus CSRF). A generated OpenAPI 3.1 document is published at `/api/openapi.json`. The sync endpoints (`/sync/*`) are separate and only for the first-party client. GraphQL is not planned.

## Consequences
+ Zero extra API code per feature: defining an operation publishes it.
+ The same names and schemas everywhere: UI, API, MCP, and docs.
− Less flexible for ad-hoc nested reads than GraphQL. Mitigated by `fields` selection and the list, get, count, and groupBy operations.
