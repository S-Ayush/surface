// What the comment UI does (SPEC-013 §3.1–§3.4, E1, E3, E15, E17, E21; PLAN-013 S5): every change is
// a dispatched operation. The actions live outside the components, so a send that is rejected
// after the user left the page still puts the text back (E21) and a rejection reaches the user
// exactly once: these dispatches pass `reportRejection: () => false` and show the message here.
//
// "queuedRejection" hook of the plan: the sync client has none. `dispatch` resolves to an outcome
// (`confirmed` or `rejected`), also for a mutation queued offline, and that promise is what these
// actions wait on. It is lost on a reload; the queue then reports the rejection to the shell's
// `onRejected`, which hands it to `reportQueuedRejection` so the text still comes back (§3.1).
import { uuidv7, type DocNodeJSON } from '@surface/domain';
import {
  commentCreate,
  commentDelete,
  commentReopen,
  commentResolve,
  commentUpdate,
  reactionSet,
} from '@surface/operations';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import type { ToastOptions } from '@surface/ui';
import { observable, runInAction } from 'mobx';
import { docInput } from '../issues/draft-adapter.js';
import { isDoc } from './model.js';

/** The part of the store these actions use. */
export type CommentStore = Pick<SyncStore, 'dispatch'>;

/** The part of the draft adapter these actions use. */
export interface CommentDrafts {
  discardComment(issueId: string): void;
  restoreRejectedComment(issueId: string, text: DocNodeJSON): 'restored' | 'copy';
}

export interface CommentActionsDeps {
  readonly store: CommentStore;
  readonly drafts: CommentDrafts;
  readonly toast: (options: ToastOptions) => unknown;
  /** The text of a document as Markdown, for **Copy text**. */
  readonly markdownOf: (doc: DocNodeJSON) => string;
  readonly copy: (text: string) => Promise<boolean>;
}

const DONE = { reportRejection: () => false } as const;

/** What the caller does with a document the server refused: put it back, or leave it to the toast. */
export type RestoreText = (doc: DocNodeJSON) => 'restored' | 'copy';

export class CommentActions {
  readonly #deps: CommentActionsDeps;
  /** Comments sent from this tab and not confirmed yet: the pending marker (§3.1 item 2). */
  readonly #pending = observable.set<string>();

  constructor(deps: CommentActionsDeps) {
    this.#deps = deps;
  }

  isPending(commentId: string): boolean {
    return this.#pending.has(commentId);
  }

