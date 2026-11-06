/**
 * Convergence of one client against the fake hub under connection faults
 * (SPEC-002 E1, E2, E8; the full multi-client simulation is PLAN-002 S9).
 *
 * Random server writes interleave with drops, server restarts, lost packets,
 * repeated messages, pruned history and timer ticks. After the faults stop
 * and one more write arrives (a lost packet is only noticed on the next
 * message), the client's rows and position must equal the server's, and so
 * must what it stored: a warm start from the same storage shows the same.
 */
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { MemoryStorage } from '../src/storage/memory.js';
import { FakeHub } from './support/hub.js';
import { TEST_MODELS } from './support/models.js';
import { clientItems, liveStore, serverItems, until } from './support/live.js';
import { PROPERTY_SEED } from './support/fc.js';

type Command =
  | { kind: 'upsert'; n: number; title: string }
  | { kind: 'archive' | 'unarchive' | 'remove'; n: number }
  | { kind: 'invisible' | 'drop' | 'restart' | 'lose' | 'repeat' | 'prune' | 'tick' }
  | { kind: 'yield'; turns: number };

const n = fc.integer({ min: 1, max: 5 });
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('upsert' as const),
      n,
      title: fc.constantFrom('A', 'B', 'C'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom('archive' as const, 'unarchive' as const, 'remove' as const),
      n,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        'invisible' as const,
        'drop' as const,
        'restart' as const,
        'lose' as const,
        'repeat' as const,
        'prune' as const,
        'tick' as const,
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('yield' as const),
      turns: fc.integer({ min: 1, max: 5 }),
    }),
  },
);

it('converges on the server state whatever the connection does', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { maxLength: 40 }), async (commands) => {
      const hub = new FakeHub();
      for (const k of [1, 2, 3]) hub.upsert(k);
      const storage = new MemoryStorage(TEST_MODELS.map((model) => model.name));
      const connectStorage = () => Promise.resolve(storage);
      const { store, timers } = liveStore(hub, { connectStorage });
      await store.start();
      let loseNext = false;

      /** A server write, losing its packet on the live connection if asked to. */
      const write = (apply: () => void) => {
        const connection = hub.live.at(-1);
        if (loseNext && connection) {
          connection.paused = true;
          apply();
          connection.lose();
          connection.paused = false;
          loseNext = false;
        } else apply();
      };

      for (const c of commands) {
        switch (c.kind) {
          case 'upsert':
            write(() => hub.upsert(c.n, { title: c.title }));
            break;
          case 'archive':
          case 'unarchive':
            write(() => hub.archive(c.n, c.kind === 'archive'));
            break;
          case 'remove':
            write(() => hub.remove(c.n));
            break;
          case 'invisible':
            hub.invisible();
            break;
          case 'drop':
            hub.live.at(-1)?.close(1006);
            break;
          case 'restart':
            for (const connection of hub.live) connection.close(1012);
            break;
          case 'lose':
            loseNext = true;
            break;
          case 'repeat':
            hub.live.at(-1)?.repeat();
            break;
          case 'prune':
            hub.retainedFrom = hub.head;
            break;
          case 'tick':
            timers.runNext();
            break;
          case 'yield':
            for (let i = 0; i < c.turns; i += 1) await Promise.resolve();
            break;
        }
      }

      // Quiesce: let every reconnect and resync run to the end, then one more write.
      loseNext = false;
      const settled = () =>
        (store.status === 'ready' || store.status === 'failed') &&
        (store.connection === 'online' || store.connection === 'offline');
      let probed = false;
      for (let round = 0; round < 50; round += 1) {
        await until(settled);
        if (store.connection === 'offline') {
          timers.runNext();
          continue;
        }
        if (!probed) {
          hub.upsert(1, { title: 'probe' });
          probed = true;
          continue;
        }
        break;
      }

      expect(store.status).toBe('ready');
      expect(store.connection).toBe('online');
      expect(clientItems(store)).toEqual(serverItems(hub));
      expect(store.position?.lastSyncId).toBe(hub.last.sent);
      const position = store.position?.lastSyncId;
      await store.close(); // waits for every queued write

      const reopened = liveStore(hub, { connectStorage }).store;
      expect(await reopened.start()).toBe('warm');
      expect(clientItems(reopened)).toEqual(serverItems(hub));
      expect(reopened.position?.lastSyncId).toBe(position);
      await reopened.close();
    }),
    { seed: PROPERTY_SEED, numRuns: 200 },
  );
}, 120_000);
