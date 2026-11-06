/**
 * Exactly once (SPEC-002 AC-3, E3, E4; client side): whatever happens to
 * requests, responses, the socket and the tab, every dispatched `debug.touch`
 * is applied by the server exactly once. Requests fail, responses get lost,
 * the socket drops and the tab reloads (adopting its queue) in random order;
 * once the faults stop, every counter equals its touches, the client shows
 * the server's state and nothing is left pending. The multi-client
 * simulation with crashes is PLAN-002 S9.
 */
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import type { StorageConnector } from '../src/storage/open.js';
import { FakeHub } from './support/hub.js';
import { clientItems, liveStore, serverItems, until } from './support/live.js';
import { id } from './support/models.js';
import { debugTouch } from './support/ops.js';
import { PROPERTY_SEED } from './support/fc.js';
import { uniqueName } from './support/storage.js';

type Command =
  | { kind: 'touch'; n: number }
  | { kind: 'fail' | 'lose' | 'stall' | 'drop' | 'tick' | 'reload' | 'yield' };

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('touch' as const),
      n: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        'fail' as const,
        'lose' as const,
        'stall' as const,
        'drop' as const,
        'tick' as const,
        'reload' as const,
        'yield' as const,
      ),
    }),
  },
);

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const connectStorage: StorageConnector = (name, models) => IndexedDbStorage.open(name, models);

it('applies every mutation exactly once through faults and reloads', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(command, { minLength: 5, maxLength: 40, size: 'max' }),
      async (commands) => {
        const hub = new FakeHub();
        for (const k of [1, 2, 3]) hub.upsert(k);
        const workspaceId = uniqueName('ws');
        const open = () => liveStore(hub, { workspaceId, connectStorage, clientId: undefined });
        let tab = open();
        await tab.store.start();
        const touches = new Map<number, number>();

        for (const c of commands) {
          switch (c.kind) {
            case 'touch':
              void tab.store.dispatch(debugTouch, { id: id(c.n) });
              touches.set(c.n, (touches.get(c.n) ?? 0) + 1);
              break;
            case 'fail':
              hub.failRequests += 1;
              break;
            case 'lose':
              hub.loseResponses += 1;
              break;
            case 'stall': {
              // Deltas (and acks) are held back until the socket drops or the faults stop,
              // so a lost response can only be recovered by a resend.
              const connection = hub.live.at(-1);
              if (connection) connection.paused = true;
              break;
            }
            case 'drop':
              hub.live.at(-1)?.close(1006);
              break;
            case 'tick':
              tab.timers.runNext();
              break;
            case 'reload':
              await tab.store.close();
              tab = open();
              await tab.store.start();
              break;
            case 'yield':
              await macrotask();
              break;
          }
        }

        // Quiesce: no new faults (queued ones still hit the next sends), stalled
        // sockets resume; let reconnects and retries run until nothing is pending.
        const { store, timers } = tab;
        for (const connection of hub.live) {
          connection.paused = false;
          connection.deliver();
        }
        for (let round = 0; round < 100; round += 1) {
          await until(() => store.status === 'ready' && store.connection !== 'connecting');
          if (store.connection === 'online' && store.pending.length === 0) break;
          await macrotask();
          if (store.connection === 'online' && store.pending.length === 0) break;
          timers.runNext();
        }

        expect(store.pending).toEqual([]);
        for (const k of [1, 2, 3]) {
          expect(hub.rows.get(id(k))?.row['counter']).toBe(k + (touches.get(k) ?? 0));
        }
        const total = [...touches.values()].reduce((sum, count) => sum + count, 0);
        expect(hub.executed('debug.touch')).toBe(total);
        expect(clientItems(store)).toEqual(serverItems(hub));
        await store.close();
      },
    ),
    { seed: PROPERTY_SEED, numRuns: 100 },
  );
}, 120_000);
