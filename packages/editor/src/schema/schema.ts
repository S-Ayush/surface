import type { DocNodeJSON } from '@surface/domain';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { SCHEMA_EXTENSIONS } from './extensions.js';

/**
 * The ProseMirror schema of stored documents (SPEC-013 §4.4), built headless with `getSchema`:
 * no Editor instance, no DOM. The web editor builds the same schema (PLAN-013 S2 tests it).
 */
export const schema = getSchema([...SCHEMA_EXTENSIONS]);

function isDocNodeJSON(value: unknown): value is DocNodeJSON {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

/** A node's JSON, typed (ProseMirror's `toJSON` returns `any`). */
export function nodeJSON(node: PMNode): DocNodeJSON {
  const json: unknown = node.toJSON();
  if (!isDocNodeJSON(json)) throw new TypeError('ProseMirror returned a node without a type');
  return json;
}

/** A string attribute of a JSON node, or `''`. */
export function stringAttr(node: DocNodeJSON, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}
