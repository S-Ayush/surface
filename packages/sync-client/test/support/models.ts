import type { ModelRow } from '@surface/domain/model';
import {
  DebugItem,
  array,
  backRef,
  bool,
  defineModel,
  int,
  ref,
  str,
  timestamp,
  uuid,
} from '@surface/domain/model';
import type { PartialLoading } from '../../src/partial.js';

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

/*
 * Partial issue loading (PLAN-011 S4c) on stand-ins, so the fake hub needs no production rows:
 * `Squad` for Team, `SquadMember` for TeamMembership, `Task` for Issue, `TaskPart` an eager child
 * (as Attachment will be) and `TaskNote` a content model of Task (as IssueContent is).
 */
export const Squad = defineModel('Squad', {
  load: 'eager',
  fields: { name: str(), private: bool() },
});

export const SquadMember = defineModel('SquadMember', {
  load: 'eager',
  fields: { teamId: uuid(), userId: uuid() },
});

export const Task = defineModel('Task', {
  load: 'eager',
  fields: {
    teamId: uuid(),
    title: str(),
    creatorId: uuid(),
    assigneeId: uuid().nullable(),
    groups: array(str()),
    archivedAt: timestamp().nullable(),
    deletedAt: timestamp().nullable(),
  },
  indexes: ['teamId'],
});

export const TaskPart = defineModel('TaskPart', {
  load: 'eager',
  fields: { issueId: uuid(), teamId: uuid(), body: str() },
});

export const TaskNote = defineModel('TaskNote', {
  load: 'content',
  parent: { model: 'Task', field: 'issueId' },
  fields: { issueId: uuid(), body: str() },
  indexes: ['issueId'],
});

export const PARTIAL_TEST_MODELS = [
  ...TEST_MODELS,
  Squad,
  SquadMember,
  Task,
  TaskPart,
  TaskNote,
] as const;

/** The stand-ins as the store's partial-loading models. */
export const PARTIAL_TEST_LOADING: PartialLoading = {
  team: 'Squad',
  membership: 'SquadMember',
  issue: 'Task',
  children: [{ model: 'TaskPart', field: 'issueId' }],
};

/** Another user (the fake hub signs nobody in; ids are what the client names). */
export const OTHER_USER = '0190f4c4-0000-7000-8000-0000000000b0';

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
