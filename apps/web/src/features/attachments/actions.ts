// What the attachment UI does to the store (SPEC-014 §3.1, §3.2, §3.5, E1, E8; PLAN-014 S5): every
// change is a dispatched operation. A refusal reaches the user exactly once: these dispatches pass
// `reportRejection: () => false` and toast the server's reason here, also when it comes after the
// page closed. The optimistic row (S4a's `optimistic`) shows at once and the queue rolls it back on
// a refusal.
import { uuidv7 } from '@surface/domain';
import {
  attachmentCreateFile,
  attachmentCreateLink,
  attachmentDelete,
  attachmentUpdate,
  type AnyOperation,
  type InputOf,
} from '@surface/operations';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import type { ToastOptions } from '@surface/ui';
import type { AttachmentItem } from './model.js';
import type { UploadAnswer } from './transport.js';

/** The part of the store these actions use. */
export type AttachmentStore = Pick<SyncStore, 'dispatch'>;

export interface AttachmentActionsDeps {
  readonly store: AttachmentStore;
  readonly toast: (options: ToastOptions) => unknown;
  /** Client UUIDv7s for new rows (SPEC-003 §8); tests pass fixed ones. */
  readonly newId?: () => string;
}

/** design-system §4: the Undo toast after Remove (8 s, the action toast's default). */
export const REMOVED_MESSAGE = 'Attachment removed';
export const UNDO_LABEL = 'Undo';

const QUIET = { reportRejection: () => false } as const;

export class AttachmentActions {
  readonly #deps: AttachmentActionsDeps;

  constructor(deps: AttachmentActionsDeps) {
    this.#deps = deps;
  }

  #id(): string {
    return (this.#deps.newId ?? uuidv7)();
  }

  /**
   * Dispatches and waits for the answer; toasts a refusal (the server's reason, or why the store
   * didn't take it, e.g. an archived issue the overlay already shows). True when confirmed.
   */
  async #run<Op extends AnyOperation>(op: Op, input: InputOf<Op>): Promise<boolean> {
    let outcome: MutationOutcome;
    try {
      outcome = await this.#deps.store.dispatch(op, input, QUIET);
    } catch (error) {
      this.#fail(
        error instanceof Error && error.message !== ''
          ? error.message
          : 'That change could not be saved. Try again.',
      );
      return false;
    }
    if (outcome.status === 'confirmed') return true;
    this.#fail(outcome.error.message);
    return false;
  }

  #fail(message: string): void {
    this.#deps.toast({ tone: 'danger', message });
  }

  /**
   * Attaches a finished upload (§3.1 step 3). The upload's answer goes along (D29) so the row shows
   * at once; a refusal (E1: archived meanwhile, 100 reached) rolls it back with its reason, and the
   * file stays unclaimed until clean-up.
   */
  attachFile(issueId: string, answer: UploadAnswer): Promise<boolean> {
    return this.#run(attachmentCreateFile, {
      id: this.#id(),
      issue: issueId,
      file: answer.id,
      upload: {
        name: answer.name,
        mimeType: answer.mimeType,
        size: answer.size,
        ...(answer.width === undefined ? {} : { width: answer.width }),
        ...(answer.height === undefined ? {} : { height: answer.height }),
      },
    });
  }

  /** §3.2: a link is only an operation, so it queues offline too. Never fetched (D10). */
  attachLink(issueId: string, url: string, title?: string): Promise<boolean> {
    return this.#run(attachmentCreateLink, {
      id: this.#id(),
      issue: issueId,
      url,
      ...(title === undefined ? {} : { title }),
    });
  }

  rename(attachmentId: string, title: string): Promise<boolean> {
    return this.#run(attachmentUpdate, { attachment: attachmentId, title });
  }

  /**
   * §3.5, D8: Remove runs at once, with an Undo toast for 8 seconds. Undo, and nothing else,
   * re-creates the attachment.
   */
  remove(issueId: string, item: AttachmentItem): Promise<boolean> {
    const removed = this.#run(attachmentDelete, { attachment: item.id });
    this.#deps.toast({
      message: REMOVED_MESSAGE,
      action: {
        label: UNDO_LABEL,
        onAction: () => {
          void this.undo(issueId, item);
        },
      },
    });
    return removed;
  }

  /**
   * Re-creates a removed attachment (§3.5): a file through `attachment.createFile` on the same,
   * detached file (D28; kept 24 hours, E8), with its title and the row's fields as the upload echo
   * so it shows at once; a link through `attachment.createLink` with the same URL and title.
   */
  undo(issueId: string, item: AttachmentItem): Promise<boolean> {
    if (item.kind === 'link') {
      if (item.url === null) return Promise.resolve(false);
      return this.#run(attachmentCreateLink, {
        id: this.#id(),
        issue: issueId,
        url: item.url,
        title: item.title,
      });
    }
    if (item.fileId === null) return Promise.resolve(false);
    return this.#run(attachmentCreateFile, {
      id: this.#id(),
      issue: issueId,
      file: item.fileId,
      title: item.title,
      ...(item.fileName !== null && item.mimeType !== null && item.size !== null
        ? {
            upload: {
              name: item.fileName,
              mimeType: item.mimeType,
              size: item.size,
              ...(item.imageWidth === null ? {} : { width: item.imageWidth }),
              ...(item.imageHeight === null ? {} : { height: item.imageHeight }),
            },
          }
        : {}),
    });
  }
}

const byStore = new WeakMap<AttachmentStore, AttachmentActions>();

/** The store's one `AttachmentActions`, so a late refusal still reaches the user after a page. */
export function attachmentActionsFor(
  store: AttachmentStore,
  toast: (options: ToastOptions) => unknown,
): AttachmentActions {
  let actions = byStore.get(store);
  if (actions === undefined) {
    actions = new AttachmentActions({ store, toast });
    byStore.set(store, actions);
  }
  return actions;
}
