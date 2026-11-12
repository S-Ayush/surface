import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineOperation,
  OperationDefinitionError,
  type AnyOperation,
  type InputOf,
  type OperationDef,
  type OutputOf,
  type ParsedInputOf,
} from '../src/index.js';
import { teamList, teamUpdate } from './fixtures.js';

const valid = {
  name: 'debug.echo',
  kind: 'query',
  domain: 'debug',
  summary: 'Echo the input back',
  description: 'Returns its input unchanged. Internal, for executor tests.',
  keywords: ['echo', 'ping'],
  input: z.object({ text: z.string().default('hi') }),
  output: z.object({ text: z.string() }),
  permission: () => true,
  destructive: false,
  examples: [{ text: 'hello' }],
  internal: true,
} as const satisfies AnyOperation;

/** Defines `valid` with some fields replaced, and returns the problems it reports. */
function problemsOf(overrides: Record<string, unknown>): readonly string[] {
  try {
    // Spreading a Record keeps the static type of `valid`, so malformed values reach the runtime checks.
    defineOperation({ ...valid, ...overrides });
  } catch (error) {
    if (error instanceof OperationDefinitionError) return error.problems;
    throw error;
  }
  return [];
}

describe('defineOperation', () => {
  it('returns the definition unchanged and frozen', () => {
    const op = defineOperation(valid);
    expect(op).toEqual(valid);
    expect(op).not.toBe(valid);
    expect(Object.isFrozen(op)).toBe(true);
  });

  it.each(['team.update', 'issue.addLabel', 'user.setRole', 'projectUpdate.list'])(
    'accepts the name %s',
    (name) => {
      expect(problemsOf({ name })).toEqual([]);
    },
  );

  it.each([
    'team',
    'Team.update',
    'team.Update',
    'team.update.now',
    'team_x.update',
    'team.up-date',
    '',
  ])('rejects the name "%s" and shows the expected shape', (name) => {
    expect(problemsOf({ name })).toEqual([
      'name must be <domain>.<verb> with a camelCase verb, like team.update',
    ]);
  });

  it('rejects a domain that is not in domain-model §7', () => {
    expect(problemsOf({ domain: 'teams' })).toEqual([
      'domain "teams" is not in domain-model §7. Use one of the listed domains, like team',
    ]);
  });

  it('rejects an unknown kind', () => {
    expect(problemsOf({ kind: 'command' })).toEqual(['kind must be "query" or "mutation"']);
  });

  it('accepts a summary of exactly 80 characters and rejects 81', () => {
    expect(problemsOf({ summary: 'A'.repeat(80) })).toEqual([]);
    expect(problemsOf({ summary: 'A'.repeat(81) })).toEqual([
      'summary must be 80 characters or fewer (81)',
    ]);
  });

  it('rejects a missing or blank summary', () => {
    expect(problemsOf({ summary: '  ' })).toEqual([
      'summary is required, like "Update a team\'s name"',
    ]);
    expect(problemsOf({ summary: undefined })).toHaveLength(1);
  });

  it('requires the summary to start with a capital letter', () => {
    expect(problemsOf({ summary: 'update a team' })).toEqual([
      'summary must start with a capital letter, like "Update a team"',
    ]);
    expect(problemsOf({ summary: 'Échanger les clés' })).toEqual([]);
  });

  it('requires a description of at most 400 characters', () => {
    expect(problemsOf({ description: '' })).toHaveLength(1);
    expect(problemsOf({ description: 'x'.repeat(400) })).toEqual([]);
    expect(problemsOf({ description: 'x'.repeat(401) })).toEqual([
      'description must be 400 characters or fewer (401)',
    ]);
  });

  it('rejects optimistic() on a query', () => {
    expect(problemsOf({ optimistic: () => undefined })).toEqual([
      'queries cannot have optimistic(): only mutations change the store',
    ]);
  });

  it('refuses contentParent() on a query (SPEC-003 §3.1)', () => {
    expect(problemsOf({ contentParent: () => ({ model: 'Issue', id: 'x' }) })).toEqual([
      'queries cannot have contentParent(): only mutations write content',
    ]);
  });

  it('accepts contentParent() and systemOnly on a mutation', () => {
    const parent = { model: 'Issue', id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' };
    const { ui: _ui, ...withoutUi } = teamUpdate;
    const op = defineOperation({ ...withoutUi, contentParent: () => parent, systemOnly: true });
    expect(op.systemOnly).toBe(true);
    expect(op.contentParent?.({ team: 'ENG' })).toEqual(parent);
  });

  it('refuses a systemOnly value other than true, and ui on a systemOnly op', () => {
    expect(problemsOf({ systemOnly: false })).toEqual(['systemOnly must be true or left out']);
    expect(problemsOf({ systemOnly: true, ui: { title: 'Sweep', contexts: ['global'] } })).toEqual([
      'a systemOnly operation is hidden from the command menu, so it cannot have ui',
    ]);
  });

  it('reports every problem at once, naming the operation', () => {
    expect(() =>
      defineOperation({ ...valid, name: 'Bad', summary: '' } as unknown as typeof valid),
    ).toThrow(
      'Operation "Bad" is invalid: name must be <domain>.<verb> with a camelCase verb, like team.update; summary is required',
    );
  });
});

describe('defineOperation types', () => {
  it('keeps the literal name and kind', () => {
    expectTypeOf(teamUpdate.name).toEqualTypeOf<'team.update'>();
    expectTypeOf(teamUpdate.kind).toEqualTypeOf<'mutation'>();
    expectTypeOf(teamList.kind).toEqualTypeOf<'query'>();
  });

  it('flows raw input to callers and parsed input to handlers', () => {
    // `limit` has a default: optional for callers, always present for handlers.
    expectTypeOf<InputOf<typeof teamList>['limit']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ParsedInputOf<typeof teamList>['limit']>().toEqualTypeOf<number>();
    expectTypeOf<InputOf<typeof teamUpdate>>().toHaveProperty('team').toEqualTypeOf<string>();
  });

  it('flows the output type', () => {
    expectTypeOf<OutputOf<typeof teamList>['pageInfo']['endCursor']>().toEqualTypeOf<
      string | null
    >();
  });

  it('is assignable to AnyOperation', () => {
    expectTypeOf(teamUpdate).toExtend<AnyOperation>();
    expectTypeOf(teamList).toExtend<OperationDef>();
  });

  it('rejects examples that do not match the input type, and optimistic on queries', () => {
    defineOperation({
      ...valid,
      // @ts-expect-error -- `text` must be a string
      examples: [{ text: 1 }],
    });
    expect(() =>
      defineOperation({
        ...valid,
        // @ts-expect-error -- queries cannot have optimistic()
        optimistic: () => undefined,
      }),
    ).toThrow(OperationDefinitionError);
    expect(() =>
      defineOperation({
        ...valid,
        // @ts-expect-error -- queries cannot have contentParent()
        contentParent: () => ({ model: 'Issue', id: 'x' }),
      }),
    ).toThrow(OperationDefinitionError);
  });
});
