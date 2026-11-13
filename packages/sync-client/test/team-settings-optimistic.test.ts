/**
 * PLAN-010 S4, SPEC-010 AC-16: `team.setDefaultStatus` and `team.setEstimates` run through the
 * real overlay against the production models. The default status is patched with the resolved
 * id (never the ref text), a refused category predicts nothing, and both roll back when the
 * server rejects the mutation. That the predicted rows equal the server's is the operations'
 * own test (`operations/src/ops/team.test.ts`).
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { PRODUCTION_MODELS, Team } from '@surface/domain/model';
import { teamSetDefaultStatus, teamSetEstimates } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const TODO = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
const STARTED = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
const now = new Date('2026-11-13T10:00:00.000Z');
const AT = now.toISOString();

function status(id: string, name: string, category: string) {
  return {
    row: {
      id,
      teamId: ENG,
      name,
      category,
      color: 'gray',
      description: null,
      position: 'a0',
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
    status(BACKLOG, 'Backlog', 'backlog'),
    status(TODO, 'Todo', 'unstarted'),
    status(STARTED, 'In Progress', 'started'),
  ]);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const mutation = (
  key: string,
  op: OverlayMutation['op'],
  input: OverlayMutation['input'],
): OverlayMutation => ({ key, op, input, now });

describe('team.setDefaultStatus in the overlay (AC-16)', () => {
  it('shows the resolved status id at once and restores the old one when the server refuses', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', teamSetDefaultStatus, { team: 'ENG', status: 'todo' }));
    expect(pool.get(Team, ENG)?.defaultStatusId).toBe(TODO);

    engine.rebuild([]);
    expect(pool.get(Team, ENG)?.defaultStatusId).toBe(BACKLOG);
  });

  it('predicts nothing for a started status, which the server refuses (INV-05)', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', teamSetDefaultStatus, { team: 'ENG', status: 'In Progress' }));
    expect(pool.get(Team, ENG)?.defaultStatusId).toBe(BACKLOG);
  });
});

describe('team.setEstimates in the overlay (AC-16)', () => {
  it('shows the new scale and options at once, and restores them on a rollback', () => {
    const { pool, engine } = setup();
    engine.push(
      mutation('c:1', teamSetEstimates, { team: 'ENG', scale: 'tshirt', allowZero: true }),
    );
    expect(pool.get(Team, ENG)).toMatchObject({
      estimateScale: 'tshirt',
      estimateAllowZero: true,
      estimateExtended: false,
    });

    engine.rebuild([]);
    expect(pool.get(Team, ENG)).toMatchObject({
      estimateScale: NEW_TEAM_SETTINGS.estimateScale,
      estimateAllowZero: false,
    });
  });

  it('applies two changes on top of each other', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', teamSetEstimates, { team: 'ENG', scale: 'linear' }));
    engine.push(mutation('c:2', teamSetEstimates, { team: 'ENG', extended: true }));
    expect(pool.get(Team, ENG)).toMatchObject({ estimateScale: 'linear', estimateExtended: true });
  });
});