  /** The message to show for a refusal, from the server or from a dispatch that threw. */
  #messageOf(error: unknown): string {
    return error instanceof Error && error.message !== ''
      ? error.message
      : 'That did not work. Try again.';
  }

  /** Waits for the outcome; resolves to the refusal's message, or undefined when it was confirmed. */
  async #settled(dispatch: () => Promise<MutationOutcome>): Promise<string | undefined> {
    try {
      const outcome = await dispatch();
      return outcome.status === 'confirmed' ? undefined : outcome.error.message;
    } catch (error) {
      // `InvalidInputError`, a refusal the replica already knew (an archived issue), content that
      // can't be loaded: nothing was queued.
      return this.#messageOf(error);
    }
  }

  #fail(message: string): void {
    this.#deps.toast({ tone: 'danger', message });
  }

  /** The refusal, with the text the user wrote one click from the clipboard (E21). */
  #failWithCopy(message: string, doc: DocNodeJSON): void {
    this.#deps.toast({
      tone: 'danger',
      message,
      action: {
        label: 'Copy text',
        onAction: () => {
          void this.#deps.copy(this.#deps.markdownOf(doc));
        },
      },
    });
  }

  /**
   * A refusal that reached the shell because no live `dispatch` promise was waiting: the mutation
   * was sent again from storage after a reload. A comment goes back into the issue's draft when
   * that is empty, else the toast offers **Copy text**; an edit always offers it. Returns false for
   * any other operation, which the shell reports as usual.
   */
  reportQueuedRejection(rejection: {
    readonly op: string;
    readonly input: unknown;
    readonly message: string;
  }): boolean {
    const { op, input, message } = rejection;
    if (op !== 'comment.create' && op !== 'comment.update') return false;
    if (typeof input !== 'object' || input === null || !('body' in input) || !isDoc(input.body)) {
      return false;
    }
    const doc = input.body;
    if (op === 'comment.update') {
      this.#failWithCopy(message, doc);
      return true;
    }
    const issueId = 'issue' in input && typeof input.issue === 'string' ? input.issue : undefined;
    if (
      issueId !== undefined &&
      this.#deps.drafts.restoreRejectedComment(issueId, doc) === 'restored'
    ) {
      this.#fail(message);
    } else {
      this.#failWithCopy(message, doc);
    }
    return true;
  }

  /**
   * Sends a comment or a reply (§3.1, §3.2). The box has already emptied. On a refusal the pending
   * comment is gone (the queue rolled it back) and `restore` puts the text back where it came from:
   * the issue's comment draft, or the reply box. When it can't (the user typed something new, or
   * left), the toast offers **Copy text** (E1, E21).
   */
  async create(options: {
    issueId: string;
    parentId?: string;
    doc: DocNodeJSON;
    restore?: RestoreText;
  }): Promise<boolean> {
    const { issueId, parentId, doc } = options;
    const id = uuidv7();
    if (parentId === undefined) this.#deps.drafts.discardComment(issueId);
    runInAction(() => this.#pending.add(id));
    const message = await this.#settled(() =>
      this.#deps.store.dispatch(
        commentCreate,
        {
          id,
          issue: issueId,
          ...(parentId === undefined ? {} : { parent: parentId }),
          body: docInput(doc),
        },
        DONE,
      ),
    );
    runInAction(() => this.#pending.delete(id));
    if (message === undefined) return true;
    const restore: RestoreText =
      options.restore ?? ((text) => this.#deps.drafts.restoreRejectedComment(issueId, text));
    if (restore(doc) === 'restored') this.#fail(message);
    else this.#failWithCopy(message, doc);
    return false;
  }

  /**
   * Saves an edit (§3.3). `onRejected` gets the message so the card can open the editor again with
   * the text (E3: a `CONFLICT` keeps it) and answers whether it did. When it didn't (the card is
   * gone or collapsed), the toast offers **Copy text**; when it did, the card shows the message.
   */
  async update(options: {
    commentId: string;
    baseVersion: number;
    doc: DocNodeJSON;
    onRejected?: (message: string) => boolean;
  }): Promise<boolean> {
    const message = await this.#settled(() =>
      this.#deps.store.dispatch(
        commentUpdate,
        {
          comment: options.commentId,
          baseVersion: options.baseVersion,
          body: docInput(options.doc),
        },
        DONE,
      ),
    );
    if (message === undefined) return true;
    if (options.onRejected?.(message) !== true) this.#failWithCopy(message, options.doc);
    return false;
  }

  async #simple(
    op: typeof commentDelete | typeof commentResolve | typeof commentReopen,
    commentId: string,
  ): Promise<boolean> {
    const message = await this.#settled(() =>
      this.#deps.store.dispatch(op, { comment: commentId }, DONE),
    );
    if (message !== undefined) this.#fail(message);
    return message === undefined;
  }

  delete(commentId: string): Promise<boolean> {
    return this.#simple(commentDelete, commentId);
  }

  resolve(commentId: string): Promise<boolean> {
    return this.#simple(commentResolve, commentId);
  }

  reopen(commentId: string): Promise<boolean> {
    return this.#simple(commentReopen, commentId);
  }

  /** Sets or clears the viewer's reaction on a comment, or on the issue when `commentId` is null. */
  async react(options: {
    issueId: string;
    commentId: string | null;
    emoji: string;
    reacted: boolean;
  }): Promise<boolean> {
    const { issueId, commentId, emoji, reacted } = options;
    const message = await this.#settled(() =>
      this.#deps.store.dispatch(
        reactionSet,
        commentId === null
          ? { issue: issueId, emoji, reacted }
          : { comment: commentId, emoji, reacted },
        DONE,
      ),
    );
    if (message !== undefined) this.#fail(message);
    return message === undefined;
  }
}
