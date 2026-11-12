# ADR-0021: Issue files: claiming, background previews and the byte protocol

Status: **Accepted** (with SPEC-014 at the M1 acceptance gate, 2026-11-12) · Date: 2026-11-12 · Supersedes [ADR-0014](0014-file-storage.md). The job queues it adds are listed in [ADR-0024](0024-job-queues.md).

## Context
[ADR-0014](0014-file-storage.md) chose content-addressed files on the local `uploads` volume behind a `BlobStore` (`put`, `get`, `delete`, `stat`), downloads through `GET /files/:id`, and **image thumbnails generated on upload**. M0 built avatars and the workspace logo on it (SPEC-001 D12, PLAN-001 S6): small files, buffered in memory, read by their uploader and by everyone once in use.

Issue attachments and images in rich text (SPEC-014) change the problem:
- **Size.** Files of up to `UPLOAD_MAX_MB` (25 MB by default) can't be buffered in a 512 MB container (SPEC-004 E10).
- **Visibility.** An attachment belongs to an issue, so it must be readable by whoever sees the issue and by nobody else, the uploader included once it is attached to a private team's issue they left (CLAUDE.md rule 4).
- **Previews.** Making a thumbnail on upload decodes every image at upload time, for files that may never be attached, and ties upload latency to the shared decode limiter (SPEC-004 E10).
- **Shared bytes.** Content addressing lets several `files` rows share one storage key. With deletes from clean-up, purge (SPEC-015) and replaced avatars racing uploads and preview jobs, a naive delete can unlink bytes another row still names, or leave bytes no row names.
- **Privacy.** Phone photos carry GPS coordinates; attaching one to a public team's issue would publish where it was taken.

## Options
1. **Keep ADR-0014 as is** and add attachments on top: thumbnails on upload, the uploader can always read, deletes unlink bytes in the transaction. Simple, but unsafe for shared keys and private teams, and every upload decodes.
2. **Move files into Postgres** (`bytea` or large objects). Transactional deletes, but backups and the database grow with every upload, and streaming is awkward.
3. **Keep the volume, change ownership, previews and deletes** (SPEC-014): streaming writes, issue-owned visibility, previews by a background job, and a lock-and-release protocol for bytes.

## Decision
**Option 3.** The details are SPEC-014 §4.2–§4.8.

- **Storage.** Files stay content-addressed (`sha256/ab/cd…`) and deduplicated on the local volume behind `BlobStore`. The interface gains streaming: `putStream` (to a temporary file, hashing on the way), `commit(tempPath, key)` (the rename) and `getStream`. Attachment and inline uploads stream; avatars and logos keep M0's buffered path and their 2 MB limit. The S3-compatible store is still v2 (FR-OPS-11).
- **Ownership and visibility.** An upload belongs to its uploader until it is **claimed**: by `attachment.createFile`, or by saving a document that references it (inline files). A claimed file is owned by its issue, and only those who can see the issue (after API key narrowing) can read it, never the uploader by right. An unclaimed file is readable by its uploader only. Avatars and logos keep the M0 rule. Every check is made on each request to `GET /files/:id`, and a file the actor can't see is the same `404` as a missing one.
- **Previews.** Not made on upload. Claiming a raster image (PNG, JPEG, GIF, WebP) queues one job on `files-preview`, in the claiming transaction. The job writes a `preview` file row and sets the attachment's `previewFileId` through the system-only operation `attachment.setPreview`, run through the executor as `system` (CLAUDE.md rule 1). Inline images have no previews. Decoding shares the per-process limiter of SPEC-004 E10.
- **Byte protocol.** Every insert and delete of a `files` row takes a per-key advisory lock (`pg_advisory_xact_lock` on a new lock class, keys in ascending order, after any issue row lock). A deleter locks each source row, deletes its previews explicitly, then the file, and records each key in the server-only `blob_release` table in the same transaction. Bytes are never unlinked inside a transaction. The `files-cleanup` job (hourly) drains `blob_release`, unlinking a key only when no `files` row still names it; the `files-sweep` job (daily) removes bytes with no row and stale temporary files. So no row ever names missing bytes, and no bytes outlive their last row for long.
- **Location metadata** is stripped from attachment and inline images while they stream, without decoding: the GPS data in EXIF and XMP goes, orientation and colour profiles stay. The hash is of the stored bytes.
- **Downloads** keep ADR-0014's and M0's rules: `ETag` caching, `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff` on every file, inline only for the four raster image types and previews, `attachment` for everything else.
- **Disk limits.** An upload that would leave less than 1 GB free on the uploads volume is refused with `507 INSUFFICIENT_STORAGE` (a new error code, SPEC-003 §9). Per-user caps on unclaimed bytes and files apply (SPEC-014 §4.6).

## Consequences
+ Large files never sit in memory: at most 64 KB of a body per request.
+ A private team's files follow the issue: nobody outside the team reads them, uploaders included.
+ Uploading never waits for image decoding; previews arrive a moment later.
+ Shared bytes are safe under any interleaving of upload, copy, preview, clean-up, purge, drain and sweep. SPEC-014 AC-14 proves it with a property test against a model of the lock, plus one run against real Postgres advisory locks (a testing-hold exception the user granted, SPEC-014 Q15).
+ Zero external dependencies, as before; backups include the uploads.
− Bytes linger after a delete until the next `files-cleanup` run (at most an hour), and orphaned bytes until the next sweep.
− Three more job queues to run and monitor ([ADR-0024](0024-job-queues.md)); the System page and metrics show the `blob_release` backlog and preview queue length.
− Images keep camera metadata other than location. An "as uploaded" setting can come later.
