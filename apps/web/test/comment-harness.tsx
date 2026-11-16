// The comment flow tests' world (PLAN-013 S5): an in-memory replica with a fake server that applies
// each dispatched operation to observable rows (as the optimistic overlay would), confirms it, or
// refuses it with a message the test chose, rolling the rows back as the queue does. The comment
// slots are mounted on a memory router inside the real shortcut engine and command target store.
import { userActor, type Actor } from '@surface/domain';
import {
  Comment,
  Draft,
  Issue,
  Label,
  Reaction,
  Team,
  TeamMembership,
  User,
  WorkflowStatus,
} from '@surface/domain/model';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import { TooltipProvider, overlayManager } from '@surface/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { observable, runInAction } from 'mobx';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import { CommentsSection } from '../src/features/comments/CommentsSection.js';
import { IssueReactions } from '../src/features/comments/IssueReactions.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { SyncStoreProvider } from '@surface/sync-react';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';
import { SHORTCUTS, type Shortcut } from '../src/shortcuts/registry.js';
import { ISSUE_A, STATUS, TEAM, installDomShims, issueRow, type Row } from './issue-fixtures.js';

export const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
export const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
export const THREAD = '0192f0c1-7e5a-7b3c-9d4e-000000000701';
export const REPLY = '0192f0c1-7e5a-7b3c-9d4e-000000000702';
export const RESOLVED = '0192f0c1-7e5a-7b3c-9d4e-000000000703';
export const RESOLVED_REPLY = '0192f0c1-7e5a-7b3c-9d4e-000000000704';
export const MINE = '0192f0c1-7e5a-7b3c-9d4e-000000000705';

const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

