// One client store at a time (SPEC-002 E5): a new session's store starts only once the previous
// one has closed, so the old queue is released and the new store can adopt it (session D).
import { describe, expect, it } from 'vitest';
import { StoreSequence } from '../src/app/stores.js';

/** A promise the test settles by hand. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise's callbacks run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('StoreSequence', () => {
  it('starts the first store at once', async () => {
    const events: string[] = [];
    new StoreSequence().open(
      () => {
        events.push('start 1');
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    await settle();
    expect(events).toEqual(['start 1']);
  });

  it('starts the next store only after the previous one has closed', async () => {
    const events: string[] = [];
    const closing = deferred();
    const stores = new StoreSequence();
    const closeFirst = stores.open(
      () => {
        events.push('start 1');
        return Promise.resolve();
      },
      () => {
        events.push('close 1');
        return closing.promise;
      },
    );
    await settle();
    closeFirst();
    stores.open(
      () => {
        events.push('start 2');
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    await settle();
    expect(events).toEqual(['start 1', 'close 1']);
    closing.resolve();
    await settle();
    expect(events).toEqual(['start 1', 'close 1', 'start 2']);
  });

  it('never starts a store disposed while it waited, but still closes it', async () => {
    const events: string[] = [];
    const closing = deferred();
    const stores = new StoreSequence();
    const closeFirst = stores.open(
      () => Promise.resolve(),
      () => closing.promise,
    );
    closeFirst();
    const closeSecond = stores.open(
      () => {
        events.push('start 2');
        return Promise.resolve();
      },
      () => {
        events.push('close 2');
        return Promise.resolve();
      },
    );
    closeSecond(); // React StrictMode mounts, unmounts and mounts again
    stores.open(
      () => {
        events.push('start 3');
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    closing.resolve();
    await settle();
    expect(events).toEqual(['close 2', 'start 3']);
  });

  it('goes on after a store fails to start or to close', async () => {
    const events: string[] = [];
    const stores = new StoreSequence();
    const closeFirst = stores.open(
      () => Promise.reject(new Error('bootstrap failed')),
      () => Promise.reject(new Error('close failed')),
    );
    await settle();
    closeFirst();
    stores.open(
      () => {
        events.push('start 2');
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    await settle();
    expect(events).toEqual(['start 2']);
  });
});
