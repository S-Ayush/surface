// One picker is open at a time (SPEC-012 §3.5). Whoever opens it (a pill, the `S` key, a row
// menu item) leaves a request here and `IssuePickersHost` shows it: a plain module store, like
// `composer-request.ts`, so a key handler needs no component to hang the popover on.
import type { PickerKind } from '../issue-pickers.js';

export interface PickerRequest {
  readonly kind: PickerKind;
  readonly issueId: string;
  /** What the popover is anchored to: the pill, the row or the panel. Null: the top left. */
  readonly anchor: Element | null;
  /**
   * Where it shows. Unset: the anchored popover (a pill click, the row menu). `menu`: a sub-page of
   * the command menu with the issue chip (a property key, command-menu.md §3.5). The due date is a
   * calendar and always stays anchored (SPEC-012 D28).
   */
  readonly frame?: 'menu';
  /** Called once the picker has closed, in any way: the list moves focus back to its row. */
  readonly onClosed?: () => void;
}

export class PickerRequests {
  #current: PickerRequest | undefined;
  readonly #listeners = new Set<() => void>();

  open(request: PickerRequest): void {
    // Replacing an open picker (a second key while one is open) still tells the first it closed.
    this.#current?.onClosed?.();
    this.#current = request;
    this.#emit();
  }

  /**
   * Takes the open request without closing it or calling `onClosed`: the command menu adopts a
   * keyboard request this way and owns it from then on, so a later popover is independent of it.
   */
  release(): PickerRequest | undefined {
    const request = this.#current;
    this.#current = undefined;
    if (request !== undefined) this.#emit();
    return request;
  }

  /** Closes the open picker. Says whether there was one. */
  close(): boolean {
    const request = this.#current;
    if (request === undefined) return false;
    this.#current = undefined;
    this.#emit();
    request.onClosed?.();
    return true;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): PickerRequest | undefined => this.#current;

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const pickerRequests = new PickerRequests();

export const openPicker = (request: PickerRequest): void => {
  pickerRequests.open(request);
};
