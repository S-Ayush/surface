/**
 * The overlay with 1,000 pending mutations (a long offline session). A new
 * dispatch must still show in the same frame (SPEC-002 AC-5, < 16 ms), and a
 * full rebuild (a confirm, or a delta to a row the mutations use) must stay
 * well inside a frame too.
 *
 * Node, not a browser: a guard against regressions (an accidental O(n²)),
 * not the real measurement, which is in the nightly perf suite (PLAN-002 S10).
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { Issue, PRODUCTION_MODELS } from '@surface/domain/model';
import { issueUpdate } from '@surface/operations';
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

const ISSUES = 10_000;
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const STATUS = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const USER = '0192f0c1-7e5a-7b3c-9d4e-0000000000e3';
const issueId = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;

// PLAN-011 S8 hardening: a replica's worth of issues in the base (SPEC-011 §10: a member's replica
// holds tens of thousands) under 1,000 pending issue edits, so an `IssueRef` resolved by scanning
// the held issues, or a rebuild that walks the base or every pending write, shows up here. It found
// one: each `find` scanned every pending write, so the rebuild was quadratic (about 60 ms).
it(`pushes one more of ${PENDING} pending issue edits within a frame, and rebuilds them in linear time, with ${ISSUES} issues in the base`, () => {
  const at = '2026-11-16T10:00:00.000Z';
  const pool = new ObjectPool(PRODUCTION_MODELS);
  pool.loadBase('Team', [
    {
      row: {
        ...NEW_TEAM_SETTINGS,
        id: TEAM,
        key: 'ENG',
        name: 'Engineering',
        icon: null,
        groups: ['workspace'],
        createdAt: at,
        updatedAt: at,
        defaultStatusId: STATUS,
      },
      archived: false,
    },
  ]);
  pool.loadBase(
    'Issue',
    Array.from({ length: ISSUES }, (_, i) => ({
      row: {
        id: issueId(i + 1),
        teamId: TEAM,
        number: i + 1,
        title: `Issue ${i + 1}`,
        statusId: STATUS,
        priority: 0,
        assigneeId: null,
        labelIds: [],
        estimate: null,
        dueDate: null,
        sortOrder: `a${String(ISSUES - i).padStart(6, '0')}`,
        creatorId: USER,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        archivedAt: null,
        deletedAt: null,
        deletedById: null,
        groups: [`team:${TEAM}`],
        createdAt: at,
        updatedAt: at,
      },
      archived: false,
    })),
  );
  expect(pool.count(Issue)).toBe(ISSUES);
  const engine = new OverlayEngine(pool, () => undefined);
  const now = new Date(at);
  // Edits spread over the whole list.
  const target = (i: number) => issueId(((i * 37) % ISSUES) + 1);
  const mutations: OverlayMutation[] = Array.from({ length: PENDING }, (_, i) => ({
    key: `c:${i + 1}`,
    op: issueUpdate,
    input:
      i % 2 === 0 ? { issue: target(i), title: `Edit ${i}` } : { issue: target(i), priority: 2 },
    now,
  }));

  for (const mutation of mutations) engine.push(mutation);
  const next: OverlayMutation = {
    key: `c:${PENDING + 1}`,
    op: issueUpdate,
    input: { issue: issueId(ISSUES), priority: 1 },
    now,
  };

  /** The best of ten rebuilds of `list`, to keep machine noise out. */
  const bestRebuild = (list: readonly OverlayMutation[]) => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = performance.now();
      engine.rebuild(list);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const quarter = bestRebuild(mutations.slice(0, PENDING / 4));
  const rebuild = bestRebuild(mutations);
  let push = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    engine.rebuild(mutations);
    const started = performance.now();
    engine.push(next);
    push = Math.min(push, performance.now() - started);
  }

  expect(pool.count(Issue)).toBe(ISSUES);
  expect(pool.get(Issue, target(998))?.title).toBe('Edit 998');
  expect(pool.get(Issue, target(999))?.priority).toBe(2);
  expect(pool.get(Issue, issueId(ISSUES))?.priority).toBe(1);
  // AC-5: a new edit shows in the same frame.
  expect(push, `push took ${push.toFixed(1)} ms`).toBeLessThan(FRAME_MS);
  // Linear in the pending edits: four times the edits, about four times the time (the quadratic
  // rebuild before the fix took ten to sixteen). A ratio, not a time: about 12 ms on an idle
  // laptop, but several times that under a parallel test run, which a frame budget can't absorb.
  expect(rebuild / quarter, `${rebuild.toFixed(1)} ms vs ${quarter.toFixed(1)} ms`).toBeLessThan(7);
});
