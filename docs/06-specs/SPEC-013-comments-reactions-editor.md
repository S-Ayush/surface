# SPEC-013: Comments, reactions & rich editor

Status: **Accepted** (2026-11-12, M1 acceptance gate) · Milestone: **M1** · Date: 2026-11-12 (revised after review, 2026-11-12)
Implements: FR-COL-01, FR-COL-02, FR-COL-04 (resolve thread and issue reactions follow Linear, D7, D8) · ADR-0009 · NFR-06, 07, 08, 14, 16, 18, 19
Depends on: SPEC-011 (issues, content models, `/sync/content`, description saves), SPEC-015 (lifecycle rules for archived and deleted issues), SPEC-014 (inline files, claiming), SPEC-012 (issue page, the `comment` shortcut scope, synced `Draft` rows), SPEC-003 (registry, optimistic store), SPEC-005 (shell, overlays, shortcut engine)
Related: [domain-model §4.8](../03-domain/domain-model.md) · [events](../03-domain/events.md) · [permissions §3.3, §5](../03-domain/permissions.md) · [sync-protocol §2, §4.2](../04-architecture/sync-protocol.md) · [ADR-0009](../04-architecture/adr/0009-editor-tiptap.md) · [shortcuts §3.4, §3.7](../05-design/shortcuts.md) · Linear's key map (SPEC-012 §3.6)

---

## 1. Problem & goal

An issue is where a team talks about the work, and today it has no conversation. This spec adds **comments** with one level of replies and **resolvable threads**, **reactions** on comments and on the issue itself, and the **rich editor** that comments and issue descriptions share. The editor's document schema runs in the browser and on the server. The server validates every document, extracts its text for search, and converts it to and from Markdown for the API and MCP (SPEC-011 Q12).

## 2. Scope

**In scope**

- Comments on issues: create, reply (one level, INV-19), edit your own (marked edited), delete your own (Admins delete any). A deleted comment with replies leaves a placeholder.
- Resolve and reopen a thread. A resolved thread collapses to one line.
- Reactions on comments and on the issue itself: set or clear an emoji, shown as chips with counts.
- `packages/editor`: one ProseMirror schema (TipTap). A headless entry `@surface/editor/schema` for the server (validate, text extraction, Markdown ↔ JSON), and a React entry for the web app, used for both descriptions and comments.
- Editor features: paragraphs, headings (1–4), bold, italic, underline, strike, inline code, links, bullet and numbered lists, checklists, block quotes, code blocks with syntax highlighting, horizontal rules, hard breaks, inline images and file chips (uploaded files, SPEC-014), Linear's key map and Markdown input rules (§3.5), `:name:` emoji autocomplete, Markdown and HTML paste, and a slash menu.
- `Comment` and `Reaction` as **content** models with parent `Issue` (SPEC-011 §5.1), loaded with `/sync/content` together with the issue's description and history.
- Domain events `comment.created`, `comment.updated`, `comment.deleted`, `comment.resolved`, `comment.reopened`, `reaction.added`, `reaction.removed` in the outbox. No consumers until M4 and M6.

**Out of scope**

- @mentions and issue, project or document chips (FR-COL-03, M4). The schema reserves no node for them; adding one is a schema change (§4.4).
- Notifications, subscriptions and the Inbox (M4). Description merge UI and presence (FR-COL-10, M4). Documents (M4). Comments on project updates (M5).
- System comments. Auto-close writes a history entry by the system actor, not a comment (SPEC-015 §4.8), so no M1 job posts one. `actorKind` gains `system`, with a nullable `userId`, in the spec that first posts one.
- Comment edit history (D13). Custom emoji (Linear has them; later). Tables (`|--`) and collapsible sections (`>>>`, `Mod+Shift+6`) in the editor: later, with FR-COL-05.
- Linear's embeds on paste (YouTube, Loom, Figma) and link unfurling: not copied, because they make the browser or server call a third party (rule 5, D9). "New sub-issue from comment" and "Unsubscribe from thread": M3 and M4.
- Real-time co-editing (FR-COL-09, v2), link previews (never: rule 5, no outbound calls).

## 3. User flows

The issue page layout is SPEC-012's. This spec owns the comment parts of the activity area and the editor.

### 3.1 Comment

1. Below the activity timeline sits a "Leave a comment…" box. `Ctrl+M` on the issue page focuses it (macOS only; SPEC-012 §3.6 and D21). `Enter` sends the comment and `Shift+Enter` starts a new line (§3.5 lists the exceptions). `Mod+Enter` also sends, anywhere in the box. A send button does the same.
2. The comment appears at once in the timeline with a pending marker until the server confirms. The box empties at once, and the issue's comment draft is discarded (`draft.discard`, SPEC-012). The sent text lives on in the queued `comment.create` until the server confirms. If the server rejects it, the pending comment is removed and a toast says why (NFR-08). The rejected text is saved back as the issue's comment draft (`draft.save`) if that draft is empty or gone (and shows in the box, if the issue is open). If the user has typed something new meanwhile, that draft is kept and the toast offers **Copy text** instead, so nothing typed is overwritten or lost, even if the user left the page (E21).
3. An empty comment (no text, no image and no file after trimming) can't be sent: the send button is disabled.
4. The comment box is shown only once the issue's content is hydrated (SPEC-011 §5.3). On the issue page that happens on open. Offline, on an issue whose content was never fetched, the activity area says "Comments are available when you're back online." and shows no box.
5. An archived or deleted issue is read-only (D10): the comment box, reply boxes, reaction buttons and the options that write are hidden. SPEC-015 shows the Archived or Deleted badge and the **Restore** control (there is no banner).
6. **Drafts.** An unsent comment is a synced `Draft` row of the user (kind comment, one per issue), owned by SPEC-012. The box writes it 500 ms after the last change and on blur, so the text shows in the box on every device and in the Drafts page. This spec defines no storage of its own.

### 3.2 Reply

Hovering a comment shows a **Reply** button, and `R` on a focused comment does the same: it focuses the thread's "Leave a reply…" box. `Enter` or `Mod+Enter` sends the reply (`Mod+Enter` is the `comment` scope's "save the edit, or send the reply, in this card", SPEC-012 §3.6). Replies are listed under their comment, oldest first. A reply has no reply box of its own: replying in a thread always adds to that thread (INV-19). A reply box has no draft row: only the issue-level comment box does.

### 3.3 Edit and delete

