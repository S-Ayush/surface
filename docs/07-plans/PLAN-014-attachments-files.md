# PLAN-014: Attachments & files

Implements: [SPEC-014](../06-specs/SPEC-014-attachments-files.md) · Status: **Draft** (waits for M1 acceptance, [README §7](README.md)) · Order: **M1, parallel track** (S1–S3 start at once, S4a, S4b and S5 wait on the issue and editor plans) · Depends on: M0 (PLAN-001 S6 files, PLAN-003 executor, PLAN-004 jobs); S4a needs PLAN-011 S1, S3, S4b/S4c (child groups `team:<teamId>`, `visibleGroups`, the client's removal of an absent issue's children) and S6; S4b needs S4a and PLAN-013 S1; S5 needs PLAN-012 S4, PLAN-012 S1 and PLAN-013 S2. PLAN-015 S2 (purge) needs S3 of this plan.

> **Owns:** the file byte protocol, the `files` table changes, the file jobs and the `attachments` model. Branch per slice: `p014-sN-topic` (e.g. `p014-s3-byte-protocol`).
>
> **Testing hold:** unit and property tests, the sync property suite and private-team leak tests are written. E2E, perf, smoke and new non-leak integration tests are held ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)), except `files-bytes-pg.int.test.ts`, which the user allowed (SPEC-014 Q15, 2026-11-12). Held rows are marked ⏸ in §4.

---

## 1. Slices

### S1: Files schema changes, visibility predicate, leak matrix · M
- **What:** widen `files` for issue files, add `blob_release`, add one visibility function used by every read of a file (SPEC-014 §4.2, §4.10). No upload or download behaviour changes yet, except that reads go through the new predicate.
- **Where:**
  - `apps/server/src/db/schema/files.ts`: `FILE_PURPOSES` gains `attachment`, `inline`, `preview`; new columns `issue_id`, `detached_at`, `width`, `height`, `preview_of`; `size` becomes `bigint` (mode `number`); the purpose check; the four indexes (`storage_key`, `issue_id`, `preview_of`, partial `uploader_id`).
  - `apps/server/src/db/schema/files.ts` (or a new `blob-release.ts` next to it, exported from `schema/index.ts`): `blob_release(storage_key pk, released_at)`.
  - `apps/server/src/files/store.ts`: `readable()` becomes `visibleFile(client, fileId, {userId, groups, keyTeamIds})` with **only the branches that need no `issues` table**: the M0 avatar/logo predicate and the unclaimed-upload branch (the uploader reads their own unclaimed file). A claimed `attachment`/`inline`/`preview` row is not readable in S1 (no such rows exist yet). The issue branch of the §4.2 SQL (`EXISTS (SELECT 1 FROM issues …)`, source = `coalesce(preview_of, id)`) is added in S4a: Postgres refuses to plan a query naming a missing table, even in a branch never reached, so it can't ship before PLAN-011 S3. The SQL is built by one function so S4a adds a branch, not a second predicate. `NewFile` gains `issueId`, `width`, `height`, `previewOf`. `FileStore` stays an interface so route tests keep a fake.
  - `apps/server/src/files/routes.ts`: `GET`/`HEAD` call `visibleFile` before the `If-None-Match` check; pass the actor's visible groups (every group the actor may see, PLAN-011 S4b's `visibleGroups` once merged; never a socket's subscriptions) and API-key `teamIds` (session only in M1, Q9).
  - `apps/server/src/executor/refs/sources.ts`: `FileRef` resolves through `visibleFile`. `AttachmentRef` is added in S4a, when the model exists.
  - The `attachments` table is created in S4a's migration. S1 has no FK to `issues`: `files.issue_id` is a plain `uuid` column until PLAN-011 S3 lands the `issues` table, and the FK is added in S4a's migration (see §3). This keeps S1 mergeable on its own.
