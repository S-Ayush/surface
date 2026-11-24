# SPEC-014: Attachments & files

Status: **Accepted** (2026-11-12, M1 acceptance gate) · Milestone: **M1** · Date: 2026-11-12 (revised after review and for Linear parity, 2026-11-12)
Implements: FR-ISS-06, FR-ISS-07 · FR-OPS-10 · NFR-14, 15, 16 · supersedes ADR-0014 entirely, through [ADR-0021](../04-architecture/adr/0021-issue-files.md) (§12)
Depends on: SPEC-011 (issues, history, the issue write lock and lifecycle rule), SPEC-013 (editor image and file nodes), SPEC-015 (the lifecycle rule table, purge), SPEC-001 D12 and PLAN-001 S6 (the `files` table, `BlobStore`, `POST /files/upload`, `GET /files/:id`), SPEC-004 §7 (`UPLOAD_MAX_MB`), E6 (disk), E10 (image memory)
Related: [domain-model §4.9](../03-domain/domain-model.md) · [permissions §2, §3.3, §3.5, §4, §5](../03-domain/permissions.md) · [events](../03-domain/events.md) · [ADR-0010](../04-architecture/adr/0010-jobs-pg-boss.md) · [ADR-0014](../04-architecture/adr/0014-file-storage.md)

---

## 1. Problem & goal

An issue often needs a screenshot, a log file or a link to a design. M0 can store an avatar or a logo, and nothing else. This spec lets people attach files and links to issues, and put images and files in descriptions and comments. Files stay on the server's own volume. They are readable only by people who can see the issue, so a private team's files never leak. A file is never run in the browser, and the server never fetches anything from the internet to make a link look nice.

## 2. Scope

**In scope**

- **File attachments** on an issue: upload by picking, pasting or dropping, up to `UPLOAD_MAX_MB` per file (default 25), any type. Images get a preview.
- **Link attachments** (FR-ISS-07): a URL with a title, typed by the person. The server never fetches the URL (architecture rule 5).
- **Inline files** in descriptions and comments: the SPEC-013 editor uploads an image (or another file) and puts a node that points at it into the document.
- The `Attachment` synced model (eager), and the server-only `files` table extended with `attachment`, `inline` and `preview` purposes, an owning issue and a detach time.
- Upload and download routes extended from M0, with streaming, type sniffing, location-metadata stripping and safe headers (NFR-15).
- Operations `attachment.createFile`, `attachment.createLink`, `attachment.update`, `attachment.delete`, and the system-only `attachment.setPreview`.
- **One byte protocol** for every writer and deleter of file rows (§4.5). SPEC-015's purge uses it.
- Clean-up of uploads that were never attached, of detached files, and of replaced avatars and logos, plus the foreign keys from `users.avatar_file_id` and `workspace.logo_file_id` to `files` (PLAN-001 S6 "Later").

**Out of scope**

- The purge job itself: the rule is here (§4.7), the job is SPEC-015's.
- Video or audio playback, PDF previews, `Range` requests (D19). These files download.
- An S3-compatible store (FR-OPS-11, v2), configurable quotas, and the storage-usage System page (FR-OPS-08, M7). M1 has fixed per-user caps (§4.6).
- Attachments on projects, documents or project updates (M3–M5). The `files.issue_id` owner becomes a general owner then (D22).
- Fetching link titles, favicons or previews from the URL. This is never done: no outbound calls.

## 3. User flows

The screens belong to SPEC-012 (issue page) and SPEC-013 (editor). The flows here say what happens underneath.

### 3.1 Attach a file

1. On the issue page, the person picks files with "Attach file" (`Mod+Shift+U`), pastes a file outside the editor, or drops files on the page. With focus in the description or a comment box, `Mod+Shift+U` inserts the chosen file inline instead (§3.3, SPEC-012 §3.6): one binding, and focus decides.
2. For each file the client calls `POST /files/upload?purpose=attachment` with the bytes. A progress row shows the file name and percentage. It lives only in the page and is not in the store.
3. The answer carries the file's id, sniffed type, size and, for images, width and height. The client then dispatches `attachment.createFile {id, issue, file, title?}`. The optimistic row replaces the progress row.
4. For an image, claiming the file queues a preview (§4.4). The row shows a thumbnail once the preview exists, and a type icon until then.

### 3.2 Attach a link

