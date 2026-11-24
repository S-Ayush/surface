// Pasting on the issue page (SPEC-014 §3.1, §3.2, E23, AC-22; PLAN-014 S5). With focus **outside**
// any text field (the shortcut engine's `isTypingTarget`), a lone URL opens the "Link any URL to
// issue" form filled in, and pasted files become attachments. In the title, a comment, the
// description or any other input the paste is that field's own: nothing here runs.
import { isTypingTarget } from '../../shortcuts/engine.js';
import { loneUrl } from './model.js';

export interface PasteActions {
  /** Opens the link form with this URL filled in. */
  readonly openLink: (url: string) => void;
  /** Uploads pasted files as attachments. */
  readonly attachFiles: (files: readonly File[]) => void;
}

/** The parts of a paste event the handler reads. */
export interface PasteLike {
  readonly target: unknown;
  readonly clipboardData: Pick<DataTransfer, 'files' | 'getData'> | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * Handles a paste at the page; true if it was taken. `focused` is the element with focus
 * (`document.activeElement`), checked as well as the event's target.
 */
export function handlePagePaste(
  event: PasteLike,
  focused: unknown,
  actions: PasteActions,
): boolean {
  if (event.defaultPrevented) return false;
  if (isTypingTarget(event.target) || isTypingTarget(focused)) return false;
  const data = event.clipboardData;
  if (data === null) return false;
  const files = Array.from(data.files);
  if (files.length > 0) {
    event.preventDefault();
    actions.attachFiles(files);
    return true;
  }
  const url = loneUrl(data.getData('text/plain'));
  if (url === undefined) return false;
  event.preventDefault();
  actions.openLink(url);
  return true;
}

/**
 * Listens for pastes on `doc` while the page is editable; returns the clean-up. While an overlay
 * (a dialog, the viewer, a menu) is open the paste is the overlay's, not the page's.
 */
export function listenForPaste(
  doc: Document,
  actions: () => PasteActions,
  overlayOpen: () => boolean,
): () => void {
  const onPaste = (event: ClipboardEvent) => {
    if (overlayOpen()) return;
    handlePagePaste(event, doc.activeElement, actions());
  };
  doc.addEventListener('paste', onPaste);
  return () => {
    doc.removeEventListener('paste', onPaste);
  };
}
