// The polite live region of SPEC-012 §7.4: "Created ENG-42", rejections, "ENG-42 deleted",
// "Restored ENG-42", "ENG-42 was removed" (E2). A module singleton, so any issue code can call
// `announce`; `AnnouncerHost` (mounted in SHELL_HOSTS) renders the region.
export interface Announcement {
  readonly text: string;
  /** Changes on every call, so the same text announced twice is read twice. */
  readonly serial: number;
}

export class Announcer {
  #current: Announcement = { text: '', serial: 0 };
  readonly #listeners = new Set<() => void>();

  announce(text: string): void {
    this.#current = { text, serial: this.#current.serial + 1 };
    for (const listener of this.#listeners) listener();
  }

  /** `useSyncExternalStore` pair. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): Announcement => this.#current;
}

export const announcer = new Announcer();

export const announce = (text: string): void => {
  announcer.announce(text);
};
