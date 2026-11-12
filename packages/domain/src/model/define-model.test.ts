import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RowOfModel, DebugItem } from './index.js';
import {
  array,
  backRef,
  bool,
  defineModel,
  enumOf,
  int,
  json,
  jsonEquals,
  ref,
  str,
  timestamp,
  uuid,
} from './index.js';

const ID = '0192f5a4-1c2b-7d3e-8f40-123456789abc';

const Team = defineModel('Team', {
  load: 'eager',
  fields: {
    key: str(),
    name: str(),
    icon: str().nullable(),
    private: bool(),
    cycleLength: int(),
    tier: enumOf(['free', 'pro']),
    settings: json(),
    createdAt: timestamp(),
    leadId: uuid().nullable(),
    tags: array(str()),
  },
  refs: { lead: ref('User', 'leadId'), memberships: backRef('TeamMembership', 'teamId') },
  indexes: ['key'],
});

const teamRow = {
  id: ID,
  key: 'ENG',
  name: 'Engineering',
  icon: null,
  private: false,
  cycleLength: 2,
  tier: 'pro',
  settings: { estimates: [1, 2, 3] },
  createdAt: '2026-11-06T10:00:00.000Z',
  leadId: null,
  tags: ['core'],
};

describe('defineModel', () => {
  it('infers the row type from the fields, with an implicit id (SPEC-002 §5.3)', () => {
    expectTypeOf<RowOfModel<typeof DebugItem>>().toEqualTypeOf<{
      readonly id: string;
      readonly title: string;
      readonly counter: number;
      readonly groups: string[];
      readonly archivedAt: string | null;
    }>();
    expectTypeOf<RowOfModel<typeof Team>['icon']>().toEqualTypeOf<string | null>();
    expectTypeOf<RowOfModel<typeof Team>['tier']>().toEqualTypeOf<'free' | 'pro'>();
  });

  it('exposes what the schema hash needs: name, load, and each field type and nullability', () => {
    expect(Team.name).toBe('Team');
    expect(Team.load).toBe('eager');
    expect(
      Object.fromEntries(Object.entries(Team.fields).map(([n, f]) => [n, [f.type, f.nullable]])),
    ).toEqual({
      id: ['uuid', false],
      key: ['string', false],
      name: ['string', false],
      icon: ['string', true],
      private: ['bool', false],
      cycleLength: ['int', false],
      tier: ['enum<free|pro>', false],
      settings: ['json', false],
      createdAt: ['timestamp', false],
      leadId: ['uuid', true],
      tags: ['array<string>', false],
    });
  });

  it('validates wire rows against the fields and strips undeclared columns', () => {
    expect(Team.rowSchema.parse({ ...teamRow, sync_groups: ['workspace'] })).toEqual(teamRow);
    expect(Team.rowSchema.safeParse({ ...teamRow, icon: undefined }).success).toBe(false);
    expect(Team.rowSchema.safeParse({ ...teamRow, tier: 'enterprise' }).success).toBe(false);
    expect(Team.rowSchema.safeParse({ ...teamRow, cycleLength: 1.5 }).success).toBe(false);
    expect(Team.rowSchema.safeParse({ ...teamRow, createdAt: 'yesterday' }).success).toBe(false);
    expect(Team.rowSchema.safeParse({ ...teamRow, id: 'ENG' }).success).toBe(false);
  });

  it('compares values the way the pool needs to skip no-op updates', () => {
    const { settings, tags, icon } = Team.fields;
    expect(settings?.equals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(settings?.equals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(tags?.equals(['x', 'y'], ['x', 'y'])).toBe(true);
    expect(tags?.equals(['x'], ['x', 'y'])).toBe(false);
    expect(icon?.equals(null, null)).toBe(true);
    expect(icon?.equals(null, 'x')).toBe(false);
    expect(jsonEquals([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('keeps refs and indexes, and validates them', () => {
    expect(Team.refs).toEqual({
      lead: { kind: 'ref', model: 'User', field: 'leadId' },
      memberships: { kind: 'backRef', model: 'TeamMembership', field: 'teamId' },
    });
    expect(Team.indexes).toEqual(['key']);
  });

  it.each([
    ['a lowercase model name', () => defineModel('team', { load: 'eager', fields: {} })],
    ['an explicit id', () => defineModel('Team', { load: 'eager', fields: { id: uuid() } })],
    [
      'a snake_case field',
      () => defineModel('Team', { load: 'eager', fields: { team_id: uuid() } }),
    ],
    [
      'an index on a json field',
      () => defineModel('Team', { load: 'eager', fields: { s: json() }, indexes: ['s'] }),
    ],
    [
      'a ref through a non-uuid field',
      () =>
        defineModel('Team', {
          load: 'eager',
          fields: { name: str() },
          refs: { owner: ref('User', 'name') },
        }),
    ],
    [
      'a ref named like a field',
      () =>
        defineModel('Team', {
          load: 'eager',
          fields: { leadId: uuid() },
          refs: { leadId: ref('User', 'leadId') },
        }),
    ],
    ['an array of nullable values', () => array(str().nullable())],
  ])('rejects %s', (_case, define) => {
    expect(define).toThrow();
  });

  it('freezes the definition all the way down, so the registry cannot drift at runtime', () => {
    expect(Object.isFrozen(Team)).toBe(true);
    expect(Object.isFrozen(Team.fields)).toBe(true);
    expect(Object.isFrozen(Team.fields['key'])).toBe(true);
    expect(Object.isFrozen(Team.refs)).toBe(true);
    expect(Object.isFrozen(Object.values(Team.refs)[0])).toBe(true);
    expect(Object.isFrozen(Team.indexes)).toBe(true);
  });

  it('rejects field and ref names that would shadow what every instance has', () => {
    // `then` would make every instance a thenable, so `await instance` would misbehave.
    for (const name of ['toJSON', 'then', 'constructor', 'valueOf', 'toString', 'hasOwnProperty']) {
      expect(() => defineModel('Thing', { load: 'eager', fields: { [name]: str() } })).toThrow(
        `Model Thing: ${name} is reserved; choose another field name`,
      );
      expect(() =>
        defineModel('Thing', { load: 'eager', fields: {}, refs: { [name]: backRef('Team', 'x') } }),
      ).toThrow(`Model Thing: ${name} is reserved; choose another ref name`);
    }
  });
});

describe('enumOf', () => {
  it('describes the same members the same way whatever their order, for a stable schema hash', () => {
    expect(enumOf(['b', 'a', 'c']).type).toBe(enumOf(['c', 'b', 'a']).type);
    expect(enumOf(['b', 'a']).type).toBe('enum<a|b>');
  });

  it('rejects members that would make the type string ambiguous, and duplicates', () => {
    for (const bad of ['a|b', 'a<b', 'a>b']) {
      expect(() => enumOf(['ok', bad])).toThrow(/cannot contain \|, < or >/);
    }
    expect(() => enumOf(['a', 'a'])).toThrow(/listed twice/);
  });
});
