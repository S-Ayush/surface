import { describe, expect, it } from 'vitest';
import {
  ALL_OPERATIONS,
  createRegistry,
  definitionProblems,
  OperationDefinitionError,
  registry,
} from '../src/index.js';
import { teamList, teamUpdate } from './fixtures.js';

describe('createRegistry', () => {
  it('looks operations up by name and lists them in declaration order', () => {
    const reg = createRegistry([teamUpdate, teamList]);
    expect(reg.get('team.update')).toBe(teamUpdate);
    expect(reg.has('team.list')).toBe(true);
    expect(reg.get('team.delete')).toBeUndefined();
    expect(reg.list().map((op) => op.name)).toEqual(['team.update', 'team.list']);
    expect(reg.size).toBe(2);
  });

  it('rejects two operations with the same name', () => {
    expect(() => createRegistry([teamUpdate, teamList, teamUpdate])).toThrow(
      new OperationDefinitionError('team.update', [
        'name is already registered. Operation names must be unique',
      ]),
    );
  });

  it('does not let callers mutate the list', () => {
    const reg = createRegistry([teamUpdate]);
    expect(Object.isFrozen(reg.list())).toBe(true);
  });
});

describe('the built-in registry', () => {
  it('holds every operation in ALL_OPERATIONS, each one valid', () => {
    expect(registry.size).toBe(ALL_OPERATIONS.length);
    for (const op of ALL_OPERATIONS) {
      expect(registry.get(op.name)).toBe(op);
      expect(definitionProblems(op)).toEqual([]);
    }
  });
});
