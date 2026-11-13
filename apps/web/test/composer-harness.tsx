// Shared by the composer and Drafts page tests (jsdom; PLAN-012 S5): a replica with two public
// teams (ENG uses estimates, DES doesn't) and a private one the user isn't in, `Draft` rows in a
// MobX box (so a test can change them like a delta would), a recording dispatcher whose answers a
// test settles, and the shell's hosts with `/team/:key/issues`, `/drafts` and `/issue/…` routes.
// Not a test file.
import { userActor, type Actor } from '@surface/domain';
import {
  Draft,
  Issue,
  Label,
  Team,
  TeamMembership,
  User,
  UserPreferences,
  WorkflowStatus,
} from '@surface/domain/model';
import type { MutationOutcome, Rejection, SyncStore } from '@surface/sync-client';
import { OverlayProvider } from '@surface/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router';
import { observable, runInAction } from 'mobx';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { DraftsPage } from '../src/features/issues/DraftsPage.js';
import { IssueApiContext, type IssueApi } from '../src/features/issues/issue-api.js';
import { IssueNavHost } from '../src/features/issues/IssueNavHost.js';
import { IssuesHost } from '../src/features/issues/IssuesHost.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';

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
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;
export const ME = id(1);
export const BOB = id(2);
export const ENG = id(11);
export const DES = id(12);
export const SEC = id(13);
export const ENG_BACKLOG = id(101);
export const ENG_TODO = id(102);
export const ENG_TRIAGE = id(103);
export const DES_TODO = id(201);
export const LABEL_FRONTEND = id(301);
export const LABEL_BUG = id(302);
const AT = '2026-11-13T10:00:00.000Z';

const team = (teamId: string, key: string, name: string, scale: string, priv = false) => ({
  id: teamId,
  key,
  name,
  icon: null,
  color: 'blue',
  timezone: 'UTC',
  private: priv,
  defaultStatusId: key === 'ENG' ? ENG_BACKLOG : DES_TODO,
  estimateScale: scale,
  estimateExtended: false,
  estimateAllowZero: false,
});

const status = (
  statusId: string,
  teamId: string,
  name: string,
  category: string,
  position: string,
) => ({
  id: statusId,
  teamId,
  name,
  category,
  position,
  color: 'gray',
  description: null,
  groups: [],
  createdAt: AT,
});

