// Shared by the issue list page tests (jsdom): a replica with two teams, statuses and issues held
// in MobX boxes (so a test can change them like a delta would), the page under the providers the
// app gives it, and an issue route that shows the router state it was opened with. Not a test file.
import { userActor, type Actor } from '@surface/domain';
import { Issue, Label, Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import { OverlayProvider } from '@surface/ui';
import type { SyncStore } from '@surface/sync-client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useLocation,
  useParams,
} from '@tanstack/react-router';
import { observable, runInAction } from 'mobx';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import { readListSource } from '../src/features/issues/focus-model.js';
import { IssueListPage } from '../src/features/issues/IssueListPage.js';
import { IssueNavHost } from '../src/features/issues/IssueNavHost.js';
import { MyIssuesPage } from '../src/features/issues/MyIssuesPage.js';
import type { ListIssue } from '../src/features/issues/list-model.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { DES, ENG, ME, STATUSES, issue, uuid } from './issue-list-fixtures.js';

// jsdom has no matchMedia: a wide screen, which never changes.
if (typeof Reflect.get(window, 'matchMedia') !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const AT = '2026-11-13T10:00:00.000Z';

const team = (id: string, key: string, name: string, scale: string) => ({
  id,
  key,
  name,
  icon: null,
  color: 'blue',
  timezone: 'UTC',
  private: false,
  estimateScale: scale,
  estimateExtended: false,
  estimateAllowZero: false,
});

export class IssueApp extends AppModel {
  readonly issues = observable.box<readonly ListIssue[]>([], { deep: false });
  readonly #store: SyncStore;
  readonly #connection = observable.box<'online' | 'offline'>('online');

  constructor(
    initial: readonly ListIssue[],
    readonly memberOf: readonly string[] = [ENG, DES],
  ) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.issues.set(initial);
    const byModel = new Map<unknown, () => readonly unknown[]>([
      [Team, () => [team(ENG, 'ENG', 'Engineering', 'linear'), team(DES, 'DES', 'Design', 'off')]],
      [TeamMembership, () => this.memberOf.map((teamId) => ({ teamId, userId: ME }))],
      [
        User,
        () => [
          { id: ME, name: 'Ada', displayName: 'ada', email: 'a@example.com', active: true },
          { id: 'u-bob', name: 'Bob', displayName: 'bob', email: 'b@example.com', active: true },
        ],
      ],
      [
        WorkflowStatus,
        () => STATUSES.map((s) => ({ ...s, teamId: ENG, groups: [], createdAt: AT })),
      ],
      [Label, () => [{ id: uuid(1), name: 'Perf', color: 'blue', teamId: ENG }]],
      [Issue, () => this.issues.get()],
    ]);
    const connection = this.#connection;
    this.#store = {
      status: 'ready',
      get connection() {
        return connection.get();
      },
      pool: {
        all: (model: unknown) => byModel.get(model)?.() ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model)?.() ?? []).find((row) => (row as { id?: string }).id === id),
      },
    } as unknown as SyncStore;
  }

  override get store(): SyncStore {
    return this.#store;
  }

  override get session(): Session {
    return { userId: ME, workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    userActor({
      userId: ME,
      role: 'member',
      memberships: this.memberOf.map((teamId) => ({ teamId, private: false })),
    });

  setIssues(next: readonly ListIssue[]): void {
    runInAction(() => {
      this.issues.set(next);
    });
  }

  setOnline(online: boolean): void {
    runInAction(() => {
      this.#connection.set(online ? 'online' : 'offline');
    });
  }
}

/** The page the issue route shows: the source list it was opened with, as text. */
function IssueProbe() {
  const location = useLocation();
  const source = readListSource(location.state);
  return (
    <div data-testid="issue-route">
      <span data-testid="issue-path">{location.pathname}</span>
      <span data-testid="issue-source">{JSON.stringify(source ?? null)}</span>
    </div>
  );
}

export type Mounted = {
  readonly host: HTMLElement;
  readonly commands: () => CommandRegistry;
  readonly navigate: (href: string) => Promise<void>;
  unmount(): Promise<void>;
};

function RegistryProbe({ sink }: { sink: (registry: CommandRegistry) => void }) {
  sink(useCommandRegistry());
  return null;
}

/** Mounts the list routes at `path` under the providers; `/issue/…` shows the probe. */
export async function mountLists(app: AppModel, path: string): Promise<Mounted> {
  let registry: CommandRegistry | undefined;
  const root = createRootRoute({
    component: function Root(): ReactNode {
      return (
        <>
          <RegistryProbe
            sink={(value) => {
              registry = value;
            }}
          />
          <IssueNavHost />
          <RouterOutlet />
        </>
      );
    },
  });
  const team = createRoute({
    getParentRoute: () => root,
    path: 'team/$key/issues',
    component: function Team() {
      const params: Record<string, unknown> = useParams({ strict: false });
      return <IssueListPage teamKey={typeof params.key === 'string' ? params.key : ''} />;
    },
  });
  const assigned = createRoute({
    getParentRoute: () => root,
    path: 'my-issues',
    component: () => <MyIssuesPage tab="assigned" />,
  });
  const created = createRoute({
    getParentRoute: () => root,
    path: 'my-issues/created',
    component: () => <MyIssuesPage tab="created" />,
  });
  const issueRoute = createRoute({
    getParentRoute: () => root,
    path: 'issue/$ref/$slug',
    component: IssueProbe,
  });
  const router = createRouter({
    routeTree: root.addChildren([team, assigned, created, issueRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const host = document.createElement('div');
  document.body.append(host);
  const mounted: Root = createRoot(host);
  await act(async () => {
    mounted.render(
      <AppContext value={app}>
        <ShellContext value={new ShellStore(null)}>
          <OverlayProvider>
            <TargetContext value={new TargetStore()}>
              <ShortcutProvider>
                <RouterProvider router={router} />
              </ShortcutProvider>
            </TargetContext>
          </OverlayProvider>
        </ShellContext>
      </AppContext>,
    );
    await Promise.resolve();
  });
  return {
    host,
    commands: () => {
      if (registry === undefined) throw new Error('not mounted');
      return registry;
    },
    navigate: async (href) => {
      await act(async () => {
        await router.navigate({ href });
      });
    },
    unmount: () => {
      act(() => {
        mounted.unmount();
      });
      host.remove();
      return Promise.resolve();
    },
  };
}

import { Outlet } from '@tanstack/react-router';
function RouterOutlet() {
  return <Outlet />;
}

export { issue };