export function body(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export function commentRow(id: string, extra: Row = {}): Row {
  return {
    id,
    issueId: ISSUE_A,
    teamId: TEAM,
    parentCommentId: null,
    userId: IRIS,
    actorKind: 'user',
    body: body('Hello'),
    version: 1,
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    createdAt: iso(3),
    updatedAt: iso(3),
    ...extra,
  };
}

/** A valid uuid for row ids (the model schemas check them). */
export const uuidOf = (n: number | string) =>
  `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;

export function reactionRow(id: string, emoji: string, userId: string, commentId: string | null) {
  return { id, issueId: ISSUE_A, teamId: TEAM, commentId, userId, emoji, createdAt: iso(1) };
}

/** The fixture's comments: an open thread with a reply, a resolved thread, and one of mine. */
export function seedComments(): Row[] {
  return [
    commentRow(THREAD, { body: body('Does this happen on Safari?'), createdAt: iso(5) }),
    commentRow(REPLY, {
      parentCommentId: THREAD,
      userId: ME,
      body: body('Yes, on 17.2'),
      createdAt: iso(4),
    }),
    commentRow(RESOLVED, {
      body: body('Old question about caching'),
      createdAt: iso(48),
      resolvedAt: iso(2),
      resolvedById: ME,
    }),
    commentRow(RESOLVED_REPLY, {
      parentCommentId: RESOLVED,
      body: body('Fixed in the last build'),
      createdAt: iso(47),
    }),
    commentRow(MINE, { userId: ME, body: body('My own comment'), createdAt: iso(1), version: 3 }),
  ];
}

export class FakeServer {
  readonly dispatched: { op: string; input: Record<string, unknown> }[] = [];
  readonly comments = observable.array<Row>([], { deep: false });
  readonly reactions = observable.array<Row>([], { deep: false });
  readonly drafts = observable.array<Row>([], { deep: false });
  readonly issues = observable.array<Row>([], { deep: false });
  readonly contentState = observable.box<'loading' | 'ready' | 'offline'>('ready');
  /** The refusal the next dispatch of an operation gets (consumed once). */
  readonly refusals = new Map<string, string>();
  /** Dispatches kept unanswered until the test answers them. */
  holding = false;
  readonly held: (() => void)[] = [];
  #clock = 0;

  /** Rows of the pool by model. */
  #rows(model: unknown): readonly Row[] {
    if (model === Comment) return this.comments;
    if (model === Reaction) return this.reactions;
    if (model === Draft) return this.drafts;
    if (model === Issue) return this.issues;
    if (model === User) {
      return [
        { id: ME, name: 'Ada Lovelace', displayName: 'Ada', email: 'a@x.test', active: true },
        { id: IRIS, name: 'Iris West', displayName: 'Iris', email: 'i@x.test', active: true },
      ];
    }
    if (model === Team) {
      return [{ id: TEAM, key: 'ENG', name: 'Engineering', private: false, estimateScale: 'off' }];
    }
    if (model === TeamMembership) return [{ teamId: TEAM, userId: ME }];
    if (model === WorkflowStatus) {
      return [
        { id: STATUS, teamId: TEAM, name: 'In Progress', category: 'started', color: 'yellow' },
      ];
    }
    if (model === Label) return [];
    return [];
  }

  #stamp(): string {
    this.#clock += 1;
    return new Date(Date.now() + this.#clock).toISOString();
  }

  /** Applies an operation to the rows, as its `optimistic` would; returns how to undo it. */
  #apply(op: string, input: Record<string, unknown>): () => void {
    const touched = [this.comments, this.reactions, this.drafts];
    const before = touched.map((rows) => rows.slice());
    const text = (key: string) => String(input[key]);
    runInAction(() => {
      switch (op) {
        case 'comment.create':
          this.comments.push(
            commentRow(text('id'), {
              userId: ME,
              parentCommentId: input['parent'] ?? null,
              body: input['body'],
              createdAt: this.#stamp(),
            }),
          );
          break;
        case 'comment.update':
          this.#patch(text('comment'), (row) => ({
            ...row,
            body: input['body'],
            version: Number(row['version']) + 1,
            editedAt: this.#stamp(),
          }));
          break;
        case 'comment.delete':
          this.comments.replace(this.comments.filter((row) => row['id'] !== input['comment']));
          break;
        case 'comment.resolve':
          this.#patch(text('comment'), (row) => ({
            ...row,
            resolvedAt: this.#stamp(),
            resolvedById: ME,
          }));
          break;
        case 'comment.reopen':
          this.#patch(text('comment'), (row) => ({ ...row, resolvedAt: null, resolvedById: null }));
          break;
        case 'reaction.set': {
          const commentId = typeof input['comment'] === 'string' ? input['comment'] : null;
          const rest = this.reactions.filter(
            (row) =>
              !(
                row['commentId'] === commentId &&
                row['userId'] === ME &&
                row['emoji'] === input['emoji']
              ),
          );
          this.reactions.replace(
            input['reacted'] === true
              ? [...rest, reactionRow(uuidOf(800 + this.#clock++), text('emoji'), ME, commentId)]
              : rest,
          );
          break;
        }
        case 'draft.save':
          this.drafts.replace([
            ...this.drafts.filter((row) => row['issueId'] !== input['issueId']),
            {
              id: text('id'),
              userId: ME,
              kind: 'comment',
              teamId: null,
              issueId: input['issueId'],
              data: input['data'],
              createdAt: this.#stamp(),
              updatedAt: this.#stamp(),
            },
          ]);
          break;
        case 'draft.discard':
          this.drafts.replace(this.drafts.filter((row) => row['issueId'] !== input['issueId']));
          break;
        default:
          break;
      }
    });
    return () => {
      runInAction(() => {
        this.comments.replace(before[0] ?? []);
        this.reactions.replace(before[1] ?? []);
        this.drafts.replace(before[2] ?? []);
      });
    };
  }

  #patch(id: string, change: (row: Row) => Row): void {
    this.comments.replace(this.comments.map((row) => (row['id'] === id ? change(row) : row)));
  }

  /** Answers every held dispatch as confirmed. */
  release(): void {
    this.holding = false;
    for (const answer of this.held.splice(0)) answer();
  }

  #store: SyncStore | undefined;

  asStore(): SyncStore {
    if (this.#store !== undefined) return this.#store;
    const store = {
      status: 'ready',
      connection: 'online',
      rejections: [],
      openTeam: () => undefined,
      content: {
        state: () => this.contentState.get(),
        rows: () => ({ Comment: this.comments.slice(), Reaction: this.reactions.slice() }),
        open: () => ({ release: () => undefined }),
      },
      pool: {
        all: (model: unknown) => this.#rows(model),
        get: (model: unknown, id: string) => this.#rows(model).find((row) => row['id'] === id),
        findBy: (model: unknown, field: string, value: unknown) =>
          this.#rows(model).filter((row) => row[field] === value),
      },
      dispatch: (
        op: { name: string },
        input: Record<string, unknown>,
      ): Promise<MutationOutcome> => {
        this.dispatched.push({ op: op.name, input });
        const undo = this.#apply(op.name, input);
        const refusal = this.refusals.get(op.name);
        const answer = (): MutationOutcome => {
          if (refusal === undefined) return { status: 'confirmed' };
          this.refusals.delete(op.name);
          undo();
          return { status: 'rejected', error: { code: 'CONFLICT', message: refusal } };
        };
        if (!this.holding) return Promise.resolve(answer());
        return new Promise((resolve) => {
          this.held.push(() => {
            resolve(answer());
          });
        });
      },
    };
    // The replica as the sync client exposes it, narrowed to what the comment UI reads.
    this.#store = store as unknown as SyncStore;
    return this.#store;
  }

  /** What was dispatched for one operation. */
  of(op: string): Record<string, unknown>[] {
    return this.dispatched.filter((entry) => entry.op === op).map((entry) => entry.input);
  }
}

class HarnessApp extends AppModel {
  readonly #store: SyncStore;
  constructor(store: SyncStore) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.#store = store;
  }
  override get store(): SyncStore | null {
    return this.#store;
  }
  override get session(): Session {
    return { userId: ME, workspaceId: 'w-1' };
  }
  override actor = (): Actor | null =>
    userActor({ userId: ME, role: 'member', memberships: [{ teamId: TEAM, private: false }] });
}

const ALL_KEYS: readonly Shortcut[] = SHORTCUTS.map((binding) => ({
  ...binding,
  milestone: 'M0' as const,
}));

export interface World {
  readonly server: FakeServer;
  readonly host: HTMLElement;
  readonly targets: TargetStore;
  readonly registry: CommandRegistry | undefined;
  unmount(): Promise<void>;
}

function Page() {
  return (
    <>
      <IssueReactions issueId={ISSUE_A} />
      <CommentsSection issueId={ISSUE_A} />
    </>
  );
}

/** Hands the page's command registry to the test, to invoke commands as the menu would. */
function RegistryProbe({ onRegistry }: { onRegistry: (registry: CommandRegistry) => void }) {
  const registry = useCommandRegistry();
  useEffect(() => {
    onRegistry(registry);
  }, [onRegistry, registry]);
  return null;
}

export async function mountComments(
  options: {
    comments?: readonly Row[];
    reactions?: readonly Row[];
    drafts?: readonly Row[];
    issue?: Row;
    hash?: string;
    state?: 'loading' | 'ready' | 'offline';
  } = {},
): Promise<World> {
  installDomShims();
  const server = new FakeServer();
  runInAction(() => {
    server.comments.replace([...(options.comments ?? seedComments())]);
    server.reactions.replace([...(options.reactions ?? [])]);
    server.drafts.replace([...(options.drafts ?? [])]);
    server.issues.replace([
      options.issue ?? issueRow(ISSUE_A, 42, { assigneeId: null, creatorId: ME }),
    ]);
    server.contentState.set(options.state ?? 'ready');
  });
  const app = new HarnessApp(server.asStore());
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: 'issue/$ref',
    component: Page,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [`/issue/ENG-42${options.hash === undefined ? '' : `#${options.hash}`}`],
    }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const targets = new TargetStore();
  const holder: { registry?: CommandRegistry } = {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AppContext value={app}>
        <SyncStoreProvider store={server.asStore()}>
          <TooltipProvider>
            <TargetContext value={targets}>
              <ShortcutProvider bindings={ALL_KEYS}>
                <RegistryProbe
                  onRegistry={(registry) => {
                    holder.registry = registry;
                  }}
                />
                <RouterProvider router={router} />
              </ShortcutProvider>
            </TargetContext>
          </TooltipProvider>
        </SyncStoreProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
  const world: World = {
    server,
    host,
    targets,
    get registry() {
      return holder.registry;
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      host.remove();
    },
  };
  return world;
}

/** The messages of the toasts on screen. */
export function toasts(): string[] {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  return [...visibleToasts, ...queuedToasts].map((toast) => toast.message);
}

export function clearToasts(): void {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  for (const toast of [...visibleToasts, ...queuedToasts]) overlayManager.dismissToast(toast.id);
}
