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

/** Deterministic UUIDv7-shaped ids: `id(1)` → `00000000-0000-7000-8000-000000000001`. */
export function id(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function debugRow(n: number, overrides: Partial<Record<string, unknown>> = {}): ModelRow {
  return { id: id(n), title: `Item ${n}`, counter: n, groups: ['workspace'], ...overrides };
}
