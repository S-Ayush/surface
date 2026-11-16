// Shared by the jsdom tests of the issue page (`issue-page-keys.test.tsx`,
// `issue-not-found.test.tsx`): a replica with observable issue rows (a remote change re-renders
// the page), a store that records what is dispatched, and the page mounted on a real router.
import { userActor, type Actor } from '@surface/domain';
import { Issue, Label, Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import { NO_CONTENT } from './content-stub.js';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
  type AnyRouter,
} from '@tanstack/react-router';
import { TooltipProvider } from '@surface/ui';
import { observable, runInAction, type IObservableArray } from 'mobx';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import type { IssueApi } from '../src/features/issues/issue-api.js';
import { IssueApiContext } from '../src/features/issues/issue-api.js';
import { IssuePage } from '../src/features/issues/IssuePage.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';
import { SHORTCUTS, type Shortcut } from '../src/shortcuts/registry.js';

export const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
export const STATUS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
export const ISSUE_A = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
export const ISSUE_B = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
export const ISSUE_C = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
/** A user whose id is a uuid, for content rows (pass it as `users`). */
export const IRIS_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
export const IRIS: Row = {
  id: IRIS_ID,
  name: 'Iris West',
  displayName: 'Iris',
  email: 'i@x.test',
  active: true,
};
/** In a source list but not in the replica. */
export const UNHELD = '0192f0c1-7e5a-7b3c-9d4e-0000000000b9';

export type Row = Record<string, unknown>;

export const issueRow = (id: string, number: number | null, extra: Row = {}): Row => ({
  id,
  teamId: TEAM,
  number,
  title: 'Login page flickers',
  statusId: STATUS,
  priority: 2,
  assigneeId: 'u-ada',
  labelIds: [],
  estimate: null,
  dueDate: null,
  creatorId: 'u-ada',
  archivedAt: null,
  deletedAt: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...extra,
});

const teamRow: Row = {
  id: TEAM,
  key: 'ENG',
  name: 'Engineering',
  private: false,
  estimateScale: 'fibonacci',
  estimateExtended: false,
  estimateAllowZero: false,
};

export type Dispatched = { readonly op: string; readonly input: unknown };

export class FakeApp extends AppModel {
  readonly #store: SyncStore;
  readonly dispatched: Dispatched[] = [];
  /** The teams the page opened (`store.openTeam`), in order. */
  readonly opened: string[] = [];
  readonly issues: IObservableArray<Row>;
  /** The store's unconfirmed mutations (`store.pending`), observable. */
  readonly pending = observable.array<{ op: string; input?: unknown }>([], { deep: false });

  constructor(options: {
    issues: readonly Row[];
    teams?: readonly Row[];
    statuses?: readonly Row[];
    labels?: readonly Row[];
    /** The store's `content` (`content-stub.ts`); `NO_CONTENT` by default. */
    content?: unknown;
    /** More users (content rows name users by uuid: `IRIS`). */
    users?: readonly Row[];
    /** How a dispatch ends; confirmed by default. */
    answer?: (op: string, input: unknown) => Promise<MutationOutcome>;
  }) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.issues = observable.array(
      options.issues.map((row) => observable({ ...row })),
      { deep: false },
    );
    const teams = options.teams ?? [teamRow];
    const byModel = new Map<unknown, readonly Row[]>([
      [Team, teams],
      [TeamMembership, teams.map((t) => ({ teamId: t['id'], userId: 'u-ada' }))],
      [
        User,
        [
          {
            id: 'u-ada',
            name: 'Ada Lovelace',
            displayName: 'Ada',
            email: 'a@x.test',
            active: true,
          },
          ...(options.users ?? []),
        ],
      ],
      [
        WorkflowStatus,
        options.statuses ?? [
          { id: STATUS, teamId: TEAM, name: 'In Progress', category: 'started', color: 'yellow' },
        ],
      ],
      [Label, options.labels ?? []],
      [Issue, this.issues],
    ]);
    this.#store = {
      status: 'ready',
      connection: 'online',
      rejections: [],
      pending: this.pending,
      content: options.content ?? NO_CONTENT,
      dispatch: (op: { name: string }, input: unknown) => {
        this.dispatched.push({ op: op.name, input });
        return options.answer?.(op.name, input) ?? Promise.resolve({ status: 'confirmed' });
      },
      openTeam: (teamId: string) => {
        this.opened.push(teamId);
      },
      pool: {
        all: (model: unknown) => byModel.get(model) ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model) ?? []).find((row) => row['id'] === id),
        findBy: (model: unknown, field: string, value: unknown) =>
          (byModel.get(model) ?? []).filter((row) => row[field] === value),
      },
    } as unknown as SyncStore;
  }

  /** A change that arrives from the server. */
  remote(id: string, change: Row): void {
    const row = this.issues.find((r) => r['id'] === id);
    if (row === undefined) throw new Error('no such issue');
    runInAction(() => Object.assign(row, change));
  }

  /** The issue leaves the replica (a delete or archive packet, or an optimistic delete). */
  removeIssue(id: string): void {
    runInAction(() => {
      this.issues.replace(this.issues.filter((row) => row['id'] !== id));
    });
  }

  override get store(): SyncStore | null {
    return this.#store;
  }

  override get session(): Session {
    return { userId: 'u-ada', workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    userActor({ userId: 'u-ada', role: 'member', memberships: [{ teamId: TEAM, private: false }] });
}

/** The M1 keys are in the registry but outside the build until a slice raises it (S1). */
const ALL_KEYS: readonly Shortcut[] = SHORTCUTS.map((binding) => ({
  ...binding,
  milestone: 'M0' as const,
}));

// jsdom has no layout or media queries: Radix and the layout hooks ask for these.
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
export function installDomShims(): void {
  globalThis.ResizeObserver ??= NoResize;
  window.scrollTo = () => undefined;
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }
}

