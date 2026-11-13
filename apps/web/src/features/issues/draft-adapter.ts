// Drafts on the client (SPEC-012 §3.2, §4.3; PLAN-012 S5): reads the replica's `Draft` rows and
// writes through `dispatch` (`draft.save`, `draft.discard`), so a draft saved offline queues like
// any operation (E19) and the last write wins on the server (E13). There is no drafts store of its
// own. Comment drafts save 500 ms after the last change and on navigation (`flush`); one older
// than 30 days is discarded when it is read. PLAN-013 S5's comment box calls the comment half.
import { uuidv7, type DocNodeJSON } from '@surface/domain';
import {
  COMMENT_DRAFT_MAX_AGE_DAYS,
  readCommentDraft,
  Draft,
  type ComposerDraftData,
} from '@surface/domain/model';
import { draftDiscard, draftSave, type InputOf } from '@surface/operations';
import type { InstanceOf, MutationOutcome, SyncStore } from '@surface/sync-client';
import { toast } from '@surface/ui';

type DraftOp = typeof draftSave | typeof draftDiscard;

export type DraftRow = Pick<
  InstanceOf<typeof Draft>,
  'id' | 'kind' | 'teamId' | 'issueId' | 'data' | 'createdAt' | 'updatedAt'
>;

/** What the adapter needs from the store: its rows, its dispatcher and a clock. */
export interface DraftDeps {
  /** The replica's `Draft` rows (the user's own: nobody else's ever arrive). Observable. */
  rows(): readonly DraftRow[];
  dispatch<Op extends DraftOp>(op: Op, input: InputOf<Op>): Promise<MutationOutcome>;
  now(): number;
  /** A change the store didn't take (not ready, queue lost): the caller's toast. */
  failed(message: string): void;
}

/** SPEC-012 §3.2: comment drafts save this long after the last change. */
export const COMMENT_DRAFT_DEBOUNCE_MS = 500;
const MAX_AGE_MS = COMMENT_DRAFT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** A document with nothing in it: no blocks, or only empty paragraphs. */
export function isEmptyDoc(doc: DocNodeJSON | null | undefined): boolean {
  if (doc === null || doc === undefined) return true;
  return (doc.content ?? []).every(
    (block) => block.type === 'paragraph' && (block.content ?? []).length === 0,
  );
}

/** A document as `draft.save` takes it (its schema checks the root is a `doc`). */
export function docInput(doc: DocNodeJSON): { readonly type: 'doc' } & Record<string, unknown> {
  return { ...doc, type: 'doc' };
}

/** A row the Drafts page lists. */
export type DraftEntry =
  | { readonly kind: 'composer'; readonly row: DraftRow; readonly teamId: string }
  | {
      readonly kind: 'comment';
      readonly row: DraftRow;
      readonly issueId: string;
      readonly text: DocNodeJSON;
    };

export class DraftAdapter {
  readonly #deps: DraftDeps;
  /** Comment text waiting for its debounce, per issue (null: the box was emptied). */
  readonly #pending = new Map<
    string,
    { text: DocNodeJSON | null; timer: ReturnType<typeof setTimeout> }
  >();
  /** Expired comment drafts already being discarded, so a re-read doesn't send it twice. */
  readonly #expiring = new Set<string>();

  constructor(deps: DraftDeps) {
    this.#deps = deps;
  }

