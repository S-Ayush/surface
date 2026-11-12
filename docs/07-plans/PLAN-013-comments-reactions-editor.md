# PLAN-013: Comments, reactions & rich editor

Implements: [SPEC-013](../06-specs/SPEC-013-comments-reactions-editor.md) · Status: **Ready** (M1 acceptance gate, 2026-11-12) · Order: **S1 and S2 start at once (M0 only); S3 after PLAN-011 S5; S4 after S3; S5 last** · Depends on: PLAN-011 S5 (content machinery, `lockIssueForWrite` from S3, `contentParent`; partial loading from S4b/S4c, which S5 follows) for S3; PLAN-012 S4 (issue page) for S5; PLAN-012 S5 (`Draft` model, `draft.*`); PLAN-011 S6 (the `claimInlineFiles` seam; S3 creates it if S6 has not merged) and PLAN-014 S4b/S5 (the real claim, upload) for the parts named in S3 and S5; PLAN-015 S2 (the purge-step registry; S3 creates it if S2 has not merged)

> **Foundations this plan owns:** `packages/editor`, the `@surface/editor/schema` export and its server build, and `EMPTY_DOC`, `DOC_SCHEMA_VERSION` and `reactionId` in `packages/domain`. PLAN-011 S6 (`issue.updateDescription`, `issue_search_text`) needs S1. PLAN-012 S4 (description editor) needs S2.
>
> **Foundations this plan uses and does not build:** `contentParent` and `lockIssueForWrite` (PLAN-011 S1, S3), content models and `/sync/content` (PLAN-011 S5), the `comment` shortcut scope, the `Draft` model and `draft.*` (PLAN-012 S1, S5), inline file claiming (seam: PLAN-011 S6; body: PLAN-014 S4b), the purge-step registry (PLAN-015 S2).

---

## 1. Slices

Sizes: S ≤ 1 day, M 2–3, L 4–5. Estimated total: about **17 ideal days** (S1 4.5 + S2 4.5 + S3 4 + S4 2.5 + S5 2.5; small rounding).

### S1: Editor schema, domain constants, Markdown & server build · L · ✅ Done 2026-11-12
Branch `p013-s1-editor-schema`. Starts at once. No UI and no operations.

- **Domain (`packages/domain/src/`):** new `doc.ts` with `EMPTY_DOC` (one empty paragraph, frozen), `DOC_SCHEMA_VERSION = 1`, `DOC_MAX_BYTES` (50 KB comment, 200 KB description, SPEC-013 D14) and `reactionId(subjectId, userId, emoji)` (UUIDv5-style hash, same output on client and server; no Node-only API, so it runs in the browser). Exported from `index.ts`. `computeSchemaHash` input gains `DOC_SCHEMA_VERSION` (sync-protocol §8; the function lives in `packages/sync-protocol` or `domain`, check where on build). This changes the hash once; no model changes.
- **Package layout (`packages/editor`, new files):** `src/schema/index.ts` (headless entry), `src/schema/extensions.ts` (the explicit extension list), `src/schema/validate.ts`, `normalize.ts`, `text.ts`, `markdown.ts`, `links.ts`, `files.ts` (`docFileIds`), `src/index.ts` stays the React entry (filled in S2). `src/index.ts` keeps `EDITOR_PACKAGE` until S2 so existing tests pass.
- **Schema:** nodes `doc, paragraph, heading(1–4), bulletList, orderedList, listItem, taskList, taskItem(checked), blockquote, codeBlock(language), horizontalRule, hardBreak, image(src, alt), file(src, name)`; marks `bold, italic, underline, strike, code, link(href)`. Built with `getSchema` from an explicit list; every StarterKit extension not named is disabled, and StarterKit's own Link is replaced by the link rule. `code` excludes all other marks.
- **`validateDoc(json)`:** returns the doc or a list of problems with JSON paths. Checks: schema shape via `Node.fromJSON` + `check()`; link rule (`new URL`, `http:`/`https:`/`mailto:`, no relative or `//host`, no control characters); `src` exactly `/files/<uuid>`; at most 50 file references; size limits are the caller's (`DOC_MAX_BYTES`). Error messages are the SPEC-013 §6.3 sentences.
- **`normalize`, `docToText`, `docFileIds`:** as SPEC-013 §4.4 (underline removed, equal-mark text merged, empty-paragraph runs collapsed, edge empties removed, trailing hard break removed, hard break in a heading becomes a space, text blocks trimmed, adjacent same-kind lists merged; text extraction joins blocks with newlines, images as `alt`, files as name).
- **Markdown (`markdown.ts`):** `docToMarkdown` and `markdownToDoc` on `@tiptap/pm/markdown` (prosemirror-markdown) with `markdown-it`. A small markdown-it rule for GFM task lists. Image ↔ `![alt](/files/<uuid>)`; file chip ↔ `[name](/files/<uuid>)`; other image targets become a link with the alt text; tables and raw HTML become plain-text paragraphs; fence longer than any backtick run inside; escaping of text that reads as syntax; underline dropped.
- **Packaging:** `packages/editor/package.json` gets `exports["./schema"]` with `@surface/source`, `types` and `default` conditions, `"files": ["dist"]`, a `build` script (`tsc -p tsconfig.build.json`; the new `tsconfig.build.json` includes only `src/schema/**`), and `dependencies` `@tiptap/core`, `@tiptap/pm`, `markdown-it` (+ `@types/markdown-it` dev). The `"."` export stays source-only. `apps/server/package.json` adds `"@surface/editor": "workspace:*"`. Check the server Dockerfile/deploy step ships `packages/editor/dist` (PLAN-004 S5 `pnpm deploy --prod`).
- **Boundary rules (`.dependency-cruiser.cjs`):** add `editor-schema-headless` (files under `packages/editor/src/schema/` may import only that folder, `packages/domain/`, `@tiptap/core`, `@tiptap/pm`, `markdown-it`; written as a `from`/`to` pair that matches npm package names via `dependencyTypes`) and `server-editor-schema-only` (`apps/server/` may import `packages/editor/src/schema/` only). Update the comment header of the file. The existing `ui-and-editor-only-domain` and `operations-only-domain` rules already cover the rest. A `test/` fixture (a throwaway file that breaks each rule) is not needed: the S1 test runs dependency-cruiser's API against two in-memory violations.
- **New dependencies (justify in the PR, SPEC-013 D23):** `@tiptap/core`, `@tiptap/pm`, `markdown-it`. TipTap is ADR-0009's decision. `markdown-it` is already a dependency of prosemirror-markdown.
- **Nothing else changes:** no operation, migration or server code uses the schema yet (PLAN-011 S6 and S3 here do).
- **Tests:**
  - `packages/editor/test/schema-shape.test.ts`: node, mark and attribute names equal the §4.4 list; StarterKit extras are disabled; snapshot pairing `DOC_SCHEMA_VERSION` with a hash of the schema spec (AC-9).
  - `packages/editor/test/validate.test.ts` and `validate.prop.test.ts`: accepts every document the arbitrary builds (headings 1–4, underline); rejects unknown nodes and marks, bad links (mixed case, control characters, relative, `//host`), `data:`/`blob:`/external images, with a path (AC-7, E6).
  - `packages/editor/test/markdown.prop.test.ts`: `markdownToDoc(docToMarkdown(d))` equals `normalize(d)`; `normalize` idempotent; Markdown fixed point after one pass; `docToText` deterministic (AC-8, AC-25, E7). Plus example tests for fences, escaping, files and images, tables and HTML.
  - `packages/editor/test/schema-node-env.test.ts` (Vitest `environment: node`, no DOM globals): the entry imports and runs (AC-10). `packages/editor/test/boundaries.test.ts`: dependency-cruiser API on the real tree passes and on two synthetic violations fails (AC-10).
  - `packages/domain/src/doc.test.ts`: `EMPTY_DOC` valid shape, `reactionId` deterministic and distinct per input, schema hash changes with `DOC_SCHEMA_VERSION`.
  - `pnpm -r build` builds the schema entry before the server. `pnpm check` green.