export type DraftRowFixture = {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'composer' | 'comment';
  readonly teamId: string | null;
  readonly issueId: string | null;
  readonly data: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Dispatched = {
  readonly op: string;
  readonly input: Record<string, unknown>;
  settle(outcome: MutationOutcome): void;
};

let draftCounter = 900;
export function draftRow(extra: Partial<DraftRowFixture>): DraftRowFixture {
  draftCounter += 1;
  return {
    id: id(draftCounter),
    userId: ME,
    kind: 'composer',
    teamId: ENG,
    issueId: null,
    data: {},
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

export interface ComposerAppOptions {
  readonly teams?: 'all' | 'none';
  readonly homeTeamId?: string;
  readonly drafts?: readonly DraftRowFixture[];
  readonly issues?: readonly Record<string, unknown>[];
}

export class ComposerApp extends AppModel {
  readonly drafts = observable.box<readonly DraftRowFixture[]>([], { deep: false });
  readonly dispatched: Dispatched[] = [];
  readonly issueRows = observable.box<readonly Record<string, unknown>[]>([], { deep: false });
  readonly rejections = observable.array<Rejection>([], { deep: false });
  readonly #store: SyncStore;
  readonly #connection = observable.box<'online' | 'offline'>('online');

  constructor(options: ComposerAppOptions = {}) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.drafts.set(options.drafts ?? []);
    this.issueRows.set(options.issues ?? []);
    const none = options.teams === 'none';
    const byModel = new Map<unknown, () => readonly unknown[]>([
      [
        Team,
        () =>
          none
            ? []
            : [team(ENG, 'ENG', 'Engineering', 'linear'), team(DES, 'DES', 'Design', 'off')],
      ],
      [
        TeamMembership,
        () =>
          none
            ? []
            : [
                { id: id(401), teamId: ENG, userId: ME },
                { id: id(402), teamId: DES, userId: ME },
                { id: id(403), teamId: ENG, userId: BOB },
              ],
      ],
      [
        User,
        () => [
          { id: ME, name: 'Ada', displayName: 'ada', email: 'a@example.com', active: true },
          { id: BOB, name: 'Bob', displayName: 'bob', email: 'b@example.com', active: true },
        ],
      ],
      [
        UserPreferences,
        () =>
          options.homeTeamId === undefined
            ? []
            : [{ id: ME, values: { homeTeamId: options.homeTeamId } }],
      ],
      [
        WorkflowStatus,
        () => [
          status(ENG_TRIAGE, ENG, 'Triage', 'triage', 'a0'),
          status(ENG_BACKLOG, ENG, 'Backlog', 'backlog', 'a0'),
          status(ENG_TODO, ENG, 'Todo', 'unstarted', 'a0'),
          status(DES_TODO, DES, 'Todo', 'unstarted', 'a0'),
        ],
      ],
      [
        Label,
        () => [
          {
            id: LABEL_FRONTEND,
            name: 'Frontend',
            color: 'blue',
            teamId: ENG,
            parentId: null,
            isGroup: false,
            exclusive: false,
            archivedAt: null,
          },
          {
            id: LABEL_BUG,
            name: 'Bug',
            color: 'red',
            teamId: null,
            parentId: null,
            isGroup: false,
            exclusive: false,
            archivedAt: null,
          },
        ],
      ],
      [Issue, () => this.issueRows.get()],
      [Draft, () => this.drafts.get()],
    ]);
    const connection = this.#connection;
    const dispatched = this.dispatched;
    const rejections = this.rejections;
    this.#store = {
      status: 'ready',
      get connection() {
        return connection.get();
      },
      get rejections() {
        return rejections;
      },
      pool: {
        all: (model: unknown) => byModel.get(model)?.() ?? [],
        get: (model: unknown, rowId: string) =>
          (byModel.get(model)?.() ?? []).find((row) => (row as { id?: string }).id === rowId),
      },
      dispatch: (op: { name: string }, input: Record<string, unknown>) =>
        new Promise<MutationOutcome>((resolve) => {
          dispatched.push({ op: op.name, input, settle: resolve });
        }),
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
      memberships: [
        { teamId: ENG, private: false },
        { teamId: DES, private: false },
      ],
    });

  setDrafts(next: readonly DraftRowFixture[]): void {
    runInAction(() => {
      this.drafts.set(next);
    });
  }

  setOnline(online: boolean): void {
    runInAction(() => {
      this.#connection.set(online ? 'online' : 'offline');
    });
  }

  /** The operations dispatched so far, by name. */
  ops(): string[] {
    return this.dispatched.map((d) => d.op);
  }
}

function RegistryProbe({ sink }: { sink: (registry: CommandRegistry) => void }) {
  sink(useCommandRegistry());
  return null;
}

function PathProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

export type Mounted = {
  readonly commands: () => CommandRegistry;
  readonly path: () => string | null | undefined;
  unmount(): void;
};

/** Mounts the shell's issue hosts with a few routes at `path`. */
export async function mountComposer(
  app: AppModel,
  path: string,
  api: IssueApi = { get: () => Promise.reject(new Error('unused')) },
): Promise<Mounted> {
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
          <IssuesHost />
          <PathProbe />
          <Outlet />
        </>
      );
    },
  });
  const routes = [
    createRoute({ getParentRoute: () => root, path: 'team/$key/issues', component: () => null }),
    createRoute({ getParentRoute: () => root, path: 'drafts', component: DraftsPage }),
    createRoute({ getParentRoute: () => root, path: 'issue/$ref/$slug', component: () => null }),
    createRoute({ getParentRoute: () => root, path: 'settings/teams', component: () => null }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
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
        <IssueApiContext value={api}>
          <ShellContext value={new ShellStore(null)}>
            <OverlayProvider>
              <TargetContext value={new TargetStore()}>
                <ShortcutProvider>
                  <RouterProvider router={router} />
                </ShortcutProvider>
              </TargetContext>
            </OverlayProvider>
          </ShellContext>
        </IssueApiContext>
      </AppContext>,
    );
    await Promise.resolve();
  });
  return {
    commands: () => {
      if (registry === undefined) throw new Error('not mounted');
      return registry;
    },
    path: () => document.querySelector('[data-testid="path"]')?.textContent,
    unmount: () => {
      act(() => {
        mounted.unmount();
      });
      host.remove();
    },
  };
}

/** The open dialog with this title, if any. */
export function dialogNamed(title: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].find(
    (d) => d.querySelector('h2')?.textContent === title,
  );
}

export function buttonNamed(name: string, within: ParentNode = document): HTMLButtonElement {
  // A button's text may end with its shortcut (<Kbd>), so the name is matched without it.
  const named = (b: HTMLButtonElement) => {
    const text = [...b.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.tagName === 'KBD'))
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    return text === name || b.textContent?.trim() === name;
  };
  const button = [...within.querySelectorAll('button')].find(
    (b) => named(b) || b.getAttribute('aria-label') === name,
  );
  if (button === undefined) throw new Error(`no button "${name}"`);
  return button;
}

export function titleInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Issue title"]');
  if (input === null) throw new Error('no title field');
  return input;
}

export { AT, id };
