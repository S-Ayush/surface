/**
 * PLAN-010 S6, SPEC-010 AC-11 and AC-16 (archive part): `label.archive` and `label.unarchive`
 * through the real overlay against the production models. The archive flag is read from
 * `archivedAt` (SPEC-011 §5.5), a group takes its labels with it (D26), E14 is refused like the
 * server does, and the rows come back when the server rejects the change.
 */
import { NEW_TEAM_SETTINGS } from '@surface/domain';
import { Label, PRODUCTION_MODELS } from '@surface/domain/model';
import { labelArchive, labelUnarchive } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DEFECT = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
const SIZE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a3';
const SMALL = '0192f0c1-7e5a-7b3c-9d4e-0000000000a4';
const LARGE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a5';
const now = new Date('2026-11-13T10:00:00.000Z');
const AT = now.toISOString();
const EARLIER = '2026-11-12T10:00:00.000Z';

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
    archived: extra['archivedAt'] != null,
  };
}

function setup(groupArchived = false) {
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
  const archivedAt = groupArchived ? { archivedAt: EARLIER } : {};
  pool.loadBase('Label', [
    label(DEFECT, 'Defect'),
    label(SIZE, 'Size', { isGroup: true, ...archivedAt }),
    label(SMALL, 'Small', { parentId: SIZE, ...archivedAt }),
    label(LARGE, 'Large', { parentId: SIZE, archivedAt: EARLIER }),
  ]);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const mutation = (
  key: string,
  op: OverlayMutation['op'],
  input: OverlayMutation['input'],
): OverlayMutation => ({ key, op, input, now });

describe('label archive in the overlay (AC-11, AC-16)', () => {
  it('archives a label at once, sets archivedAt, and rolls back when the server refuses', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelArchive, { label: 'Defect', team: 'ENG' }));
    expect(pool.get(Label, DEFECT)).toMatchObject({ archivedAt: AT, $archived: true });
    engine.rebuild([]);
    expect(pool.get(Label, DEFECT)).toMatchObject({ archivedAt: null, $archived: false });
  });

  it('archives a group with its labels and leaves the already archived one as it was', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelArchive, { label: 'Size', team: 'ENG' }));
    expect(pool.get(Label, SIZE)?.archivedAt).toBe(AT);
    expect(pool.get(Label, SMALL)?.archivedAt).toBe(AT);
    expect(pool.get(Label, LARGE)?.archivedAt).toBe(EARLIER);
    expect(pool.get(Label, DEFECT)?.archivedAt).toBeNull();
  });

  it('archives one label of a group alone, found as Group/Label', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', labelArchive, { label: 'Size/Small', team: 'ENG' }));
    expect(pool.get(Label, SMALL)?.archivedAt).toBe(AT);
    expect(pool.get(Label, SIZE)?.archivedAt).toBeNull();
  });

  it('unarchives a group with all its labels, and archives them again on rollback', () => {
    const { pool, engine } = setup(true);
    engine.push(mutation('c:1', labelUnarchive, { label: 'Size', team: 'ENG' }));
    for (const id of [SIZE, SMALL, LARGE]) {
      expect(pool.get(Label, id), id).toMatchObject({ archivedAt: null, $archived: false });
    }
    engine.rebuild([]);
    expect(pool.get(Label, SMALL)?.archivedAt).toBe(EARLIER);
  });

  it('predicts nothing for a label in an archived group (E14)', () => {
    const { pool, engine } = setup(true);
    engine.push(mutation('c:1', labelUnarchive, { label: 'Size/Small', team: 'ENG' }));
    expect(pool.get(Label, SMALL)?.archivedAt).toBe(EARLIER);
  });
});
