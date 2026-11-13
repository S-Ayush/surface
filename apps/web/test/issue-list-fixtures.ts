// Shared by the issue list tests: statuses, teams and issues as the list model reads them. Not a
// test file.
import type { ListIssue, ListLookups, ListStatus } from '../src/features/issues/list-model.js';

export const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
export const DES = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
export const ME = 'u-ada';
export const OTHER = 'u-bob';

const id = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;

export const ENG_TODO = id(101);
export const ENG_DOING = id(102);
export const ENG_DONE = id(103);
export const ENG_CANCELED = id(104);
export const DES_TODO = id(201);
export const DES_DONE = id(202);

export const STATUSES: ListStatus[] = [
  { id: ENG_TODO, name: 'Todo', category: 'unstarted', position: 'a0', color: 'gray' },
  { id: ENG_DOING, name: 'In Progress', category: 'started', position: 'a0', color: 'amber' },
  { id: ENG_DONE, name: 'Done', category: 'completed', position: 'a0', color: 'green' },
  { id: ENG_CANCELED, name: 'Canceled', category: 'canceled', position: 'a0', color: 'gray' },
  { id: DES_TODO, name: 'Todo', category: 'unstarted', position: 'a1', color: 'gray' },
  { id: DES_DONE, name: 'Done', category: 'completed', position: 'a1', color: 'green' },
];

export const LOOKUPS: ListLookups = {
  statuses: STATUSES,
  teams: new Map([
    [ENG, { key: 'ENG', estimate: { scale: 'linear', extended: false, allowZero: false } }],
    [DES, { key: 'DES', estimate: { scale: 'off', extended: false, allowZero: false } }],
  ]),
  labels: new Map([
    [id(1), { name: 'Perf', color: 'blue' }],
    [id(2), { name: 'Bug', color: 'red' }],
  ]),
  users: new Map([
    [ME, { name: 'Ada' }],
    [OTHER, { name: 'Bob' }],
  ]),
  today: '2026-11-13',
};

let counter = 1000;
export function issue(extra: Partial<ListIssue> = {}): ListIssue {
  counter += 1;
  return {
    id: id(counter),
    teamId: ENG,
    number: counter,
    title: `Issue ${String(counter)}`,
    statusId: ENG_TODO,
    priority: 0,
    assigneeId: null,
    creatorId: OTHER,
    labelIds: [],
    estimate: null,
    dueDate: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: '2026-11-06T12:00:00.000Z',
    updatedAt: '2026-11-12T12:00:00.000Z',
    ...extra,
  };
}

export { id as uuid };
