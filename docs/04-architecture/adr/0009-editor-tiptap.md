# ADR-0009: Rich text editor

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
**TipTap** (ProseMirror). Documents are stored as ProseMirror JSON, with a derived plain-text column for search. Custom extensions: @mention, issue/project/doc chips, slash commands, checklists, code blocks (lowlight), and image upload. The same schema runs on the server for validation and text extraction.

The v1 concurrency model is **versioned whole-document saves with conflict detection** (`baseVersion`). The v2 upgrade path is **Yjs collaboration** (TipTap Collaboration), which fits naturally with ProseMirror.

## Consequences
+ A mature ecosystem and a clear path to real-time co-editing.
− The ProseMirror schema is a compatibility contract, so changes need a migration.