> **As built:** `@tiptap/core` and `@tiptap/pm` 3.32.2, `markdown-it` 15.0.3 (pinned exactly; ships its own types, so no `@types/markdown-it`), one `prosemirror-model` (1.25.13, through `@tiptap/pm`). Dev: `fast-check`, `dependency-cruiser` (for `boundaries.test.ts`), `@types/node`. `@surface/domain` became a dependency of `editor` and `sync-protocol`. 97 editor tests; `pnpm check` green.
> - **No `@tiptap/pm/markdown` (deviation, SPEC-013 D26).** TipTap 3 dropped it (present in 3.20, gone by 3.26), so Markdown is our own writer and reader over `markdown-it` and the document JSON (`markdown.ts`, `inline.ts`). SPEC-013 §4.4 is updated. The round-trip property found that `normalize` needs more rules than the plan listed; they are in the `normalize.ts` docblock and SPEC-013 §4.4 (newlines and NUL in text, whitespace around hard breaks, no marks on hard breaks and file chips, emphasis CommonMark's flanking rules can't write is narrowed by a character, empty alt is null, a list item starts with a paragraph). Writing choices: empty paragraph `&nbsp;`, thematic break `___`, bullets switch `-`/`*` next to another list, nested markers never form `- - -`.
> - **No StarterKit in the schema entry.** `extensions.ts` defines the 21 extensions with `Node.create`/`Mark.create` from `@tiptap/core` (attributes exactly the spec list: `orderedList` has no `start`, `link` only `href`, `image` `src` and `alt`). The schema-shape test checks the schema is built only from that list instead of "StarterKit extras disabled". **S2:** `extensions.web.ts` must `.extend()` `SCHEMA_EXTENSIONS` (same names and attributes; lowlight `codeBlock` included) so the web schema equals the headless one, and `isSingleEmoji` is still to add to the schema entry.
> - **Domain:** `doc.ts` has `DocNodeJSON`/`DocMarkJSON`, `EMPTY_DOC`, `DOC_SCHEMA_VERSION = 1`, `DOC_MAX_BYTES` (`comment` 51 200, `description` 204 800; KB = 1024) and `docJsonBytes`; `reactionId` is UUIDv5 (own `sha1.ts`, no Node API) of `subject:user:emoji` with ids lowercased. The schema-hash test lives in `packages/sync-protocol/test/schema-hash.test.ts` (where `computeSchemaHash` is): its input is now `[SYNC_PROTOCOL_VERSION, DOC_SCHEMA_VERSION, models]`, and the pinned hash changed once.
> - **For PLAN-011 S6 and S3:** use `validateDoc` (problems carry paths and the SPEC-013 §6.3 messages, `DOC_MESSAGES`), `docJsonBytes` with `DOC_MAX_BYTES`, `docToText`, `markdownToDoc`/`docToMarkdown` and `docFileIds` from `@surface/editor/schema`. `normalize` throws on an invalid document, so validate first.
> - **Build:** `pnpm --filter @surface/server deploy --legacy --prod` ships `packages/editor/dist`; the Dockerfile's `build` stage was built by hand and `@surface/editor/schema` loaded in it under plain Node. `schema-node-env.test.ts` also loads the built `dist` in a child `node` process.
> - **Tests not in the list above:** `markdown.test.ts` (examples, E7), `normalize.test.ts`, `text.test.ts`. The property describes have a 60 s timeout: the 1 000-run round trip takes longer than Vitest's 5 s default when the whole gate runs in parallel.