Hovering or focusing a comment shows **Reply**, **Add reaction** and an **options** menu (Linear's, D7): Resolve thread (Reopen thread when resolved), Copy link to comment, Copy content as Markdown, New issue from comment…, Edit (own), Delete (own, or any for Admins).

**New issue from comment…** opens SPEC-012's composer with the comment's body as the description and the title field focused. It is a command-menu command and a menu entry, not a registry operation: the issue is created by `issue.create` when the user submits. Inline files in the body are copied per SPEC-014 §4.3.

- **Edit** turns the comment into an editor in place. `Mod+Enter` saves and `Esc` cancels, with the dirty-close guard (design-system §5.2). An edited comment shows "edited" next to its time, with the edit time on hover.
- **Delete** asks for confirmation ("Delete this comment? This can't be undone.") because a comment delete is irreversible.

### 3.3a Resolve a thread

1. **Resolve thread** is in the root comment's options menu. In a reply's menu the same entry reads **Resolve thread** and resolves the whole thread, not the reply (the reply's menu has it so a reply that answers the question can close it). Anyone who can see the issue can resolve or reopen.
2. A resolved thread collapses to one line: the first line of the root's text, "Resolved by Ada · 2h ago" and a **Reopen** button. A chevron expands it. An expanded resolved thread shows its replies and, under the last one, the reply box. Replying to a resolved thread leaves it resolved.
3. **Reopen thread** clears the state. Resolving writes no history entry (D24).
4. A deleted root with replies (placeholder) can still be resolved and reopened.

### 3.4 React

**Add reaction** opens the EmojiPicker (design-system §5.3): a search field, "Frequently used" (the user's most-used, kept on this device), then categories. Choosing an emoji sets it. Under the comment, each emoji shows as a chip with its count. The chip is highlighted when it includes the user, and its tooltip names who reacted. Clicking a chip sets or clears the user's reaction. **The issue itself takes reactions too** (D8): under its description (SPEC-012 places the row) the same chips and an **Add reaction** button, and the command **Add reaction…** in the `issue` context. Chips are buttons with `aria-pressed` and an accessible name like "Thumbs up, 3 reactions, including you".

### 3.5 Write rich text

The same editor serves descriptions (SPEC-011 `issue.updateDescription`) and comments. Keys and input rules are Linear's panel (D4, scratchpad `linear-shortcuts-2026-11-12.md`). `Mod` is Cmd on macOS and Ctrl elsewhere.

**Keys** (handled by the editor; SPEC-012 §3.6 lists them for the help menu)

| Key | Does |
|---|---|
| `Mod+B` · `Mod+I` · `Mod+U` · `Mod+Shift+X` · `Mod+E` | Bold · italic · underline · strikethrough · inline code |
| `Mod+K` | With a text selection, adds or edits a link; without one it opens the command menu (shortcuts §3.7, SPEC-005 E1) |
| `Alt+Shift+.` | Block quote |
| `Mod+Alt+0` | Regular text |
| `Mod+Alt+1` … `4` | Heading 1–4 |
| `Mod+Shift+7` · `Mod+Shift+8` · `Mod+Shift+9` | Checklist · bulleted list · numbered list (matched on `Digit7`…`9`) |
| `Mod+Shift+\` | Code block |
| `Mod+Shift+U` | Attach: opens the file chooser and inserts the file inline at the cursor (SPEC-014 §3.3). This is the `issue-page` binding "Attach file" (SPEC-012 §3.6), not an editor binding: with focus in the description or a comment box it inserts inline, elsewhere on the page it adds an attachment. On the issue page only |
| `Alt+↑` / `Alt+↓` | Move the current block up or down |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo |
| `Mod+Enter` | In a checklist item: toggles it. Anywhere else: not consumed, so it submits or saves (below) |
| `Shift+Enter` | Hard break in a comment; in a description `Enter` is the new line and `Shift+Enter` also breaks |

**Enter.**

- **Comment box, reply box, comment being edited:** `Enter` sends or saves. `Shift+Enter` is a new line. In a list, checklist, block quote or code block, `Enter` keeps its editing meaning (new item or line; pressing it twice on an empty one exits the block) and `Mod+Enter` sends. Linear's behaviour in these blocks was not observable; kept as proposed. `Enter` never sends while an IME composition is open, or while the slash menu or the emoji autocomplete is open (it picks the entry).
- **Description:** `Enter` is a new line. The description saves on blur and after 2 s idle (SPEC-011), and `Mod+Enter` outside a checklist item reaches the shortcut engine (SPEC-012).
- **Checklists:** `Mod+Enter` toggles the item under the cursor. A checklist toggle in a comment still follows the author rule (§4.4 "Checklists").

**Markdown input rules**

| Type | Gives |
|---|---|
| `#`, `##`, `###`, `####` + Space | Heading 1–4 |
| `-`, `*` or `+` + Space | Bulleted list |
| `1.` + Space | Numbered list |
| `[]` or `[ ]` + Space | Checklist |
| `>` + Space | Block quote |
| ```` ``` ```` (with an optional language) | Code block |
| `***` or `---` + Space | Divider |
| `**x**` · `_x_` or `*x*` · `~x~` or `~~x~~` · `` `x` `` | Bold · italic · strikethrough · inline code |
| `:name:` | Emoji autocomplete (below) |

- **Exit.** `Enter` twice on an empty line leaves a code block or block quote.
- **Slash menu:** `/` at the start of an empty line opens it, with the same blocks plus "Image" and "File" (both open the file chooser and upload with `purpose=inline`, SPEC-014).
- **Emoji autocomplete:** typing `:` and two letters opens a list of emoji by shortcode from the pinned `emojibase-data` (bundled, §7). `Enter` or `Tab` inserts the emoji as plain text. There is no emoji node.
- **Paste** (§4.4 "Paste"): Markdown and HTML are converted to the schema. Anything the schema doesn't know becomes plain text. Pasting a bare URL over selected text makes the selection a link, if the URL passes the link rule. Pasted images are uploaded as inline files; external images become links. Embeds are not created (D9).
- There is no `Mod+Shift+6` (collapsible) and no table or `|--` rule yet (Out of scope).

## 4. Domain changes

### 4.1 Comment (content model, parent `Issue`)

| Field | Type | Rules |
|---|---|---|
| id | uuid | UUIDv7, from the client or the server |
| issueId | Issue | Set at creation, never changed. The content parent. |
| teamId | Team | The issue's team, copied at creation. Always equals the issue's `teamId`; moving an issue to another team (M3) rewrites it. Used for sync groups and API key `teamIds` filtering. |
| parentCommentId | Comment? | A top-level comment of the same issue (INV-19). A reply's parent never has a parent. |
| userId | User | The author. For `api` and `mcp`, the key's owner. |
| actorKind | `user` \| `api` \| `mcp` | Shown as "via API" or "via MCP" next to the author (D16) |
| body | editor JSON | Valid against the schema (§4.4), at most 50 KB of JSON (D14), not empty |
| version | int | Starts at 1, +1 on each body change. Used for conflict detection (§4.3, NFR-07). Resolving never changes it. |
| editedAt | timestamptz? | Set by `comment.update` when the body changes |
| deletedAt | timestamptz? | Set when a comment with replies is deleted (§4.3) |
| resolvedAt | timestamptz? | Top-level comments only (a thread's resolved state). Set by `comment.resolve`, cleared by `comment.reopen`. |
| resolvedById | User? | Who resolved the thread. Set and cleared together with `resolvedAt`. |
| createdAt, updatedAt | timestamptz | Server time |

**Server-only search text** (not a synced field, never in deltas or `/sync/content`, never computed by optimistic code): the plain text from `docToText` (§4.4) lives in a server-only table `comment_search_text (comment_id, text)`, like SPEC-011's `issue_search_text`, because synced tables hold no undeclared columns (`apps/server/src/sync/repo.ts`). It is written in the same transaction as the comment.

The domain-model field `projectUpdateId` arrives with project updates in M5; in M1 `issueId` is required.

### 4.2 Reaction (content model, parent `Issue`)

A reaction is on a comment, or on the issue itself when `commentId` is empty (D8).

| Field | Type | Rules |
|---|---|---|
| id | uuid | Derived: `reactionId(subjectId, userId, emoji)` from `packages/domain` (a UUIDv5-style hash), where `subjectId` is the comment's id, or the issue's id for an issue reaction (UUIDs never collide). The client and the server compute the same id, so a confirmed row replaces its optimistic row exactly. |
| issueId | Issue | The comment's issue. The content parent, so the client can route and evict a Reaction without a join. Never changed. |
| teamId | Team | As Comment |
| commentId | Comment? | A comment that isn't deleted. Empty: the reaction is on the issue. |
| userId | User | |
| emoji | string | Exactly one RGI emoji (§4.4 "Emoji") |
| createdAt | timestamptz | |

The id makes reactions unique per (subject, user, emoji). A comment, and the issue, each carry at most 20 distinct emoji (D15).

### 4.3 Writing comments and reactions

**Order of work in every handler** (comment and reaction operations):

1. `lockIssueForWrite(tx, issueId, ctx, 'edit')` (SPEC-011 §4.8; every comment and reaction operation uses mode `edit`, because archived and deleted issues are both read-only, D10): locks the issue row `FOR UPDATE` and applies the lifecycle rule below.
2. For an operation on a comment, lock the thread's top-level comment `FOR UPDATE` (the comment itself, or its parent for a reply). An issue reaction takes the issue lock only. Lock order is always issue row, then thread root.
3. Re-read the comment rows the handler depends on (reply count, deleted state, reactions) after the locks, not before.
4. Write through the repo (`apps/server/src/sync/repo.ts`), which logs every row in `sync_log`.

This serializes every write to one thread. Two last replies deleted at the same time, a reply racing a delete, a resolve racing a reply, two tabs setting the same reaction and two users racing the 20-emoji cap all become one-after-the-other. Issue reactions are serialized by the issue lock.

**Lifecycle rule** (SPEC-015 §4.3's table is the source; this is how it applies here). Copy Linear: an archived issue is read-only (D10). No comment or reaction operation unarchives an issue, and none writes any history entry.

| Operation | Archived issue | Deleted issue |
|---|---|---|
| `comment.create`, `comment.update`, `comment.delete`, `comment.resolve`, `comment.reopen`, `reaction.set` (on a comment or on the issue) | `CONFLICT`: "ENG-42 is archived. Restore it to edit it." | `CONFLICT`: "ENG-42 was deleted. Restore it to edit it." |

Restoring the issue (SPEC-015) is the only way back. Comments write no history of their own (D24).

**Deleting a comment**

| Case | Result (one transaction) |
|---|---|
| No replies | Hard delete of the comment and its reactions (`D` deltas) |
| Has replies | Soft delete: `deletedAt` set, `body` replaced by `EMPTY_DOC`, its `comment_search_text` row deleted, `version` +1, reactions deleted. Shown as "This comment was deleted", with its replies kept. |
| The last reply of a soft-deleted comment is deleted | The parent is hard-deleted too |
| A deleted comment is edited or reacted to | `NOT_FOUND`. (Resolve and reopen still work on a placeholder root, §3.3a.) |
| A resolved thread's root is hard-deleted with its last reply | The thread goes with it; nothing to clear |
| A deleted comment is replied to | `INVALID_INPUT` on `parent`: "That comment was deleted. Comment on the issue instead." |

Foreign keys never cascade (`ON DELETE RESTRICT`): the handler deletes reactions and replies through the repo, so each deletion gets its `D` delta. A database cascade would skip `sync_log` and break sync (architecture rule 2).

**What a deleted comment leaves behind** (D17). The comment row and its text are gone from the `comments` table at once. Copies remain for a bounded time, and none is reachable through the app, the API or MCP:

- `sync_log.data` keeps each written row, including earlier bodies, for the `sync_log` retention of 30 days (sync-protocol §9). Clients that catch up within that window replay them and then apply the delete.
- Database backups keep whatever they captured, for the operator's backup retention.
- Inline files referenced only by the deleted comment stay owned by the issue (SPEC-014 §4.3) until the issue is purged. Only people who can see the issue can read them, and only by their `/files/<id>` URL.

Comment and reaction events in the outbox carry ids and the actor, never the body, so the outbox adds no copy. Deleting an issue's comments when the issue is purged is SPEC-015's (permissions §6). This spec registers its steps in SPEC-015's purge-step registry (SPEC-015 §4.5): reactions, then comments (replies before roots), then `comment_search_text`. Comment and Reaction are content models, so their steps use `repo.deleteWhere` with `log: false` (SPEC-011 §5.1); `comment_search_text` is server-only and is a plain delete.

**Editing with conflict detection** (NFR-07). `comment.update` sends the `baseVersion` it was edited from. If the stored `version` differs, the answer is `CONFLICT` and the client keeps the user's text in the editor (§6.3). A checklist toggle is a `comment.update` like any other, so a toggle in one tab can't silently overwrite text saved from another tab. Within one client, queued edits chain: each optimistic update raises `version`, so the next queued edit carries the right base.

**Every update bumps the version.** `comment.update` always raises `version` and sets `editedAt`, even when the stored body comes out the same. The client can't predict "same" (SPEC-014 §4.3 may rewrite `src` for copied files), and a server-side no-op would leave a queued follow-up edit carrying `baseVersion` = stored + 1, so it would get a spurious `CONFLICT`. The edit UI doesn't send an unchanged body: Save is disabled until the text differs from what was loaded. A same-body update still writes no `comment.updated` event when the stored body is unchanged.

**Resolve and reopen.** `comment.resolve` on a thread that is resolved, and `comment.reopen` on one that isn't, change nothing: no write, no event (as `reaction.set`). Both lock as above, take the thread's root from a reply ref, and leave `version` and `editedAt` alone. They set or clear `resolvedAt` and `resolvedById` and bump `updatedAt`. On a change they write `comment.resolved` or `comment.reopened` to the outbox (ids and actor only). These events notify no one (Linear sends no notification on resolve) and reach webhooks when M6 adds them (events.md).

### 4.4 Editor schema (`packages/editor`)

**Nodes and marks.** One schema with nodes `doc, paragraph, heading(level 1–4), bulletList, orderedList, listItem, taskList, taskItem(checked), blockquote, codeBlock(language), horizontalRule, hardBreak, image(src, alt), file(src, name)` and marks `bold, italic, underline, strike, code, link(href)`. `image` is a block node; `file` is an inline atom (a chip). `code` excludes every other mark. Anything else is invalid.

- The schema is built from an **explicit list of extensions**. If StarterKit is used, every extension the list doesn't name is disabled (StarterKit v3 also adds Link, which must follow the link rule below; Underline is named in the list on purpose). A unit test asserts that the schema's node and mark names, and their attributes, equal the list above.
- **Links:** `href` is parsed with `new URL(href)`. The protocol must be `http:`, `https:` or `mailto:`. Relative, protocol-relative (`//host`) and unparseable links are invalid, as are any containing control characters. Mixed case is handled by the parser. Rendered with `rel="noopener noreferrer nofollow"` and `target="_blank"`.
- **Images and files** (SPEC-014 §4.3): `src` is exactly `/files/<uuid>`. Absolute URLs, `data:` and `blob:` URIs and other paths are invalid (D18). An `image` is a raster image shown inline; a `file` is a chip with the file's name. At most 50 file references per document. Saving a document (`issue.create`, `issue.updateDescription`, `comment.create`, `comment.update`) claims the inline files it references, in the same transaction, per SPEC-014 §4.3. A reference the author can't use is `INVALID_INPUT` ("A file in this text can't be used here. Upload it again.", SPEC-014's message) and nothing is saved.
- **Code blocks:** the schema's `codeBlock` is TipTap's plain CodeBlock. The web entry extends it with lowlight highlighting under the same node name and attributes. A unit test asserts that both entries produce the same schema. Unknown languages render as plain code (D19).
- **Checklists:** toggling a checkbox is an edit. In a description it is an `issue.updateDescription` (with `baseVersion`). In a comment, only the author can toggle (a `comment.update` with `baseVersion`). For everyone else the checkboxes are read-only.

**Underline and Markdown.** CommonMark has no underline. `docToMarkdown` drops the underline mark and keeps the text, so Copy as Markdown and the API's Markdown lose it. JSON keeps it.

**Constants in `packages/domain`** (so `operations`, `sync-client` and the server can use them without the editor):

- `EMPTY_DOC`: the empty document, one empty paragraph.
- `DOC_SCHEMA_VERSION`: an integer, starting at 1. It feeds `computeSchemaHash`, so a schema change gives clients a new `schemaHash` and a resync. The editor has a snapshot test pairing `DOC_SCHEMA_VERSION` with a hash of the schema's spec; changing the schema without bumping the version fails it.
- `reactionId(subjectId, userId, emoji)`.

**Headless entry `@surface/editor/schema`** (no DOM, no React, no lowlight). It exports `schema`, `validateDoc(json)` (the doc, or problems with paths), `normalize(doc)`, `docToText(doc)`, `docToMarkdown(doc)`, `markdownToDoc(md)`, `docFileIds(doc)` and `isSingleEmoji(text)` (the emoji check below, one definition for the client and the server). It uses `getSchema` and `Node.fromJSON`; it never creates an Editor instance.

**Packaging** (the server image runs built JavaScript, so the schema entry must build):

- `packages/editor/package.json` exports `"./schema"` with conditions `@surface/source` → `./src/schema/index.ts`, `types` → `./dist/schema/index.d.ts`, `default` → `./dist/schema/index.js`. The `"."` export (the React editor) stays source-only, for `apps/web`.
- A `tsconfig.build.json` includes only `src/schema/**`. A `build` script and `"files": ["dist"]` make `pnpm --filter @surface/server deploy --prod` ship it. `pnpm -r build` builds it before the server (topological order).
- `@tiptap/core` and `@tiptap/pm` are `dependencies` of `@surface/editor`. Markdown uses `@tiptap/pm/markdown` (prosemirror-markdown), so there is one copy of `prosemirror-model`. GFM task lists use a small markdown-it rule in `src/schema/markdown.ts`; markdown-it already handles strikethrough.
- `apps/server` adds `"@surface/editor": "workspace:*"`.
- **Boundary rules** in `.dependency-cruiser.cjs`:
  - `editor-schema-headless`: files under `packages/editor/src/schema/` may import only `packages/editor/src/schema/`, `packages/domain/`, `@tiptap/core`, `@tiptap/pm` and `markdown-it`.
  - `server-editor-schema-only`: `apps/server` may import `@surface/editor/schema` and nothing else from the editor.
  - `packages/operations` already can't import the editor (`operations-only-domain`).

**Text extraction** (`docToText`): block texts joined by newlines, list items without prefixes, code kept, images as their `alt`, file chips as their name. Deterministic. It fills `issue_search_text` and `comment_search_text`, on the server only.

**Markdown** (CommonMark plus GFM task lists and strikethrough):

- `image` ↔ `![alt](/files/<uuid>)`. `file` ↔ `[name](/files/<uuid>)`: a link whose target is exactly `/files/<uuid>` becomes a `file` node. That is the only relative link Markdown may contain.
- An image with any other target (for example `![x](https://…)`) becomes a link with the alt text, not an error. Tables and raw HTML become paragraphs of plain text.
- Headings 1–4 are `#` to `####`. Code blocks use a fence longer than any backtick run inside them. Text that would read as Markdown syntax is escaped.
- `normalize(doc)` gives the one form Markdown can represent: underline marks removed, adjacent text with equal marks merged, runs of empty paragraphs collapsed to one, empty paragraphs at the start and end removed (a document keeps at least one paragraph), a hard break at the end of a block removed, a hard break in a heading replaced by a space, leading and trailing spaces of a text block trimmed, and adjacent lists of the same kind merged.
- Properties: for every valid `d`, `markdownToDoc(docToMarkdown(d))` equals `normalize(d)`, and `normalize` is idempotent. For every Markdown string `md`, one pass reaches a fixed point: if `md1 = docToMarkdown(markdownToDoc(md))` then `docToMarkdown(markdownToDoc(md1)) = md1`.

**Paste** (web entry):

- Clipboard HTML is parsed in a detached document (`DOMParser`), which loads no images or scripts, then converted with the schema's parse rules.
- `data:` and `blob:` images are uploaded as inline files (E11) and inserted when the upload finishes. External images become a link to their URL with the alt text. Nothing in the editor ever loads a remote URL.
- Links are kept only if they pass the link rule; otherwise their text stays without the link.
- Embed URLs (YouTube, Loom, Figma) paste as plain links, never as embeds (D9).

**Rendering read-only documents.** A static renderer `DocView` turns a document into React elements directly from the JSON. It applies the same link and image rules as `validateDoc`, and it never mounts TipTap. Only the document being edited mounts an editor. This is what keeps 200 comments within the render budget (§10).

**Emoji.** The server checks `/^\p{RGI_Emoji}$/v` in Node 24. The client checks the same. The picker and the `:name:` autocomplete offer only emoji from the pinned `emojibase-data` version (its shortcodes file for English). A unit test asserts that every emoji in that version passes the regex in Node, so the picker never offers what the server refuses. A browser on a newer Unicode version may accept an emoji that Node refuses when typed through the API. That is `INVALID_INPUT` ("Use a single emoji, like 👍."); the regex follows each engine's Unicode version.

**Rollout of schema changes** (D6). A change to stored documents bumps `DOC_SCHEMA_VERSION` and ships a data migration that rewrites stored documents in the same release. The server accepts only documents valid against the current schema. Clients get a new `schemaHash` and resync. A queued offline mutation that carries an old-format document is replayed after the reload; if it no longer validates, it is rejected and rolled back like any rejection (NFR-08), and a comment's text goes back into the box.

### 4.5 Invariants

Each has a unit test:

- INV-19: replies are one level deep.
- Reactions are unique per (subject, user, emoji).
- Only a top-level comment is resolved, and `resolvedAt` and `resolvedById` are set together.
- A comment's `issueId` equals its parent comment's `issueId`.
- A Comment's or Reaction's `teamId` equals its issue's `teamId`.
- A Reaction's `issueId` equals its comment's `issueId` (when it has a comment).

### 4.6 Migration

One migration adds:

- `comments`: the §4.1 columns (including `resolved_at`, `resolved_by_id`).
- `comment_search_text`: server-only, `comment_id` primary key with `ON DELETE CASCADE`, and the extracted text.
- `reactions`: the §4.2 columns (`comment_id` nullable).
- `sync_groups` on both, with GIN indexes. Rows get `team:<teamId>` at insert, never the issue's `user:` groups (SPEC-011 §5.7), and are rewritten when the issue's team or the team's privacy changes (M3, M7; SPEC-014 has the same rule for Attachments).
- Foreign keys to `issues`, `comments`, `teams` and `users` (`resolved_by_id` too), all `ON DELETE RESTRICT` (§4.3).
- CHECK constraints: `resolved_at` and `resolved_by_id` are null together; a reply (`parent_comment_id` set) has no `resolved_at`; `actor_kind` is `user`, `api` or `mcp`. "A reply's parent is top-level" is checked in the handler under the thread lock, not by a trigger.
- Indexes on `comments (issue_id, created_at)`, `comments (parent_comment_id)`, `reactions (comment_id)` and `reactions (issue_id)`.
- `timestamptz(3)` timestamps.

`/sync/content` (SPEC-011 §5.2) returns both with the issue's other content.

## 5. Sync & permissions

### 5.1 Models

| Model | Load | `teamColumn` | Sync groups | Notes |
|---|---|---|---|---|
| Comment | content, parent `Issue` via `issueId` | `teamId` | `team:<teamId>` only (SPEC-011 §5.7) | Soft-deleted rows stay (placeholder); hard deletes are `D` deltas. Search text is in a server-only table. |
| Reaction | content, parent `Issue` via `issueId` | `teamId` | `team:<teamId>` only (SPEC-011 §5.7) | |

Hydration, caching, eviction and offline behaviour are SPEC-011 §5.3 and §5.4. An issue's comments and reactions arrive with its description and history, and live deltas apply once the issue is hydrated. Dispatching a comment or reaction mutation for an issue that isn't hydrated starts hydration of that issue first, so the confirmed row never vanishes when its pending entry is dropped (SPEC-011 §5.3). The UI only offers comment boxes on hydrated issues (§3.1), so in practice this covers API-shaped clients and races.

Comment and Reaction deltas reach a connection only through `team:<teamId>`, never through the issue's `user:` groups (SPEC-011 §5.7). Opening an issue subscribes its team when the client doesn't already (SPEC-011 §5.7), so an open issue's comments are always live. The comments of an archived or deleted issue are shown read-only from the server, not from the replica (SPEC-015 §3.4).

API keys with `teamIds` see comments and reactions only of those teams, filtered in SQL by `team_id` in `comment.list`, `CommentRef` and `/sync/content` (permissions §3.5).

### 5.2 Permissions

| Operation | Member | Admin | Notes |
|---|---|---|---|
| Create a comment or reply; set or clear own reactions (on comments and on the issue) | ✅ | ✅ | On any live issue the user can see (public teams included) |
| Resolve or reopen a thread | ✅ | ✅ | Anyone who can see the issue, as in Linear |
| Edit a comment | 👤 | 👤 | The author only. Admins can't edit others' words (permissions §3.3). |
| Delete a comment | 👤 | ✅ any | |
| API key / MCP | `read_write` for create, update, resolve, reopen and `reaction.set`; `comment.delete` is `destructive` | | permissions §3.5 |

Private team comments and reactions are invisible to non-members. A `CommentRef` to one is `NOT_FOUND`, worded as for one that doesn't exist. Bootstrap never carries them (content isn't bootstrapped), and neither do `/sync/content` and live deltas (permissions §5).

## 6. API

### 6.1 Operations

| Operation | Kind | Input → output, notes |
|---|---|---|
| `comment.create` | m | `{id?, issue: IssueRef, parent?: CommentRef, body}` → `CommentOutput`. `body` is editor JSON or a Markdown string (D20). `parent` must be a live top-level comment of the same issue. `ui`: **Comment…** (focuses the comment box, context `issue`). |
| `comment.update` | m | `{comment: CommentRef, baseVersion, body}` → `CommentOutput`. Author only. `CONFLICT` when `baseVersion` isn't the stored version. Every update raises `version` (§4.3). `ui`: **Edit comment** (context `comment`). |
| `comment.delete` | m, destructive | `{comment}` → `{comment, mode: "hard" \| "soft"}` (§4.3). `ui`: **Delete comment** (context `comment`). |
| `comment.resolve` | m | `{comment: CommentRef}` → `CommentOutput` of the thread's root. A reply ref resolves its thread. Idempotent (§4.3). `ui`: **Resolve thread** (context `comment`). |
| `comment.reopen` | m | `{comment: CommentRef}` → `CommentOutput` of the thread's root. Idempotent. `ui`: **Reopen thread** (context `comment`). |
| `comment.list` | q | `{issue}` plus `listInput` (SPEC-003 §7.1) → connection of `CommentOutput`, ordered by `createdAt`, replies included with `parentId`. Soft-deleted comments appear with `deleted: true` and no body. |
| `reaction.set` | m | `{comment?: CommentRef, issue?: IssueRef, emoji, reacted: boolean}` → `{target, emoji, count, mine}`. Exactly one of `comment` and `issue` (else `INVALID_INPUT`: "React to a comment or to the issue, not both."). `reacted: true` adds the user's reaction, `false` removes it. Setting the state that already holds changes nothing (no write, no event). `ui`: **Add reaction…** (contexts `comment` and `issue`, opens the EmojiPicker). |

- `CommentOutput` = id, issue (id, identifier), parentId, author (id, name), actorKind, body as Markdown and as JSON, version, createdAt, editedAt, deleted, resolved (`{at, by}` or null; top-level comments), reactions (emoji, count, mine).
- `comment.create`, `comment.update`, `comment.delete`, `comment.resolve`, `comment.reopen` and `reaction.set` declare `contentParent` (the comment's or reaction's issue), so dispatch awaits that issue's hydration before the optimistic runs (SPEC-011 §5.3 step 6).
- `CommentRef` is a new reference type: a UUID only, resolved to a comment of a visible issue (§12).
- The operation inputs check shape and size only: `body` is an object or a string, at most 50 KB. `packages/operations` can't import the editor. The server handler converts Markdown with `markdownToDoc`, then validates with `validateDoc`.
- `reaction.set` replaces domain-model §7's `reaction.toggle` (D1). It writes `reaction.added` or `reaction.removed` events only when the state changes. The issue's own reactions are read from the replica; SPEC-011's `IssueOutput` gains `reactions` (emoji, count, mine; SPEC-011 §6.1).
- `comment.resolve` writes `comment.resolved` and `comment.reopen` writes `comment.reopened`, only on a change.
- All operations meet SPEC-003 §11 (summary, description, ≥ 2 keywords, examples against the seed fixture, permission, `destructive` on delete) and pass `pnpm registry:lint`. No operation name starts with a destructive verb except `comment.delete` (`resolve` and `reopen` are not). The seed fixture gains a comment thread with a reply, a resolved thread, and reactions on a comment and on an ENG issue.

### 6.2 Optimistic updates

Optimistic code runs in `packages/operations` and never parses or builds documents beyond `EMPTY_DOC` from domain. It uses the SPEC-003 §8 store, with the additions SPEC-011 §12 lists (`find` ordered by id). No operation here touches the issue row: comments and reactions don't move the issue's `updatedAt` (SPEC-011 §4.1), and none predicts an unarchive (D10).

- **Markdown bodies:** the web app always sends JSON. If `body` is a string, `optimistic` does nothing, and the comment appears when the server confirms it.
- `comment.create` inserts the Comment with `body`, `version` 1, and the issue's `teamId` (read from the store); its groups are `team:<teamId>`.
- `comment.update` patches `body`, `editedAt` and `version` + 1.
- `comment.delete` reads the replies with `store.find('Comment', {parentCommentId: id})`. With no replies, it removes the comment and its reactions (`store.find('Reaction', {commentId: id})`). With replies, it applies the soft-delete shape (`EMPTY_DOC`, `deletedAt`, `version` + 1) and removes the reactions. If the comment was the last reply of a soft-deleted parent, it removes the parent too.
- `reaction.set` inserts or removes the Reaction with id `reactionId(subject, user, emoji)`. Its subject is the comment, or the issue when `issue` is given.
- `comment.resolve` and `comment.reopen` patch `resolvedAt` and `resolvedById` on the thread's root.

### 6.3 Errors

| Case | Code | Message |
|---|---|---|
| Empty body | `INVALID_INPUT` | "Comment can't be empty." |
| Body over 50 KB | `INVALID_INPUT` | "Comment is too long. Split it into two, or attach a file." |
| Editing someone else's comment | `FORBIDDEN` | "Only the author can edit a comment." |
| Reply to a reply | `INVALID_INPUT` | "Replies go one level deep. Reply to the thread's first comment." |
| Reply to a deleted comment | `INVALID_INPUT` | "That comment was deleted. Comment on the issue instead." |
| Stale `baseVersion` | `CONFLICT` | "This comment changed since you started editing. Copy your text, then edit it again." |
| Not one emoji | `INVALID_INPUT` | "Use a single emoji, like 👍." |
| 21st distinct emoji | `INVALID_INPUT` | "You can add at most 20 different reactions here." |
| Both or neither of `comment` and `issue` on `reaction.set` | `INVALID_INPUT` | "React to a comment or to the issue, not both." |
| Bad link | `INVALID_INPUT` | "That link isn't allowed. Use an http, https or mailto link." |
| External or `data:` image (JSON body) | `INVALID_INPUT` | "Images must be uploaded files. Drop or paste the image instead of linking it." |
| File reference the author can't use | `INVALID_INPUT` | "A file in this text can't be used here. Upload it again." (SPEC-014 §4.3) |
| Archived issue | `CONFLICT` | "ENG-42 is archived. Restore it to edit it." (SPEC-015) |
| Deleted issue | `CONFLICT` | "ENG-42 was deleted. Restore it to edit it." (SPEC-015) |

## 7. UI

| Element | Notes |
|---|---|
| Activity timeline (issue page, SPEC-012) | history entries (SPEC-011) and top-level comments interleaved by time, oldest first. Comments are cards: avatar, author, "via API" or "via MCP" when so, relative time (absolute on hover), "edited", body (`DocView`), reaction chips, replies, reply box. A resolved thread is one collapsed line (§3.3a). |
| Comment box | At the end of the timeline. Placeholder "Leave a comment…". Attach button (SPEC-014), send button, `Enter` and `Mod+Enter`. An unsent draft per issue survives navigating away and shows on the user's other devices (a synced `Draft` row, SPEC-012). |
| Reply box | Per thread, collapsed to one line until focused or until **Reply** or `R`. Placeholder "Leave a reply…". |
| Issue reactions | Chips and **Add reaction** under the description. SPEC-012 places the row; this spec owns the components. |
| Comment link | `/issue/ENG-42#comment-<id>` scrolls to the comment and highlights it for 2 s. A link to a hard-deleted comment just opens the issue. |
| Editor | `RichTextEditor`, the same component for the description and comments (D21). Placeholder text. No toolbar: formatting is by Markdown, the slash menu, the keys of §3.5 and a bubble menu on selection. Created with `injectCSS: false`; its CSS is bundled with the app, because the CSP is `style-src 'self'`. |
| Command menu | Context `issue`: "Comment…". Context `comment` (a focused comment): "Edit comment", "Delete comment", "Add reaction…", "Resolve thread" or "Reopen thread", "Copy link to comment", "Copy content as Markdown", "New issue from comment…". Context `issue` also lists "Add reaction…" (command-menu §3.3 gains the context, §12). |

**Keyboard.** `Mod+Enter` submits (shortcuts §3.4) and, in comment mode, so does `Enter` (§3.5). The editor consumes `Mod+Enter` only inside a checklist item, where it toggles the item. Everywhere else it overrides the `Mod-Enter` handlers of TipTap's HardBreak extension and its core keymap (`exitCode`) to return false, so the event reaches the shortcut engine without `defaultPrevented` (the engine ignores prevented events, `apps/web/src/shortcuts/engine.ts:129-131`), in both editor modes (AC-19). A hard break is `Shift+Enter`. `Esc` leaves the editor (shortcuts §4). Comments are reached with `Tab` like any other control. A focused comment activates the `comment` scope, which SPEC-012 owns (§3.6): it defines the scope and its keys. Linear's panel has only two comment keys, so that is all Surface binds: reply (`R`) and, in a comment box, reply box or comment being edited, send or save (`Mod+Enter`; `Enter` in comment mode, §3.5). There are no keys for moving between comments, for edit, for delete, or for resolve and reopen: those run from the comment's options menu and the command menu (§3.3). `Ctrl+M` (comment on the issue) is the `issue-page` scope's.

**Screen readers.** Each comment is an `article` labelled "Comment by Ada, 3 hours ago". Reaction chips are as in §3.4. Light and dark themes; code highlighting uses theme tokens, not a remote stylesheet.

**No outbound requests** (rule 5). The emoji data and shortcodes are the pinned `emojibase-data` JSON, bundled and loaded lazily. The `emojibase` package (whose helpers fetch from a CDN) and `emoji-mart` are not used; an ESLint `no-restricted-imports` rule forbids them. Highlighting languages are bundled.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | A comment is written offline on a hydrated issue | Queued, shown with a pending marker, sent on reconnect. If rejected, it is removed and its text goes back into the comment draft, or the toast offers Copy text (§3.1). |
| E2 | Someone replies to a comment while its author deletes it | The thread lock orders them (§4.3). Delete first: the reply is refused and the client restores the reply text. Reply first: the delete becomes a soft delete. |
| E3 | The author edits the same comment in two tabs | The second save is `CONFLICT` (§4.3); its text stays in the editor with the message of §6.3. |
| E4 | Two people set the same emoji at once | Both rows exist (one per user); the count is 2. |
| E5 | The same user sets the same emoji from two tabs | Same id; the second `reaction.set` changes nothing. |
| E6 | A JSON body contains an unknown node, a `javascript:` link, or an external image (via the API) | `INVALID_INPUT` with the path of the problem. The web editor never produces these. |
| E7 | Markdown from MCP contains a table, HTML or an external image | Tables and HTML become plain-text paragraphs; the image becomes a link (§4.4). No error. |
| E8 | A comment's author is deactivated (M7) | The comment stays with their name; users are never purged (permissions §6). |
| E9 | A body names a file the author can't use (via the API) | `INVALID_INPUT` on `body` with SPEC-014's message, never `NOT_FOUND` on the file, so nothing leaks. |
| E10 | An issue whose comments are hydrated becomes invisible to the user (a private team change) | Its content goes with the issue (SPEC-002 resync on group change). The same holds when the issue leaves the replica for another reason (E27). |
| E11 | A file is pasted or dropped, or a pasted HTML image is a `data:` or `blob:` URI | Uploaded with `purpose=inline` (SPEC-014 §3), then inserted as an `image` node (raster images) or a `file` chip (anything else). It isn't an Attachment. If the upload fails, nothing is inserted and a toast says why. |
| E12 | `comment.list` on an issue with 1,000 comments | Paged (SPEC-003 §7.1). The web app reads the replica, not the list. |
| E13 | Two people delete the last two replies of a soft-deleted comment at once | The thread lock orders them; the second delete sees no replies left and hard-deletes the parent. |
| E14 | Two people add the 20th and 21st distinct emoji at once | The thread lock orders them; the later one is `INVALID_INPUT`. |
| E15 | A comment, edit, reply, resolve or reaction is sent on an archived issue | `CONFLICT` with the archived message (§4.3). The UI hides the controls, so this is the API, MCP or a race (an issue archived by the daily job while the page is open). The client rolls back and puts a comment's text back as in §3.1. |
| E16 | Two people resolve or reopen the same thread at once, or one resolves while another replies | The thread lock orders them. Resolve twice: the second changes nothing. A reply to a resolved thread is saved and the thread stays resolved (§3.3a). |
| E17 | A comment, edit or reaction reaches the server after the issue was deleted or archived (offline) | `CONFLICT` with the matching message (§6.3). The client rolls it back and puts a comment's text back as in §3.1. |
| E18 | A comment draft references inline files that were cleaned up (unclaimed for more than 24 hours, SPEC-014) | Saving is `INVALID_INPUT` with SPEC-014's message. The draft stays, and the editor marks each missing image "This image is no longer available. Remove it or upload it again." |
| E19 | Pasted HTML contains `<img src="https://…">` | It becomes a link to that URL with the alt text; the editor makes no request to it. |
| E20 | Offline, the user opens an issue whose content was never fetched | No comment box: "Comments are available when you're back online." (§3.1) |
| E21 | A comment is rejected after the user has started a new one, or after they left the page | The new text in the draft is kept; the toast offers **Copy text** for the rejected one. If there was no draft, the rejected text is saved as the draft (`draft.save`) and shows in the box on the next visit, on any device (§3.1). |
| E22 | A user edits a comment twice quickly while offline, and the first edit's body ends up identical to the stored one | Both edits raise `version`, on the server and in the optimistic, so the second edit's `baseVersion` matches and no spurious `CONFLICT` appears (§4.3). |
| E23 | The user presses `Enter` in a comment box during IME composition, with the slash menu open, or inside a list or code block | No send: composition and the menus take the key; in a list or code block `Enter` edits and `Mod+Enter` sends (§3.5). |
| E24 | The user presses `Mod+Enter` in a checklist item of a description or comment | It toggles the item. Outside a checklist item it submits or saves (§3.5). |
| E25 | The user reacts to an issue that is already at 20 distinct emoji | `INVALID_INPUT` with the cap message; the issue's own cap is separate from its comments' (§4.2). |
| E26 | A comment with a resolved thread is copied as Markdown | Only the comment's body is copied. Resolved state isn't part of it. |
| E27 | An issue with hydrated comments leaves the replica: reassigned away from a user who holds it only through `user:`, its on-demand team dropped, archived or deleted (SPEC-011 §5.7) | Its comments and reactions go with it, with its hydration mark (SPEC-011 §5.3). Reopening it fetches them again; an archived or deleted issue shows them read-only from the server (SPEC-015 §3.4). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), except private-team leak tests and the sync property suite. Held rows are marked ⏸.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `comment.create` stores a valid, non-empty body up to 50 KB. Replies attach only to live top-level comments of the same issue (INV-19). | unit |
| AC-2 | Only the author edits. Editing with a stale `baseVersion` is `CONFLICT`. Every update bumps `version`, even when the stored body comes out the same (§4.3). Members delete their own comments, Admins any. | unit |
| AC-3 | Deleting follows §4.3: hard without replies, soft with replies (body set to `EMPTY_DOC`, text cleared, reactions removed), the parent removed with its last reply. No foreign key cascades. | unit |
| AC-4 | `reaction.set` is idempotent, uses `reactionId`, accepts exactly one RGI emoji, caps distinct emoji at 20 per comment and per issue, takes exactly one of `comment` and `issue`, and writes an event only on a change. | unit |
| AC-5 | Concurrent replies, deletes, edits and reactions on one thread from several clients, in any interleaving, converge to the server's state and keep §4.3's rules (no orphan placeholder, no reply under a hard-deleted comment, at most 20 emoji). | property (sync suite with comment and reaction operations) |
| AC-6 | Every comment, resolve, reopen and reaction operation on an archived issue answers `CONFLICT` ("ENG-42 is archived. Restore it to edit it."), and on a deleted issue `CONFLICT` ("ENG-42 was deleted. Restore it to edit it."). Nothing unarchives the issue (§4.3). | unit |
| AC-7 | `validateDoc` accepts every document the schema can build (headings 1–4, underline included) and rejects unknown nodes and marks, bad link schemes (mixed case, control characters, relative and protocol-relative included) and external, `data:` or `blob:` images, with a path. | unit + property |
| AC-8 | `markdownToDoc(docToMarkdown(d))` equals `normalize(d)` for any valid document; `normalize` is idempotent; Markdown reaches a fixed point after one pass; `docToText` is deterministic. | property |
| AC-9 | The schema's nodes, marks and attributes equal §4.4's list, and the headless and web entries build the same schema. Changing the schema without bumping `DOC_SCHEMA_VERSION` fails the snapshot test. | unit |
| AC-10 | `@surface/editor/schema` imports and runs in a Node environment with no DOM globals. The boundary rules hold: the schema folder imports only what §4.4 allows, and `apps/server` imports only the schema entry. | unit (Node environment) + dependency-cruiser rules |
| AC-11 | Each mutation's `optimistic` produces the rows the server commits, apart from server fields, using no editor code; a Markdown body produces no optimistic row. | unit |
| AC-12 | Private-team leak: no comment or reaction of a private team's issue reaches a non-member through `/sync/content`, live deltas or `comment.list`; a `CommentRef` to one is `NOT_FOUND`, worded as for a missing one; an API key limited to other teams gets the same answer. | integration (leak test, not held) |
| AC-13 | Every operation passes `pnpm registry:lint`; examples run against the seed fixture. | unit |
| AC-14 | Paste: clipboard HTML is parsed without loading resources; `data:` and `blob:` images become inline uploads; external images become links; disallowed links lose their link. `DocView` applies the same rules to stored documents. | unit (jsdom) |
| AC-15 | Every emoji in the pinned `emojibase-data` version passes the server's emoji check in Node. | unit |
| AC-16 | No request leaves the origin: rendering the editor, `DocView` and the EmojiPicker in jsdom, with `fetch`, `XMLHttpRequest`, image loads and new `link` and `script` elements instrumented, makes no request to another origin. ESLint forbids `emojibase` and `emoji-mart`. | unit |
| AC-17 | Keyboard only: write a comment with a heading, a list and a code block, submit with `Mod+Enter`, reply, react, resolve and reopen the thread, edit and delete it. Screen-reader names as §3.4 and §7. | e2e ⏸ (checked by hand) + axe in Storybook for the comment card, reaction chip and editor |
| AC-18 | A comment posted in one tab appears in another tab that has the issue open in < 150 ms p95 (NFR-02). | e2e perf ⏸ (checked by hand) |
| AC-19 | In both editor modes, outside a checklist item, `Mod+Enter` reaches the shortcut engine with `defaultPrevented` false, and `Shift+Enter` inserts a hard break. In a reply box, `Mod+Enter` and `Enter` send the reply; in an edited comment they save. | unit (jsdom, editor + engine) |
| AC-20 | Comment drafts are synced `Draft` rows (SPEC-012): sending discards the draft; a rejection saves the rejected text as the draft when there is none, or keeps the newer draft and offers Copy text (E21). Two queued offline edits never produce a spurious `CONFLICT` (E22). | unit (fake server, in-memory store) |
| AC-21 | `comment.resolve` and `comment.reopen` set and clear `resolvedAt` and `resolvedById` on the thread's root only; a reply ref resolves its root; both are idempotent (no write, no event on no change), leave `version` alone, work on a placeholder root, and write `comment.resolved` and `comment.reopened`. Any member who can see the issue may call them. | unit |
| AC-22 | A reaction on the issue uses `reactionId(issueId, user, emoji)` with an empty `commentId`, appears in the issue's chips, and is counted against its own cap of 20. Resolve and issue reactions are included in the sync property suite (AC-5). | unit + property |
| AC-23 | Editor keys and input rules of §3.5: each key in the table produces the block or mark named; each input rule fires; `Enter` twice exits a code block or quote; `:name:` inserts the emoji; a bare URL pasted over a selection makes a link only if it passes the link rule. | unit (jsdom) |
| AC-24 | In comment mode `Enter` sends and `Shift+Enter` inserts a hard break; `Enter` does not send during IME composition, with a menu open, or in a list or code block; `Mod+Enter` toggles a checklist item and otherwise reaches the shortcut engine (E23, E24). In description mode `Enter` is a new line. | unit (jsdom, editor + engine) |
| AC-25 | The underline mark is valid, `docToMarkdown` drops it, and `normalize` removes it, so the round trip of AC-8 holds for documents with underline. | property |

## 10. Metrics & performance

- `comment.create` and `reaction.set` p95 < 50 ms on the server.
- Typing latency in the editor < 16 ms per keystroke on a 5,000-word description.
- Opening a hydrated issue with 200 comments renders in < 100 ms (NFR-01). Read-only comments use `DocView`, not TipTap; comment cards aren't virtualized below 500 comments.
- The editor and the emoji data are separate lazy chunks: the issue list loads neither. `DocView` is small and loads with the issue page. Emoji data ≤ 150 KB gzipped.
- Log events: none new.

## 11. Open questions

None. The proposed defaults were accepted at the M1 gate on 2026-11-12 and moved to the Decisions table (D13–D25).

### Decisions

| # | Decision | Date |
|---|---|---|
| D1 | Reactions use one idempotent `reaction.set {comment, emoji, reacted}` with an id derived from (comment, user, emoji) on both sides. It replaces `reaction.toggle` (a replayed toggle can flip the wrong way) and `reaction.add`/`remove` (`remove` is a destructive verb under SPEC-003 §11 rule 5, which would hide it from API keys). Was Q5. | 2026-11-12 |
| D2 | Comment and description search text live in server-only tables (`comment_search_text`, `issue_search_text`), not synced columns. Optimistic code never parses documents; `EMPTY_DOC`, `DOC_SCHEMA_VERSION` and `reactionId` live in `packages/domain`. | 2026-11-12 |
| D3 | Comment edits use conflict detection (`baseVersion`, `CONFLICT`), as NFR-07 requires for rich text. | 2026-11-12 |
| D4 | Copy Linear: the editor's keys and Markdown input rules are Linear's panel (§3.5): underline `Mod+U` is added (Linear has it), headings go to 4, `Enter` sends a comment and `Shift+Enter` breaks the line, `Mod+Enter` toggles a checklist item and otherwise submits. `Mod+K` with a selection adds or edits a link; without one it opens the command menu (shortcuts §3.7 and SPEC-005 E1 stand). Reverses the earlier "no underline" and "`Mod+Enter` is never consumed" decisions. | 2026-11-12 |
| D5 | Every comment and reaction write locks the issue row, then the thread's top-level comment. Foreign keys are `ON DELETE RESTRICT`; all deletes go through the repo. | 2026-11-12 |
| D6 | Schema versioning (was Q11): `DOC_SCHEMA_VERSION` in domain feeds `schemaHash`; a schema change ships a data migration in the same release; the server accepts only the current schema. | 2026-11-12 |
| D7 | Copy Linear: threads can be resolved and reopened from the comment menu, and a resolved thread collapses to one line with "Resolved". Comments get a **Reply** hover button and Linear's menu (Copy link, Copy content as Markdown, New issue from comment…, Resolve thread). Two ops, `comment.resolve` and `comment.reopen`, with `resolvedAt` and `resolvedById` on the root. Anyone who can see the issue may resolve. Reverses Q1. | 2026-11-12 |
| D8 | Copy Linear: the issue itself takes reactions, under its description. `Reaction.commentId` is nullable; `reaction.set` takes `comment` or `issue`. Custom emoji: later. Reverses Q2. | 2026-11-12 |
| D9 | Linear embeds YouTube, Loom and Figma links on paste and unfurls links; not copied, because each makes a request to a third party (rule 5). Pasted URLs stay plain links. | 2026-11-12 |
| D10 | Copy Linear: an archived issue is read-only. Every comment, reply, resolve and reaction on it is `CONFLICT` ("ENG-42 is archived. Restore it to edit it."); a deleted issue is the same with "was deleted". No comment unarchives an issue, so the extra history entry for it, the optimistic code's predicted unarchive and the extra lock mode that comment writes once had are gone. Replaces the unarchive-on-comment rule. | 2026-11-12 |
| D11 | Copy Linear: comment drafts are synced `Draft` rows owned by SPEC-012, so an unsent comment follows the user across devices. The draft is one text, with no separate field for sent text: sending discards the draft, and a rejection puts the text back into an empty draft, else offers Copy text (§3.1). | 2026-11-12 |
| D12 | Partial issue loading (SPEC-011 §5.7, ADR-0020): Comment and Reaction rows are in `team:<teamId>` only, never in the issue's `user:` groups. Opening an issue subscribes its team, so open issues stay live; an issue leaving the replica takes its comments with it (E27). | 2026-11-12 |
| D13 (was Q3) | Comments keep no edit history: "edited" with the time only, like description history (FR-ISS-14, v2). Earlier bodies stay in `sync_log` for 30 days but are never shown (§4.3). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D14 (was Q4) | Size limits: comment body 50 KB of JSON; description 200 KB (SPEC-011 Q9). No limit on the number of comments. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D15 (was Q6) | At most 20 distinct emoji per subject (comment or issue). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D16 (was Q7) | Comments show "via API" or "via MCP" from a stored `actorKind`, so readers know when an AI client or a script wrote one. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D17 (was Q8) | A deleted comment's text: the row goes at once; copies stay in `sync_log` for its 30-day retention and in backups; inline files stay until the issue is purged (§4.3). Scrubbing `sync_log` would need data-less log rows, a protocol change; revisit only if someone needs it. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D18 (was Q9) | External image URLs are not allowed in descriptions and comments. Loading them makes every reader's browser call a third party (the spirit of rule 5), and the CSP blocks them anyway. Images are uploaded files. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D19 (was Q10) | Code highlighting covers a bundled set of about 20 languages: bash, c, cpp, csharp, css, diff, go, html/xml, java, javascript, json, kotlin, markdown, php, python, ruby, rust, sql, swift, typescript, yaml. Others render as plain code. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D20 (was Q12) | The API and MCP take a body as JSON or Markdown on write and return both on read (as SPEC-011 Q12). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D21 (was Q13) | One editor component serves descriptions and comments, with two modes. `comment` submits on `Enter` or `Mod+Enter` and has the send button (§3.5). `description` saves on blur and after 2 s idle, with `baseVersion` (SPEC-011). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D22 (was Q14) | Emoji data is a pinned `emojibase-data` (English, compact) bundled into the web build and loaded lazily, rendered with the system emoji font. No sprites, no CDN, no remote font. The server needs no data: it checks with `\p{RGI_Emoji}` (§4.4). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D23 (was Q15) | New dependencies: `@tiptap/core`, `@tiptap/pm` (including `@tiptap/pm/markdown`), `@tiptap/react`, `@tiptap/starter-kit` (unlisted extensions disabled), the task-list, link, image, placeholder and code-block-lowlight extensions, `lowlight`, `markdown-it` (already a dependency of prosemirror-markdown) and `emojibase-data`. Each is justified in the plan slice that adds it; TipTap is ADR-0009's decision. Accepted as proposed at the M1 gate. | 2026-11-12 |
| D24 (was Q16) | Comments, resolves and reactions write no IssueHistory entries. The timeline shows the comment itself; a history entry would duplicate it. events.md's H column for `comment.created` becomes "—" (§12). Accepted as proposed at the M1 gate. | 2026-11-12 |
| D25 (was Q17) | Where Linear's behaviour isn't observable without changing data, the proposal is kept: Admins may delete anyone's comment; `Enter` in lists and code blocks of a comment keeps its editing meaning (§3.5); a reply doesn't reopen a resolved thread. Accepted as proposed at the M1 gate. | 2026-11-12 |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Change | Superseding ADR? |
|---|---|---|---|
| domain-model | §4.8 Comment | Add `teamId`, `actorKind`, `version`, `resolvedAt`, `resolvedById` (top-level comments only); `bodyText` is a server-only column. The `system` actor kind is deferred. | No |
| domain-model | §4.8 Reaction | Add `issueId`, `teamId`; `commentId` is optional (empty: a reaction on the issue); id derived from (comment or issue, user, emoji). | No |
| domain-model | §4.8, §7 | Replace `reaction.toggle` with `reaction.set`; `comment.update` takes `baseVersion`; add `comment.resolve` and `comment.reopen`. | No |
| domain-model | §6 invariants | New invariants, from §4.5: only a top-level comment is resolved, with `resolvedAt` and `resolvedById` set together (INV-23); reactions are unique per (subject, user, emoji), where the subject is a comment or the issue; every child row of an issue (IssueContent, IssueHistory, Comment, Reaction, Attachment) carries its issue's `teamId` (SPEC-011 D4, shared with SPEC-014); a reply's `issueId` equals its parent comment's, and a comment reaction's `issueId` equals its comment's. INV-19 (one level of replies) stands. | No |
| permissions | §3.3 | Resolve or reopen a thread: any member or Admin who can see the issue. Reactions on the issue: any member or Admin who can see it. | No |
| PRD | FR-COL-01, FR-COL-02 | Add resolvable threads and reactions on the issue (Linear parity). | No |
| design-system | §5.3 | EmojiPicker is also used for issue reactions; the editor gains the `:name:` emoji autocomplete. | No |
| events | lines 42–44 | `comment.created` History column becomes "—". New rows `comment.resolved` and `comment.reopened`, written by `comment.resolve` and `comment.reopen` on a change. Like the other comment events they notify no one (N "—"; Linear sends no notification on resolve) and reach webhooks (W ✓, M6). `reaction.added`/`removed` are written by `reaction.set` when the state changes, and their payload names the issue and the comment, if any. Payloads carry ids and the actor, never the body. | No |
| SPEC-003 | §4 | New `CommentRef`: a UUID, resolved to a comment of a visible issue; `NOT_FOUND` otherwise. | No |
| SPEC-003 | §8 | Relies on `store.find` ordered by id, as listed in SPEC-011 §12. | No |
| shortcuts | §2 | New `comment` scope (component), owned and specified by SPEC-012. | No |
| shortcuts | §3.4, §3.7 | Editor keys become Linear's (§3.5): `Mod+U` stays (underline exists), add `Mod+Shift+X`, `Alt+Shift+.`, `Mod+Alt+0`…`4`, `Mod+Shift+7`/`8`/`9`, `Mod+Shift+\`, `Mod+Shift+U`, `Alt+↑/↓`. `Enter` sends a comment, `Shift+Enter` breaks the line; `Mod+Enter` toggles a checklist item. The `Mod+K` text stays. (Same table as SPEC-012 §12.) | No |
| command-menu | §3.3 | New context `comment` (a focused comment) with Edit, Delete, Add reaction, Resolve or Reopen thread, Copy link, Copy as Markdown, New issue from comment. Context `issue` gains Add reaction. | No |
| SPEC-003 | §3.1 `ui.contexts` | Add `comment` to `UI_CONTEXTS` (`packages/operations/src/ui.ts:5`; with SPEC-014's `attachment`). Comment-context entries give `refs` (`{ comment }`), as `checkOperationCommands` requires. | No |
| SPEC-003 | §3 | Comment and reaction operations declare `contentParent` (SPEC-011 §12 adds the field). | No |
| SPEC-005 | §4.1 command target | Add the target kind `comment` (`{ kind, ids, label }`), set by a focused comment. | No |
| sync-protocol | §8 | The schema hash input gains `DOC_SCHEMA_VERSION` (with SPEC-011's `parent` declarations). | No |
| architecture | rule 2 | Exception for D6: a schema data migration rewrites stored documents in synced tables (`issue_content`, `comments`) in a migration, not through the repo, so it logs no `sync_log` rows. It is safe only because the same release changes `schemaHash` and every client resyncs. State this exception in architecture.md. | **Yes**: [ADR-0023](../04-architecture/adr/0023-document-migration-unlogged.md), because it is a stated exception to an architecture rule |
| sync-protocol | §2, §4.2 | Comment and Reaction are content models with parent `Issue`, in `/sync/content` frames (with SPEC-011's §4.2 change). | No |
| `.dependency-cruiser.cjs` | rules | Add `editor-schema-headless` and `server-editor-schema-only` (§4.4). Not a doc, but a boundary change reviewers should see. | No |
| ADR-0009 | — | No change: TipTap stands; this spec adds the headless schema entry within it. | No |
