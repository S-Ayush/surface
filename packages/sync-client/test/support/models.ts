import type { ModelRow } from '@surface/domain/model';
import { DebugItem, backRef, defineModel, int, ref, str, uuid } from '@surface/domain/model';

export { DebugItem };

/** A parent/child pair to exercise refs and back-refs. */
export const Board = defineModel('Board', {
  load: 'eager',
  fields: { name: str() },
  refs: { cards: backRef('Card', 'boardId') },
});

export const Card = defineModel('Card', {
  load: 'eager',
  fields: { boardId: uuid(), title: str(), rank: int(), assignee: str().nullable() },
  refs: { board: ref('Board', 'boardId') },
  indexes: ['assignee'],
});

export const TEST_MODELS = [DebugItem, Board, Card] as const;

/**
 * A content model of `DebugItem` (PLAN-011 S5a): loaded per item by the fake hub's
 * `GET /sync/content`, like IssueContent per issue. Not in `TEST_MODELS`, so existing tests keep
 * their schema hash; content tests use `CONTENT_TEST_MODELS` and set the hub's `schemaHash`.
 */
export const Note = defineModel('Note', {
  load: 'content',
  parent: { model: 'DebugItem', field: 'itemId' },
  fields: { itemId: uuid(), body: str() },
  indexes: ['itemId'],
});

export const CONTENT_TEST_MODELS = [...TEST_MODELS, Note] as const;

export function noteRow(n: number, item: number, body = `Note ${n}`): ModelRow {
  return { id: id(n), itemId: id(item), body };
}

/** The signed-in user of every test store (a UUID, as on the wire, SPEC-002 E14). */
export const USER_ID = '0190f4c4-0000-7000-8000-0000000005e1';

/** Deterministic UUIDv7-shaped ids: `id(1)` → `00000000-0000-7000-8000-000000000001`. */
export function id(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function debugRow(n: number, overrides: Partial<Record<string, unknown>> = {}): ModelRow {
  return {
    id: id(n),
    title: `Item ${n}`,
    counter: n,
    groups: ['workspace'],
    archivedAt: null,
    ...overrides,
  };
}
