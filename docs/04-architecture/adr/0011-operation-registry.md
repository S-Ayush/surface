# ADR-0011: Operation Registry

Status: **Accepted (draft)** · Date: 2026-11-06

## Context
The UI, `Cmd+K`, the API, MCP, and the client's optimistic updates must all perform the *same* actions with the same validation and permissions.

## Decision
A single registry in `packages/operations`. Each operation declares:
`name`, `kind` (query | mutation), `domain`, `summary`, `description`, `keywords`, `input` (Zod), `output` (Zod), `permission`, `destructive`, `examples`, and an optional `optimistic(store, input)` (client). The server handler is registered in `apps/server` under the same name.

Generated from the registry:
- the client's dispatch functions and `Cmd+K` command entries
- `POST /api/ops/:name` and the OpenAPI document
- the MCP catalog (`search_operations`) and `execute_operation`

A **registry lint** in CI fails if any operation lacks a summary, keywords, an example, or a permission, or if its examples fail schema validation.

## Consequences
+ One definition, every surface. The MCP and API can never drift from the product.
− Up-front design effort per operation, which the specs absorb.
