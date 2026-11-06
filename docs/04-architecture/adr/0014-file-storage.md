# ADR-0014: File storage

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
Uploads are stored on the `uploads` Docker volume behind a `BlobStore` interface (`put`, `get`, `delete`, `stat`). Keys are content-addressed (`sha256/ab/cd…`) and deduplicated. Downloads go through `GET /files/:id`, which is authorised against the parent record's visibility on every request (ETag caching, `Content-Disposition: attachment` for non-image types). Image thumbnails are generated on upload (sharp). The S3-compatible implementation is v2 (FR-OPS-11).

## Consequences
+ Zero external dependencies, and backups include the uploads.
− Disk usage grows on the VM. The System page shows storage usage.
