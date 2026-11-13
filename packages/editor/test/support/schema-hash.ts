// The schema's identity: what the schema-shape test pins and the web editor must match (AC-9).
import { createHash } from 'node:crypto';
import type { MarkType, NodeType, Schema } from '@tiptap/pm/model';

export const attrNames = (type: NodeType | MarkType) => Object.keys(type.spec.attrs ?? {}).sort();

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

export function schemaHash(schema: Schema): string {
  const spec = {
    topNode: schema.topNodeType.name,
    nodes: Object.fromEntries(Object.values(schema.nodes).map((t) => [t.name, nodeSpec(t)])),
    // Mark order matters: it is the order of marks in stored JSON.
    marks: Object.values(schema.marks).map((t) => [t.name, markSpec(t)]),
  };
  const sorted = { ...spec, nodes: Object.fromEntries(Object.entries(spec.nodes).sort()) };
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
