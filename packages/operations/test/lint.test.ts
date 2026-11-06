// AC-9: the registry lint catches each SPEC-003 §11 rule, one failing fixture per rule.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_OPERATIONS, connectionOf, defineOperation, listInput } from '../src/index.js';
import type { AnyOperation } from '../src/index.js';
import { catalogSnapshot, lintOperations, parseSnapshot, type LintRule } from '../src/lint.js';
import { TeamRef, teamUpdate } from './fixtures.js';
import committedSnapshot from '../catalog.snapshot.json' with { type: 'json' };
import { LINT_FIXTURES } from './lint-fixtures/index.js';

describe('one fixture per rule (AC-9)', () => {
  it('has a fixture for each of the 8 rules', () => {
    expect(LINT_FIXTURES.map((f) => f.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('passes the valid operation the fixtures are made from', () => {
    expect(lintOperations([teamUpdate], { snapshot: catalogSnapshot([teamUpdate]) })).toEqual([]);
  });

  it.each(LINT_FIXTURES)('reports rule $rule, and only rule $rule', (fixture) => {
    const problems = lintOperations(
      [fixture.operation],
      fixture.snapshot ? { snapshot: fixture.snapshot } : {},
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.rule).toBe(fixture.rule);
      expect(problem.message).toMatch(fixture.message);
    }
  });
});

describe('the built-in operations', () => {
  // This is `pnpm registry:lint` inside `pnpm test`, so CI fails on any problem (§11).
  it('pass every rule against the committed catalog snapshot', () => {
    const snapshot = parseSnapshot(committedSnapshot);
    expect(lintOperations(ALL_OPERATIONS, { snapshot })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

function query(
  name: string,
  input: z.ZodObject,
  output: z.ZodType,
  examples: readonly Record<string, unknown>[] = [{}],
): AnyOperation {
  return defineOperation({
    name,
    kind: 'query',
    domain: 'team',
    summary: 'Fixture',
    description: 'Fixture for lint tests.',
    keywords: ['fixture', 'lint'],
    input,
    output,
    permission: (p) => p.any(),
    destructive: false,
    examples,
  });
}

function rules(ops: readonly AnyOperation[], released?: readonly AnyOperation[]) {
  return lintOperations(ops, released ? { snapshot: catalogSnapshot(released) } : {}).map(
    (p): [LintRule, string] => [p.rule, p.message.replace(/\. Add a new operation.*$/, '')],
  );
}

describe('rule 4: reference types', () => {
  const uuid = '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e';
  const mutation = (name: string, input: z.ZodObject, internal = false): AnyOperation => ({
    ...teamUpdate,
    name,
    input,
    examples: [{ id: uuid, team: 'ENG' }],
    internal,
  });

  it("allows a create op's own client-generated id, refs, and internal ops", () => {
    expect(rules([mutation('team.create', z.object({ id: z.uuid(), team: TeamRef }))])).toEqual([]);
    expect(rules([mutation('team.touch', z.object({ id: z.uuid() }), true)])).toEqual([]);
  });

  it('flags ids elsewhere, nested and in arrays', () => {
    const input = z.object({
      id: z.uuid(),
      team: TeamRef,
      moves: z.array(z.object({ to: z.uuid().nullable() })).optional(),
    });
    expect(
      rules([mutation('team.update', input)]).map(([rule, m]) => [rule, m.split(' is')[0]]),
    ).toEqual([
      [4, 'input id'],
      [4, 'input moves[].to'],
    ]);
  });
});

describe('rule 6: list conventions', () => {
  const node = z.object({ id: z.uuid(), name: z.string() });

  it('passes a list built from listInput and connectionOf, with extra inputs', () => {
    expect(
      rules([
        query('team.list', z.object({ ...listInput, team: TeamRef }), connectionOf(node), [
          { team: 'ENG' },
        ]),
      ]),
    ).toEqual([]);
  });

  it('flags a changed list field and a mutation named list', () => {
    const input = z.object({ ...listInput, limit: z.int().min(1).max(500).default(50) });
    const list = query('team.list', input, connectionOf(node));
    expect(rules([list])).toEqual([[6, expect.stringMatching(/^input limit differs/)]]);
    const valid = query('team.list', z.object(listInput), connectionOf(node));
    expect(rules([{ ...valid, kind: 'mutation' }])).toEqual([[6, 'a list must be a query']]);
  });

  it('applies to list verbs only', () => {
    expect(rules([query('team.listless', z.object({}), node)])).toEqual([]);
  });
});

describe('rule 8: breaking changes against the snapshot', () => {
  const Out = z.object({
    id: z.uuid(),
    name: z.string(),
    icon: z.string(),
    kind: z.enum(['a', 'b']),
    owner: z.object({ id: z.uuid(), name: z.string() }),
  });
  const In = z.object({
    name: z.string().optional(),
    count: z.number().optional(),
    kind: z.enum(['a', 'b']).optional(),
    note: z.string().nullable().optional(),
  });
  const v1 = query('team.read', In, Out);
  const v2 = (input: z.ZodObject, output: z.ZodType = Out) => query('team.read', input, output);
  const breaks = (next: AnyOperation) =>
    rules([next], [v1]).flatMap(([rule, m]) => (rule === 8 ? [m] : []));

  it('allows additions: optional inputs, outputs, wider inputs, new output enum values', () => {
    const input = In.extend({
      extra: z.string().optional(),
      kind: z.enum(['a', 'b', 'c']).optional(),
      count: z.number().nullable().optional(),
      // A required child of a new optional parent: old inputs leave the parent out.
      range: z.object({ from: z.string() }).optional(),
    });
    const output = Out.extend({ extra: z.boolean(), kind: z.enum(['a', 'b', 'c']) });
    expect(breaks(v2(input, output))).toEqual([]);
  });

  it('rejects inputs that are removed, newly required or narrowed', () => {
    const input = z.object({
      name: z.string(),
      count: z.int().optional(),
      kind: z.enum(['a']).optional(),
      note: z.uuid().optional(),
    });
    expect(breaks(v2(input))).toEqual([
      'input count no longer accepts number',
      'input kind no longer accepts "b"',
      'input note no longer accepts null',
      'input note now requires format uuid',
      'input name is now required',
    ]);
    expect(breaks(v2(In.omit({ note: true })))).toEqual(['input note was removed']);
  });

  it('rejects outputs that are removed, made optional or widened', () => {
    const output = Out.omit({ owner: true }).extend({
      name: z.string().optional(),
      icon: z.string().nullable(),
      kind: z.string(),
    });
    expect(breaks(v2(In, output))).toEqual([
      'output name is no longer always present',
      'output icon can now be null',
      'output kind is no longer limited to its values',
      // Only the outermost removed field.
      'output owner was removed',
    ]);
  });

  it('rejects a changed kind and a removed operation, unless it was released deprecated', () => {
    expect(breaks({ ...v1, kind: 'mutation' })).toEqual(['kind changed from query to mutation']);
    expect(rules([], [v1])).toEqual([
      [8, 'was released and is now gone. Keep it, deprecated, until a release replaces it'],
    ]);
    const old = { ...v1, deprecated: { since: '0.2.0', replacedBy: 'team.get' } };
    const replacement = query('team.get', In, Out);
    expect(rules([replacement], [old, replacement])).toEqual([]);
    expect(rules([{ ...replacement, internal: true }], [old, replacement])).toEqual([
      [8, expect.stringMatching(/^was released and is now gone/)],
      [8, expect.stringMatching(/^was released and is now gone/)],
    ]);
  });

  it('rejects a deprecation pointing at an operation that does not exist', () => {
    const old = { ...v1, deprecated: { since: '0.2.0', replacedBy: 'team.gone' } };
    expect(rules([old], [old])).toEqual([
      [8, 'is deprecated in favour of team.gone, which is not a public operation'],
    ]);
  });

  it('ignores internal operations, which are never released', () => {
    expect(catalogSnapshot([{ ...v1, internal: true }])).toEqual({ operations: {} });
  });
});

describe('the snapshot file format', () => {
  it('round-trips through JSON and rejects malformed files', () => {
    const snapshot = catalogSnapshot([teamUpdate]);
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(() => parseSnapshot({ operations: { 'team.update': { kind: 'other' } } })).toThrow(
      /catalog\.snapshot\.json is malformed/,
    );
  });
});
