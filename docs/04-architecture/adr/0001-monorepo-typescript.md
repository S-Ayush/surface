# ADR-0001: Monorepo & TypeScript

Status: **Accepted (draft)** · Date: 2026-11-06

## Context
Client and server share a lot: entity types, operation schemas, filter evaluation, and optimistic logic. Drift between them would break sync.

## Options
1. **TypeScript everywhere in one monorepo** (pnpm workspaces + Turborepo)
2. Separate repos for client and server
3. A Go or Rust server with a TypeScript client

## Decision
Option 1. TypeScript in strict mode, Node.js LTS (24.x) on the server, pnpm workspaces, and Turborepo for task caching. Shared logic lives in `packages/domain` and `packages/operations`.

## Consequences
+ One language, and shared code across the network boundary (filters and optimistic logic run identically on both sides).
+ Atomic changes across client, server, and protocol.
− Node's single-threaded CPU limits. These are acceptable at small-team scale, and the job worker can run as a separate role if needed.
