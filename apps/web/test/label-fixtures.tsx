// Shared by the labels page tests: a replica with team ENG, a few labels and groups, and a
// signed-in actor who is a member of the given teams. Not a test file.
import { userActor, type Actor } from '@surface/domain';
import { Label, Team, TeamMembership, User } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { SettingsReadsContext, type SettingsReads } from '../src/features/teams/settings-reads.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';

const AT = '2026-11-13T10:00:00.000Z';
export const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
export const RETIRED = '0192f0c1-7e5a-7b3c-9d4e-0000000000a9';
export const SIZE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a3';

const team = {
  id: TEAM,
  key: 'ENG',
  name: 'Engineering',
  icon: null,
  color: 'blue',
  timezone: 'UTC',
  private: false,
  defaultStatusId: SIZE,
};

let n = 0;
const label = (
  name: string,
  extra: {
    teamId?: string | null;
    id?: string;
    isGroup?: boolean;
    parentId?: string | null;
    exclusive?: boolean;
    description?: string | null;
  } = {},
) => ({
  id: extra.id ?? `0192f0c1-7e5a-7b3c-9d4e-00000000${String(++n).padStart(4, '0')}`,
  teamId: extra.teamId === undefined ? TEAM : extra.teamId,
  name,
  color: 'blue',
  description: extra.description ?? null,
  parentId: extra.parentId ?? null,
  isGroup: extra.isGroup ?? false,
  exclusive: extra.exclusive ?? true,
  groups: ['workspace'],
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
});

const LABELS = [
  label('Perf', { description: 'Slow things' }),
  label('bug fix'),
  label('Size', { id: SIZE, isGroup: true }),
  label('Small', { parentId: SIZE }),
  label('Scope', { isGroup: true, exclusive: false }),
  label('Bug', { teamId: null }),
  label('Feature', { teamId: null }),
  label('Archived one', { teamId: null }),
  label('Retired', { teamId: null, id: RETIRED, isGroup: true }),
  label('Old size', { teamId: null, parentId: RETIRED }),
];

export class FakeApp extends AppModel {
  readonly #store: SyncStore;
  readonly #raw: { connection: string };

  constructor(
    private readonly memberOf: readonly string[],
    private readonly role: 'admin' | 'member' = 'member',
    dispatch?: (op: { name: string }, input: unknown) => Promise<unknown>,
  ) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    const byModel = new Map<unknown, readonly unknown[]>([
      [Team, [team]],
      [TeamMembership, memberOf.map((teamId) => ({ teamId, userId: 'u-ada' }))],
      [
        User,
        [{ id: 'u-ada', name: 'Ada', displayName: 'ada', email: 'a@example.com', active: true }],
      ],
      [
        Label,
        LABELS.map((l) =>
          ['Archived one', 'Retired', 'Old size'].includes(l.name) ? { ...l, $archived: true } : l,
        ),
      ],
    ]);
    this.#raw = {
      status: 'ready',
      connection: 'online',
      ...(dispatch === undefined ? {} : { dispatch }),
      pool: {
        all: (model: unknown) => byModel.get(model) ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model) ?? []).find((row) => (row as { id?: string }).id === id),
      },
    } as { connection: string };
    this.#store = this.#raw as unknown as SyncStore;
  }

  /** The connection is down: set before mounting (the fake store is not observable). */
  goOffline(): this {
    this.#raw.connection = 'offline';
    return this;
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

/** Server reads that never answer: the pages show "—" (SPEC-010 §5), and no test fetches. */
export const SILENT_READS: SettingsReads = {
  labelUsage: () => new Promise(() => undefined),
  issueGroupBy: () => new Promise(() => undefined),
};

/** The page under the providers the app gives it, on a routable memory history. */
export async function pageTree(
  app: AppModel,
  page: () => ReactNode,
  reads: SettingsReads = SILENT_READS,
): Promise<ReactNode> {
  const rootRoute = createRootRoute({ component: page });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/teams/ENG/labels'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return (
    <AppContext value={app}>
      <SettingsReadsContext value={reads}>
        <ShellContext value={new ShellStore(null)}>
          <ShortcutProvider>
            <RouterProvider router={router} />
          </ShortcutProvider>
        </ShellContext>
      </SettingsReadsContext>
    </AppContext>
  );
}
