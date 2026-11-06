# ADR-0008: Search

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
| Scope | Engine |
|---|---|
| Client: titles, identifiers, labels, projects, docs titles, people | **FlexSearch** in a Web Worker, built from the eager replica. Instant and works offline. |
| Client: full text (descriptions, comments, doc bodies) | Server query `issue.search` / `document.search`, with results merged into the command menu asynchronously |
| Server (API / MCP / full text) | **Postgres FTS** (`tsvector`, `websearch_to_tsquery`) + **`pg_trgm`** for fuzzy identifiers and titles. Visibility is filtered before ranking. |
| MCP operation discovery | **MiniSearch** in memory over the Operation Registry |

## Consequences
+ The common search (ID or title) is instant and works offline.
− Full-text results need the server (target < 300 ms on a LAN).