function IssueRoute() {
  const ref: unknown = useParams({
    strict: false,
    select: (params: Record<string, unknown>) => params['ref'],
  });
  return <IssuePage issueRef={typeof ref === 'string' ? ref : ''} />;
}

export type Mounted = {
  readonly router: AnyRouter;
  readonly host: HTMLElement;
  /** The page's command registry, to ask what the menu and the keys would offer. */
  readonly registry: () => CommandRegistry | undefined;
  unmount(): Promise<void>;
};

/** Hands the command registry to the test. */
function RegistryProbe({ onRegistry }: { onRegistry: (registry: CommandRegistry) => void }) {
  const registry = useCommandRegistry();
  useEffect(() => {
    onRegistry(registry);
  }, [onRegistry, registry]);
  return null;
}

/**
 * The page on a memory router: the list at `/team/ENG` first, then the issue `ref` on top of it
 * (so Back has somewhere to go), with `state` as a list leaves it.
 */
export async function mountIssuePage(options: {
  app: AppModel;
  ref: string;
  api?: IssueApi;
  state?: Record<string, unknown>;
}): Promise<Mounted> {
  const rootRoute = createRootRoute();
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'issue/$ref',
    component: IssueRoute,
  });
  const issueSlugRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'issue/$ref/$slug',
    component: IssueRoute,
  });
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: 'team/$key',
    component: () => <p>The list</p>,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p>Home</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([issueRoute, issueSlugRoute, list, home]),
    history: createMemoryHistory({ initialEntries: ['/team/ENG'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  await router.navigate({
    to: '/issue/$ref',
    params: { ref: options.ref },
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  const api: IssueApi = options.api ?? { get: () => new Promise(() => undefined) };
  const holder: { registry?: CommandRegistry } = {};
  const onRegistry = (registry: CommandRegistry) => {
    holder.registry = registry;
  };
  await act(async () => {
    root.render(
      <AppContext value={options.app}>
        <IssueApiContext value={api}>
          <ShellContext value={new ShellStore(null)}>
            <TargetContext value={new TargetStore()}>
              <ShortcutProvider bindings={ALL_KEYS}>
                <RegistryProbe onRegistry={onRegistry} />
                {/* The shell's overlays provide it; the comment cards' tooltips need it. */}
                <TooltipProvider>
                  <RouterProvider router={router} />
                </TooltipProvider>
              </ShortcutProvider>
            </TargetContext>
          </ShellContext>
        </IssueApiContext>
      </AppContext>,
    );
    await Promise.resolve();
  });
  return {
    router,
    host,
    registry: () => holder.registry,
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      host.remove();
    },
  };
}

/** Runs `change` inside `act` and lets the effects and promises it started settle. */
export async function inAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

export function keydown(target: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  return inAct(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export function setValue(input: HTMLInputElement, value: string): Promise<void> {
  return inAct(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
