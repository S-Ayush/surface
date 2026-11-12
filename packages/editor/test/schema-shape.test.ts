// PLAN-013 S1: the schema's shape is exactly SPEC-013 §4.4's list, and a change to it can't ship
// without a DOC_SCHEMA_VERSION bump (AC-9).
import { createHash } from 'node:crypto';
import { DOC_SCHEMA_VERSION } from '@surface/domain';
import type { MarkType, NodeType } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { SCHEMA_EXTENSIONS, schema } from '../src/schema/index.js';

const attrNames = (type: NodeType | MarkType) => Object.keys(type.spec.attrs ?? {}).sort();

/** Everything about a node or mark type that changes what a stored document can be. */
function nodeSpec(type: NodeType) {
  const { spec } = type;
  return {
    content: spec.content ?? null,
    group: spec.group ?? null,
    marks: spec.marks ?? null,
    inline: spec.inline ?? false,
    atom: spec.atom ?? false,
    code: spec.code ?? false,
    attrs: Object.fromEntries(
      attrNames(type).map((name) => [name, spec.attrs?.[name]?.default ?? null]),
    ),
  };
}

function markSpec(type: MarkType) {
  const { spec } = type;
  return {
    excludes: spec.excludes ?? null,
    inclusive: spec.inclusive ?? true,
    attrs: Object.fromEntries(
      attrNames(type).map((name) => [name, spec.attrs?.[name]?.default ?? null]),
    ),
  };
}

function schemaHash(): string {
  const spec = {
    topNode: schema.topNodeType.name,
    nodes: Object.fromEntries(Object.values(schema.nodes).map((t) => [t.name, nodeSpec(t)])),
    // Mark order matters: it is the order of marks in stored JSON.
    marks: Object.values(schema.marks).map((t) => [t.name, markSpec(t)]),
  };
  const sorted = { ...spec, nodes: Object.fromEntries(Object.entries(spec.nodes).sort()) };
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

describe('editor schema shape (AC-9)', () => {
  it('has exactly the nodes of SPEC-013 §4.4, with their attributes', () => {
    const nodes = Object.fromEntries(
      Object.values(schema.nodes).map((type) => [type.name, attrNames(type)]),
    );
    expect(nodes).toEqual({
      doc: [],
      text: [],
      paragraph: [],
      heading: ['level'],
      bulletList: [],
      orderedList: [],
      listItem: [],
      taskList: [],
      taskItem: ['checked'],
      blockquote: [],
      codeBlock: ['language'],
      horizontalRule: [],
      hardBreak: [],
      image: ['alt', 'src'],
      file: ['name', 'src'],
    });
  });

  it('has exactly the marks of SPEC-013 §4.4, with their attributes', () => {
    const marks = Object.fromEntries(
      Object.values(schema.marks).map((type) => [type.name, attrNames(type)]),
    );
    expect(marks).toEqual({
      bold: [],
      italic: [],
      underline: [],
      strike: [],
      code: [],
      link: ['href'],
    });
  });

  it('is built only from the explicit extension list, with nothing added on the side', () => {
    // No StarterKit (and so none of its extras, such as its own Link) in the headless entry:
    // each extension is one node or mark of the list above.
    expect(SCHEMA_EXTENSIONS.map((extension) => extension.name).sort()).toEqual(
      [...Object.keys(schema.nodes), ...Object.keys(schema.marks)].sort(),
    );
  });

  it('makes image a block and file an inline atom, and code exclude every other mark', () => {
    expect(schema.nodes['image']?.isBlock).toBe(true);
    expect(schema.nodes['file']?.isInline).toBe(true);
    expect(schema.nodes['file']?.isAtom).toBe(true);
    expect(schema.marks['code']?.spec.excludes).toBe('_');
  });

  it('pairs DOC_SCHEMA_VERSION with the hash of the schema', () => {
    // If this fails, the schema changed. Stored documents are a compatibility contract
    // (ADR-0009): bump DOC_SCHEMA_VERSION in packages/domain, ship a migration that rewrites
    // stored documents in the same release (SPEC-013 D6, ADR-0023), then update both values.
    expect({ version: DOC_SCHEMA_VERSION, hash: schemaHash() }).toEqual({
      version: 1,
      hash: 'f90153c0832cd1eabe695ec0a9cae64a2474cd85f171cfb41452869164fe3d1a',
    });
  });
});
