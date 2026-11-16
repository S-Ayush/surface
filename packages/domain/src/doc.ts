/**
 * Rich-text document constants shared by the client, the operations and the server, without the
 * editor (SPEC-013 §4.4, D2). The schema itself lives in `@surface/editor/schema`; optimistic
 * code never parses documents beyond `EMPTY_DOC` (SPEC-013 §6.2).
 */
import { utf8Length } from './sha1.js';
import { uuidv5 } from './uuid.js';

/** A mark in a stored document (ProseMirror JSON). */
export interface DocMarkJSON {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** A node in a stored document (ProseMirror JSON). The root has `type: 'doc'`. */
export interface DocNodeJSON {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly DocNodeJSON[];
  readonly marks?: readonly DocMarkJSON[];
  readonly text?: string;
}

/** The empty document: one empty paragraph (SPEC-013 §4.4). Frozen, so it can be shared. */
export const EMPTY_DOC: DocNodeJSON = Object.freeze({
  type: 'doc',
  content: Object.freeze([Object.freeze({ type: 'paragraph' })]),
});

/**
 * Version of the stored document schema (SPEC-013 D6). It feeds `computeSchemaHash`
 * (sync-protocol §8), so bumping it resyncs every client. Bump it, with a data migration in the
 * same release (ADR-0023), whenever the editor schema changes; the editor's snapshot test fails
 * until you do.
 */
export const DOC_SCHEMA_VERSION = 1;

/** Size limits of a stored document, in UTF-8 bytes of its JSON (SPEC-013 D14, SPEC-011 Q9). */
export const DOC_MAX_BYTES = {
  comment: 50 * 1024,
  description: 200 * 1024,
} as const;

/** UTF-8 size of a value's JSON, as `DOC_MAX_BYTES` measures it. */
export function docJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8Length(json);
}

/**
 * Whether `value` has a document's root shape (`type: 'doc'`, `content` an array when present).
 * Only the root is checked: the editor's schema validates the rest (`@surface/editor/schema`).
 */
export function isDocJson(value: unknown): value is DocNodeJSON {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const content: unknown = Reflect.get(value, 'content');
  return Reflect.get(value, 'type') === 'doc' && (content === undefined || Array.isArray(content));
}

/**
 * Deep equality of two JSON values, whatever the order of an object's keys. Postgres `jsonb` and
 * IndexedDB give a stored document's keys back in their own order, so the server's "did the text
 * change" (SPEC-011 §4.1, D17), the optimistic copy of it and the composer's E20 check all compare
 * documents by content with this one function. A key whose value is `undefined` counts as absent,
 * as `JSON.stringify` drops it.
 */
export function sameDocJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameDocJson(item, b[i]))
    );
  }
  const keysA = Object.keys(a).filter((k) => Reflect.get(a, k) !== undefined);
  const keysB = new Set(Object.keys(b).filter((k) => Reflect.get(b, k) !== undefined));
  return (
    keysA.length === keysB.size &&
    keysA.every((k) => keysB.has(k) && sameDocJson(Reflect.get(a, k), Reflect.get(b, k)))
  );
}

/** Namespace of `reactionId`'s UUIDv5 names. Never change it: stored reaction ids depend on it. */
const REACTION_NAMESPACE = '43457bcc-57ec-45b6-a3db-1393e0782480';

/**
 * The id of a user's reaction (SPEC-013 §4.2, D1): derived from the subject (a comment's id, or
 * the issue's id for a reaction on the issue), the user and the emoji, so the optimistic row and
 * the server's row share it and a reaction is unique per (subject, user, emoji).
 */
export function reactionId(subjectId: string, userId: string, emoji: string): string {
  return uuidv5(`${subjectId.toLowerCase()}:${userId.toLowerCase()}:${emoji}`, REACTION_NAMESPACE);
}
