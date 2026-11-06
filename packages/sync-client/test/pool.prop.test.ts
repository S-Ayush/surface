/**
 * Model-based property test for the pool and its indexes: any sequence of base
 * changes, overlays, tracked and untracked reads, and reactions starting and
 * stopping keeps the pool equal to a plain reference model, keeps every index
 * equal to a full scan, and keeps every live reaction up to date.
 */
import fc from 'fast-check';
import { autorun } from 'mobx';
import { expect, it } from 'vitest';
import { ObjectPool } from '../src/pool.js';
import { PROPERTY_RUNS, PROPERTY_SEED } from './support/fc.js';
import { DebugItem, TEST_MODELS, debugRow, id } from './support/models.js';

const IDS = [1, 2, 3, 4] as const;
const TITLES = ['A', 'B', 'C'] as const;

type Command =
  | { kind: 'upsert'; n: number; title: string }
  | { kind: 'archive' | 'unarchive' | 'delete'; n: number }
  | { kind: 'overlay'; n: number; title: string | null }
  | { kind: 'clearOverlay'; n: number }
  | { kind: 'watchRow'; n: number }
  | { kind: 'watchIndex'; title: string }
  | { kind: 'unwatch'; index: number }
  | { kind: 'peekRow'; n: number }
  | { kind: 'peekIndex'; title: string };

const n = fc.constantFrom(...IDS);
const title = fc.constantFrom(...TITLES);
const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('upsert' as const), n, title }),
  fc.record({
    kind: fc.constantFrom('archive' as const, 'unarchive' as const, 'delete' as const),
    n,
  }),
  fc.record({ kind: fc.constant('overlay' as const), n, title: fc.option(title, { nil: null }) }),
  fc.record({ kind: fc.constant('clearOverlay' as const), n }),
  fc.record({ kind: fc.constant('watchRow' as const), n }),
  fc.record({ kind: fc.constant('watchIndex' as const), title }),
  fc.record({ kind: fc.constant('unwatch' as const), index: fc.nat({ max: 5 }) }),
  fc.record({ kind: fc.constant('peekRow' as const), n }),
  fc.record({ kind: fc.constant('peekIndex' as const), title }),
);

interface View {
  title: string;
  archived: boolean;
}

it('pool, indexes and reactions always match a reference model', () => {
  fc.assert(
    fc.property(fc.array(command, { maxLength: 60 }), (commands) => {
      const pool = new ObjectPool(TEST_MODELS);
      const base = new Map<number, View>();
      const overlay = new Map<number, View | null>();
      const viewOf = (k: number): View | undefined => {
        const o = overlay.get(k);
        return o === undefined ? base.get(k) : (o ?? undefined);
      };
      const describeRow = (k: number) => {
        const v = viewOf(k);
        return v ? `${v.title}${v.archived ? '/archived' : ''}` : 'absent';
      };
      const scan = (t: string) => IDS.filter((k) => viewOf(k)?.title === t).map(id);

      const watchers: { expected: () => string; seen: string; dispose: () => void }[] = [];

      for (const c of commands) {
        switch (c.kind) {
          case 'upsert': {
            pool.applyBase([
              { kind: 'upsert', model: 'DebugItem', row: debugRow(c.n, { title: c.title }) },
            ]);
            base.set(c.n, { title: c.title, archived: base.get(c.n)?.archived ?? false });
            break;
          }
          case 'archive':
          case 'unarchive':
          case 'delete': {
            pool.applyBase([{ kind: c.kind, model: 'DebugItem', id: id(c.n) }]);
            const current = base.get(c.n);
            if (current === undefined) break;
            if (c.kind === 'delete') base.delete(c.n);
            else base.set(c.n, { ...current, archived: c.kind === 'archive' });
            break;
          }
          case 'overlay': {
            const state = c.title === null ? null : { title: c.title, archived: false };
            pool.setOverlay(
              'DebugItem',
              id(c.n),
              state && { row: debugRow(c.n, { title: state.title }), archived: false },
            );
            overlay.set(c.n, state);
            break;
          }
          case 'clearOverlay': {
            pool.setOverlay('DebugItem', id(c.n), undefined);
            overlay.delete(c.n);
            break;
          }
          case 'watchRow': {
            const k = c.n;
            const watcher = { expected: () => describeRow(k), seen: '', dispose: () => {} };
            watcher.dispose = autorun(() => {
              const item = pool.get(DebugItem, id(k));
              watcher.seen = item ? `${item.title}${item.$archived ? '/archived' : ''}` : 'absent';
            });
            watchers.push(watcher);
            break;
          }
          case 'watchIndex': {
            const t = c.title;
            const watcher = { expected: () => scan(t).join(), seen: '', dispose: () => {} };
            watcher.dispose = autorun(() => {
              watcher.seen = pool
                .findBy(DebugItem, 'title', t)
                .map((item) => item.id)
                .sort()
                .join();
            });
            watchers.push(watcher);
            break;
          }
          case 'unwatch': {
            const [watcher] = watchers.splice(c.index % Math.max(watchers.length, 1), 1);
            watcher?.dispose();
            break;
          }
          case 'peekRow':
            pool.get(DebugItem, id(c.n));
            break;
          case 'peekIndex':
            pool.findBy(DebugItem, 'title', c.title);
            break;
        }

        for (const k of IDS) {
          const item = pool.get(DebugItem, id(k));
          const actual = item ? `${item.title}${item.$archived ? '/archived' : ''}` : 'absent';
          expect(actual, `row ${k}`).toBe(describeRow(k));
        }
        for (const t of TITLES) {
          const actual = pool
            .findBy(DebugItem, 'title', t)
            .map((item) => item.id)
            .sort();
          expect(actual, `index ${t}`).toEqual(scan(t));
        }
        expect(pool.count(DebugItem)).toBe(IDS.filter((k) => viewOf(k)).length);
        for (const watcher of watchers)
          expect(watcher.seen, 'live reaction').toBe(watcher.expected());
      }
      for (const watcher of watchers) watcher.dispose();
    }),
    { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
  );
});