  #send<Op extends DraftOp>(op: Op, input: InputOf<Op>): void {
    try {
      // A rejection is the shell's toast (SPEC-002 §3.5); nothing waits on the answer.
      this.#deps.dispatch(op, input).catch(() => undefined);
    } catch (error) {
      this.#deps.failed(
        error instanceof Error ? error.message : 'The draft could not be saved. Try again.',
      );
    }
  }

  #expired(row: DraftRow): boolean {
    const at = Date.parse(row.updatedAt);
    return Number.isFinite(at) && this.#deps.now() - at > MAX_AGE_MS;
  }

  /** Discards an expired comment draft after the current read (never during a render). */
  #expire(row: DraftRow): void {
    const issueId = row.issueId;
    if (issueId === null || this.#expiring.has(row.id)) return;
    this.#expiring.add(row.id);
    queueMicrotask(() => {
      this.#send(draftDiscard, { kind: 'comment', issueId });
    });
  }

  // ── Composer drafts ────────────────────────────────────────────────────────────────────────

  /** The team's composer draft, if there is one. */
  composerDraft(teamId: string): DraftRow | undefined {
    return this.#deps.rows().find((row) => row.kind === 'composer' && row.teamId === teamId);
  }

  /** "Save as draft?" → Save: the team's one composer draft, replaced (an upsert). */
  saveComposer(teamId: string, data: ComposerDraftData): void {
    const { description, ...rest } = data;
    const doc = description === null ? null : docInput(description);
    this.#send(draftSave, {
      id: uuidv7(),
      kind: 'composer',
      teamId,
      data: { ...rest, labelIds: [...rest.labelIds], description: doc },
    });
  }

  /** Creating the issue, or "Draft restored · Discard": the team's draft goes. */
  discardComposer(teamId: string): void {
    if (this.composerDraft(teamId) === undefined) return;
    this.#send(draftDiscard, { kind: 'composer', teamId });
  }

  // ── Comment drafts ─────────────────────────────────────────────────────────────────────────

  #commentRow(issueId: string): DraftRow | undefined {
    return this.#deps.rows().find((row) => row.kind === 'comment' && row.issueId === issueId);
  }

  /**
   * The text the issue's comment box shows: what is waiting to be saved, else the saved draft.
   * A draft older than 30 days is discarded instead (§3.2).
   */
  commentText(issueId: string): DocNodeJSON | undefined {
    const pending = this.#pending.get(issueId);
    if (pending !== undefined) return pending.text ?? undefined;
    const row = this.#commentRow(issueId);
    if (row === undefined) return undefined;
    if (this.#expired(row)) {
      this.#expire(row);
      return undefined;
    }
    return readCommentDraft(row.data);
  }

  /** The comment box changed: saved 500 ms after the last change; an empty box deletes it. */
  setCommentText(issueId: string, text: DocNodeJSON | null): void {
    const before = this.#pending.get(issueId);
    if (before !== undefined) clearTimeout(before.timer);
    const value = isEmptyDoc(text) ? null : text;
    const timer = setTimeout(() => {
      this.#flushComment(issueId);
    }, COMMENT_DRAFT_DEBOUNCE_MS);
    this.#pending.set(issueId, { text: value, timer });
  }

  #flushComment(issueId: string): void {
    const pending = this.#pending.get(issueId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(issueId);
    if (pending.text === null) {
      if (this.#commentRow(issueId) !== undefined) {
        this.#send(draftDiscard, { kind: 'comment', issueId });
      }
      return;
    }
    this.#send(draftSave, {
      id: uuidv7(),
      kind: 'comment',
      issueId,
      data: { text: docInput(pending.text) },
    });
  }

  /** Navigation, or the page closing: every waiting comment draft is saved now. */
  flush(): void {
    for (const issueId of [...this.#pending.keys()]) this.#flushComment(issueId);
  }

  /** Sending the comment (SPEC-013 §3.1): the draft goes, and nothing waiting is saved after. */
  discardComment(issueId: string): void {
    const pending = this.#pending.get(issueId);
    if (pending !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(issueId);
    this.#send(draftDiscard, { kind: 'comment', issueId });
  }

  /**
   * The server rejected a comment (§3.2, AC-24): its text goes back into the issue's comment
   * draft when that draft is empty or gone (`restored`); if the user has typed something new
   * meanwhile, that stays and the caller's toast offers **Copy text** (`copy`).
   */
  restoreRejectedComment(issueId: string, text: DocNodeJSON): 'restored' | 'copy' {
    if (!isEmptyDoc(this.commentText(issueId))) return 'copy';
    const pending = this.#pending.get(issueId);
    if (pending !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(issueId);
    this.#send(draftSave, {
      id: uuidv7(),
      kind: 'comment',
      issueId,
      data: { text: docInput(text) },
    });
    return 'restored';
  }

  // ── The Drafts page ────────────────────────────────────────────────────────────────────────

  /** Every composer draft and every unexpired comment draft, newest first. */
  list(): DraftEntry[] {
    const entries: DraftEntry[] = [];
    for (const row of this.#deps.rows()) {
      if (row.kind === 'composer' && row.teamId !== null) {
        entries.push({ kind: 'composer', row, teamId: row.teamId });
      } else if (row.kind === 'comment' && row.issueId !== null) {
        if (this.#expired(row)) {
          this.#expire(row);
          continue;
        }
        const text = readCommentDraft(row.data);
        if (text !== undefined) entries.push({ kind: 'comment', row, issueId: row.issueId, text });
      }
    }
    return entries.sort(
      (a, b) =>
        Date.parse(b.row.updatedAt) - Date.parse(a.row.updatedAt) || (a.row.id < b.row.id ? 1 : -1),
    );
  }

  /** The row menu's **Delete draft**. */
  discard(entry: DraftEntry): void {
    if (entry.kind === 'composer')
      this.#send(draftDiscard, { kind: 'composer', teamId: entry.teamId });
    else this.discardComment(entry.issueId);
  }

  /** The shell closing: what is waiting is saved, so nothing typed is lost. */
  dispose(): void {
    this.flush();
  }
}

const adapters = new WeakMap<SyncStore, DraftAdapter>();

/** The store's one adapter, so the composer, the Drafts page and the comment box share timers. */
export function draftAdapterFor(store: SyncStore): DraftAdapter {
  let adapter = adapters.get(store);
  if (adapter === undefined) {
    adapter = new DraftAdapter({
      rows: () => store.pool.all(Draft),
      dispatch: (op, input) => store.dispatch(op, input),
      now: () => Date.now(),
      failed: (message) => {
        toast({ tone: 'danger', message });
      },
    });
    adapters.set(store, adapter);
  }
  return adapter;
}
