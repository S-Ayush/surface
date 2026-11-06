/**
 * The overlay with 1,000 pending mutations (a long offline session). A new
 * dispatch must still show in the same frame (SPEC-002 AC-5, < 16 ms), and a
 * full rebuild (a confirm, or a delta to a row the mutations use) must stay
 * well inside a frame too.
 *
 * Node, not a browser: a guard against regressions (an accidental O(n²)),
 * not the real measurement, which is in the nightly perf suite (PLAN-002 S10).
 */
import { expect, it } from 'vitest';
import { OverlayEngine } from '../src/overlay.js';
import type { OverlayMutation } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
import { DebugItem, TEST_MODELS, debugRow, id } from './support/models.js';
import { debugCreate, debugRename, debugTouch } from './support/ops.js';

const PENDING = 1000;
const FRAME_MS = 16;

it(`pushes onto and rebuilds ${PENDING} pending mutations within a frame`, () => {
  const pool = new ObjectPool(TEST_MODELS);
  pool.loadBase(
    'DebugItem',
    Array.from({ length: 200 }, (_, i) => ({ row: debugRow(i + 1), archived: false })),
  );
  const engine = new OverlayEngine(pool, () => undefined);
  const now = new Date('2026-11-06T10:00:00.000Z');
  const mutations: OverlayMutation[] = Array.from({ length: PENDING }, (_, i) => {
    const key = `c:${i + 1}`;
    if (i % 10 === 9) {
      const created = `0190f4c4-0000-7000-8000-${String(i).padStart(12, '0')}`;
      return { key, op: debugCreate, input: { id: created, title: `New ${i}` }, now };
    }
    if (i % 2 === 0) return { key, op: debugTouch, input: { id: id((i % 200) + 1) }, now };
    return { key, op: debugRename, input: { id: id((i % 200) + 1), title: `T${i}` }, now };
  });

  for (const mutation of mutations) engine.push(mutation);
  const next = { key: 'c:1001', op: debugTouch, input: { id: id(1) }, now };

  // The best of a few runs, to keep machine noise out.
  let rebuild = Number.POSITIVE_INFINITY;
  let push = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let started = performance.now();
    engine.rebuild(mutations);
    rebuild = Math.min(rebuild, performance.now() - started);
    started = performance.now();
    engine.push(next);
    push = Math.min(push, performance.now() - started);
  }

  expect(pool.count(DebugItem)).toBe(300);
  expect(pool.get(DebugItem, id(1))?.counter).toBe(1 + 5 + 1);
  expect(rebuild, `rebuild took ${rebuild.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
  expect(push, `push took ${push.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
});
