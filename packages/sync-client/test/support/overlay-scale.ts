/**
 * The overlay under 1,000 pending mutations (a long offline session), for `overlay-scale.test.ts`
 * (what it computes, and the searches it does, in the gate) and `overlay.perf.test.ts` (how long
 * it takes, SPEC-002 AC-5's 16 ms frame, in `pnpm test:deep`).
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { issueUpdate } from '@surface/operations';
import { OverlayEngine } from '../../src/overlay.js';
import type { OverlayMutation } from '../../src/overlay.js';
import { ObjectPool } from '../../src/pool.js';
import { TEST_MODELS, debugRow, id } from './models.js';
import { debugCreate, debugRename, debugTouch } from './ops.js';

export const PENDING = 1000;

export interface OverlayScene {
  readonly pool: ObjectPool;
  readonly engine: OverlayEngine;
  /** The pending mutations, already pushed. */
  readonly mutations: readonly OverlayMutation[];
  /** One more mutation to push. */
  readonly next: OverlayMutation;
}

/** 200 debug rows under `PENDING` touches, renames and creates. */
export function debugScene(): OverlayScene {
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
  const next = { key: `c:${PENDING + 1}`, op: debugTouch, input: { id: id(1) }, now };
  return { pool, engine, mutations, next };
}

export const ISSUES = 10_000;
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const STATUS = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const USER = '0192f0c1-7e5a-7b3c-9d4e-0000000000e3';
export const issueId = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;
/** The issue the `i`th pending edit changes: edits spread over the whole list. */
export const editTarget = (i: number) => issueId(((i * 37) % ISSUES) + 1);

/**
 * PLAN-011 S8 hardening: a replica's worth of issues in the base (SPEC-011 §10: a member's replica
 * holds tens of thousands) under `PENDING` issue edits, so an `IssueRef` resolved by scanning the
 * held issues, or a rebuild that walks the base or every pending write, shows up.
 */
export function issueScene(): OverlayScene {
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
  const engine = new OverlayEngine(pool, () => undefined);
  const now = new Date(at);
  const mutations: OverlayMutation[] = Array.from({ length: PENDING }, (_, i) => ({
    key: `c:${i + 1}`,
    op: issueUpdate,
    input:
      i % 2 === 0
        ? { issue: editTarget(i), title: `Edit ${i}` }
        : { issue: editTarget(i), priority: 2 },
    now,
  }));
  for (const mutation of mutations) engine.push(mutation);
  const next: OverlayMutation = {
    key: `c:${PENDING + 1}`,
    op: issueUpdate,
    input: { issue: issueId(ISSUES), priority: 1 },
    now,
  };
  return { pool, engine, mutations, next };
}

/** The best of five timings of `run`, in ms, to keep machine noise out. */
export function bestOfFive(run: () => void, before: () => void = () => undefined): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    before();
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
