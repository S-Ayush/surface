// SPEC-011 AC-12 (PLAN-011 S4): every operation of SPEC-011 §6.1 is registered, public, of the
// kind the spec gives, and passes the registry lint (the registry-wide run is `lint.test.ts`; the
// examples run against the seed in server/test/registry-contract.int.test.ts).
import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS, type AnyOperation } from '../src/index.js';
import { lintOperations } from '../src/lint.js';

type Kind = AnyOperation['kind'];

/** SPEC-011 §6.1, in its order. */
const SPEC_011_OPERATIONS: readonly (readonly [string, Kind])[] = [
  ['issue.create', 'mutation'],
  ['issue.update', 'mutation'],
  ['issue.updateDescription', 'mutation'],
  ['issue.get', 'query'],
  ['issue.list', 'query'],
  ['issue.count', 'query'],
  ['issue.groupBy', 'query'],
];

const registered = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));

describe('SPEC-011 operations (AC-12)', () => {
  it.each(SPEC_011_OPERATIONS)(
    'registers %s as a public %s that passes the registry lint',
    (name, kind) => {
      const op = registered.get(name);
      expect(op, `${name} is not registered`).toBeDefined();
      if (!op) return;
      expect([op.kind, op.internal ?? false]).toEqual([kind, false]);
      expect(lintOperations([op])).toEqual([]);
    },
  );

  it('offers "Create issue…" in the team and global contexts, and no command for issue.update', () => {
    expect(registered.get('issue.create')?.ui).toMatchObject({
      title: 'Create issue…',
      contexts: ['team', 'global'],
    });
    expect(registered.get('issue.update')?.ui).toBeUndefined();
    expect(registered.get('issue.updateDescription')?.ui).toBeUndefined();
  });

  it('gives the web-used mutations a prediction (§6.2)', () => {
    expect(typeof registered.get('issue.create')?.optimistic).toBe('function');
    expect(typeof registered.get('issue.update')?.optimistic).toBe('function');
    expect(typeof registered.get('issue.updateDescription')?.optimistic).toBe('function');
  });

  it('loads the issue’s content before predicting a description save (§6.2)', () => {
    expect(
      registered.get('issue.updateDescription')?.contentParent?.({
        issue: 'ENG-1',
        baseVersion: 1,
        description: 'x',
      }),
    ).toEqual({ model: 'Issue', id: 'ENG-1' });
  });
});
