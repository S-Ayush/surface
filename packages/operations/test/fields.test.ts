// AC-7: `fields` projects outputs with dot-paths and rejects unknown paths with suggestions
// (SPEC-003 §7.2).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_FIELDS,
  connectionOf,
  defineOperation,
  fieldPaths,
  fieldsProblem,
  shapeOutput,
} from '../src/index.js';

const Named = z.object({ id: z.uuid(), name: z.string() });
const IssueSummary = z.object({
  id: z.uuid(),
  identifier: z.string(),
  title: z.string(),
  status: Named,
  assignee: Named.nullable(),
  labels: z.array(Named),
});

function op(name: string, output: z.ZodType) {
  return defineOperation({
    name,
    kind: 'query',
    domain: 'debug',
    summary: 'Fixture',
    description: 'Fixture for fields tests.',
    keywords: ['fixture', 'fields'],
    input: z.object({}),
    output,
    permission: (p) => p.any(),
    destructive: false,
    examples: [{}],
    internal: true,
  });
}

const get = op('debug.getIssue', IssueSummary);
const list = op('debug.listIssues', connectionOf(IssueSummary));

const ids = {
  a: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6a',
  s: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6b',
  u: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6c',
};
const issue = {
  id: ids.a,
  identifier: 'ENG-1',
  title: 'Crash on save',
  status: { id: ids.s, name: 'Todo' },
  assignee: null,
  labels: [
    { id: ids.u, name: 'Bug' },
    { id: ids.s, name: 'P1' },
  ],
};

describe('fieldPaths', () => {
  it('lists nested objects, nullable objects and array elements as dot-paths', () => {
    expect([...fieldPaths(get).paths].sort()).toEqual([
      'assignee',
      'assignee.id',
      'assignee.name',
      'id',
      'identifier',
      'labels',
      'labels.id',
      'labels.name',
      'status',
      'status.id',
      'status.name',
      'title',
    ]);
    expect(fieldPaths(get).top).toEqual([
      'assignee',
      'id',
      'identifier',
      'labels',
      'status',
      'title',
    ]);
  });

  it("addresses a list's nodes, not the page", () => {
    expect(fieldPaths(list).list).toBe(true);
    expect(fieldPaths(list).paths).toEqual(fieldPaths(get).paths);
  });
});

describe('shapeOutput', () => {
  it('projects dot-paths, keeping nulls and mapping over arrays', () => {
    expect(
      shapeOutput(get, issue, ['identifier', 'status.name', 'assignee.name', 'labels.name']),
    ).toEqual({
      identifier: 'ENG-1',
      status: { name: 'Todo' },
      assignee: null,
      labels: [{ name: 'Bug' }, { name: 'P1' }],
    });
  });

  it('keeps a whole object when its own path is requested, whatever else is', () => {
    expect(shapeOutput(get, issue, ['status.name', 'status'])).toEqual({ status: issue.status });
    expect(shapeOutput(get, issue, ['status', 'status.name'])).toEqual({ status: issue.status });
  });

  it('shapes every node of a list and keeps pageInfo and totalCount', () => {
    const page = {
      nodes: [issue, { ...issue, identifier: 'ENG-2' }],
      pageInfo: { hasNextPage: true, endCursor: 'abc' },
      totalCount: 7,
    };
    expect(shapeOutput(list, page, ['identifier'])).toEqual({
      nodes: [{ identifier: 'ENG-1' }, { identifier: 'ENG-2' }],
      pageInfo: { hasNextPage: true, endCursor: 'abc' },
      totalCount: 7,
    });
  });
});

describe('fieldsProblem', () => {
  it('accepts known paths', () => {
    expect(fieldsProblem(get, ['id', 'status.name', 'labels'])).toBeUndefined();
    expect(fieldsProblem(list, ['identifier'])).toBeUndefined();
  });

  it('rejects an unknown path with close suggestions and the top-level fields', () => {
    expect(fieldsProblem(get, ['id', 'staus.name'])).toEqual({
      index: 1,
      message:
        'debug.getIssue has no field "staus.name". Did you mean "status.name"? Fields: assignee, id, identifier, labels, status, title.',
    });
  });

  it('lists the fields alone when nothing is close', () => {
    expect(fieldsProblem(get, ['priorityLevel'])?.message).toBe(
      'debug.getIssue has no field "priorityLevel". Fields: assignee, id, identifier, labels, status, title.',
    );
  });

  it('rejects page-level paths on a list, where paths address nodes', () => {
    expect(fieldsProblem(list, ['nodes.identifier'])?.index).toBe(0);
  });

  it('bounds the work: too many fields, and no suggestions for very long ones', () => {
    expect(
      fieldsProblem(
        get,
        Array.from({ length: MAX_FIELDS + 1 }, () => 'id'),
      ),
    ).toEqual({
      index: MAX_FIELDS,
      message: `Request at most ${MAX_FIELDS} fields.`,
    });
    const long = `status.${'x'.repeat(10_000)}`;
    const message = fieldsProblem(get, [long])?.message ?? '';
    expect(message).not.toContain('Did you mean');
    expect(message.length).toBeLessThan(200);
  });
});
