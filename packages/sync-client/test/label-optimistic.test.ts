/**
 * PLAN-010 S3, SPEC-010 AC-16 and AC-17 (label part): the label operations' `optimistic` run
 * through the real overlay against the production models, which drop a row they reject
 * (`archivedAt` is required, so a created row must carry `null`). A delete removes the Label row
 * only and comes back when the server refuses. That the predicted rows equal the server's is
 * checked in server/test/label-handlers.test.ts.
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { Label, PRODUCTION_MODELS } from '@surface/domain/model';
import { labelCreate, labelDelete, labelMoveToWorkspace, labelUpdate } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DEFECT = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
const SIZE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a3';
const SMALL = '0192f0c1-7e5a-7b3c-9d4e-0000000000a4';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const now = new Date('2026-11-13T10:00:00.000Z');
const AT = now.toISOString();

function label(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    row: {
      id,
      teamId: ENG,
      name,
      color: 'gray',
      description: null,
      parentId: null,
      isGroup: false,
      exclusive: true,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      ...extra,
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
        defaultStatusId: ENG,
      },
      archived: false,
    },
  ]);
  pool.loadBase('Label', [
    label(DEFECT, 'Defect'),
    label(SIZE, 'Size', { isGroup: true }),
    label(SMALL, 'Small', { parentId: SIZE }),
  ]);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const mutation = (
  key: string,
  op: OverlayMutation['op'],
  input: OverlayMutation['input'],
): OverlayMutation => ({ key, op, input, now });

describe('label operations in the overlay', () => {
  it('shows a created label at once, in its group, and drops it when the server rejects it', () => {
    const { pool, engine } = setup();
    engine.push(
      mutation('c:1', labelCreate, { id: NEW_ID, team: 'ENG', name: 'Large', group: 'Size/' }),
    );
    // "Size/" is not a valid reference: the prediction is skipped and nothing is shown.
    expect(pool.get(Label, NEW_ID)).toBeUndefined();

    engine.push(
      mutation('c:2', labelCreate, { id: NEW_ID, team: 'ENG', name: 'Large', group: 'Size' }),
    );
    expect(pool.get(Label, NEW_ID)).toMatchObject({
      name: 'Large',
      parentId: SIZE,
      archivedAt: null,
      exclusive: true,
    });
    engine.rebuild([]);
    expect(pool.get(Label, NEW_ID)).toBeUndefined();
  });

  it('applies a rename and a move into a group on top of each other', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelUpdate, { label: 'Defect', team: 'ENG', name: 'Bug' }));
    engine.push(mutation('c:2', labelUpdate, { label: 'Bug', team: 'ENG', group: 'Size' }));
    expect(pool.get(Label, DEFECT)).toMatchObject({ name: 'Bug', parentId: SIZE });
  });

  it('moves a group and its label to the workspace, and back to the team when the server refuses', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelMoveToWorkspace, { label: 'Size', team: 'ENG' }));
    expect(pool.get(Label, SIZE)?.teamId).toBeNull();
    expect(pool.get(Label, SMALL)?.teamId).toBeNull();
    expect(pool.get(Label, DEFECT)?.teamId).toBe(ENG);

    engine.rebuild([]);
    expect(pool.get(Label, SIZE)?.teamId).toBe(ENG);
    expect(pool.get(Label, SMALL)?.teamId).toBe(ENG);
  });

  it('removes a deleted label at once and brings it back when the server refuses (AC-17)', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelDelete, { label: 'Defect', team: 'ENG' }));
    expect(pool.get(Label, DEFECT)).toBeUndefined();

    engine.rebuild([]);
    expect(pool.get(Label, DEFECT)).toMatchObject({ name: 'Defect' });
  });

  it('keeps a group that still has labels, which the server refuses too', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelDelete, { label: 'Size', team: 'ENG' }));
    expect(pool.get(Label, SIZE)).toBeDefined();
  });
});
