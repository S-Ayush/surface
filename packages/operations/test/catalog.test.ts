// AC-1 (catalog and OpenAPI side): both are generated from the definitions alone.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { catalogEntry, defineOperation, isPublicOperation, toOpenApi } from '../src/index.js';
import { teamList, teamUpdate } from './fixtures.js';

interface Tree {
  name: string;
  children: Tree[];
}
const TreeSchema: z.ZodType<Tree> = z.lazy(() =>
  z.object({ name: z.string(), children: z.array(TreeSchema) }),
);
const treeOp = defineOperation({
  name: 'debug.tree',
  kind: 'query',
  domain: 'debug',
  summary: 'Return a tree',
  description: 'Fixture with a recursive output schema.',
  keywords: ['tree', 'recursive'],
  input: z.object({ depth: z.int().min(0).max(3) }),
  output: z.object({ root: TreeSchema, extra: TreeSchema.optional() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ depth: 1 }],
  internal: true,
});

/** Every `$ref` in the document, with whether its JSON pointer resolves. */
function refs(doc: unknown): { ref: string; resolves: boolean }[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') found.push(child);
        else walk(child);
      }
    }
  };
  walk(doc);
  return found.map((ref) => {
    let target: unknown = doc;
    for (const part of ref.replace(/^#\//, '').split('/')) {
      target =
        typeof target === 'object' && target !== null
          ? (target as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')]
          : undefined;
    }
    return { ref, resolves: target !== undefined };
  });
}

describe('catalogEntry', () => {
  it('describes an operation with compact schemas', () => {
    const entry = catalogEntry(teamUpdate);
    expect(entry).toMatchObject({
      name: 'team.update',
      kind: 'mutation',
      domain: 'team',
      destructive: false,
      keywords: teamUpdate.keywords,
      examples: teamUpdate.examples,
    });
    expect(entry.input.team).toMatchObject({ type: 'TeamRef', required: true });
    expect(entry).not.toHaveProperty('deprecated');
  });
});

describe('isPublicOperation', () => {
  it('leaves internal and systemOnly operations out of the catalog (SPEC-003 §3.1)', () => {
    const { ui: _ui, ...withoutUi } = teamUpdate;
    const job = defineOperation({ ...withoutUi, name: 'team.sweep', systemOnly: true });
    expect(isPublicOperation(teamUpdate)).toBe(true);
    expect(isPublicOperation(treeOp)).toBe(false);
    expect(isPublicOperation(job)).toBe(false);
    expect([teamUpdate, teamList, treeOp, job].filter(isPublicOperation)).toEqual([
      teamUpdate,
      teamList,
    ]);
  });
});

describe('toOpenApi', () => {
  const doc = toOpenApi([teamUpdate, teamList, treeOp], { version: '1.2.3' });

  it('has one POST path per operation, with its schemas and examples', () => {
    expect(doc).toMatchObject({ openapi: '3.1.0', info: { version: '1.2.3' } });
    expect(Object.keys(doc.paths as object)).toEqual([
      '/api/ops/team.update',
      '/api/ops/team.list',
      '/api/ops/debug.tree',
    ]);
    const update = (doc.paths as Record<string, { post: Record<string, unknown> }>)[
      '/api/ops/team.update'
    ];
    expect(update?.post).toMatchObject({
      operationId: 'team.update',
      tags: ['team'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              required: ['input'],
              properties: {
                input: { $ref: '#/components/schemas/team.update.input' },
                clientMutationId: { maxLength: 200 },
              },
            },
            examples: { example1: { value: { input: teamUpdate.examples[0] } } },
          },
        },
      },
    });
  });

  it('offers clientMutationId on mutations only', () => {
    const list = (doc.paths as Record<string, { post: unknown }>)['/api/ops/team.list'];
    expect(JSON.stringify(list)).not.toContain('clientMutationId');
  });

  it('resolves every reference, including recursive schemas moved into components', () => {
    const all = refs(doc);
    // The recursive type became its own component, referenced from inside itself.
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    const defs = Object.keys(schemas).filter((k) => k.startsWith('debug.tree.output.'));
    expect(defs).toHaveLength(1);
    expect(
      all.filter((r) => r.ref === `#/components/schemas/${defs[0] ?? ''}`).length,
    ).toBeGreaterThan(1);
    expect(all.filter((r) => !r.resolves)).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain('"$defs"');
    expect(JSON.stringify(doc)).not.toContain('"$schema"');
  });
});