### S2: Editor component, DocView & emoji data · L
Branch `p013-s2-editor-component`. Starts at once (needs S1 merged; can overlap on a stack).

- **Where:** `packages/editor/src/` (new): `RichTextEditor.tsx`, `extensions.web.ts` (the S1 list plus lowlight `codeBlock` under the same node name and attributes), `keymap.ts`, `inputRules.ts`, `paste.ts`, `slashMenu.tsx`, `bubbleMenu.tsx`, `emoji/autocomplete.ts`, `emoji/data.ts` (lazy `import()` of `emojibase-data`), `DocView.tsx`, `editor.css` (bundled, `injectCSS: false`, theme tokens for highlighting), `index.ts` exports. `apps/web` only consumes it from S5 and PLAN-012 S4; this slice adds Storybook stories (`packages/editor/stories`, check where `packages/ui/src/stories` keeps theirs and follow that).
- **`RichTextEditor` props:** `mode: 'comment' | 'description'`, `value` (JSON), `onChange`, `onSubmit` (comment mode `Enter`/`Mod+Enter`, and description `Mod+Enter` is not consumed), `onBlur`, `placeholder`, `readOnly`, `checklistEditable`, `onUploadFile(file) → {src, name, kind}` (injected by the host; the real upload is PLAN-014, so this slice ships with a stub that rejects with a toast message), `autofocus`.
- **Keys and rules (§3.5):** every key in the table (`Mod+B/I/U/E`, `Mod+Shift+X`, `Mod+K` with selection adds or edits a link and without one is not consumed so the command menu opens, `Alt+Shift+.`, `Mod+Alt+0–4`, `Mod+Shift+7/8/9` matched on `Digit7–9`, `Mod+Shift+\`, `Mod+Shift+U` (not an editor binding: the `issue-page` "Attach file" binding, PLAN-014 S5, asks the focused editor to open its `onUploadFile` chooser and insert inline; SPEC-012 §3.6), `Alt+↑/↓` move block, undo/redo). Markdown input rules (headings 1–4, lists, checklist `[]`/`[ ]`, `>`, fences with language, `***`/`---`, bold, italic, strike, code). `Enter` twice leaves a code block or quote.
- **Enter and `Mod+Enter` (§4.4 Keyboard):** comment mode `Enter` submits except during IME composition, with slash menu or emoji list open, or inside list, checklist, quote or code block (there `Mod+Enter` submits). `Shift+Enter` is a hard break. `Mod+Enter` is consumed only in a checklist item (toggle); everywhere else the editor overrides the `Mod-Enter` handlers of TipTap's HardBreak and the core keymap (`exitCode`) to return false so `defaultPrevented` stays false and the shortcut engine (`apps/web/src/shortcuts/engine.ts`) sees it.
- **Slash menu** (blocks plus Image and File via `onUploadFile`), **emoji autocomplete** (`:` plus two letters, `Enter`/`Tab` inserts plain text, no emoji node), **bubble menu** on selection.
- **Paste (`paste.ts`):** clipboard HTML parsed with `DOMParser` in a detached document, converted with the schema's parse rules; unknown content becomes text; links kept only if they pass the link rule; bare URL over a selection makes a link; `data:`/`blob:` images call `onUploadFile` and are inserted when it finishes; external images become a link with the alt text; embed URLs stay plain links (D9, E19).
- **`DocView`:** React elements straight from the JSON, same link and image rules as `validateDoc`, never mounts TipTap, checkbox rendering with an `onToggle` callback (author rule is the host's). Image `src` renders only `/files/<uuid>`; a missing file shows "This image is no longer available. Remove it or upload it again." (E18, host passes the missing set).
- **Emoji data:** `emojibase-data` pinned in `packages/editor/package.json` (English compact + shortcodes), bundled as a separate lazy chunk (≤ 150 KB gzipped, check in the build). `emoji/valid.ts` exports `isSingleEmoji` (`/^\p{RGI_Emoji}$/v`); the server uses the same regex in S4 (put the function in `@surface/editor/schema` as `isSingleEmoji`, so one definition serves both; a pure regex, still headless).
- **ESLint:** `no-restricted-imports` for `emojibase` and `emoji-mart` in `packages/config/eslint.js` (a config change reviewers should see). Check that `injectCSS: false` is set so the CSP `style-src 'self'` holds.
- **New dependencies (justify in the PR):** `@tiptap/react`, `@tiptap/starter-kit`, task-list/task-item, link, image, placeholder, code-block-lowlight extensions, `lowlight`, `emojibase-data`, `@tiptap/suggestion` if the autocomplete uses it. React and `@tiptap/*` as `dependencies` of the editor; React as a peer.
- **Stub until later:** the file upload (PLAN-014 S5) and the missing-file marker data. The emoji picker is not here (S4).
- **Tests (jsdom; add `jsdom` environment per file or vitest workspace config):**
  - `test/keys.test.tsx`: each key makes the block or mark named; each input rule fires; `Enter` twice exits; `:name:` inserts; bare URL paste rule (AC-23, AC-9 second half: the web schema equals the headless schema, same node and mark names, attributes and `DOC_SCHEMA_VERSION` hash).
  - `test/enter-modes.test.tsx` with the real shortcut engine from `apps/web/src/shortcuts/engine.ts` imported through a test-only harness in `apps/web` (if the boundary rules forbid editor → web, put this test in `apps/web/src/editor-keys.test.tsx`): `Mod+Enter` reaches the engine with `defaultPrevented` false in both modes outside a checklist, toggles in a checklist; comment `Enter` sends, no send during composition, with a menu open or in a list/code block; `Shift+Enter` breaks (AC-19, AC-24, E23, E24).
  - `test/paste.test.tsx`: HTML parsed without loading resources, `data:`/`blob:` upload hook called, external image becomes a link, disallowed links lose the link, embeds stay links (AC-14, E19).
  - `test/doc-view.test.tsx`: `DocView` applies the same rules as `validateDoc` (shared fixtures with S1), never mounts TipTap (AC-14).
  - `test/no-network.test.tsx`: render the editor and `DocView` with `fetch`, `XMLHttpRequest`, image loads and new `link`/`script` elements instrumented; no cross-origin request (AC-16, first half). The emoji picker is in `packages/ui`, which `packages/editor` may not import (`ui-and-editor-only-domain` in `.dependency-cruiser.cjs`, tests included), so its check is S4's, in `packages/ui`.
  - `test/emoji.test.ts`: every emoji in the pinned data passes `isSingleEmoji` in Node (AC-15).
  - Storybook stories for the editor and `DocView`, with the axe check (AC-17 axe half).

### S3: Comment model, operations & locking · L
Branch `p013-s3-comments`. **Needs PLAN-011 S5** (content models, `parent`, `contentParent`; `lockIssueForWrite` and `teamId`/groups derived from the issue row come from PLAN-011 S3). Needs S1 (validate, `markdownToDoc`, `docToText`).

- **Migration (next migration number):** `comments`, `comment_search_text` (server-only, `comment_id` PK, `ON DELETE CASCADE`) and `reactions` (created here so S4 adds no migration; table only, no operations until S4). Columns per SPEC-013 §4.1, §4.2, §4.6; `sync_groups` with GIN indexes; foreign keys `ON DELETE RESTRICT` to `issues`, `comments`, `teams`, `users` (also `resolved_by_id`); indexes `comments (issue_id, created_at)`, `comments (parent_comment_id)`, `reactions (comment_id)`, `reactions (issue_id)`; `timestamptz(3)`; CHECKs: `parent` of a reply is top-level is enforced in the handler (a trigger is not used), `resolved_at` and `resolved_by_id` null together, a reply has no `resolved_at`, `actor_kind` in (`user`,`api`,`mcp`). Schema in `apps/server/src/db/schema/comments.ts` (new) and listed in `apps/server/src/db/README.md` (synced vs server-only).
- **Models (`packages/domain/src/model/comment-models.ts`, new):** `Comment` and `Reaction` through `defineModel` with `parent: Issue via issueId`, `teamColumn: teamId`, load `content`. Added to `PRODUCTION_MODELS`, the server `SYNCED_MODELS` (`apps/server/src/sync/models.ts`) with `groupsOf` = `team:<teamId>` only, `teamId` read from the locked issue row (PLAN-011 S3's `groupsOfIssueChild`; never the issue's `user:` groups, SPEC-011 §5.7), and `SYNCED_TABLES` in `packages/config/eslint.js`. Invariant helpers (INV-19, resolved fields set together, `issueId` and `teamId` equalities) in `packages/domain/src/comment.ts` with their unit tests.
- **Operations (`packages/operations/src/ops/comment.ts`, new; handlers `apps/server/src/handlers/comments/`):** `comment.create`, `comment.update`, `comment.delete` (destructive), `comment.resolve`, `comment.reopen`, `comment.list` (query, `listInput`, SQL `team_id` filter for key `teamIds`). `CommentRef` in `packages/operations/src/refs` (check where `IssueRef` lives after PLAN-011 S4; a UUID resolved to a comment of a visible issue, `NOT_FOUND` otherwise). Add `comment` to `UI_CONTEXTS` (`packages/operations/src/ui.ts`) with `refs: { comment }` on the comment-context entries; the **Comment…** entry is context `issue`. Declare `contentParent` on all of them. Operation inputs check shape and size only (body is an object or a string ≤ 50 KB); the handler runs `markdownToDoc` then `validateDoc`.
- **Handler order (§4.3):** `lockIssueForWrite(tx, issueId, ctx, 'edit')` (archived and deleted issues give `CONFLICT`), then lock the thread root `FOR UPDATE`, re-read replies and reactions, write through the repo. `comment_search_text` is written by plain SQL in the same transaction (server-only). Delete deletes reactions and replies through the repo (no cascade). Hard vs soft delete, last-reply cleanup of a soft-deleted parent. `comment.update` always bumps `version` and sets `editedAt`, but writes no `comment.updated` event when the stored body is equal. Resolve and reopen are idempotent, take the root from a reply ref, leave `version` alone, work on a placeholder root.
- **Events:** outbox rows `comment.created/updated/deleted/resolved/reopened` with ids and actor, never the body. No history entries (SPEC-013 D24). They notify no one; webhooks get them in M6.
- **Files:** saving a body claims its inline files per SPEC-014 §4.3 in the same transaction, by calling **the one seam** `claimInlineFiles(tx, doc, issue, actor)` in `apps/server/src/files/claim.ts` (owned by PLAN-011 S6; if S6 has not merged, this slice creates that file with the same signature and the same stub body). The stub accepts documents without file references and refuses any reference with the SPEC-014 message ("A file in this text can't be used here. Upload it again."), so nothing unclaimed is saved. PLAN-014 S4b replaces the body; no comment handler changes then.
- **Purge steps** (`apps/server/src/issues/purge-steps.ts`, PLAN-015 S2's registry; if S2 has not merged, this slice creates the file with the registry type): register Reaction, then Comment (replies before roots), then `comment_search_text` (server-only, plain delete). Comment and Reaction are content models, so their steps use `repo.deleteWhere(…, { log: false })` (PLAN-011 S1; SPEC-015 Q2). The lifecycle rule table (PLAN-015 S1) gains the comment rows.
- **Client / optimistic (`packages/operations`):** `optimistic` for create (inserts Comment with `version` 1, the issue's `teamId` from the store and groups `team:<teamId>`; none when `body` is a string), update (`body`, `editedAt`, `version`+1), delete (uses `store.find('Comment', { parentCommentId })`, with soft-delete shape or removal incl. last-reply parent and reactions), resolve and reopen (patch the root). No editor code in `packages/operations`. Optimistic uses `EMPTY_DOC` from domain.
- **Registry:** summary, description, ≥ 2 keywords, examples against the seed fixture, permission, `destructive` on delete. The seed fixture gains a thread with a reply, a resolved thread and (in S4) reactions. `pnpm registry:lint` green; `pnpm registry:snapshot` run for the new catalog.
- **Sync suite:** add comment operations (create, reply, edit, delete, resolve, reopen) to the sync property suite generators in `tests/sync-sim` and to the real-server run. Reactions join in S4.
- **UI:** none (S5).
- **Tests:**
  - `apps/server/test/comment-ops.test.ts` (fake repo and executor harness, the way PLAN-001's handler tests do): AC-1, AC-2, AC-3 (hard, soft, last reply, no cascade), AC-6 (archived and deleted issue), AC-21 (resolve and reopen rules), E2, E3, E8, E13, E15, E17, error table of §6.3.
  - `packages/operations/src/ops/comment.test.ts`: AC-11 (optimistic produces the rows the server commits, no editor code, Markdown body gives none), E22 (two queued edits chain `version`), AC-13 (registry lint and examples).
  - `packages/domain/src/comment.test.ts`: §4.5 invariants.
  - `apps/server/test/comment-purge-step.test.ts` (fake repo): the steps delete reactions, replies, roots and search text for one issue, unlogged, in that order (SPEC-015 AC-4 for comments).
  - `apps/server/test/comment-models.test.ts`: models registered on both sides with the same schema hash; no undeclared column on `comments`/`reactions` (as `workspace-models.test.ts` does); a comment and a reaction on a public team's issue assigned to someone get only `team:<teamId>` (SPEC-013 D12).
  - `tests/sync-sim/test/comments.prop.test.ts`: AC-5 for comments (convergence, no orphan placeholder, no reply under a hard-deleted comment).
  - `apps/server/test/comment-leak.int.test.ts` (**leak test, not held**): AC-12 (see §4).

### S4: Reactions & emoji picker · M
Branch `p013-s4-reactions`. After S3 (tables and models exist) and S2 (emoji data).

- **Operation:** `reaction.set` (`packages/operations/src/ops/reaction.ts`, handler `apps/server/src/handlers/reactions/set.ts`): exactly one of `comment` and `issue`, `reacted` boolean, idempotent, `reactionId`, emoji check with `isSingleEmoji`, 20 distinct emoji cap per subject, lock order issue row then thread root (issue reactions: issue lock only), `reaction.added`/`removed` only on change, `CONFLICT` on archived and deleted issues, `NOT_FOUND` for a deleted comment. Declares `contentParent`. `ui`: **Add reaction…** in contexts `comment` and `issue`.
- **Optimistic:** insert or remove the Reaction with the derived id, subject comment or issue.
- **Output:** `{ target, emoji, count, mine }`. **Cross-plan:** SPEC-011 §6.1 `IssueOutput.reactions` (emoji, count, mine) is built in PLAN-011; this slice supplies the shared `summariseReactions(rows, userId)` helper in `packages/domain/src/reaction.ts` for both, and `CommentOutput.reactions` uses it. Tell PLAN-011 S4/S6 to import it, or add it there as a follow-up if S4 here lands later.
- **UI components (`packages/editor` or `packages/ui`? keep it in `packages/ui` because the design system §5.3 owns EmojiPicker; `packages/ui` cannot import the editor, so the picker takes `loadEmoji` as a prop and the editor's lazy data is passed by `apps/web`):** `EmojiPicker` (search, "Frequently used" kept on this device in `localStorage` with try/catch, categories, keyboard navigation), `ReactionChips` (buttons with `aria-pressed`, accessible name "Thumbs up, 3 reactions, including you", tooltip with names) and `ReactionRow` with **Add reaction**. Stories with axe.
- **Seed fixture:** reactions on a comment and on an ENG issue.
- **Sync suite:** add `reaction.set` on comments and the issue, to `tests/sync-sim`.
- **Tests:**
  - `apps/server/test/reaction-set.test.ts`: AC-4, AC-22, E4, E5, E14, E25, `NOT_FOUND` on a deleted comment, archived and deleted issue (AC-6 reaction half).
  - `packages/operations/src/ops/reaction.test.ts`: AC-11 for reactions (same id both sides), AC-13.
  - `packages/domain/src/reaction.test.ts` (+ `.prop.test.ts`): `reactionId` uniqueness, `summariseReactions`.
  - `tests/sync-sim/test/reactions.prop.test.ts`: AC-5 and AC-22 (≤ 20 emoji, convergence, issue reactions).
  - `packages/ui/src/components/EmojiPicker.test.tsx`: search, frequent list, keyboard, with a fake `loadEmoji` prop.
  - `packages/ui/test/emoji-picker-no-network.test.tsx`: the picker rendered with a fake `loadEmoji`, the same network instrumentation as the editor's test; no request at all (AC-16 for the picker).
  - `apps/web/test/editor-picker-no-network.test.tsx`: the editor with the picker wired to the real lazy emoji data, as the app mounts them; no cross-origin request (AC-16, combined check; `apps/web` may import both).
  - Leak: `comment-leak.int.test.ts` gains reactions (see §4).

### S5: Comments UI on the issue page · M
Branch `p013-s5-comments-ui`. **Needs PLAN-012 S4** (issue page, activity area, `comment` scope) and S2, S3, S4. The synced-`Draft` parts need **PLAN-012 S5**; until it merges the box keeps the text in component state only (a `useCommentDraft` seam) and the AC-20 draft tests use a fake.

- **Where:** `apps/web/src/features/comments/` (new): `ActivityTimeline` pieces (`CommentCard.tsx`, `ThreadView.tsx`, `ResolvedThreadLine.tsx`, `CommentBox.tsx`, `ReplyBox.tsx`, `CommentMenu.tsx`, `IssueReactions.tsx`), `useComments(issueId)` (reads the replica, pairs with `useContent` from PLAN-011; for an archived or deleted issue it reads PLAN-012 S4's server-backed view instead, read-only), `commentActions.ts`. Plugs into PLAN-012 S4's activity area; the timeline interleaves history and top-level comments by time.
- **Behaviour:**
  - Comment box shown only on hydrated issues; offline-unfetched shows "Comments are available when you're back online." (E20). Archived and deleted issues hide all write controls (D10).
  - Send: empties the box at once, `draft.discard`, pending marker; on rejection remove the pending comment, toast, and `draft.save` of the text if the draft is empty or gone, else toast with **Copy text** (E1, E21). A `queuedRejection` hook from the sync client's mutation queue (see PLAN-002 S8) supplies the failure.
  - Draft writes 500 ms after the last change and on blur (uses PLAN-012 S5's `draft.save`).
  - Reply: hover button and `R` on a focused comment (the `comment` scope from PLAN-012 S1), one level, no draft row.
  - Edit in place (`Mod+Enter` saves, `Esc` cancels with the dirty-close guard, Save disabled while unchanged, `baseVersion` sent, `CONFLICT` keeps the text and shows the message); delete with confirmation.
  - Resolve and reopen from the menu; resolved thread collapses to one line with Reopen and a chevron.
  - Options menu: Resolve/Reopen thread, Copy link (`/issue/ENG-42#comment-<id>`, scroll and highlight for 2 s), Copy content as Markdown (calls `docToMarkdown` from the schema entry; the UI imports the web editor package, which can reach it), New issue from comment… (opens the PLAN-012 S5 composer with the body; before that slice lands the entry is hidden behind `composerAvailable`; inline file copy is SPEC-014 §4.3), Edit (own), Delete (own or Admin).
  - Checklist toggle in a comment is allowed for the author only; in a description it follows `issue.updateDescription` (PLAN-012 S4 wires that).
  - Issue reaction row under the description (placed by PLAN-012 S4; this slice supplies `IssueReactions`).
  - Command menu: context `issue` gains **Comment…** and **Add reaction…**; new context `comment` (SPEC-005 §4.1 target kind `comment`, `{ kind, ids, label }`, set by a focused comment). The `comment` scope itself is PLAN-012's.
  - Screen readers: each comment an `article` labelled "Comment by Ada, 3 hours ago"; light and dark; "via API"/"via MCP" label.
  - Attach button and `Mod+Shift+U`: wired to PLAN-014 S5's upload hook when present; until then the stub from S2 shows a toast "Attachments are not available yet." (remove the stub in PLAN-014 S5).
  - Performance: read-only comments use `DocView`; no virtualisation below 500 comments; lazy chunks for the editor and the emoji data (check the issue list chunk has neither).
- **Tests:**
  - `apps/web/src/features/comments/comment-flow.test.tsx` (jsdom, fake server and in-memory store): AC-20 (send discards draft, rejection saves draft or offers Copy text, E21), E1, E15 and E17 client side (rollback and text restored), E3 (conflict keeps text), E20, E26, resolve and collapse (AC-21 UI), reply box send and edit save keys (AC-19 last sentence).
  - `apps/web/src/features/comments/commands.test.ts`: command-menu entries and contexts, `checkOperationCommands` refs.
  - Storybook stories with axe: comment card, reaction chip, editor, resolved thread (AC-17 axe half).
  - AC-17 keyboard run and AC-18 timing: checked by hand (⏸, §4).

---

## 2. Modules touched

| Area | Paths | Slices |
|---|---|---|
| Domain constants and models | `packages/domain/src/doc.ts`, `comment.ts`, `reaction.ts`, `model/comment-models.ts`, `index.ts` | S1, S3, S4 |
| Editor (schema entry) | `packages/editor/src/schema/*`, `package.json` exports, `tsconfig.build.json` | S1 |
| Editor (React entry, DocView, emoji) | `packages/editor/src/*`, `editor.css`, stories | S2 |
| Operations | `packages/operations/src/ops/comment.ts`, `reaction.ts`, `ui.ts` (`comment` context), refs (`CommentRef`), catalog, registry snapshot | S3, S4 |
| Server | `apps/server/src/handlers/comments/`, `handlers/reactions/`, `db/schema/comments.ts`, `db/README.md`, `sync/models.ts`, `package.json` | S1, S3, S4 |
| Web | `apps/web/src/features/comments/`, command-menu contexts, activity area hook-in | S5 |
| UI package | `packages/ui/src/components/EmojiPicker*`, `ReactionChips*` | S4 |
| Config | `.dependency-cruiser.cjs`, `packages/config/eslint.js` (`SYNCED_TABLES`, `no-restricted-imports`) | S1, S2, S3 |
| Tests | `tests/sync-sim` (comment and reaction generators), `apps/server/test/*leak*` | S3, S4 |
| Docs | SPEC-013 `§12` rows are applied at M1 acceptance, not by a slice; each slice adds its "As built" | all |

## 3. Migration & rollback

- **One migration (S3)** adds `comments`, `comment_search_text` and `reactions`, with their indexes and foreign keys. S4 adds none. S1, S2 and S5 add none.
- **Before the first release:** roll back with a down step that drops `reactions`, `comment_search_text`, `comments` in that order (foreign keys are `RESTRICT`, so the order matters), and remove the two models from `PRODUCTION_MODELS`. Clients then resync on the changed `schemaHash`. Nothing else in M1 stores comment rows, so no data is lost beyond test data.
- **After release:** forward-only. A fix is a new migration. `comment_search_text` can be rebuilt from `comments.body` with `docToText`, so a change of text extraction needs only a reindex job, not a data migration.
- **S1's `DOC_SCHEMA_VERSION = 1`** changes the `schemaHash` once (a resync on first deploy, which M1 already causes with the issue models). After release, a schema change ships a data migration and a version bump together (SPEC-013 D6). That migration is the stated exception to architecture rule 2, and it needs the short ADR named in SPEC-013 §12; the ADR is written at M1 acceptance, not in a slice here. This plan has no such migration.

## 4. Test plan (AC → test)

Held rows are marked ⏸ per [README §6](README.md#6-testing-hold-e2e-smoke-and-integration). Leak tests and the sync property suite are not held.

| AC / case | Test | Slice |
|---|---|---|
| AC-1 create, size, reply rules | `apps/server/test/comment-ops.test.ts` | S3 |
| AC-2 author edit, `baseVersion`, version bump, delete rights | `apps/server/test/comment-ops.test.ts` | S3 |
| AC-3 delete modes, no cascade | `apps/server/test/comment-ops.test.ts` (asserts repo `D` deltas for replies and reactions) | S3 |
| AC-4 `reaction.set` rules | `apps/server/test/reaction-set.test.ts` | S4 |
| AC-5 convergence | `tests/sync-sim/test/comments.prop.test.ts`, `reactions.prop.test.ts`; real-server run in `pnpm test:int` (sync suite, not held) | S3, S4 |
| AC-6 archived and deleted issue | `comment-ops.test.ts` and `reaction-set.test.ts` (every operation, both states, nothing unarchives) | S3, S4 |
| AC-7 `validateDoc` | `packages/editor/test/validate.test.ts`, `validate.prop.test.ts` | S1 |
| AC-8 Markdown round trip | `packages/editor/test/markdown.prop.test.ts` (examples in `markdown.test.ts`, `normalize.test.ts`, `text.test.ts`) | S1 |
| AC-9 schema shape and hash snapshot | `packages/editor/test/schema-shape.test.ts`; web equals headless in `test/keys.test.tsx` | S1, S2 |
| AC-10 Node environment and boundaries | `packages/editor/test/schema-node-env.test.ts`, `boundaries.test.ts`; `pnpm lint:deps` | S1 |
| AC-11 optimistic equals server rows | `packages/operations/src/ops/comment.test.ts`, `reaction.test.ts` | S3, S4 |
| AC-12 private-team leak | `apps/server/test/comment-leak.int.test.ts` (**not held**) | S3, S4 |
| AC-13 registry lint and examples | `comment.test.ts`, `reaction.test.ts`; `pnpm registry:lint` | S3, S4 |
| AC-14 paste and `DocView` | `packages/editor/test/paste.test.tsx`, `doc-view.test.tsx` | S2 |
| AC-15 emoji data valid | `packages/editor/test/emoji.test.ts` | S2 |
| AC-16 no outbound request, ESLint ban | `packages/editor/test/no-network.test.tsx` (editor, `DocView`; S2) + `packages/ui/test/emoji-picker-no-network.test.tsx` and `apps/web/test/editor-picker-no-network.test.tsx` (picker; S4); lint rule check in `packages/config` test | S2, S4 |
| AC-17 keyboard only, screen reader names | ⏸ e2e; checked by hand in S5 "As built". Axe in Storybook for card, chip, editor | S5 |
| AC-18 cross-tab < 150 ms | ⏸ e2e perf; checked by hand | S5 |
| AC-19 `Mod+Enter` and `Shift+Enter` | `test/enter-modes.test.tsx` (editor + engine); reply and edit keys in `comment-flow.test.tsx` | S2, S5 |
| AC-20 drafts, rejection, queued edits | `apps/web/src/features/comments/comment-flow.test.tsx` (fake server, in-memory store); E22 in `comment.test.ts` | S3, S5 |
| AC-21 resolve and reopen | `comment-ops.test.ts`; UI collapse in `comment-flow.test.tsx` | S3, S5 |
| AC-22 issue reactions | `reaction-set.test.ts`, `reactions.prop.test.ts` | S4 |
| AC-23 keys and input rules | `packages/editor/test/keys.test.tsx` | S2 |
| AC-24 `Enter` modes, IME, checklist | `test/enter-modes.test.tsx` | S2 |
| AC-25 underline | `markdown.prop.test.ts` (underline in the arbitrary) | S1 |
| Leak checklist (permissions §5): `/sync/content`, live deltas, `comment.list`, `CommentRef` NOT_FOUND worded as missing, API key with other `teamIds`, reactions, soft-deleted placeholder, `sync_log` rows | `comment-leak.int.test.ts`, mutation-checked as in PLAN-001 S1 (with every team public, tests fail) | S3, S4 |
| E1, E15, E17, E21 client rollback | `comment-flow.test.tsx` | S5 |
| E2, E13, E14, E16 thread-lock races | `comment-ops.test.ts` (lock order asserted with a fake lock recorder) plus the sync property tests; real-Postgres concurrency is covered by the sync suite run | S3, S4 |
| E5, E4 same emoji | `reaction-set.test.ts` | S4 |
| E6, E7, E9 bad bodies via API | `validate.test.ts`, `markdown.prop.test.ts`, `markdown.test.ts`, `comment-ops.test.ts` (E9 through the S3 file seam) | S1, S3 |
| E11, E18 file paste, missing file marker | ⏸ upload part (PLAN-014 S5); the insert logic and the marker are in `paste.test.tsx` and `doc-view.test.tsx` | S2 |
| E12 1,000 comments | unit: `comment.list` paging in `comment-ops.test.ts`; render budget ⏸ perf, by hand | S3, S5 |
| E20 offline, never fetched | `comment-flow.test.tsx` | S5 |
| E3, E22 | `comment-flow.test.tsx`, `comment.test.ts` | S3, S5 |
| E8, E10, E26 | `comment-ops.test.ts` (author kept), covered by PLAN-011's group-change resync test, `comment-flow.test.tsx` | S3, S5 |
| E27 issue leaves the replica | PLAN-011 S4c `sync-client/test/issue-removal.test.ts` (children and mark removed) + `comment-flow.test.tsx` (the read-only server view of an archived issue's comments) | S5 |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **The schema entry fails in the server image** (built JS, source condition missing at runtime). | S1 adds the build script and `files`, and `pnpm -r build` order is checked in CI. S1's Node-environment test imports the built `dist/schema` once. The PLAN-004 image build is run by hand in S1. |
| **Two schemas drift** (headless vs web with lowlight). | One extension list shared by both entries, and the S2 test compares the two. The `DOC_SCHEMA_VERSION` snapshot fails on any change that is not bumped. |
| **Markdown round trip is hard to get exactly equal** to `normalize(d)` (escaping, nested lists, fences). | The property test lands in S1 first with a small arbitrary, then grows. `normalize` is defined by the test, so a rule that cannot round-trip is added to `normalize` instead of weakening the property. S1 is sized L for this. |
| **TipTap StarterKit adds nodes or marks silently on upgrade** (e.g. Link in v3). | Explicit list, StarterKit extras disabled, shape test. Dependency versions pinned exactly. |
| **`Mod+Enter` is swallowed by TipTap** and never reaches the shortcut engine. | AC-19 test runs the real engine (`apps/web/src/shortcuts/engine.ts`) against the real editor in jsdom. If jsdom cannot show the issue, the by-hand keyboard run in S5 covers it. |
| **Thread deadlocks or lost updates** (issue lock then thread root). | One fixed lock order, asserted in tests; all comment and reaction handlers share a helper `withThreadLock` so the order exists in one place. |
| **Foreign keys block hard deletes** (`RESTRICT`) if a handler misses a child. | AC-3 test counts the `D` deltas; the migration has the `RESTRICT` so a missed child fails loudly in the sync suite, not silently. |
| **PLAN-014 and PLAN-012 S5 are later than S3/S5.** | The two seams (`claimInlineFiles` from PLAN-011 S6, which rejects any file reference, and the in-memory comment draft) keep the slices mergeable. Each seam has a test that PLAN-014 S4b and PLAN-012 S5 must replace, listed in S3 and S5. |
| **Bundle size:** editor, lowlight and emoji data leak into the issue list chunk. | Lazy `import()` boundaries, a size check script in S2 (`pnpm --filter @surface/web build` and a small test reading the Vite manifest), emoji data ≤ 150 KB gzipped. |
| **Emoji validity differs between Node and browsers** (Unicode version). | The pinned data is tested in Node (AC-15); a newer browser emoji refused by the server gives the specified `INVALID_INPUT` message. |
| **Leaving a deleted comment's text in `sync_log`** for 30 days. | Accepted and documented (SPEC-013 D17); events carry no body. The leak test checks that outbox rows carry no body. |
| **Sync property suite gets slow or flaky** with more operations. | New generators are added behind the existing seed and run at the same case counts; run at 1,000 cases by hand once before the S4 merge. |
