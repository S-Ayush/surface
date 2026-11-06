# ADR-0012: MCP shape

Status: **Accepted (draft)** · Date: 2026-11-06

## Options
1. One MCP tool per operation
2. Code mode: model-written JavaScript in a sandbox (Cloudflare search + execute)
3. **Two structured tools:** `search_operations` + `execute_operation` (JSON only)

## Decision
Option 3. See [`mcp-design.md`](../mcp-design.md). Search is MiniSearch over the registry. Execute validates the JSON input and runs it through the standard executor. There is no code execution and no sandbox. Transport is MCP Streamable HTTP at `/mcp`, with personal API keys.

## Consequences
+ A tiny, constant context footprint. The smallest security surface. Trivial to build on top of the registry.
− Multi-step tasks take several calls. Mitigated by the operation design rules (bulk operations, rich filters, aggregates, readable references). JMESPath `select` remains a non-breaking future option.
