/**
 * References inside `optimistic()` resolve against the overlay being built
 * (review m3): base plus the mutations before this one, never what the
 * screen showed before the rebuild. So a replay is deterministic, and a
 * mutation that depended on a rolled-back one loses its effect with it.
 */
import { defineOperation } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
import { id } from './support/models.js';
import { REF_FIXTURE_MODELS, Team } from './support/ref-models.js';

const fixture = {
  domain: 'team' as const,
  permission: () => true,
  destructive: false,
  internal: true,
  output: z.object({ id: z.uuid() }),
  kind: 'mutation' as const,
};

const rekey = defineOperation({
  ...fixture,
  name: 'team.rekey',
  summary: 'Change a team key',
  description: 'Changes the key of a team. For overlay tests.',
  keywords: ['team key', 'rekey team'],
  input: z.object({ id: z.uuid(), key: z.string() }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', key: 'ENX' }],
  optimistic(store, input) {
    store.patch('Team', input.id, { key: input.key });
  },
});

const rename = defineOperation({
  ...fixture,
  name: 'team.rename',
  summary: 'Rename a team by reference',
  description: 'Renames the team a reference names. For overlay tests.',
  keywords: ['rename team', 'team name'],
  input: z.object({ team: z.string(), name: z.string() }),
  examples: [{ team: 'ENG', name: 'Engineering' }],
  optimistic(store, input) {
    store.patch('Team', input.team, { name: input.name });
  },
});

const ENG = id(1);
const now = new Date('2026-11-06T10:00:00.000Z');
const mutation = (
  key: string,
  op: typeof rekey | typeof rename,
  input: unknown,
): OverlayMutation => ({
  key,
  op,
  input,
  now,
});

function setup() {
  const pool = new ObjectPool(REF_FIXTURE_MODELS);
  pool.loadBase('Team', [
    { row: { id: ENG, key: 'ENG', name: 'Engineering', private: false }, archived: false },
  ]);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const toEnx = mutation('c:1', rekey, { id: ENG, key: 'ENX' });
const renameEnx = mutation('c:2', rename, { team: 'ENX', name: 'Platform' });

describe('references in a rebuild', () => {
  it('see the mutations before them', () => {
    const { pool, engine } = setup();
    engine.rebuild([toEnx, renameEnx]);
    expect(pool.get(Team, ENG)).toMatchObject({ key: 'ENX', name: 'Platform' });
  });

  it('lose their effect when the mutation they depended on is rolled back', () => {
    const { pool, engine } = setup();
    engine.push(toEnx);
    engine.push(renameEnx);
    expect(pool.get(Team, ENG)).toMatchObject({ key: 'ENX', name: 'Platform' });

    engine.rebuild([renameEnx]); // the rekey was rejected
    expect(pool.get(Team, ENG)).toMatchObject({ key: 'ENG', name: 'Engineering' });
  });

  it('make a change to any row of a model they searched by name rebuild the overlay', () => {
    const { engine } = setup();
    engine.rebuild([renameEnx]); // nothing is called ENX yet
    // A delta adding a team keyed ENX would change the result.
    expect(engine.dependsOn('Team', id(2))).toBe(true);
    expect(engine.dependsOn('User', id(2))).toBe(false);
  });
});
