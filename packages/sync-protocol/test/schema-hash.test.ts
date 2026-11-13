import { createHash } from 'node:crypto';
import { DOC_SCHEMA_VERSION } from '@surface/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SchemaHashModel } from '../src/index.js';
import { computeSchemaHash, ProtocolError, schemaHashSchema } from '../src/index.js';
import { sha256Hex } from '../src/sha256.js';
import { propertyOptions } from './support/arbitraries.js';

const DEBUG_ITEM: SchemaHashModel = {
  name: 'DebugItem',
  load: 'eager',
  fields: {
    id: { type: 'uuid', nullable: false },
    title: { type: 'string', nullable: false },
    counter: { type: 'int', nullable: false },
  },
};
const TEAM: SchemaHashModel = {
  name: 'Team',
  load: 'eager',
  fields: {
    id: { type: 'uuid', nullable: false },
    key: { type: 'string', nullable: false },
    icon: { type: 'string', nullable: true },
  },
};

const reverseFields = (model: SchemaHashModel): SchemaHashModel => ({
  ...model,
  fields: Object.fromEntries(Object.entries(model.fields).reverse()),
});

describe('computeSchemaHash', () => {
  it('is pinned, so an accidental change to the algorithm is caught', () => {
    // If this fails on purpose (protocol version bump, canonical form change), every
    // client re-bootstraps on deploy: update the value and say so in the change summary.
    // Changed in PLAN-013 S1, when DOC_SCHEMA_VERSION joined the input (SPEC-013 D6), and in
    // PLAN-011 S2, when SYNC_PROTOCOL_VERSION became 2 (v0.7: A and V packets carry the row).
    expect(computeSchemaHash([DEBUG_ITEM, TEAM])).toBe(
      '9c11eb17f22a2d35916eb92bc882758ef5a3765f676133b5f4d03dc4b74d2715',
    );
  });

  it('includes the stored document schema version, so an editor schema change resyncs clients', () => {
    expect(computeSchemaHash([TEAM])).toBe(computeSchemaHash([TEAM], DOC_SCHEMA_VERSION));
    expect(computeSchemaHash([TEAM], DOC_SCHEMA_VERSION + 1)).not.toBe(computeSchemaHash([TEAM]));
  });

  it('produces a value the wire codecs accept', () => {
    expect(schemaHashSchema.safeParse(computeSchemaHash([TEAM])).success).toBe(true);
  });

  it('does not depend on the order of models or fields', () => {
    const models = fc.uniqueArray(
      fc.record({
        name: fc.stringMatching(/^[A-Z][a-z]{0,6}$/),
        load: fc.constantFrom('eager', 'content'),
        fields: fc.dictionary(
          fc.stringMatching(/^[a-z][a-zA-Z]{0,6}$/),
          fc.record({
            type: fc.constantFrom('uuid', 'string', 'int', 'bool'),
            nullable: fc.boolean(),
          }),
          { maxKeys: 6 },
        ),
      }),
      { selector: (m) => m.name, maxLength: 6 },
    );
    fc.assert(
      fc.property(models, fc.integer(), (defs, salt) => {
        const shuffled = [...defs]
          .map((model, i) => ({ model: reverseFields(model), key: (i * 7919 + salt) % 101 }))
          .sort((a, b) => a.key - b.key)
          .map(({ model }) => model);
        expect(computeSchemaHash(shuffled)).toBe(computeSchemaHash(defs));
      }),
      propertyOptions,
    );
  });

  it.each<[string, SchemaHashModel]>([
    ['a model is renamed', { ...TEAM, name: 'Squad' }],
    ['the load strategy changes', { ...TEAM, load: 'content' }],
    [
      'a field is added',
      { ...TEAM, fields: { ...TEAM.fields, color: { type: 'string', nullable: false } } },
    ],
    [
      'a field is removed',
      {
        ...TEAM,
        fields: { id: { type: 'uuid', nullable: false }, key: { type: 'string', nullable: false } },
      },
    ],
    [
      'a field is renamed',
      {
        ...TEAM,
        fields: {
          id: { type: 'uuid', nullable: false },
          code: { type: 'string', nullable: false },
          icon: { type: 'string', nullable: true },
        },
      },
    ],
    [
      'a field type changes',
      { ...TEAM, fields: { ...TEAM.fields, key: { type: 'int', nullable: false } } },
    ],
    [
      'a field becomes nullable',
      { ...TEAM, fields: { ...TEAM.fields, key: { type: 'string', nullable: true } } },
    ],
  ])('changes when %s', (_case, changed) => {
    expect(computeSchemaHash([DEBUG_ITEM, changed])).not.toBe(
      computeSchemaHash([DEBUG_ITEM, TEAM]),
    );
  });

  it('changes with a content model’s parent, model or field (PLAN-011 S5a)', () => {
    const content = (parent: { model: string; field: string }): SchemaHashModel => ({
      name: 'Note',
      load: 'content',
      parent,
      fields: {
        id: { type: 'uuid', nullable: false },
        issueId: { type: 'uuid', nullable: false },
        itemId: { type: 'uuid', nullable: false },
      },
    });
    const hash = (model: SchemaHashModel) => computeSchemaHash([TEAM, model]);
    const base = hash(content({ model: 'Issue', field: 'issueId' }));
    expect(hash(content({ model: 'DebugItem', field: 'issueId' }))).not.toBe(base);
    expect(hash(content({ model: 'Issue', field: 'itemId' }))).not.toBe(base);
    const { parent: _parent, ...withoutParent } = content({ model: 'Issue', field: 'issueId' });
    expect(hash(withoutParent)).not.toBe(base);
  });

  it('changes when a model is added', () => {
    expect(computeSchemaHash([DEBUG_ITEM, TEAM])).not.toBe(computeSchemaHash([TEAM]));
  });

  it('ignores client-only metadata such as refs and indexes', () => {
    const withExtras = {
      ...TEAM,
      refs: { memberships: 'TeamMembership.teamId' },
      indexes: ['key'],
    };
    expect(computeSchemaHash([withExtras])).toBe(computeSchemaHash([TEAM]));
  });

  it('rejects two models with the same name', () => {
    expect(() => computeSchemaHash([TEAM, { ...TEAM, load: 'content' }])).toThrow(ProtocolError);
  });

  it('accepts any iterable, such as a registry Map', () => {
    const registry = new Map([
      ['Team', TEAM],
      ['DebugItem', DEBUG_ITEM],
    ]);
    expect(computeSchemaHash(registry.values())).toBe(computeSchemaHash([DEBUG_ITEM, TEAM]));
  });
});

describe('sha256Hex', () => {
  const nodeSha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the FIPS 180-4 vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('matches node:crypto at every padding boundary', () => {
    for (let length = 0; length <= 130; length++) {
      const input = 'x'.repeat(length);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeSha256(input));
    }
  });

  it('matches node:crypto for any string, including non-ASCII and lone surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (input) => {
        expect(sha256Hex(input)).toBe(nodeSha256(input));
      }),
      propertyOptions,
    );
  });
});