- **Migration:** next migration number. Files and `blob_release` only. It also adds the `users.avatar_file_id` and `workspace.logo_file_id` FKs to `files(id)` with `ON DELETE RESTRICT`, with no clean-up step: there are no existing users or rows (SPEC-014 D13). A dev database whose ids fail the keys is recreated.
- **Operations:** none.
- **Client / UI:** none.
- **Tests:**
  - `apps/server/test/files-visibility.test.ts` (unit, a fake `FileStore`): the SQL builder for the predicate, one case per matrix row: AC-5 (builder side), E16.
  - `apps/server/test/files-leak.int.test.ts` (leak suite, Postgres): the matrix cells that need no issue (avatar, logo, own and another user's unclaimed upload, API key) on `GET`, `HEAD`, matching `If-None-Match`, `?download=1`; 404 bodies equal to a missing file's apart from `correlationId`: AC-5, E5, E16. The cells that need an issue (private team, archived, deleted, preview of an invisible source) are added in S4a with real issues.
  - Updates `apps/server/test/files.test.ts` and `files-store.test.ts` for the new `NewFile` shape and `visibleFile`.

### S2: Upload route: streaming, sniffing, names, limits, headers · M
- **What:** `POST /files/upload?purpose=attachment|inline` and the download headers (SPEC-014 §4.6, §4.8, §6.1). Uploads of the new purposes write temp files and unclaimed rows; nothing claims them yet (S4a claims attachments, S4b inline files). Avatars and logos keep the buffered parser and 2 MB limit.
- **Where:**
  - `apps/server/src/files/routes.ts`: the new purposes get their own content-type parser that returns the raw stream (no `parseAs: 'buffer'`); the `Content-Length` refusal before reading; `413` once the limit is passed; empty body `400`; `X-File-Name`; `201 {id, url, mimeType, size, name, width?, height?}`. `UPLOADS_PER_MINUTE` is split: 30 for `attachment`/`inline`, 10 kept for avatars and logos (two token buckets).
  - `apps/server/src/files/blob-store.ts`: `BlobStore` gains `putStream(source) -> {tempPath, sha256, size}` (hashes while writing to `<uploads>/tmp/<uuid>.tmp`), `commit(tempPath, key)` (rename over the key, always) and `getStream(key)`. `put` and `get` stay for avatars.
  - `apps/server/src/files/sniff.ts` (new): `sniffType(head)` for PNG, JPEG, GIF, WebP, PDF, ZIP, GZIP, UTF-8 text (no NUL in the first 8 KB, cutting at a character boundary), else `application/octet-stream`. SVG, HTML, XML are `text/plain`. `sniffImage` in `image.ts` stays for avatars.
  - `apps/server/src/files/strip-location.ts` (new): a streaming `Transform` per format: JPEG (overwrite the GPS IFD in the EXIF segment, drop XMP segments), PNG (drop `eXIf` and XMP `iTXt` chunks), WebP (drop `EXIF` and `XMP ` chunks, fix the RIFF size). No decode.
  - `apps/server/src/files/names.ts` (new): `cleanFileName(header)` with the six steps of §4.8. The Content-Disposition builder (`attachment; filename="<fallback>"; filename*=UTF-8''…`) lives here too.
  - `apps/server/src/files/limits.ts` (new): the constants of §4.6 (1 GB free-space floor, 1 GB and 100 unclaimed per user, rates), and a `diskSpace(path)` probe injected into `FileRouteDeps` so tests can fake it. Free space is checked before reading and again before the rename: `507 INSUFFICIENT_STORAGE`.
  - Dimensions: `sharp(tempPath).metadata()` after the body is on disk, header only. If sharp can't load, dimensions are left empty and the server logs once per start (E10).
  - Server error table: add `INSUFFICIENT_STORAGE` → `507` (`ROUTE_ERROR_STATUS` and the OpenAPI document, SPEC-003 §9).
  - `GET`: streams from `getStream`; headers per §4.8 (`inline` only for the four image types and previews; `text/plain; charset=utf-8`; `?download=1`).
  - The upload row is inserted in S2 in a plain transaction (insert, then commit). S3 wraps it in the key lock; until then, S2 inserts and renames without the lock and the code says so with a `// S3` marker. S2 is only exposed on `attachment` and `inline` once S3 is merged if the order matters for release: both land before M1 ships, and nothing in the UI calls the route until S5.
- **Migration:** none.
- **Operations:** none.
- **Client / UI:** none (S5 uses the route).
- **Tests:**
  - `apps/server/test/files-upload.test.ts` (unit, route with a fake store and fake disk probe): size limit from `Content-Length`, no declared length, empty body, memory bound by a counting stream (never more than 64 KB held), avatars still buffered at 2 MB: AC-1, E3, E13. Floor `507`, per-user caps and rate `429`: AC-16, E9.
  - `apps/server/test/files-sniff.test.ts` (table): AC-2, E4.
  - `apps/server/test/files-names.test.ts` (table incl. U+202E, zero-width, path parts, 255 bytes with extension, undecodable): AC-4.
  - `apps/server/test/files-download.test.ts` (unit): headers, `sandbox` CSP, `nosniff`, RFC 6266 fallback, `?download=1`: AC-3.
  - `apps/server/test/files-strip-location.test.ts` (unit, fixtures with GPS EXIF and XMP; decoded pixels compared; JPEG orientation kept): AC-13, E20.

### S3: Byte protocol, `files-cleanup`, `files-sweep` · M
- **What:** the one protocol for every insert and delete of a `files` row (SPEC-014 §4.5), and the two jobs. Purge (PLAN-015 S2) calls the delete helper from here.
- **Where:**
  - `apps/server/src/db/locks.ts`: `LOCK_CLASSES.fileBytes` (new class, `pg_advisory_xact_lock(class, hashtext(storage_key))`).
  - `apps/server/src/files/bytes.ts` (new): the only module that inserts or deletes `files` rows. Functions: `insertUpload(tx, …)` (key lock, `commit` rename, insert), `insertCopy(tx, …)` (key lock, check bytes exist, else `INTERNAL` and the `file bytes missing` log, insert), `deleteFiles(tx, ids)` (lock each source row `FOR UPDATE`, delete its previews first, then the file, key locks in ascending order, insert keys into `blob_release`; never unlink in the transaction), `drainBlobRelease(pool, store)` (per key: lock, `NOT EXISTS` check, unlink, delete the `blob_release` row), `sweep(pool, store)` (keys on disk with no row, re-checked under the lock; `*.tmp` older than 1 hour). Lock order: after any issue row lock.
  - `apps/server/src/files/routes.ts`: the upload now uses `insertUpload`. If the transaction fails the temp file is removed; a renamed key is left for the sweep.
  - `apps/server/src/jobs/files.ts` (new) and `apps/server/src/jobs/index.ts`: `QUEUES.filesCleanup` (`files-cleanup`, hourly, `singletonKey`) and `QUEUES.filesSweep` (`files-sweep`, daily). Cleanup deletes: unclaimed `attachment`/`inline` rows older than 24 h; `attachment` rows with `detached_at` older than 24 h; `avatar`/`logo` rows no user or workspace names and older than 24 h. Uses `FOR UPDATE SKIP LOCKED`; a delete that fails the `RESTRICT` FK is skipped and retried next run. Then `drainBlobRelease`. Logs `files cleanup` with counts.
  - Replaced avatars and logos: nothing deletes them at replacement time. Cleanup finds them after 24 h (§4.6).
  - With `SURFACE_ROLE=worker` the worker uses the same uploads volume (docs note in `docs/ops/`, not code).
  - Metrics (when `/metrics` is on): bytes stored, `blob_release` backlog (`apps/server/src/http/metrics.ts`).
- **Migration:** none (S1 made `blob_release`).
- **Operations:** none.
- **Client / UI:** none.
- **Tests:**
  - `apps/server/test/files-bytes.prop.test.ts` (fast-check, a model of the key lock and a fake store): any interleaving of upload, copy, preview insert, detach, cleanup, purge, drain and sweep leaves no row naming missing bytes, and after a final drain and sweep no bytes without a row: AC-14 (model half), E18, E21.
  - `apps/server/test/files-bytes-pg.int.test.ts` (real Postgres advisory locks; **not held**: the user granted SPEC-014 Q15's exception on 2026-11-12): AC-14, Postgres half.
  - `apps/server/test/files-cleanup.test.ts` (unit, fake clock and store): the 24 h rules, two runs at once, previews deleted before their source, keys reach `blob_release`, an avatar delete that fails the FK is skipped: AC-15, E22, E21, E15.
  - `apps/server/test/jobs.int.test.ts` is extended only if it already covers queue registration (existing integration test, kept).

### S4a: Attachment model and operations · M (3 d)
- **What:** the `Attachment` synced model (eager), its operations, history, the issue branch of the file visibility predicate, and the purge step for attachments and issue files. This is the first slice that needs issues. It ships behind no flag: the operations exist, and no UI uses them until S5.
- **Needs:** PLAN-011 S1 (`systemOnly`, repo `updateWhere`/`deleteWhere`), PLAN-011 S3 (`issues` table, `lockIssueForWrite`, groups derived from the issue row, child `teamId`), PLAN-011 S6 (history kinds), S3 of this plan (`deleteFiles`).
- **Migration:** next migration number: `attachments` (`team_id`, `sync_groups`, GIN index, FKs to `issues`, `teams`, `users`, `size bigint`, `timestamptz(3)`), and the FK `files.issue_id → issues(id)` (no cascade). See §3.
- **Where:**
  - `apps/server/src/files/store.ts`: the issue branch of `visibleFile` (§4.2 SQL: claimed `attachment`/`inline` rows and previews through `coalesce(preview_of, id)`, the issue's `sync_groups`, API-key `teamIds`, lifecycle rules). Now possible because `issues` exists.
  - `packages/domain/src/model/attachment.ts` (new): the Attachment type, Zod schema, limits (`MAX_ATTACHMENTS_PER_ISSUE = 100`, title and URL rules), `defaultLinkTitle(url)` and `parseAttachmentUrl(url)` (http/https only, no credentials, 2,048 chars), shared by client and server (AC-17).
  - `packages/operations/src/ops/attachment.ts` (new): `attachment.createFile`, `attachment.createLink`, `attachment.update`, `attachment.delete` (`destructive`), `attachment.setPreview` (`systemOnly`). Summaries, descriptions, ≥ 2 keywords, examples, `permission`, `optimistic`, `ui` per SPEC-014 §6.2. `UI_CONTEXTS` in `packages/operations/src/ui.ts` gains `attachment` (shared with PLAN-013's `comment`; whichever merges first adds the list, the other appends). Registered in `ops/index.ts`.
  - `apps/server/src/handlers/attachment/` (new): `create-file.ts` (claims or clears `detached_at`, copies name, type, size, dimensions), `create-link.ts`, `update.ts`, `delete.ts` (deletes the row, sets `detached_at`), `set-preview.ts`. Each except `set-preview` takes `lockIssueForWrite(…, 'edit')` first and checks the 100 limit under the lock; `set-preview` uses mode `cascade`. History entries and outbox events `attachment.created`/`attachment.deleted` (SPEC-014 §6.3). The preview enqueue is S4b.
  - **Purge step** (`apps/server/src/issues/purge-steps.ts`, the registry PLAN-015 S2 creates; if S2 has not merged, this slice creates the file with the registry type): register `attachments` (eager, `repo.deleteWhere` with one `D` each) and the issue's `files` rows (`deleteFiles` from S3, keys to `blob_release`). The lifecycle rule table (PLAN-015 S1) gains the five attachment rows.
  - `apps/server/src/executor/refs/sources.ts`: `AttachmentRef` (uuid, resolved to an Attachment the actor can see; key `teamIds` narrowing); `FileRef` resolution stays from S1.
  - `apps/server/src/executor/key-scope.ts`: attachment ops are narrowed by `teamIds` like issue ops.
  - `apps/server/src/sync/models.ts`: register the `Attachment` model (eager, `teamColumn` = `team_id`, groups `team:<teamId>` only through PLAN-011 S3's `groupsOfIssueChild`, never the issue's `user:` groups, SPEC-014 §4.1). Bootstrap leaves out the attachments of archived and deleted issues (PLAN-011 S4b's rule covers eager children). `issue.get` output gains `attachments` (PLAN-011 `IssueOutput`, shape in §6.2).
  - Seed fixture: one uploaded file for `attachment.createFile`'s example (`FileRef` examples resolve against it).
  - `packages/sync-client`: the `Attachment` model in the store (generic; check `packages/sync-client/test` model registration tests). S4a calls PLAN-011 S4c's `registerIssueChild('Attachment', 'issueId')`, so the client drops an issue's Attachment rows once a batch leaves the Issue absent (archived, deleted, purged) or its team is unsubscribed (on the ack); `issue.restore` logs them again (PLAN-015 S1); optimistic functions from `packages/operations/src/ops/attachment.ts` using `lifecycleOf` (PLAN-015 S1 supplies the shared function; until then the guard uses the PLAN-011 `archivedAt` and `deletedAt` fields).
- **Operations:** `attachment.createFile`, `.createLink`, `.update`, `.delete`, `.setPreview` (system).
- **Client / optimistic:** per §6.2 "Optimistic": refuse an archived or deleted issue at once with the §6.4 message; `createFile` inserts from the upload answer; `createLink` uses `defaultLinkTitle`; `update` patches the title; `delete` removes the row.
- **UI:** none (S5). The command menu gets the `attachment` context entries in S5.
- **Tests:**
  - `packages/domain/src/model/attachment.test.ts` (unit): title and URL rules, default titles, credentials and scheme refusals: AC-7 (link half), E11, E12.
  - `apps/server/test/attachment-handlers.test.ts` (unit, fake store): create-file accepts only own unclaimed `attachment` upload or a same-issue detached file, claims, copies fields; 100 limit: AC-7, E1; permissions of update and delete, `destructive`: AC-9; lifecycle `CONFLICT` messages and `setPreview` not refused: AC-10.
  - `apps/server/test/attachment-history.test.ts` (unit): added and removed entries, the 3-minute fold: AC-11.
  - `apps/server/test/files-visibility.test.ts` (extend): the issue branch, one case per remaining matrix row (AC-5 builder side).
  - `apps/server/test/attachment-purge-step.test.ts` (unit, fake repo): attachments get one `D` each, the issue's files go through `deleteFiles` and reach `blob_release` (SPEC-015 AC-4 and AC-5 for attachments).
  - `packages/operations/src/ops/attachment.test.ts` (unit): `optimistic` equals the server row apart from server fields; `pnpm registry:lint` passes; `setPreview` absent from catalog, OpenAPI, MCP and menu, refused to non-system actors: AC-17, AC-18.
  - `sync-client/test/attachment-removal.test.ts` (unit): an `A`, a delete's `U`, a purge and an unsubscribe remove the issue's Attachment rows; a restore's `V` or `U` brings the issue back and the Attachment `U`s that `issue.restore` logs after it (PLAN-015 S1) bring the attachments back, with no refetch (SPEC-014 §4.1); the children go after the whole batch, so a `D`+`U` group-change pair keeps them.
  - `apps/server/test/attachment-leak.int.test.ts` (leak suite, Postgres): non-member gets no Attachment rows (bootstrap, catch-up, deltas); an assignee of a public team's issue who doesn't subscribe to the team gets none either, because Attachment rows are in `team:<teamId>` only; `NOT_FOUND` for every attachment operation like an unknown id, key `teamIds` narrowing: AC-6, E5, E17. Also extends the S1 matrix in `files-leak.int.test.ts` with the issue cells (private team, archived, deleted, preview of an invisible source).
  - The sync property suite gains `Attachment` (create, update, delete, preview update) in its generators: required, not held.

### S4b: Claiming inline files and previews · M (3 d)
- **What:** the real body of `claimInlineFiles`, the preview job, and pg-boss as a producer in every role.
- **Needs:** S4a, PLAN-013 S1 (document schema with `image` and `file` nodes, to find `src` references). The claim seam itself (one file, one signature, a stub that refuses any file reference) is **PLAN-011 S6's**; `issue.create`, `issue.updateDescription` (PLAN-011 S6) and the comment handlers (PLAN-013 S3) already call it, so this slice changes no caller.
- **Where:**
  - `apps/server/src/files/claim.ts` (seam from PLAN-011 S6): `claimInlineFiles(tx, doc, issue, actor)` per §4.3 replaces the stub body: collect distinct `/files/<uuid>` references (max 50), one conditional `UPDATE … RETURNING` per file, the copy branch (`SELECT … FOR SHARE` on the source, then `insertCopy` from S3, rewriting `src`), and one identical `INVALID_INPUT` for every unusable case.
  - `apps/server/src/handlers/attachment/create-file.ts`: enqueues the `files-preview` job for an image in the same transaction with pg-boss `send` on the transaction client, `singletonKey` = file id.
  - `apps/server/src/jobs/files-preview.ts` (new) and `jobs/index.ts`: queue `files-preview`. The job reads the original by path (`sharp(path)`), makes an 800 px WebP without metadata (first frame for GIF), inserts the `preview` row with `insertCopy`-style locking (`preview_of`, uploader = the source's uploader), then runs `attachment.setPreview` through the executor as `system`. It does nothing if the attachment or source is gone, or on re-run. Images over 25 MP, or ones that can't decode, get no preview and no error.
  - `apps/server/src/files/image.ts`: export one decode limiter per process (2 at once), shared by avatars and previews, instead of one per `imageProcessor()` call.
  - `apps/server/src/jobs/index.ts`: today the `web` role starts pg-boss only to queue email. It must also start in `web` when `attachment.createFile` has to enqueue a preview, so the producer side (`createQueue` and `send`) runs in every role, and only `work` runs in `all` and `worker` (see §5).
- **Migration:** none.
- **Tests:**
  - `apps/server/test/attachment-claim.test.ts` (unit, statement builder and fake store): claim, keep, copy with `src` rewrite, refuse; narrowed key; one identical message; 0-row result; `FOR SHARE` on the copy; FKs are `RESTRICT`: AC-8 (handler half), AC-21 (statement half), E7, E17, E19, E24. The seam's "refuses any reference" test from PLAN-011 S6 is replaced here.
  - `apps/server/test/attachment-preview.test.ts` (unit, real sharp as `files.test.ts`): 800 px WebP, no metadata, 25 MP skip, gone attachment, re-run, shared limiter: AC-12, E10, E14, E21.
  - `apps/server/test/attachment-handlers.test.ts` (extend): one preview job enqueued for an image, none for other types.
  - `apps/server/test/attachment-leak.int.test.ts` (extend): a document referencing an invisible file gets the same answer as an unknown id (AC-8 leak half).

### S5: Attachments UI · M
- **What:** the Attachments section, upload progress, drop and paste, the link form with its shortcut, the image viewer, Remove with Undo, and the command-menu entries. Layout belongs to SPEC-012; the editor's inline upload hook belongs to SPEC-013.
- **Needs:** PLAN-012 S4 (the issue page and its sections), PLAN-012 S1 (shortcut engine: platform-literal `Ctrl`, `isTypingTarget`), PLAN-013 S2 (the editor's `uploadFile` callback; this slice supplies the implementation).
- **Where:**
  - `apps/web/src/features/attachments/` (new): `AttachmentsSection.tsx` (rows: thumbnail or type icon, title, size or host, creator, time; row menu Open, Download, Copy link, Rename, Remove), `useUpload.ts` (`XMLHttpRequest` or `fetch` with progress, Cancel, Retry; progress rows are page state, not store state; offline check shows "Uploads need a connection. Try again when you're back online."), `DropZone.tsx`, `LinkForm.tsx` (URL and optional title, client-side `parseAttachmentUrl`), `ImageViewer.tsx` (overlay, Esc closes, ←/→ between the issue's image attachments, focus trap and restore), `UndoToast.tsx` usage (8 seconds; Undo re-dispatches `attachment.createFile` on the same file or `attachment.createLink`).
  - `apps/web/src/features/attachments/paste.ts` (new): a page-level paste handler for a lone URL when focus is not in a text field (uses the engine's `isTypingTarget`, `apps/web/src/shortcuts/engine.ts`); files pasted outside the editor upload.
  - `apps/web/src/features/attachments/editor-upload.ts` (new): the function handed to the SPEC-013 editor: uploads with `purpose=inline`, returns `/files/<id>`; refuses offline.
  - `apps/web/src/shortcuts/registry.ts` and `help.ts`: `Mod+Shift+U` "Attach file" (all platforms) and `Ctrl+L` "Link any URL to issue…" (literal Control, macOS only; no binding on Windows and Linux). If PLAN-012 S1 owns the key map, this slice adds the two entries to its table.
  - `apps/web/src/command-menu/context.ts`, `sources/operations.ts`: the `attachment` command target `{ kind: 'attachment', ids: [id], label: <title> }`, set when an attachment row has focus; entries from the operations' `ui` ("Attach file…", "Link any URL to issue…", "Rename attachment…", "Remove attachment"), with `refs` (`{ attachment }`) so `checkOperationCommands` passes. The `attachment` context chip text ("Attachment: design.pdf").
  - Docs updates in this slice (not code): the §12 rows for SPEC-005 §4.1, command-menu §3.3 and shortcuts §3.4 are done in the M1 acceptance PR; this slice only checks them.
  - A link is never fetched: no code path requests the URL; links open with `rel="noopener noreferrer"`.
- **Migration:** none.
- **Operations:** none new.
- **Client / optimistic:** uses S4a's `optimistic`. The progress row replaces itself with the optimistic row when `createFile` dispatches. A failed `createFile` (E1) rolls back and toasts the reason; the file stays unclaimed.
- **Tests:**
  - `apps/web/test/attachments-section.test.tsx` (jsdom): rows, progress with Cancel and Retry, offline refusal toast, Undo toast re-creating a file and a link, rollback on rejection: AC-19 (unit parts), E1, E8.
  - `apps/web/test/attachments-paste.test.tsx` (jsdom paste handler): a lone URL outside text fields opens the filled form; inside the title, a comment or any input it goes into that field: AC-22, E23.
  - `apps/web/test/attachments-shortcuts.test.ts` (engine with a platform flag): `Ctrl+L` on macOS only, `Mod+Shift+U` everywhere; a fake network that fails on any request proves a link is never fetched or unfurled: AC-23, D9, D10.
  - `apps/web/test/command-operations.test.ts` extended: the `attachment` target and entries pass `checkOperationCommands`: AC-22.
  - `apps/web/test/image-viewer.test.tsx` (jsdom): Esc, arrows, focus trap and restore: AC-19 (unit part).
  - E2E (pick, paste, drop, preview, open, download, rename, remove, undo, by keyboard) ⏸ held: checked by hand at the end of the slice and at the M1 demo (PLAN-012 S7).

---

## 2. Modules touched

| Area | Paths | Slices |
|---|---|---|
| Files schema | `apps/server/src/db/schema/files.ts`, `schema/index.ts`, new migration | S1, S4a |
| File store and visibility | `apps/server/src/files/store.ts`, `executor/refs/sources.ts` | S1, S4a |
| Upload and download routes | `apps/server/src/files/routes.ts`, `blob-store.ts`, new `sniff.ts`, `strip-location.ts`, `names.ts`, `limits.ts` | S2 |
| Byte protocol and jobs | new `files/bytes.ts`, `jobs/files.ts`, `jobs/files-preview.ts`; `jobs/index.ts`, `db/locks.ts`, `http/metrics.ts` | S3, S4b |
| Image decode limiter | `apps/server/src/files/image.ts` | S4b |
| Claiming | `files/claim.ts` (seam created by PLAN-011 S6, body here); called from PLAN-011 and PLAN-013 handlers | S4b |
| Attachment model and ops | `packages/domain/src/model/attachment.ts`, `packages/operations/src/ops/attachment.ts`, `ops/index.ts`, `ui.ts`, `apps/server/src/handlers/attachment/`, `sync/models.ts`, `executor/key-scope.ts`, `issues/purge-steps.ts` | S4a |
| Client store | `packages/sync-client` (model registration, optimistic) | S4a |
| Web UI | new `apps/web/src/features/attachments/`, `shortcuts/registry.ts`, `command-menu/` | S5 |
| Error table, OpenAPI | `INSUFFICIENT_STORAGE` / `507` in the route error table | S2 |

## 3. Migration & rollback

Two migrations, both with the next migration number at the time.

- **S1 (files, `blob_release`, avatar/logo FKs).** Forward-only after release. Before the first release it rolls back by reverting the code and the migration file together (the M1 migrations are not yet released): drop the FKs, the `blob_release` table and the added `files` columns, narrow the purpose check, and cast `size` back to `integer` (safe while no file is over 2 GB). The FKs are added with no clean-up step: there are no existing users or rows, so no id can fail them (SPEC-014 D13, user decision 2026-11-12). A dev database that fails them is recreated.
- **S4a (`attachments`, `files.issue_id` FK).** Additive. Rolls back before release by dropping the table and the FK. After release the tables are kept (forward-only). It is a separate migration from S1 because `files.issue_id` can't reference `issues` until PLAN-011 S3 exists.

No data is moved. M0 file rows keep working: their `issue_id` is null and their purpose is `avatar` or `logo`.

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack, perf measurement or non-leak Postgres are held** ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)). Held rows are marked; their unit parts are still written. Leak tests and the sync property suite are not held.

| AC | Test |
|---|---|
| AC-1 | `server/test/files-upload.test.ts` (S2): size limit from `Content-Length`, memory bound by a counting stream, avatars still buffered |
| AC-2 | `server/test/files-sniff.test.ts` (S2) |
| AC-3 | `server/test/files-download.test.ts` (S2) |
| AC-4 | `server/test/files-names.test.ts` (S2) |
| AC-5 | `server/test/files-visibility.test.ts` (S1, unit builder) + `server/test/files-leak.int.test.ts` (S1, extended in S4a; leak suite, not held) |
| AC-6 | `server/test/attachment-leak.int.test.ts` (S4a; leak suite, not held) + the Attachment model in the sync property suite (S4a) |
| AC-7 | `server/test/attachment-handlers.test.ts` + `domain/src/model/attachment.test.ts` (S4a) |
| AC-8 | `server/test/attachment-claim.test.ts` (S4b, handler) + `server/test/attachment-leak.int.test.ts` (S4b, the refusal equals an unknown id's; leak suite) |
| AC-9 | `server/test/attachment-handlers.test.ts` (S4a) |
| AC-10 | `server/test/attachment-handlers.test.ts` (S4a) |
| AC-11 | `server/test/attachment-history.test.ts` (S4a) |
| AC-12 | `server/test/attachment-preview.test.ts` (S4b, real sharp) |
| AC-13 | `server/test/files-strip-location.test.ts` (S2) |
| AC-14 | `server/test/files-bytes.prop.test.ts` (S3, model half) + `server/test/files-bytes-pg.int.test.ts` (S3, Postgres half; not held, Q15 exception granted 2026-11-12) |
| AC-15 | `server/test/files-cleanup.test.ts` (S3) |
| AC-16 | `server/test/files-upload.test.ts` (S2, fake disk probe and store) |
| AC-17 | `operations/src/ops/attachment.test.ts` (S4a) |
| AC-18 | `operations/src/ops/attachment.test.ts` (S4a) + `pnpm registry:lint` (run by `pnpm test`) |
| AC-19 | ⏸ held (e2e) `e2e/attachments.spec.ts` (checked by hand in S5). Unit parts: `web/test/attachments-section.test.tsx`, `web/test/image-viewer.test.tsx` |
| AC-20 | ⏸ held (perf), measured by hand in a 512 MB container at the end of S2 (D10 measurement repeated) |
| AC-21 | `server/test/attachment-claim.test.ts` (S4b, statement builder and fake store) + ⏸ held (migration test, integration): the FK actions checked by hand when S1 and S4a migrations run on a scratch database |
| AC-22 | `web/test/attachments-paste.test.tsx` + `web/test/command-operations.test.ts` (S5) |
| AC-23 | `web/test/attachments-shortcuts.test.ts` (S5; fake network, platform flag) |
| E1 | `server/test/attachment-handlers.test.ts` (S4a) + `web/test/attachments-section.test.tsx` (S5) |
| E2 | `server/test/files-bytes.prop.test.ts` (S3, one copy on disk, two rows) |
| E3 | `server/test/files-upload.test.ts` (S2) |
| E4 | `server/test/files-sniff.test.ts` and `files-download.test.ts` (S2) |
| E5, E16 | `server/test/files-leak.int.test.ts` (S1; leak suite) |
| E6 | Leak suite cells in `files-leak.int.test.ts` run again when move-team (M3) and team privacy (M7) land; the invariant has a unit test on the repo's group rewrite in PLAN-011 S3 |
| E7, E19 | `server/test/attachment-claim.test.ts` (S4b) |
| E8 | `server/test/files-leak.int.test.ts` (detached row) + `web/test/attachments-section.test.tsx` (undo) |
| E9 | `server/test/files-upload.test.ts` (S2) |
| E10 | `server/test/attachment-preview.test.ts` (S4b) |
| E11, E12 | `domain/src/model/attachment.test.ts` (S4a) |
| E13 | `server/test/files-upload.test.ts` (S2) |
| E14 | `server/test/attachment-preview.test.ts` (S4b) |
| E15 | `server/test/files-cleanup.test.ts` (S3) |
| E17 | `server/test/attachment-leak.int.test.ts` (S4a; leak suite) |
| E18, E21 | `server/test/files-bytes.prop.test.ts` (S3) |
| E20 | `server/test/files-strip-location.test.ts` (S2) |
| E22 | `server/test/files-cleanup.test.ts` (S3) |
| E23 | `web/test/attachments-paste.test.tsx` (S5) |
| E24 | `server/test/attachment-claim.test.ts` (S4b) |
| Leak checklist (permissions §5) | `files-leak.int.test.ts` and `attachment-leak.int.test.ts`: bootstrap, catch-up, delta, operation inputs (`AttachmentRef`, `FileRef`), file download, `HEAD`, `If-None-Match`, a document reference, error bodies equal to unknown ids |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Lost bytes.** Rows share one key, and a delete racing a copy could unlink bytes a row still names. This is silent data loss. | Every insert and delete takes the per-key lock (S3). Bytes are unlinked only by the drain, after a re-check under the lock. The fast-check model runs in S3, and so does the Postgres half of AC-14 (Q15 exception granted 2026-11-12), since a fake lock can't show this bug. |
| **A file leaks through the uploader exception or a stale cache.** | One visibility function for `GET`, `HEAD`, `If-None-Match` and `FileRef` (S1), tested cell by cell before any attachment exists. `Cache-Control: private, no-cache` with the check done before the 304. |
| **Previews cannot be queued from a `web` role.** Today pg-boss starts in `web` only when SMTP is set. `attachment.createFile` must enqueue in its own transaction. | S4b starts the producer side of pg-boss in every role (queues created, `send` available) and leaves `work` to `all` and `worker`. If `SURFACE_ROLE=web` runs with no worker, previews wait and images show the type icon: documented in the ops notes. |
| **Memory.** Streaming bugs would hold whole files; 30 simultaneous image decodes OOM-killed the server in M0. | The 64 KB counting-stream test (S2). One shared decode limiter per process (S4b). Perf check by hand, AC-20. |
| **Location stripping corrupts images.** Hand-written JPEG, PNG and WebP chunk rewriting is easy to get wrong. | Fixtures with GPS EXIF and XMP, decoded pixels compared before and after (S2). A file that fails to parse is stored as uploaded only if it is not an image of those types; for those types a parse failure refuses the upload with the "unreadable image" message rather than storing location data. |
| **Claim vs clean-up races** (E24). | One conditional `UPDATE … RETURNING` per file, `SKIP LOCKED` in clean-up, `FOR SHARE` on the copy source, covered by AC-21 statement tests and the model in S3. |
| **Cross-plan timing.** S4a and S4b need foundations from PLAN-011 and PLAN-013. | S1–S3 are independent and ship first. S4a is built after PLAN-011 S6. The `claimInlineFiles` seam and its callers exist from PLAN-011 S6 and PLAN-013 S3, so S4b changes only the body, whichever lands first. |
| **A slow single-disk host fills up.** | The 1 GB floor and per-user caps (S2), a `blob_release` backlog metric (S3). Configurable quotas wait for M7. |
