/**
 * AC-7 (unit level) and SPEC-002 §3.5: a mutation the server rejects is
 * removed, its effect rolls back within the round-trip, the base state is
 * untouched, and the rejection is reported once (the toast).
 */
import { describe, expect, it, vi } from 'vitest';
import { FakeHub } from './support/hub.js';
import { clientItems, liveStore, serverItems, until } from './support/live.js';
import { DebugItem, id } from './support/models.js';
import { debugBroken, debugCreate, debugRename, debugTouch } from './support/ops.js';

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

describe('a rejected mutation (AC-7)', () => {
  it('rolls back, leaves the base alone, and is reported once', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');
    // Deleted on the server, but this client has not heard yet.
    hub.last.paused = true;
    hub.remove(1);

    const outcome = store.dispatch(debugRename, { id: id(1), title: 'Too late' });
    void store.dispatch(debugTouch, { id: id(2) }); // an unrelated change stays
    expect(store.pool.get(DebugItem, id(1))?.title).toBe('Too late');

    expect(await outcome).toEqual({
      status: 'rejected',
      error: { code: 'NOT_FOUND', message: 'Debug item not found. It may have been deleted.' },
    });
    // Back to the base row at once, before the delete itself arrives.
    expect(store.pool.get(DebugItem, id(1))?.title).toBe('Item 1');
    expect(store.pool.get(DebugItem, id(2))?.counter).toBe(3);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledWith({
      op: 'debug.rename',
      seq: 1,
      input: { id: id(1), title: 'Too late' },
      code: 'NOT_FOUND',
      message: 'Debug item not found. It may have been deleted.',
    });
    expect(store.rejections).toHaveLength(1);
    expect(store.pending.map((p) => p.op)).toEqual(['debug.touch']);

    hub.last.paused = false;
    hub.last.deliver();
    await until(() => store.pending.length === 0);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});

describe("a rejection's issues", () => {
  it('reach the outcome and the handler, so a form can show each on its field', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');

    const outcome = await store.dispatch(debugCreate, { id: id(1), title: 'Again' });

    const message = 'A debug item with this id exists.';
    const issues = [{ path: ['id'], message }];
    expect(outcome).toEqual({ status: 'rejected', error: { code: 'CONFLICT', message, issues } });
    expect(onRejected).toHaveBeenCalledWith({
      op: 'debug.create',
      seq: 1,
      input: { id: id(1), title: 'Again' },
      code: 'CONFLICT',
      message,
      issues,
    });
    await store.close();
  });

  it('are absent when the server sends none', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);

    const outcome = await store.dispatch(debugRename, { id: id(1), title: 'Too late' });

    expect(outcome.status === 'rejected' && 'issues' in outcome.error).toBe(false);
    expect(onRejected.mock.calls[0]?.[0]).not.toHaveProperty('issues');
    await store.close();
  });
});

describe('the onRejected handler (review m2)', () => {
  it('runs after the rollback, so it sees the store as the user will', async () => {
    const hub = seededHub();
    const seen: unknown[] = [];
    const { store } = liveStore(hub, {
      onRejected: () => {
        seen.push(store.pool.get(DebugItem, id(1))?.title, store.pending.length);
      },
    });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);
    await store.dispatch(debugRename, { id: id(1), title: 'Too late' });
    expect(seen).toEqual(['Item 1', 0]);
    await store.close();
  });

  it('cannot stall the queue by throwing', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub, {
      onRejected: () => {
        throw new Error('bug in the toast');
      },
    });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);
    const rejected = store.dispatch(debugRename, { id: id(1), title: 'Too late' });
    const next = store.dispatch(debugTouch, { id: id(2) });
    expect(await rejected).toMatchObject({ status: 'rejected' });
    hub.last.paused = false;
    hub.last.deliver();
    expect(await next).toEqual({ status: 'confirmed' });
    expect(store.rejections).toHaveLength(1);
    await store.close();
  });
});

describe('a caller that shows the refusal itself (reportRejection)', () => {
  it('keeps the onRejected handler quiet while it says so, and still records the rejection', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);

    const outcome = await store.dispatch(
      debugRename,
      { id: id(1), title: 'Too late' },
      { reportRejection: () => false },
    );

    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    expect(onRejected).not.toHaveBeenCalled();
    // The inspector still lists it.
    expect(store.rejections).toHaveLength(1);
    await store.close();
  });

  it('asks at the moment of the rejection, so a caller that stopped waiting gets the toast', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);
    let showing = true;

    const outcome = store.dispatch(
      debugRename,
      { id: id(1), title: 'Too late' },
      { reportRejection: () => !showing },
    );
    showing = false; // e.g. the dialog closed while waiting
    expect(await outcome).toMatchObject({ status: 'rejected' });
    expect(onRejected).toHaveBeenCalledOnce();
    await store.close();
  });

  it('reports a rejection by default, and when the flag itself throws', async () => {
    const hub = seededHub();
    const onRejected = vi.fn();
    const { store } = liveStore(hub, { onRejected });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.remove(1);
    hub.remove(2);

    await store.dispatch(debugRename, { id: id(1), title: 'Too late' });
    await store.dispatch(
      debugRename,
      { id: id(2), title: 'Too late' },
      {
        reportRejection: () => {
          throw new Error('bug in the form');
        },
      },
    );
    expect(onRejected).toHaveBeenCalledTimes(2);
    await store.close();
  });
});

describe('an optimistic() that throws', () => {
  it('shows no effect, does not disturb the others, and is still sent', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    void store.dispatch(debugTouch, { id: id(2) });
    const outcome = store.dispatch(debugBroken, { id: id(2), title: 'From the server' });
    void store.dispatch(debugTouch, { id: id(2) });
    expect(store.pool.get(DebugItem, id(2))?.title).toBe('Item 2');
    expect(store.pool.get(DebugItem, id(2))?.counter).toBe(4);

    await until(() => store.connection === 'online');
    expect(await outcome).toEqual({ status: 'confirmed' });
    await until(() => store.pending.length === 0);
    expect(store.pool.get(DebugItem, id(2))?.title).toBe('From the server');
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});
