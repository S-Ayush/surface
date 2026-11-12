# ADR-0020: Partial issue sync (your teams up front, other issues on demand)

Status: **Accepted** (direction chosen by the user, 2026-11-12: "keep it like Linear"; accepted with SPEC-011 at the M1 acceptance gate, 2026-11-12) · Date: 2026-11-12 · Supersedes the "Full metadata replica" clause of [ADR-0002](0002-sync-strategy.md); the rest of ADR-0002 stands.

## Context
ADR-0002 replicates **all metadata** to every client: every issue row the user can see is loaded at bootstrap and kept live, and only heavy content is loaded per parent. VISION §6 backs it: "no partial *metadata* sync … ahead of a real need".

SPEC-011 measured the Issue row: about 610 bytes, so **≈ 61 MB raw at the 100k-issue reference scale**, against a 35 MB budget for all eager models. Most of those rows are issues a user never opens: other teams' work and closed issues that were archived long ago.

The user asked why every client should hold every issue, and chose to copy Linear: Linear loads teams, users and other small models at start, and loads issues partially, on demand (public reverse-engineering notes of its sync engine; Linear's own posts only announce the talks).

## Options
1. **Keep the full metadata replica** and raise the budget to ≈ 70 MB at 100k issues. Simplest; every list, filter and count stays local and offline.
2. **Keep every live issue, load archived and deleted issues on demand.** Smaller change; other teams' live issues still load for everyone. "Live" means not archived and not deleted: completed and canceled issues stay until they are archived. With the default 6-month auto-archive (SPEC-015), most issues of a large workspace are archived, so this option's live set may well fit the budget. We have no measurement either way.
3. **Your teams up front, other issues on demand** (Linear's approach). Up front: the live issues of the teams you are a member of, plus live issues assigned to you or created by you in any public team. On demand: another public team's issues when you open them, archived and deleted issues through server queries.

## Decision
**Option 3.** The user chose it on 2026-11-12 to match Linear, although option 2 may fit the budget (see its note above). Option 2 stays the **fallback** if option 3 proves too costly to build or run. The details are SPEC-011 §5.7. In short:

- **Issue rows are in the team's group for every team**, public or private (`team:<id>`). An issue of a **public** team is also in `user:<creatorId>` and `user:<assigneeId>`, so "My issues" is local for everyone. A private team's issue is in its team group only. Child rows (content, attachments) are in the team group only.
- **A connection's groups** are `workspace`, `user:<id>`, the groups of the private teams the user is a member of (as today), and the groups of the **public teams the client subscribes to**: the ones it is a member of, plus up to 5 others opened on demand (least recently opened dropped first). The server checks every subscription: a public team, or a private team the user is a member of. Anything else is ignored, exactly like an unknown team.
- **Subscribing** happens on the WebSocket (`subscribe`/`unsubscribe` messages; the server confirms an unsubscribe with `unsubscribed`, and the client removes the team's rows on that ack) and loads the team through the **partial bootstrap** `GET /sync/bootstrap?groups=team:<id>`, which sync-protocol §4.1 already reserves.
- **Archived and deleted issues are never stored in the replica.** Bootstrap leaves them out, and a packet that archives or deletes an issue removes it. Completed and canceled issues are live and stay until they are archived. The archive page, the recently deleted tab and an archived or deleted issue's page read them from the server (online only); they are read-only anyway.
- Everything else in ADR-0002 is unchanged: server-authoritative ordering, intent-level operations, full-row deltas filtered by sync groups, lazy content.

## Consequences
+ The replica holds what the user works on. At the reference scale a user in two or three teams holds a fraction of the 100k rows, so the 35 MB budget stays (now per replica, SPEC-011 §10).
+ Private-team isolation is unchanged: private issues are in the team group only, and only members can subscribe to it.
+ Matches Linear, as the user asked.
− **VISION §6 changes:** "no partial metadata sync" becomes "partial *issue* sync only; other metadata stays fully replicated". VISION is edited at the M1 acceptance gate, with the rest of SPEC-011 §12, not in the docs PR of this ADR.
− Lists of a team you're not a member of, the archive page and the recently deleted tab need the network the first time (offline: "Available when online").
− Counts that span issues the client doesn't hold (label usage, issues per status, "N archived issues") come from server queries, not the replica.
− Client title and ID search (ADR-0008) covers the issues the client holds; an exact identifier it doesn't hold falls back to `issue.get`, and other issues are found through the server, as full-text search already is. ADR-0008 itself is unchanged.
− An assignee change is a sync-group change (`D` then `U`, sync-protocol §6), so reassigning an issue to someone outside its team reaches them like a team join.
− About 10 more ideal days in M1 (PLAN-011 S4b, S4c).
