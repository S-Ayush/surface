/**
 * PLAN-010 S2, SPEC-010 AC-16 (client half): the status operations' `optimistic` run through the
 * real overlay against the production models, which drop a row they reject. A delete shows
 * at once and rolls back when the server refuses (the issue half of AC-17 is PLAN-010 S5). That
 * the predicted rows equal the server's is checked in server/test/status-handlers.test.ts.
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { PRODUCTION_MODELS, Team, WorkflowStatus } from '@surface/domain/model';
import { statusCreate, statusDelete, statusReorder, statusUpdate } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const PROGRESS = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
const REVIEW = '0192f0c1-7e5a-7b3c-9d4e-0000000000b4';
const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b5';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const now = new Date('2026-11-12T10:00:00.000Z');
const AT = now.toISOString();

function status(id: string, name: string, category: string, position: string) {
  return {
    row: {
      id,
      teamId: ENG,
      name,
      category,
      color: 'gray',
      description: null,
      position,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
    },
    archived: false,
  };
}

function setup() {
  const pool = new ObjectPool(PRODUCTION_MODELS);
  pool.loadBase('Team', [
    {
      row: {
        ...NEW_TEAM_SETTINGS,
        id: ENG,
        key: 'ENG',
        name: 'Engineering',
        icon: null,
        groups: ['workspace'],
        createdAt: AT,
        updatedAt: AT,
        defaultStatusId: BACKLOG,
      },
      archived: false,
    },
  ]);
  pool.loadBase('WorkflowStatus', [
    status(BACKLOG, 'Backlog', 'backlog', 'a0'),
    status(PROGRESS, 'In Progress', 'started', 'a0'),
    status(REVIEW, 'In Review', 'started', 'a1'),
    status(DONE, 'Done', 'completed', 'a0'),
  ]);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const mutation = (
  key: string,
  op: OverlayMutation['op'],
  input: OverlayMutation['input'],
): OverlayMutation => ({ key, op, input, now });

describe('status operations in the overlay', () => {
  it('shows a created status at once, in order, and drops it when the server rejects it', () => {
    const { pool, engine } = setup();
    const create = mutation('c:1', statusCreate, {
      id: NEW_ID,
      team: 'ENG',
      name: 'QA',
      category: 'started',
      after: 'In Progress',
    });
    engine.push(create);
    expect(pool.get(WorkflowStatus, NEW_ID)).toMatchObject({ name: 'QA', category: 'started' });
    const created = pool.get(WorkflowStatus, NEW_ID)?.position ?? '';
    expect(created > 'a0' && created < 'a1').toBe(true);

    engine.rebuild([]);
    expect(pool.get(WorkflowStatus, NEW_ID)).toBeUndefined();
  });

  it('applies an update and a reorder on top of each other, writing only the moved row', () => {
    const { pool, engine } = setup();
    engine.push(
      mutation('c:1', statusUpdate, { team: 'ENG', status: 'In Review', name: 'Review' }),
    );
    engine.push(
      mutation('c:2', statusReorder, { team: 'ENG', status: 'Review', before: 'In Progress' }),
    );
    expect(pool.get(WorkflowStatus, REVIEW)).toMatchObject({ name: 'Review' });
    expect((pool.get(WorkflowStatus, REVIEW)?.position ?? 'z') < 'a0').toBe(true);
    expect(pool.get(WorkflowStatus, PROGRESS)?.position).toBe('a0');
  });

  it('removes a deleted status at once and brings it back when the server refuses', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', statusDelete, { team: 'ENG', status: 'In Review' }));
    expect(pool.get(WorkflowStatus, REVIEW)).toBeUndefined();

    engine.rebuild([]); // the server's CONFLICT: the issues were ones this client doesn't hold
    expect(pool.get(WorkflowStatus, REVIEW)).toMatchObject({ name: 'In Review' });
  });

  it('keeps the row of a delete the pure rules refuse, so nothing flickers', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', statusDelete, { team: 'ENG', status: 'Backlog' }));
    engine.push(mutation('c:2', statusDelete, { team: 'ENG', status: 'Done' }));
    expect(pool.get(WorkflowStatus, BACKLOG)).toBeDefined();
    expect(pool.get(WorkflowStatus, DONE)).toBeDefined();
    expect(pool.get(Team, ENG)).toBeDefined();
  });
});
