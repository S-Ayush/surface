// One client store at a time (SPEC-002 E5). A new session (sign-in, or the same user's shell
// reopened after a 4001) opens a new store; it must not start until the previous one has closed,
// or the old store still holds the queue the new one should adopt.

export class StoreSequence {
  /** Settles when the latest disposed store has closed. Never rejects. */
  #closed: Promise<void> = Promise.resolve();

  /**
   * Starts a store once the previous one has closed. Returns its disposer, which closes it (after
   * the previous store, so closes keep their order). A store disposed before its turn never
   * starts. A failed start shows in the store's status; a failed close only ends that store.
   */
  open(start: () => Promise<unknown>, close: () => Promise<void>): () => void {
    const previous = this.#closed;
    let disposed = false;
    void previous.then(() => (disposed ? undefined : start())).catch(() => undefined);
    return () => {
      disposed = true;
      this.#closed = previous.then(close).catch(() => undefined);
    };
  }
}
