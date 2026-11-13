// Shared by the estimates and workflow page tests (PLAN-010 S4): a replica with team ENG, its
// estimate settings and a few statuses, a signed-in actor who is a member of the given teams, and
// a dispatch spy that confirms everything. Not a test file.
import { userActor, type Actor } from '@surface/domain';
import { Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import type { AnyOperation } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';

export { pageTree } from './label-fixtures.js';

const AT = '2026-11-13T10:00:00.000Z';
export const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
export const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
export const TODO = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
export const STARTED = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
export const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b4';

export type EstimateSettings = {
  estimateScale?: string;
  estimateExtended?: boolean;
  estimateAllowZero?: boolean;
  estimateCountUnestimatedAsOne?: boolean;
};

const status = (id: string, name: string, category: string, position: string) => ({
  id,
  teamId: ENG,
  name,
  category,
  color: 'gray',
  description: null,
  position,
  groups: ['workspace'],
  createdAt: AT,
  updatedAt: AT,
});

export const STATUSES = [
  status(BACKLOG, 'Backlog', 'backlog', 'a0'),
  status(TODO, 'Todo', 'unstarted', 'a0'),
  status(STARTED, 'In Progress', 'started', 'a0'),
  status(DONE, 'Done', 'completed', 'a0'),
];

export type Dispatched = { readonly op: string; readonly input: unknown };

export class EstimateApp extends AppModel {
  readonly #store: SyncStore;
  readonly dispatched: Dispatched[] = [];
  /** When `message` is set, `dispatch` throws it, like a store that did not take the change. */
  readonly failure: { message: string | undefined } = { message: undefined };

  constructor(
    private readonly memberOf: readonly string[],
    settings: EstimateSettings = {},
    private readonly role: 'admin' | 'member' = 'member',
  ) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    const team = {
      id: ENG,
      key: 'ENG',
      name: 'Engineering',
      icon: null,
      color: 'blue',
      timezone: 'UTC',
      private: false,
      defaultStatusId: BACKLOG,
      estimateScale: 'off',
      estimateExtended: false,
      estimateAllowZero: false,
      estimateCountUnestimatedAsOne: true,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
      ...settings,
    };
    const byModel = new Map<unknown, readonly unknown[]>([
      [Team, [team]],
      [TeamMembership, memberOf.map((teamId) => ({ teamId, userId: 'u-ada' }))],
      [
        User,
        [{ id: 'u-ada', name: 'Ada', displayName: 'ada', email: 'a@example.com', active: true }],
      ],
      [WorkflowStatus, STATUSES],
    ]);
    const dispatched = this.dispatched;
    const failure = this.failure;
    this.#store = {
      status: 'ready',
      connection: 'online',
      pool: {
        all: (model: unknown) => byModel.get(model) ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model) ?? []).find((row) => (row as { id?: string }).id === id),
      },
      dispatch: (op: AnyOperation, input: unknown) => {
        if (failure.message !== undefined) throw new Error(failure.message);
        dispatched.push({ op: op.name, input });
        return Promise.resolve({ status: 'confirmed' as const });
      },
    } as unknown as SyncStore;
  }

  override get store(): SyncStore | null {
    return this.#store;
  }

  override get session(): Session {
    return { userId: 'u-ada', workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    userActor({
      userId: 'u-ada',
      role: this.role,
      memberships: this.memberOf.map((teamId) => ({ teamId, private: false })),
    });
}