On the issue page, "Link any URL to issue…" opens a small form with a URL and an optional title. Its shortcut is `Ctrl+L`, the literal Control key, on macOS only (D9). On Windows and Linux it has no binding, because `Ctrl+L` is the browser's address bar there. It is reachable from the command menu, the issue's "…" menu and the Attachments section on every platform. Pasting a lone URL on the issue page opens the same form, already filled in, only when focus is **not** in a text field (the engine's `isTypingTarget` test, `apps/web/src/shortcuts/engine.ts:74`). A URL pasted into the title, a comment or any other input goes into that field as usual (E23). The client dispatches `attachment.createLink`. The title shown for a link is what the person typed: the server never fetches the page, and a link is never unfurled or embedded (D10). Links work offline, since they are only an operation.

### 3.3 Images and files in the editor

Pasting or dropping a file into the description or a comment uploads it with `purpose=inline`. The editor inserts an image node (raster images) or a file chip (anything else) whose `src` is `/files/<id>` (SPEC-013). When the description or comment is saved, the server checks every such reference and claims the file for the issue (§4.3). Inline files are not listed as attachments (D16).

### 3.4 Open or download

A click on an image attachment opens it in a viewer overlay. A click on any other file downloads it with its original name. Every byte goes through `GET /files/:id`, which checks visibility on every request.

### 3.5 Remove

The row menu has **Rename** (`attachment.update`) and **Remove** (`attachment.delete`). Remove runs at once, with an **Undo** toast for 8 seconds (design-system §4: a reversible delete needs no dialog). The Undo button, and nothing else, re-creates the attachment (the global `Mod+Z` restores only the last deleted issue, SPEC-012 §3.11, until M2's general undo): for a file, `attachment.createFile` on the same file, which is detached but kept for 24 hours (§4.2); for a link, `attachment.createLink` with the same URL and title. After 24 hours the clean-up job deletes a detached file (§4.5).

### 3.6 Offline

An upload can't be queued: bytes don't go through the mutation queue. While offline, "Attach file", paste and drop show "Uploads need a connection. Try again when you're back online." and do nothing, and the editor refuses to insert a file. A file whose upload finished before the connection dropped is attached through the queue as usual. `attachment.createLink`, `update` and `delete` queue like any operation.

### 3.7 Archived and deleted issues

The SPEC-015 lifecycle rule applies: archived issues are read-only, and so are deleted ones (D11). Creating, renaming or removing an attachment on an archived issue is `CONFLICT`, "ENG-42 is archived. Restore it to edit it." On a deleted issue (in "Recently deleted issues") it is `CONFLICT`, "ENG-42 was deleted. Restore it to edit it." Nothing unarchives an issue as a side effect. The system-only `attachment.setPreview` is not refused: it is a background job, not an edit. Files of an archived or deleted issue stay downloadable by those who can see the issue.

## 4. Domain changes

### 4.1 Attachment (eager, synced)

| Field | Type | Rules |
|---|---|---|
| id | uuid | Client UUIDv7 (`create*` exemption, SPEC-003 §11 rule 4) |
| issueId | Issue | Set at creation; never changes |
| teamId | Team | Denormalised: always the issue's `teamId`, so sync groups and API-key `teamIds` filters work as for issues. Move-team (M3) rewrites it in the same transaction. The model's `teamColumn`. |
| kind | `file` \| `link` | |
| title | string | 1–255 characters, trimmed. Files: defaults to the file name. Links: defaults to the URL without the scheme, cut to 255. |
| url | string? | `link` only. Absolute `http:` or `https:` URL, at most 2,048 characters, no credentials (`user:pass@`). Stored as typed after URL parsing. |
| fileId | uuid? | `file` only. The `files` row (server-only, §4.2). |
| fileName, mimeType | string? | `file` only. Copied from the file row, so the client never needs the file row (D15) |
| size | number? | `file` only. Bytes; `bigint` in Postgres, a JSON number on the wire (exact below 2⁵³). |
| imageWidth, imageHeight | int? | Raster images only, read at upload (§4.8) |
| previewFileId | uuid? | Set by `attachment.setPreview` (§4.4); null until then, and for non-images |
| creatorId | User | |
| createdAt, updatedAt | timestamptz | |

- **Sync groups** are `team:<teamId>` only (SPEC-011 §5.7): never the issue's `user:` groups, so an assignee who doesn't subscribe to the team holds the Issue row but not its attachments until they open it (opening subscribes the team). **Invariant:** any operation that changes an issue's team or the team's privacy (move-team in M3, a privacy change in M7) rewrites its Attachment rows' groups and `teamId` in the same transaction, through the repo. The leak suite covers it when those operations land.
- Attachments of an archived or deleted issue stay with it on the server. The client doesn't hold them (SPEC-011 §5.7): bootstrap leaves them out with their issue, and once a delta batch leaves an Issue absent (archived, deleted, purged), or its team is unsubscribed (on the ack), the client drops that issue's Attachment rows too, as it does content, after the whole batch (SPEC-011 §5.3, §5.7). An Attachment upsert for an issue the client doesn't hold (a preview set on an archived or deleted issue, §4.4) is dropped the same way once the attachment's team is loaded in that tab, so the client never keeps a row bootstrap would leave out; while the team's partial load is pending the row is kept, and the load's end drops it if its issue is still absent (D30, amended 2026-11-24). **A restore sends them again:** `issue.restore` logs each of the issue's Attachment rows again after the Issue's `V` or `U`, in the same transaction (one `U` each, empty patch, at most 100, SPEC-011 §5.7, SPEC-015 §5.1), so a subscribed client has them as soon as it has the issue. The read-only page of an archived or deleted issue shows its attachments from `issue.get` (SPEC-015 §3.4).
- At most 100 attachments per issue (D20), counted under the issue row lock.
- Rows are hard-deleted (`D` delta).

### 4.2 File (server-only, extended)

The M0 `files` table gains:

| Change | Detail |
|---|---|
| `purpose` | Adds `attachment`, `inline` and `preview` to `avatar`, `logo` |
| `issue_id uuid null` | The **owner**: the issue the file belongs to. Null while unclaimed. Set by `attachment.createFile` (purpose `attachment`) or when a saved document references the file (purpose `inline`, §4.3). Never changes once set (move-team keeps the issue, so it keeps the owner). Previews leave it null and take their visibility from their source (`preview_of`). |
| `detached_at timestamptz(3) null` | `attachment` purpose only. Set by `attachment.delete` in its transaction; cleared by `attachment.createFile` when the same issue re-attaches the file (undo, §3.5). A detached file is readable by nobody and deleted by the clean-up job 24 hours later. |
| `name` | The uploader's file name for `attachment` and `inline`, cleaned (§4.8). Avatars and logos keep their generated names (SPEC-001 D12). |
| `size` | Widened from `integer` to `bigint`, so files over 2 GB fit (`UPLOAD_MAX_MB` allows up to 10,240). |
| `width`, `height` | Raster images only |
| `preview_of uuid null` | For a preview, the file it shows. `ON DELETE RESTRICT`: a source can't be deleted while its preview row exists. Every deleter removes previews explicitly first, under the byte protocol (§4.5 step 4), so their keys reach `blob_release`. A cascade would delete preview rows without the key lock or a `blob_release` row. |
| Checks | `(purpose = 'preview') = (preview_of IS NOT NULL)`: a preview always names its source, and nothing else does. `detached_at IS NULL OR purpose = 'attachment'`: only an attachment can be detached. (Added in PLAN-014 S1, 2026-11-12.) |
| Index | `files(storage_key)` (byte protocol, §4.5), `files(issue_id)`, `files(preview_of)`, `files(uploader_id) WHERE issue_id IS NULL AND purpose IN ('attachment','inline')` (per-user caps, §4.6) |

A preview's `uploader_id` is its source's uploader (the column is `NOT NULL`, and the system actor has no user id). File rows are never synced (SPEC-001 D12 stands). Clients learn what they need from Attachment rows and from the `src` in documents.

**Visibility of a file.** One rule, used by `GET /files/:id`, `HEAD`, the `If-None-Match` path and the `FileRef` resolver alike. It replaces M0's "the uploader can always read it", which would let an uploader keep reading their file after leaving a private team. For a reader with groups `G` (after API-key `teamIds` narrowing, permissions §3.5; `G` is every group the actor may see, including every public team's `team:<id>`, not only the teams a socket subscribes to, SPEC-011 §5.7) and user id `me`, a file `f` is visible when:

```sql
-- s = the file whose owner decides: f itself, or f's source when f is a preview
-- (s.id = coalesce(f.preview_of, f.id))
   (s.purpose IN ('avatar','logo')                        -- M0 rule, unchanged
      AND <M0 avatar/logo predicate on s>)
OR (s.purpose IN ('attachment','inline')
      AND s.issue_id IS NULL AND s.uploader_id = me       -- unclaimed: its uploader only,
      AND f.preview_of IS NULL                            -- never through a preview,
      AND <key teamIds> IS NULL)                          -- nor a key limited to some teams
OR (s.purpose IN ('attachment','inline')
      AND s.issue_id IS NOT NULL
      AND s.detached_at IS NULL
      AND EXISTS (SELECT 1 FROM issues i
                  WHERE i.id = s.issue_id
                    AND i.sync_groups && G                -- archived and deleted included
                    AND (<key teamIds> IS NULL OR i.team_id = ANY(<key teamIds>))))
```

A preview of an unclaimed file is visible to nobody (previews are only made after claiming, §4.4). An unclaimed upload belongs to no team, so a key limited to some teams never reads one (the matrix's key column; the last two conditions of the unclaimed branch were added on 2026-11-12 in PLAN-014 S1, so the SQL says what the matrix and AC-5 already required). Everything not visible is `404 NOT_FOUND`, byte-identical to a missing file apart from `correlationId` (permissions §5). One exception, for one input field only (D28, PLAN-014 S4a, accepted 2026-11-24): `attachment.createFile`'s `file` (`FileRefIncludingDetached`) also resolves a detached `attachment` file whose issue the reader sees (the last branch with `detached_at IS NOT NULL`), so the removal can be undone (§3.5, §6.2). Every other `FileRef` answers such a file `NOT_FOUND`, exactly like an unknown id. Downloads, `HEAD` and `If-None-Match` never do: a detached file stays 404 for everyone, as the matrix says.

**Visibility matrix** (tested by the leak suite, AC-5; each cell on `GET`, `HEAD`, `GET` with a matching `If-None-Match`, and `?download=1`):

| File state | Uploader | Other member who sees the issue | Uploader after leaving the private team | Non-member of a private team | Key with `teamIds` excluding the team |
|---|---|---|---|---|---|
| `attachment`/`inline`, unclaimed | 200 | 404 | — | 404 | 404 |
| owned, attached | 200 | 200 | 404 | 404 | 404 |
| owned, detached | 404 | 404 | 404 | 404 | 404 |
| preview of an owned file | 200 | 200 | 404 | 404 | 404 |
| owned by an archived or deleted issue | 200 | 200 | 404 | 404 | 404 |
| avatar, logo | M0 rule | M0 rule | M0 rule | M0 rule | M0 rule |

### 4.3 Claiming inline files

The SPEC-013 schema has an `image(src, alt)` node and a `file(src, name)` node, each with `src` = `/files/<uuid>`. Absolute URLs, `data:` URIs and other paths are refused by the schema: images never come from another host (CSP `img-src 'self' data: blob:` in the app, rule 5; `blob:` is for local previews before upload). When `issue.create`, `issue.updateDescription`, `comment.create` or `comment.update` saves a document, the handler calls the one server function `claimInlineFiles(tx, doc, issue, actor)` (`apps/server/src/files/claim.ts`), which checks each distinct referenced file, in the same transaction, after taking the issue row lock:

| The referenced file is… | Then |
|---|---|
| unclaimed, uploaded by the actor, purpose `inline` | Claimed: `issue_id` = this issue (for a comment, the comment's issue). The claim is `UPDATE files SET issue_id = $issue WHERE id = $id AND issue_id IS NULL AND uploader_id = $actor AND purpose = 'inline' RETURNING id`; a row count of 0 (clean-up deleted it, or another save claimed it meanwhile) is treated as "not visible" below. |
| purpose `inline`, already owned by this issue | Kept as is |
| visible to the actor (§4.2 rule, after key narrowing) and any other case: an `inline` file of another issue, or an `attachment` or `preview` file of any issue | A new `inline` file row is made for this issue with the same `storage_key` (no new bytes, dedup), under the byte protocol (§4.5), and the `src` in the saved document is rewritten to the new id (D1). So removing an attachment never breaks an image in a document. |
| not visible to the actor (unknown, someone else's unclaimed upload, a detached file, an issue outside the actor's groups or key `teamIds`, an avatar or logo) | `INVALID_INPUT` on the document: "A file in this text can't be used here. Upload it again." Nothing is saved. The same answer for every case, so it never confirms that a file id exists. |

- **Claims race clean-up safely.** The check and the claim are one statement per file (above), and the copy branch locks its source row (`SELECT … FOR SHARE`) before inserting. A save takes all of these row locks, in id order, before any key lock (§4.5 step 3). Clean-up deletes with `FOR UPDATE SKIP LOCKED`. So either the claim commits first and clean-up no longer sees an unclaimed row, or clean-up deletes first and the claim matches 0 rows and refuses the document with `INVALID_INPUT`. A saved document never points at a deleted file (E24).
- At most 50 distinct file references per document.
- Removing an image from a document doesn't release its file: older versions and history may still show it. Deleting a comment doesn't release its inline files either, even when no other document references them. Inline files go when their issue is purged (§4.7).
- Claiming an inline file queues no preview: inline images have none (§4.4).

### 4.4 Previews

- `attachment.createFile` on a raster image (PNG, JPEG, GIF, WebP) enqueues a pg-boss job on queue `files-preview`, **in the claiming transaction** (pg-boss `send` on the transaction's client), keyed by the file id (`singletonKey`). Uploads never enqueue previews, so a preview never exists for an unclaimed file.
- The job makes a WebP preview at most 800 px on its longer side. Metadata is dropped. Animated GIFs use their first frame. It reads the original from its path (`sharp(path)`), never a whole-file buffer.
- It inserts the `preview` row (`preview_of` = source, `uploader_id` = the source's uploader) under the byte protocol, then sets `previewFileId` by running the **system-only operation `attachment.setPreview`** through the executor as `system` (architecture rule 1, ADR-0010). That writes a `U` delta and no history entry, and is not refused on an archived or deleted issue (§3.7).
- If the attachment or the source file is gone when the job runs, it does nothing. Re-running it after success does nothing.
- **Decode limits:** the same as avatars (SPEC-004 E10): 25 MP from the header, one libvips thread, no cache, and at most 2 decodes at once **per process, shared** with avatar uploads. `files/image.ts` exposes one limiter per process instead of one per `imageProcessor()` call. An image over 25 MP, or one that can't be decoded, gets no preview and shows its type icon. That is not an error.
- **Inline images get no preview.** The editor shows the original scaled down, and the viewer opens the original.
- The upload itself never decodes the image beyond its header, so uploading isn't limited by the decode queue (unlike avatars). Only previews wait.
- **pg-boss produces in every role.** Its producer side (queues created, `send` available) starts in every `SURFACE_ROLE`, `web` included, because `attachment.createFile` enqueues in its own transaction. Only `all` and `worker` run jobs. A `web` role with no worker leaves previews waiting, and images show their type icon until a worker runs.
- With `SURFACE_ROLE=worker` (architecture.md), the worker mounts the same uploads volume as the web process.

### 4.5 Byte protocol

Several `files` rows can share one `storage_key` (content addressing, ADR-0014). Every writer and deleter follows one protocol, so no row ever points at missing bytes and no bytes outlive their last row for long. SPEC-015's purge cites this section.

1. **Lock.** Every insert or delete of a `files` row takes `pg_advisory_xact_lock(LOCK_CLASSES.fileBytes, hashtext(storage_key))` in its transaction (a new class in `apps/server/src/db/locks.ts`). A transaction touching several keys locks them all in one statement, in `hashtext` order (so two keys whose hashes collide are one lock, taken once), after any issue row lock and after any `files` row lock: row locks first, then all of the transaction's key locks at once, so two transactions sharing keys never wait on each other in a cycle. The protocol relies on `READ COMMITTED`: the statement after a lock wait sees what the previous holder committed. All of it lives in `apps/server/src/files/bytes.ts`, the only module that inserts or deletes `files` rows or unlinks bytes. *(Row locks before key locks, and all keys at once in one statement in hash order, made explicit in PLAN-014 S3, 2026-11-13.)*
2. **Upload.** The body streams to a temporary file `<uploads>/tmp/<uuid>.tmp` while the SHA-256 is computed (location metadata is stripped on the way, §4.8). Then, in one transaction: take the key lock, rename the temporary file over the key (always, even if the key exists: the bytes are identical, and never short-circuiting removes a "these bytes already exist" timing hint), insert the row, commit. If the transaction fails, the temporary file is removed; bytes renamed before a failed commit are left for the sweep (step 5). Avatars and logos take the same path: their processed image is written to a temporary file and renamed under the lock, never written straight under its key, which a drain could unlink before the row commits. *(Avatars and logos added in PLAN-014 S3, 2026-11-13; M0 wrote them straight under the key.)*
3. **Other inserts** (the §4.3 copy, a preview): a saved document takes every row lock first, in id order: each claim's conditional `UPDATE` and each copy source `FOR SHARE` (§4.3). If any file can't be used it inserts nothing. Then it takes every copy's key lock at once (step 1), and per copy checks the bytes exist and inserts the row. Claiming or copying one file at a time would go row, key, row, key, and deadlock with a clean-up holding an unclaimed row that shares a key. A preview locks its source row `FOR SHARE` and, if the source is gone, inserts nothing, then is an upload (step 2) of its own bytes. Missing bytes there break this invariant: the handler fails with `INTERNAL` and logs `file bytes missing` (error, `fileId`, never the key or name).
4. **Deletes.** Any transaction that deletes `files` rows (clean-up, purge, a replaced avatar) first locks each source row `FOR UPDATE`, then deletes that file's previews, then the file, so the preview job (which needs the source row to insert a preview) can't add one in between. It takes each key's lock and inserts the key into **`blob_release(storage_key, released_at)`**, a server-only table, in the same transaction. Bytes are never unlinked inside the transaction. The `files-cleanup` job drains `blob_release`: per key, in its own transaction, it takes the key lock, deletes the `blob_release` row (if another drain deleted it first, it stops there), checks `NOT EXISTS (SELECT 1 FROM files WHERE storage_key = $1)`, and unlinks the bytes if so. A crash anywhere leaves either the row in `blob_release` (drained next run) or bytes that the sweep removes.
5. **Sweep** (`files-sweep`, daily): removes keys on disk with no `files` row (under the key lock, re-checked), and `*.tmp` files older than 1 hour.

### 4.6 Clean-up and limits

The pg-boss job `files-cleanup` runs hourly (`singletonKey`, so replicas don't run it twice):

1. It deletes `attachment` and `inline` file rows still unclaimed 24 hours after upload, `attachment` rows with `detached_at` more than 24 hours ago, and `avatar` and `logo` rows that no user or workspace names and that are more than 24 hours old. It deletes the previews of a file explicitly before the file (§4.5 step 4). Row deletes use `FOR UPDATE SKIP LOCKED`, so two runs at once are safe. An avatar or logo delete that fails the `RESTRICT` foreign key (a user or the workspace named it after the check) is skipped and retried next run; the foreign key, not the `NOT EXISTS` check, is what protects it.
2. It drains `blob_release` (§4.5 step 4).

**Limits** that protect the disk, which is shared with backups and, on a single-disk host, with Postgres (SPEC-004 E6). Constants in `apps/server/src/files/limits.ts`; if they ever become settings, architecture rule 7 applies.

| Limit | Value | Answer |
|---|---|---|
| Free space floor | An upload is refused when free space on the uploads volume minus the declared length (or the limit, without a declared length) would drop below 1 GB, checked before reading and again before the rename | `507 INSUFFICIENT_STORAGE`: "The server is almost out of disk space. Ask an Admin to free some." |
| Unclaimed bytes per user | 1 GB across `attachment` and `inline` uploads not yet claimed | `429 RATE_LIMITED`: "You have too many unsaved uploads. Attach or save them, or wait a day." |
| Unclaimed files per user | 100 | the same |
| Uploads per minute per user | 30 for `attachment` and `inline`; avatars and logos keep 10 (D18) | `429 RATE_LIMITED`, M0 message |
| Uploads at once per user | 3 `attachment` or `inline` uploads streaming at the same time, checked before reading (in memory, per process, like the rate) | `429 RATE_LIMITED`: "You have 3 uploads in progress. Wait for one to finish, then try again." |
| Idle upload | An `attachment` or `inline` upload that sends no data for 30 seconds is closed and its temporary file removed. The server sets no overall request timeout, since a large file on a slow link may take minutes. | The connection is destroyed (the server logs `408` with reason `idle`) |

The unclaimed caps are checked before reading (from the declared length) and again inside the insert's transaction, under a per-uploader transaction advisory lock (`LOCK_CLASSES.uploadCaps`) with the real size: parallel uploads all pass the first check, and the lock makes each count the rows of those before it. Every refusal of an upload whose body may be unread, including a server error, answers with `Connection: close`.

### 4.7 Purge (SPEC-015)

An Admin purges an issue with "Permanently delete…" on its page in "Recently deleted issues", after a confirm dialog (SPEC-015); the 30-day job does the same. Purging deletes its Attachment rows (`D` deltas) and **every** file row it owns: attachments (detached or not), inline files, and the previews of those, which it deletes explicitly first (no cascade). It follows §4.5 step 4: keys go to `blob_release`, and bytes are unlinked after commit only when no other row uses them. Bytes shared with another file row (the same content uploaded elsewhere, or a copy made in §4.3) stay.

### 4.8 Types, names, metadata and headers (NFR-15)

- **Type** comes from the bytes, never from the browser: the M0 sniffer extended with PDF, ZIP (and the Office formats inside it, reported as ZIP), GZIP, and text (valid UTF-8 with no NUL bytes in the first 8 KB → `text/plain`). Everything else is `application/octet-stream`. SVG, HTML and XML count as text and are served as `text/plain` (D17). Only PNG, JPEG, GIF and WebP are images.
- **Dimensions** come from `sharp(tempPath).metadata()` after the body is on disk (a JPEG's size can sit beyond its first 64 KB). It reads headers only, no decode.
- **Location metadata is stripped** from `attachment` and `inline` images while streaming, with no decode and no change to the primary image's pixels (D3, D27): JPEG keeps its EXIF segment (orientation) with every GPS IFD overwritten in place (pointed to from IFD0, IFD1 or the Exif sub-IFD), cleans the EXIF thumbnail in place (its own EXIF GPS cleared, its XMP and APP13 payloads zeroed, bytes after its end zeroed; a thumbnail it can't follow, or one nested more than two deep, is zeroed whole), drops XMP segments (standard and extended) and drops every Photoshop APP13 segment whole (its resources carry IPTC city and country, EXIF and XMP). Any APP1 starting `Exif` is treated as EXIF, as libvips reads it; PNG drops `eXIf` chunks and XMP text chunks (`XML:com.adobe.xmp` in `iTXt`, `zTXt` or `tEXt`: libvips writes it as `zTXt`), and ImageMagick's raw EXIF and XMP profiles (`Raw profile type exif`, `APP1`, `xmp`); WebP drops its `EXIF` and `XMP ` chunks, clears their VP8X flags and fixes the RIFF size; GIF drops its XMP application extension. Bytes after the image's end (JPEG EOI, PNG IEND, the RIFF size, GIF's trailer) are dropped: a second image appended there could carry its own location. That loses what some phones append there: MPF secondary images, Ultra HDR gain maps and Motion Photo video (D27). The parser's work is bounded by the bytes read (a step budget refuses a file made of thousands of 1-byte parts), and the disk gets one write per chunk read. The hash is of the stored (stripped) bytes. Other files are stored as uploaded. A file sniffed as PNG, JPEG, GIF or WebP whose structure the stripper can't parse is refused (`400 INVALID_INPUT`, the M0 "unreadable image" message), never stored with its metadata (E25). *(PNG text chunks other than `iTXt`, the raw profiles, GIF's XMP and the trailing bytes were added in PLAN-014 S2, 2026-11-12: the fixtures showed libvips stores XMP in `zTXt`, so `iTXt` alone left the location in place. APP13, the Exif sub-IFD, IFD1 and the thumbnail were added at its review, D27.)*
- **Names:** the uploader's file name, from the `X-File-Name` header (percent-encoded UTF-8). Cleaning:
  1. A name that fails to percent-decode or isn't valid UTF-8 becomes `file`.
  2. Normalise to NFC.
  3. Keep only the part after the last `/` or `\`.
  4. Drop control characters (Cc) and format characters (Cf: bidi overrides such as U+202E, zero-width characters), so "invoice‮fdp.exe" can't pose as a PDF.
  5. Trim spaces and dots at the ends (in linear time); cut to 255 bytes, keeping the extension.
  6. An empty result becomes `file`.
  
  Names never reach logs, which carry ids only, as in M0.
- **Download headers**, on top of M0's (`Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `ETag`, `Cache-Control: private, no-cache`):
  - the stored type as `Content-Type`; `text/plain` gets `; charset=utf-8`;
  - `Content-Disposition: inline` only for PNG, JPEG, GIF and WebP and previews, and only without `?download=1`;
  - `attachment; filename="<fallback>"; filename*=UTF-8''<percent-encoded name>` for everything else and on `?download=1`. The fallback replaces `"`, `\`, `/`, `;`, `%` and every non-ASCII character with `_`.
  - `Content-Length` from the stored file. `HEAD` answers the same headers without opening the bytes, and so does a matching `If-None-Match` (`304` with `ETag` and `Cache-Control` only). Every file header is set only once the bytes are found, so a row without its bytes answers exactly like a missing file (PLAN-014 S2).
- **Streaming:** the `attachment` and `inline` purposes get their own streaming body parser with the `UPLOAD_MAX_MB` limit; `avatar` and `logo` keep M0's buffering parser and their 2 MB limit. Nothing larger than 64 KB of a body is held in memory per request. Downloads stream from disk. This replaces M0's whole-buffer `get` for these purposes, so 25 MB files don't load into a 512 MB container's memory (SPEC-004 E10). The `BlobStore` interface gains `putStream` (to a temporary path), `commit(tempPath, key)` (the rename) and `getStream`.

### 4.9 Invariants

- An Attachment's file is owned by the attachment's issue, with purpose `attachment`. An attachment never points at another issue's file.
- An owned file's owner never changes.
- A file row's bytes exist while the row does (§4.5).
- An Attachment's `teamId` equals its issue's, and its sync groups are `team:<teamId>` (SPEC-011 §5.7).
- A file with `detached_at` set has no Attachment row naming it.
- INV-21: purge leaves no Attachment, file row or bytes behind that only the purged issue used.

### 4.10 Migration

Three migrations (one in the spec before PLAN-014 S1; the plan splits it, §3 of PLAN-014): S1's generated migration (`files` changes and `blob_release`), S1's hand-written one (the avatar and logo foreign keys, which the Drizzle schema can't declare without an import cycle), and S4a's (`attachments` and the `files.issue_id` foreign key, once `issues` exists). Together they make:

- `files`: the purpose check widened; `issue_id` (FK to `issues`, no cascade: purge deletes file rows explicitly), `detached_at`, `width`, `height`, `preview_of` (FK to `files`, `ON DELETE RESTRICT`, §4.1); `size` to `bigint`; the indexes of §4.2.
- `blob_release(storage_key text primary key, released_at timestamptz(3) not null default now())`.
- `attachments` with `team_id`, `sync_groups` and a GIN index, foreign keys to `issues`, `teams` and `users`, `size bigint`, and `timestamptz(3)`.
- Foreign keys from `users.avatar_file_id` and `workspace.logo_file_id` to `files(id)`, `ON DELETE RESTRICT`. `users` and `workspace` are synced tables, so a `SET NULL` cascade would change synced rows without a `sync_log` row (architecture rule 2). Clean-up skips a row whose delete fails the foreign key (§4.6). There are no deployed users or rows yet, so the migration adds these keys with no clean-up step; a dev database whose ids fail them is recreated (D13).

`domain-model §7` names the operation `attachment.uploadFile`; this spec renames it `attachment.createFile` (D2, §12).

## 5. Sync & permissions

| Model | Load | Sync group | Notes |
|---|---|---|---|
| Attachment | eager, with its issue's team (SPEC-011 §5.7) | `team:<teamId>` only, never the issue's `user:` groups | Metadata only (sync-protocol §2). `teamColumn` = `team_id`. Not held for archived, deleted or unheld issues (§4.1). |
| File | server-only | — | Read through `GET /files/:id`; named by Attachment rows and document `src` |

| Action | Who (on an issue the actor can see) |
|---|---|
| Upload (`purpose=attachment` or `inline`) | Any signed-in user. The file is theirs alone until claimed. |
| `attachment.createFile`, `attachment.createLink` | Anyone who can see the issue (permissions §3.3: edit any property) |
| `attachment.update` (title) | The attachment's creator, members of the issue's team, Admins |
| `attachment.delete` | The attachment's creator, members of the issue's team, Admins (permissions §3.3: "own or team member") |
| `attachment.setPreview` | The system actor only |
| Download | §4.2 visibility, checked on every request |

- API keys and MCP: `attachment.delete` is `destructive`. A key's `teamIds` narrow every check above, including `AttachmentRef`, `FileRef` and the §4.3 copy (permissions §3.5).
- Uploading needs a session in M1; API-key uploads come with M6 (D21).
- A private team's attachments, files and previews never reach non-members: bootstrap, deltas, downloads and refs all filter by sync groups. A non-member asking for one of its files gets the same `404` as for a missing file.

## 6. API

### 6.1 HTTP routes (outside the registry, extended from M0)

| Route | Change |
|---|---|
| `POST /files/upload?purpose=attachment\|inline` | New purposes, with their own streaming parser. At most `UPLOAD_MAX_MB` (refused from `Content-Length` before reading; `413` otherwise once the limit is passed). Name in `X-File-Name`. Same session, CSRF and setup guard as M0. Limits of §4.6 (rate, per-user unclaimed caps, free-space floor). `201 {id, url, mimeType, size, name, width?, height?}`. An empty body is `400`. `avatar` and `logo` behave as in M0, still at most 2 MB, buffered. |
| `GET /files/:id` | Visibility of §4.2 (before the `If-None-Match` check); headers and streaming of §4.8; `?download=1`. `HEAD` answers the same headers. |

`507 INSUFFICIENT_STORAGE` is a new error code: it is added to the server's route error table, SPEC-003 §9 and the OpenAPI document (§12).

### 6.2 Operations

| Operation | Kind | Input → output, notes |
|---|---|---|
| `attachment.createFile` | m | `{id?, issue: IssueRef, file: FileRef, title?, upload?}` → Attachment. `upload` (`{name, mimeType, size, width?, height?}`, the upload route's answer) is read only by the optimistic, to predict the row; the server ignores it and copies the `files` row (D29). The file must be either the actor's own unclaimed `attachment` upload, or a detached `attachment` file owned by the same issue (undo, §3.5). Anything else is `NOT_FOUND` on `file`. Claims the file (or clears `detached_at`) and queues its preview. `ui`: **Attach file…** (opens the file picker; the operation runs after the upload). |
| `attachment.createLink` | m | `{id?, issue, url, title?}` → Attachment. `ui`: **Link any URL to issue…**. |
| `attachment.update` | m | `{attachment: AttachmentRef, title}` → Attachment. `ui`: **Rename attachment…** (attachment context). |
| `attachment.delete` | m, destructive | `{attachment: AttachmentRef}` → `{attachment}`. Deletes the row and sets the file's `detached_at`. `ui`: **Remove attachment** (attachment context). |
| `attachment.setPreview` | m, system-only | `{attachment: AttachmentRef, previewFile: uuid}` → Attachment. Run only by the `files-preview` job. Carries SPEC-003's new `systemOnly` flag (§12, the same row as in SPEC-015). |

- `FileRef` is extended: it resolves through the §4.2 visibility rule (after key narrowing), so an invisible file is `NOT_FOUND`. `createFile` then applies its own narrower rule.
- `AttachmentRef` is new: a UUID only, resolved to an Attachment the actor can see (otherwise `NOT_FOUND`).
- There is no `attachment.list`: attachments come with `issue.get` (`attachments: [{id, kind, title, url, fileName, mimeType, size, downloadUrl, createdAt, creator}]`, in SPEC-011's `IssueOutput`).
- Every handler except `setPreview` first takes `lockIssueForWrite(…, 'edit')` and so applies the lifecycle rule (SPEC-011 §4.8, SPEC-015 §4.3, §4.4). `setPreview` is a system write and uses mode `cascade`.
- Each public operation has a summary, a description, ≥ 2 keywords, examples that run against the seed fixture, a `permission` and an `optimistic`, and passes `pnpm registry:lint`. The seed fixture gains one uploaded file for `attachment.createFile`'s example (`FileRef` examples resolve against it).

**Optimistic:** every mutation first checks the issue's lifecycle in the store with the shared `lifecycleOf` (SPEC-015 §4.1) and refuses at once, with the §6.4 message, if the store shows the issue archived or deleted. The store holds no archived or deleted issue (SPEC-011 §5.7), so this fires only for a change still in the overlay (for example a delete queued in this tab). When the issue is absent from the store, the optimistic predicts no Attachment row and the server decides; its `CONFLICT` rolls the dispatch back with the §6.4 message. `createFile` inserts the Attachment from the upload answer (name, type, size, dimensions; `teamId` from the issue in the store; `previewFileId` null). `createLink` inserts it with the default title computed by the same shared function the server uses (`packages/domain`). `update` patches the title. `delete` removes the row.

### 6.3 History and events

`attachment.createFile`, `attachment.createLink` and `attachment.delete` write a history entry on the issue (events.md: H ✓). Per SPEC-011 §4.4, its change is `attachments: { added: [{id, kind, title}] }` or `removed: […]`, with the title stored as the name snapshot. Renames and previews write none. They emit `attachment.created` and `attachment.deleted` to the outbox. Changes by the creator within 3 minutes of the issue's creation fold into `created`, like any other field.

### 6.4 Errors

| Case | Message |
|---|---|
| Too large | "Files must be 25 MB or smaller." (the configured limit) |
| Empty body | "Choose a file to upload." |
| 100 attachments | "An issue can have at most 100 attachments. Remove one first." |
| Bad scheme | "Use a web address that starts with https:// or http://." |
| Credentials in URL | "Web addresses can't include a user name or password." |
| `NOT_FOUND` on `file` | "That upload has expired or isn't yours. Upload the file again." Sent as SPEC-003's reference message with this hint: `File "<id>" not found. That upload has expired or isn't yours. Upload the file again.`, the same for an unknown id, an invisible file and one `createFile` refuses (PLAN-014 S4a) |
| Document references an unusable file | "A file in this text can't be used here. Upload it again." (SPEC-013 uses the same text) |
| Archived issue | "ENG-42 is archived. Restore it to edit it." |
| Deleted issue | "ENG-42 was deleted. Restore it to edit it." |
| Disk floor | "The server is almost out of disk space. Ask an Admin to free some." |
| Per-user unclaimed caps | "You have too many unsaved uploads. Attach or save them, or wait a day." |
| Too many uploads at once (§4.6) | "You have 3 uploads in progress. Wait for one to finish, then try again." |
| Missing or unknown `purpose` | "Say what the file is for: ?purpose=attachment, ?purpose=inline, ?purpose=avatar or ?purpose=logo." |
| Image the stripper can't parse (§4.8) | "That image could not be read. Try saving it again as a PNG or JPEG." (M0's `IMAGE_UNREADABLE_MESSAGE`, reused) |
| Offline (client-side, §3.6) | "Uploads need a connection. Try again when you're back online." |

## 7. UI

Defined in SPEC-012 (issue page) and SPEC-013 (editor). This spec only requires:

- an **Attachments** section under the description on the issue page: rows with a thumbnail or type icon, title, size or host, creator, time; a row menu with Open, Download, Copy link, Rename and Remove;
- an image viewer overlay (Esc closes, ←/→ moves between the issue's image attachments, focus trapped and restored);
- upload progress rows with Cancel, and an inline error with Retry on failure;
- a drop zone shown while files are dragged over the issue page;
- the Undo toast after Remove (§3.5);
- command-menu entries from the operations' `ui`: "Attach file…" (`Mod+Shift+U`), "Link any URL to issue…" (`Ctrl+L` on macOS; issue context), "Rename attachment…", "Remove attachment" (attachment context). The `attachment` context is new: `UI_CONTEXTS` is `global, team, issue, issues, project` today (`packages/operations/src/ui.ts:5`), and the command target kinds in SPEC-005 §4.1 are the same set. The target is `{ kind: 'attachment', ids: [id], label: <title> }`, set when an attachment row has focus. Each attachment-context entry gives `refs` (`{ attachment }`), as `checkOperationCommands` requires (`apps/web/src/command-menu/sources/operations.ts:126`). Changes in §12.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | The upload finishes but `attachment.createFile` is rejected (the issue was archived or deleted meanwhile, or the limit of 100 was reached) | The optimistic row rolls back with a toast giving the reason. The file stays unclaimed and is cleaned up after 24 h. |
| E2 | The same bytes are uploaded twice, or attached to two issues | One copy on disk (content addressing). Two file rows, each with its own owner and visibility. |
| E3 | A file is larger than `UPLOAD_MAX_MB` | `413` from `Content-Length` before the body is read. Without a declared length, the server stops reading at the limit. The client checks the size first and doesn't send it. |
| E4 | Someone pastes an HTML or SVG file | Stored and served as `text/plain`, as an attachment download. It never renders. |
| E5 | A non-member of a private team guesses or is sent a file URL | `404`, the same body as for an unknown id (leak checklist). |
| E6 | The issue is moved to a private team (M3), or a team becomes private (M7) | Downloads follow the issue's groups, read live on every request; Attachment rows' groups are rewritten in the same transaction (§4.1 invariant). Browser caches revalidate (`no-cache` with ETag, visibility checked before the 304). |
| E7 | A description is copied into an issue of another team the reader can't see | §4.3 gives the new issue its own file row. Readers of each issue see the image through their own issue. |
| E8 | An attachment is removed and someone opens its old link | `404`: the file is detached. Undo within 24 h clears `detached_at` and the link works again. After 24 h the file is deleted. |
| E9 | The disk fills during an upload | The free-space floor usually refuses it first (`507`). If the write still fails, the temporary file is removed, the answer is `507`, and no row is written. |
| E10 | sharp can't load on the server | Uploads still work (dimensions are left empty). Previews aren't made and the server logs an error once per start. Images show their type icon. |
| E11 | A link with `javascript:` or `data:`, or with credentials | `INVALID_INPUT` on `url`. |
| E12 | A link to a private or internal address (e.g. `http://10.0.0.5`) | Allowed: the server never fetches it. The browser opens it with `rel="noopener noreferrer"`. |
| E13 | Many large uploads at once | Each holds at most 64 KB in memory (streaming). The per-user rate limit, the unclaimed caps and the free-space floor apply. |
| E14 | An image's header declares more than 25 MP | Stored and downloadable, with no preview. |
| E15 | The uploader of an unclaimed inline image leaves the page without saving | The file is cleaned up after 24 h. |
| E16 | A user uploads a file, it is claimed by a private team's issue, and the user then leaves that team | `404` for them, like any non-member. Being the uploader gives no access after claiming. |
| E17 | A key with `teamIds=[A]` saves a description that references a file owned by a team B issue | The same `INVALID_INPUT` as for an unknown id. Nothing is copied. |
| E18 | A purge deletes the last row of a key while a copy of that key is being inserted | Both take the key lock, so they run one after the other. Bytes are unlinked only later, by the drain, after re-checking under the lock that no row uses the key. So whichever commits first, the copy's row either finds the bytes on disk or is never written, and the drain keeps bytes that any row still names. |
| E19 | An attachment's description image: someone removes the attachment while the description shows the same file | The description has its own `inline` copy (§4.3), so it keeps working. |
| E20 | A photo with GPS data is attached to a public team's issue | The stored original has no location (§4.8). |
| E21 | A preview job runs while clean-up or purge deletes the source file | The deleter locks the source row first, so the preview insert waits, then fails the foreign key and does nothing; or the preview committed first, and the deleter removes it explicitly before the source (§4.5 step 4). No preview row outlives its source, and its key reaches `blob_release`. |
| E22 | A user sets an avatar while clean-up deletes that file row as unreferenced | The delete fails the `RESTRICT` foreign key; clean-up skips it and retries next run, when the row is referenced and kept. No synced row is changed without `sync_log`. |
| E23 | A URL is pasted into the title field, a comment or another input on the issue page | It goes into that field; the "Link any URL to issue" form doesn't open (§3.2). |
| E24 | A description is saved, referencing an inline upload that clean-up deletes at the same moment | Either the claim commits first (clean-up no longer sees it as unclaimed) or the delete commits first and the claim matches 0 rows: `INVALID_INPUT`, "A file in this text can't be used here. Upload it again." The editor keeps the text (§4.3). |
| E25 | A PNG, JPEG, GIF or WebP upload whose chunks or segments the location stripper can't parse (truncated, malformed) | `400 INVALID_INPUT` with the unreadable-image message (§6.4); nothing is stored, so no location metadata can slip through (§4.8). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), except private-team leak tests, the sync property suite and the Postgres byte-protocol test (Q15, a user-granted exception).

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `POST /files/upload?purpose=attachment` stores any file up to `UPLOAD_MAX_MB` with its sniffed type and cleaned name, refuses larger ones from `Content-Length` before reading the body, and never holds more than 64 KB of a body in memory. Avatars keep the 2 MB buffered parser. | unit (route with a fake store; memory bound by a counting stream) |
| AC-2 | The type sniffer reports §4.8's types from the bytes. SVG, HTML and XML are `text/plain`; a renamed executable is `application/octet-stream`. | unit (table) |
| AC-3 | `GET /files/:id` sends §4.8's headers: inline only for the four image types and previews, `attachment` with the RFC 6266 fallback and `filename*` otherwise and with `?download=1`. It always sends `sandbox` CSP and `nosniff`. | unit |
| AC-4 | File names are cleaned as §4.8 says: path parts, Cc and Cf characters removed, NFC, 255 bytes with the extension kept, undecodable → `file`; the `Content-Disposition` fallback is ASCII-safe. | unit (table, including U+202E and zero-width cases) |
| AC-5 | Every cell of the §4.2 visibility matrix holds on `GET`, `HEAD`, a matching `If-None-Match`, and `?download=1`; each `404` is byte-identical to a missing file's apart from `correlationId`. | leak suite (Postgres, allowed by the hold) |
| AC-6 | Private-team leak: a non-member never receives a private team's Attachment rows (bootstrap, catch-up, deltas), and gets `NOT_FOUND` for every attachment operation naming them, exactly as for an unknown id. A key whose `teamIds` exclude the team gets the same. | leak suite |
| AC-7 | `attachment.createFile` accepts only the actor's own unclaimed `attachment` upload or a detached file of the same issue, claims it (or clears `detached_at`), copies name, type, size and dimensions onto the row, and enqueues one preview job for an image in the same transaction. `createLink` accepts only `http(s)` URLs without credentials. Both respect the 100-per-issue limit. | unit |
| AC-8 | Saving a document claims the actor's unclaimed inline files, copies any other visible file into a new `inline` row (rewriting `src`), and refuses any other reference, including through a narrowed key, with one identical answer and nothing saved. | unit (handler) + leak suite (the refusal for an invisible file equals an unknown id's) |
| AC-9 | `attachment.delete` and `update` are allowed for the creator, team members and Admins, and refused for others with a reason. `delete` is flagged `destructive`, refused to a key without `allowDestructive`, and sets `detached_at`. | unit |
| AC-10 | Attachment mutations follow the lifecycle rule: on an archived issue they are `CONFLICT`, "ENG-42 is archived. Restore it to edit it."; on a deleted issue, `CONFLICT`, "ENG-42 was deleted. Restore it to edit it." Nothing is unarchived. `setPreview` is not refused on either. | unit |
| AC-11 | History records added and removed attachments with their titles, folding creator changes within 3 minutes of creation (SPEC-011 §4.4). | unit |
| AC-12 | The preview job makes an 800 px WebP without metadata for images up to 25 MP, stores the row with `preview_of` and the source's uploader, sets `previewFileId` through `attachment.setPreview`, does nothing for a gone attachment or on a re-run, and skips larger or broken images without failing. Avatars and previews share one limiter of 2 decodes per process. | unit (with the real sharp, as `files.test.ts`) |
| AC-13 | Location metadata is stripped from JPEG, PNG and WebP uploads without changing pixel data; JPEG orientation survives. | unit (fixtures with GPS EXIF and XMP; decoded pixels compared) |
| AC-14 | The byte protocol holds: under any interleaving of upload, copy, preview insert, detach, clean-up, purge, drain and sweep, no `files` row ever names missing bytes, and after a final drain and sweep no bytes remain without a row. | property (fast-check) against a model of the lock and store **plus** a run against real Postgres advisory locks (`files-bytes-pg.int.test.ts`, allowed under the hold: Q15) |
| AC-15 | The clean-up job removes unclaimed files and detached files after 24 h, unreferenced avatars and logos after 24 h, and drains `blob_release`. Two runs at once don't fail or double-delete. Previews are deleted explicitly before their source, with their keys in `blob_release`; an avatar or logo delete that fails the foreign key is skipped (E21, E22). | unit (fake clock and store) |
| AC-16 | Uploads are refused with `507` below the free-space floor, and with `429` beyond the per-user unclaimed caps or rate. | unit (fake disk-space probe, fake store) |
| AC-17 | Each mutation's `optimistic` produces the Attachment the server commits, apart from server fields (`createdAt`, `updatedAt`, `previewFileId`), and refuses an issue the store shows archived or deleted like the server does; with the issue absent from the store it predicts nothing and the server's answer decides. | unit |
| AC-18 | Every operation passes `pnpm registry:lint`, with examples run against the seed fixture; `setPreview` is absent from the catalog, OpenAPI, MCP and the command menu, and refused to any non-system actor. | unit |
| AC-19 | Attach by picking, pasting and dropping; see the preview; open, download, rename, remove and undo; by keyboard as well. Offline, attaching a file shows the "needs a connection" toast and adding a link queues. | e2e ⏸ (checked by hand) |
| AC-20 | A 25 MB upload and download in a 512 MB container keeps the process under its E10 budget (D10 measurement repeated). | perf ⏸ (by hand) |
| AC-21 | Claiming is one conditional `UPDATE … RETURNING` per file; a 0-row result refuses the document with the unusable-file message, and the copy branch locks its source `FOR SHARE` (E24). The migration's foreign keys are `RESTRICT` (no `SET NULL`, no `CASCADE`) on `preview_of`, `users.avatar_file_id` and `workspace.logo_file_id`. | unit (statement builder, fake store) + migration test ⏸ |
| AC-22 | A lone URL pasted with focus outside text fields opens the "Link any URL to issue" form filled in; pasted into any text field, it goes into that field (E23). The attachment command context passes `checkOperationCommands`. | unit (jsdom paste handler, command tests) |
| AC-23 | `Ctrl+L` (literal Control) opens the link form on macOS and is unbound on Windows and Linux; `Mod+Shift+U` opens the file picker on every platform. A link is never fetched, unfurled or embedded: no code path in the server or client requests the URL. | unit (shortcut engine with a platform flag; fake network that fails on any request) |

## 10. Metrics & performance

- Uploads: limited by the network and disk, not CPU. Under 64 KB of memory per upload in flight.
- `GET /files/:id` checks visibility with one indexed query (p95 < 10 ms before the bytes stream).
- Previews: at most 2 decodes at once per process (E10), and a preview within 5 s of attaching on an idle server.
- Log events: `file uploaded` (info, `fileId`, `purpose`, `size`; never the name), `file preview failed` (warn, `fileId`, reason), `file bytes missing` (error, `fileId`), `upload refused` (info, `reason`: floor, caps, rate), `files cleanup` and `files sweep` (info, counts), `files cleanup failed` and `files sweep failed` (error, a run that threw; pg-boss runs it again on schedule), and `file bytes could not be removed` (warn, the file system error's code only, never the key or path).
- Metrics (when `/metrics` is on): bytes stored (`surface_files_stored_bytes`, each key once), uploads and downloads by purpose, preview queue length, `blob_release` backlog (`surface_files_blob_release_backlog`). The two named ones were built in PLAN-014 S3 (read from the database on each scrape); the others are not built yet.
- `files cleanup` logs `unclaimed`, `detached`, `unused` (avatars and logos), `previews`, `skipped` (a foreign key refused the delete, E22), `unlinked` and `kept` (drained keys whose bytes went or stayed) and `failed` (keys whose bytes couldn't be removed: left in `blob_release` for the next run); `files sweep` logs `orphans`, `temps` and `failed`. One file that can't be removed never stops the others. *(Counts named in PLAN-014 S3, 2026-11-13.)*

## 11. Open questions and decisions

No open questions. The proposed defaults were accepted at the M1 gate on 2026-11-12 and moved to the Decisions table (D15–D24).

**Decisions**

| # | Decision | Date |
|---|---|---|
| D1 (was Q3) | Copying text with files to another issue gives the target issue its own `inline` row for the same bytes and rewrites the `src`. The same applies to a document that references an attachment's or a preview's file, so removing an attachment never breaks a document. | 2026-11-12 |
| D2 (was Q8) | `attachment.uploadFile` (domain-model §7) is renamed `attachment.createFile`: the bytes go through the upload route, the operation only attaches an uploaded file, and `create*` matches registry rule 4's client-id exemption. | 2026-11-12 |
| D3 (was Q12) | Location metadata is stripped from uploaded images by default (§4.8). An inline phone photo in a public team would otherwise show where it was taken to the whole workspace; the M0 avatar review refused the same. | 2026-11-12 |
| D4 (was Q13) | Unclaimed uploads and detached files live 24 hours: long enough for a slow save and for the Undo toast. | 2026-11-12 |
| D5 | A removed attachment's file is detached (`detached_at`), not left owned: readable by nobody, re-attachable by undo, deleted after 24 h. | 2026-11-12 |
| D6 | The uploader has no special access once a file is claimed; one visibility rule serves downloads and `FileRef`. | 2026-11-12 |
| D7 | Previews are made only for claimed attachment images, queued in the claiming transaction, and set through a system-only operation. Inline images have no previews. | 2026-11-12 |
| D8 | Removing an attachment runs at once with an Undo toast, no dialog (design-system §4). Issue delete now has a dialog (SPEC-012), but an attachment stays reversible for 24 hours. | 2026-11-12 |
| D9 | Copy Linear: "Link any URL to issue…" is `Ctrl+L`, the literal Control key, on macOS; "Attach" is `Mod+Shift+U`. On Windows and Linux there is no `Ctrl+L` binding, since the browser owns it. Replaces Q11 (no shortcut for Add link) and drops the IBus question. | 2026-11-12 |
| D10 | Linear embeds YouTube, Loom and Figma links, loads external images and unfurls links; not copied, because architecture rule 5 forbids outbound calls. A link shows the title the person typed (or the URL), and images only come from `/files/<id>`. | 2026-11-12 |
| D11 | Copy Linear: archived issues are read-only. Attachment changes on an archived or deleted issue are `CONFLICT`; nothing unarchives as a side effect, and Restore is the only way back (SPEC-015). Replaces "any edit unarchives" and the optimistic unarchive prediction. | 2026-11-12 |
| D12 | Copy Linear: "Trash" is called "Recently deleted issues", and purging is "Permanently delete…" with a confirm dialog (SPEC-015). | 2026-11-12 |
| Q15 | The Postgres half of the byte-protocol test (`files-bytes-pg.int.test.ts`, AC-14) is allowed under the testing hold, as an exception the user granted at the M1 gate: a lost-bytes bug is silent data loss that a fake lock can't show. | 2026-11-12 |
| D13 | There are no existing users or rows, so the migration adds the `users.avatar_file_id` and `workspace.logo_file_id` foreign keys with no clean-up step (§4.10). The earlier step that nulled ids naming no file "through the repo" is dropped: a migration can't call the repo. Dev databases that fail the keys are recreated. User decision. | 2026-11-12 |
| D14 | Partial issue loading (SPEC-011 §5.7, ADR-0020): Attachment rows are in `team:<teamId>` only, and the client holds none for an archived, deleted or unheld issue (§4.1, §5). File visibility checks every group the actor may see, not a socket's subscriptions (§4.2). | 2026-11-12 |
| D15 (was Q1) | File rows stay server-only behind Attachment (SPEC-001 D12 stands). Attachment carries the file's name, type, size and dimensions, so clients need nothing else, and no new synced model has to pass the leak checklist. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D16 (was Q2) | Copy Linear: an image pasted into the description is not an Attachment row. It is an `inline` file owned by the issue and referenced only from the document. Attachments are the files someone attached on purpose. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D17 (was Q4) | Only PNG, JPEG, GIF and WebP render inline. SVG, HTML, PDF and everything else download, under a `sandbox` CSP. PDF and SVG previews can come later as images made on the server. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D18 (was Q5) | Attachment and inline uploads are limited to 30 a minute per user (dropping 10 screenshots is normal). Avatars and logos keep their 10. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D19 (was Q6) | No `Range` requests and no video or audio playback in M1. Such files download. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D20 (was Q7) | An issue has at most 100 attachments. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D21 (was Q9) | Uploads with an API key or through MCP come in M6. The upload route takes sessions only in M1. MCP clients can add links. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D22 (was Q10) | Files have a single `issue_id` owner in M1. M3–M5 replace it with `owner_type` and `owner_id` when projects and documents get files. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D23 (was Q14) | The per-user caps (1 GB, 100 unclaimed files) and the 1 GB free-space floor are fixed constants in M1. Configurable quotas come with FR-OPS-08 (M7) and then follow architecture rule 7. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D24 (was Q16) | Only location metadata is stripped from uploaded images (GPS in EXIF, and XMP, which can hold it). Orientation and colour profiles stay, so photos display correctly. An "as uploaded" workspace setting can come later. Accepted as proposed at the M1 gate. Amended by D27. | 2026-11-12 |
| D25 | A key limited to some teams (`teamIds` set) never reads an unclaimed upload, not even its owner's (§4.2, the matrix's key column; the SQL said so from PLAN-014 S1). So such a key can't pass its owner's upload to `attachment.createFile`, while the §4.3 inline claim, which checks the uploader and not visibility, still works for it. Moot in M1: uploads take sessions only (D21). M6 revisits it with key uploads. The M0 branch is not narrowed the same way: a narrowed key still reads its owner's avatar or logo that nothing uses yet (workspace-wide files, M0 rule). Coordinator decision at the PLAN-014 S1 review. | 2026-11-12 |
| D26 | Seeing a file is not owning it. `FileRef` resolves any file the actor can see (§4.2), so another user's avatar in use resolves too. `user.updateProfile` and `workspace.update` set only the actor's own upload or the current avatar or logo; any other file answers `NOT_FOUND` exactly like an unknown id, so nobody can pin another user's file with the `RESTRICT` key (SPEC-003 §4). Coordinator decision at the PLAN-014 S1 review, following Linear. | 2026-11-12 |
| D27 | Location stripping (§4.8) may drop image data that is not the primary image, amending D24 and §4.8's earlier "no loss of image data". Bytes after a JPEG's EOI are dropped, which loses MPF secondary images, Ultra HDR gain maps and Motion Photo video. Photoshop's APP13 is dropped whole (resources 0x0424 XMP, 0x0422 EXIF, IPTC city and country). GPS IFDs are cleared wherever EXIF points to them (IFD0, IFD1, the Exif sub-IFD 0x8769). The EXIF thumbnail (IFD1 tags 0x0201 offset, 0x0202 length) is cleaned in place: its EXIF GPS cleared, its XMP and APP13 zeroed, and a thumbnail that can't be parsed, or is nested more than two deep, zeroed whole. The primary image's pixels never change. Coordinator decision at the PLAN-014 S2 review. | 2026-11-12 |
| D28 | `attachment.createFile`'s `file` also resolves a detached `attachment` file whose issue the reader sees (§4.2). Without it, the undo (§3.5, §6.2: "a detached file owned by the same issue") could never run, because the one visibility rule hides a detached file from everyone and `FileRef` would answer `NOT_FOUND` first. It is opt-in, by the input field's type (`FileRefIncludingDetached`): every other `FileRef` (`user.updateProfile`'s avatar, `workspace.update`'s logo) answers such a file `NOT_FOUND` exactly like an unknown id (D26). Downloads never use this branch, so the matrix is unchanged. `createFile` then accepts it only for its own issue. This narrows §4.2's "one rule" for that one field only. Proposed in PLAN-014 S4a (2026-11-16); accepted in this narrowed form by the coordinator at the S4a review (2026-11-24). The user may override it. | 2026-11-24 |
| D29 | `attachment.createFile` takes an optional `upload` (the upload route's answer: name, type, size, dimensions) that only the optimistic reads, because the client store holds no `files` rows (server-only, D15) and §6.2 says the row is predicted "from the upload answer". The server ignores it and copies the `files` row. Without it (an undo, an API or MCP caller) nothing is predicted. PLAN-014 S4a. | 2026-11-16 |
| D30 | A client drops an eager child row (an Attachment) whose issue it doesn't hold, after the whole delta batch, in the pool and in storage: an upsert whose Issue is in neither the pool nor the batch is removed at the batch's last id, like the children of an issue the batch removed (§4.1). The server may log such a row: `attachment.setPreview` runs on an archived or deleted issue (§4.4) and writes a `U` under `team:<teamId>`. Bootstrap leaves it out, so keeping it would make a streaming tab differ from a fresh one. An Issue's `I` always precedes its children in the log, so a live issue's child is never dropped. Found by the sync property suite; PLAN-014 S4a review. **Amended 2026-11-24 (PLAN-011 S8's 1,000-case run):** that last assumption fails when the replica gains a team after the Issue's `I` was logged. A team subscribed a moment ago streams its packets before its partial bootstrap answer arrives, and the answer's snapshot may predate a child logged meanwhile, so dropping that child lost it for good. The refined rule: an eager child upsert whose Issue is in neither the pool nor the batch is dropped only when its team (the row's `teamId`) is loaded in this tab, that is, no partial load of the team is pending. While the load is pending the row is kept, in the pool and in storage. When the load completes, the tab drops that team's eager children whose Issue is still absent, from the pool and in `writePartialRows` (a tombstone at the row's version or `C`, whichever is higher). An unsubscribe also removes a stored child of the team whose Issue isn't stored. A child row without `teamId` is dropped at once, as before. A dropped upsert is not written to storage at all, because a delete at the batch's last id can't overwrite an upsert stored at that same id (the batch's last packet). The pool's prune on another team's removal keeps such a child too, for the sweep at its team's load end. Tabs sharing a replica can still tie: when one tab's delete and another tab's kept upsert carry the same id, the first write wins, so a loading tab's kept upsert can leave a stray row in storage until its load-end sweep, or, if that tab closes first, until the team is next loaded or removed. That row is storage-only and heals itself, and a starting tab's pool never shows it (`prepare` prunes it). | 2026-11-24 |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| ADR-0014 file storage | Decision ("thumbnails are generated on upload") | New ADR "Issue files: claiming, background previews and the byte protocol", superseding ADR-0014. Proposed decision: *Files stay content-addressed on the local volume behind `BlobStore`, now with streaming `putStream`/`commit`/`getStream`. Image previews are made by a pg-boss job queued when a file is claimed, not on upload, and set through a system-only operation. Issue files are owned by their issue once claimed; visibility is the owning issue's (§4.2 rule), never the uploader's. Every insert and delete of a file row takes a per-key advisory lock; bytes are released through a `blob_release` table and a daily sweep. Location metadata is stripped from uploaded images. Download headers and the `sandbox` CSP stand as in ADR-0014.* ADR-0014's status line becomes "Superseded by ADR-0021"; `adr/README.md` lists the new ADR. | Yes: [ADR-0021](../04-architecture/adr/0021-issue-files.md) |
| ADR-0010 jobs | Queue list | [ADR-0024](../04-architecture/adr/0024-job-queues.md) (job queue names and the M1 queues, superseding ADR-0010's queue list) adds `files-preview`, `files-cleanup` (hourly) and `files-sweep` (daily), hyphenated like the code's queue names; SPEC-015's queues are in the same ADR. | Yes: ADR-0024 |
| SPEC-003 | §3.1 definition fields | Add `systemOnly: true` to the registry definition: the operation is callable only by the system actor in every environment, and is hidden from the API, catalog, OpenAPI, MCP and the command menu; it is exempt from rule 2's seed run and rule 4. Used by `attachment.setPreview`, `issue.autoArchive` and `issue.autoClose`. (`internal` stays for dev-only debug ops.) Same row in SPEC-014 and SPEC-015. | No |
| SPEC-003 | §4 reference types | `FileRef`: resolves through SPEC-014 §4.2 (unclaimed → its uploader; owned → whoever sees the issue, after key narrowing; avatar and logo as before). Add `AttachmentRef` (uuid, an Attachment the actor can see). | No |
| SPEC-003 | §9 error model | Add `INSUFFICIENT_STORAGE` → HTTP `507`; also in `ROUTE_ERROR_STATUS` and OpenAPI. | No |
| SPEC-001 | D12 | File purposes widen to `attachment`, `inline`, `preview`; the uploader-always-reads rule applies only to avatars and logos. | No |
| SPEC-004 | §7 / E6 | E6's "clear error" for a full disk is `507` with the §6.4 message; note the 1 GB upload floor next to the health warning. | No |
| PLAN-001 | S6 "Later" | Mark the avatar/logo FKs and the clean-up of replaced files as covered by SPEC-014. | No |
| domain-model | §4.9 | Attachment fields of §4.1 (including `teamId`); File purpose, `issue_id`, `detached_at`, `preview_of`, `bigint` size. | No |
| domain-model | §7 | `attachment.uploadFile` → `attachment.createFile`; add `attachment.update`, `attachment.setPreview` (system). | No |
| permissions | §3.3, §4 | Attachment rename and remove rows; files: unclaimed readable by the uploader only, owned by those who see the issue (no uploader exception); detached by nobody. | No |
| permissions | §6 (purge) | Purge removes every file row the issue owns: attachments, inline files and previews. | No |
| SPEC-003 | §3.1 `ui.contexts` | Add `attachment` to `UI_CONTEXTS` (with SPEC-013's `comment`). | No |
| SPEC-005 | §4.1 command target | Add the target kind `attachment` (`{ kind, ids, label }`), set by a focused attachment row. | No |
| command-menu | §3.3 contexts | Add the attachment context chip ("Attachment: design.pdf") and its commands. | No |
| shortcuts | §3.4 | Add `Mod+Shift+U` "Attach file" and `Ctrl+L` "Link any URL to issue…" (literal Control, macOS only; unbound on Windows and Linux). Listed once with the full key map in SPEC-012 §12. | No |
| state-machines | §2 | Remove "any edit unarchives": archived issues are read-only, so attachment edits on them are `CONFLICT` (owned by SPEC-015; listed here because attachments follow it). | No |
| design-system | §4 | Remove attachment keeps the Undo toast and no dialog (D8). Issue and settings deletes now confirm in a dialog (SPEC-012 §12, SPEC-010 §12), so §4 names attachment removal as the reversible delete that runs at once. | No |

Cross-spec alignment (done in review round 1): SPEC-013 uses this spec's unusable-file message; SPEC-015's purge cites §4.5 and §4.7; SPEC-011's `IssueOutput.attachments` matches §6.2; SPEC-012 lists `Ctrl+L` (macOS only) and `Mod+Shift+U` in its key map.
