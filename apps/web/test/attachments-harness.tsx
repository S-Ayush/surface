// The attachment UI tests' world (PLAN-014 S5): an in-memory replica whose `dispatch` runs each
// operation's real `optimistic` (S4a) over observable rows, then confirms it or refuses it with a
// message the test chose, rolling the rows back as the queue does. The Attachments section is
// mounted inside the real shortcut engine, command registry and command target store, with a fake
// uploader (no request ever leaves the test).
import { userActor, type Actor } from '@surface/domain';
import {
  Attachment,
  Issue,
  Label,
  Team,
  TeamMembership,
  User,
  WorkflowStatus,
} from '@surface/domain/model';
import type { AnyOperation, OptimisticStore, StoreRow } from '@surface/operations';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import { SyncStoreProvider } from '@surface/sync-react';
import { PlatformProvider, TooltipProvider, overlayManager, type Platform } from '@surface/ui';
import { observable, runInAction } from 'mobx';
import { act, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import type { CommandRegistry } from '../src/commands/registry.js';
import { AttachmentsSection } from '../src/features/attachments/AttachmentsSection.js';
import {
  UploaderContext,
  type UploadAnswer,
  type Uploader,
  type UploadRequest,
  type UploadResult,
} from '../src/features/attachments/transport.js';
import { ServerContentContext, type ServerContent } from '../src/features/issues/server-issue.js';
import {
  ShortcutProvider,
  useCommandRegistry,
  usePageScope,
} from '../src/shortcuts/ShortcutProvider.js';
import { SHORTCUTS, type Shortcut } from '../src/shortcuts/registry.js';
import { ISSUE_A, STATUS, TEAM, installDomShims, issueRow, type Row } from './issue-fixtures.js';

export const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
export const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
export const uuidOf = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;
export const FILE_1 = uuidOf(901);
export const FILE_2 = uuidOf(902);
export const LINK_1 = uuidOf(911);
export const IMAGE_1 = uuidOf(921);
export const IMAGE_2 = uuidOf(922);

const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

export function attachmentRow(id: string, extra: Row = {}): Row {
  return {
    id,
    issueId: ISSUE_A,
    teamId: TEAM,
    kind: 'file',
    title: 'design.pdf',
    url: null,
    fileId: uuidOf(500 + Number(id.slice(-3))),
    fileName: 'design.pdf',
    mimeType: 'application/pdf',
    size: 1_258_291,
    imageWidth: null,
    imageHeight: null,
    previewFileId: null,
    creatorId: IRIS,
    groups: [`team:${TEAM}`],
    createdAt: iso(3),
    updatedAt: iso(3),
    ...extra,
  };
}

export function linkRow(id: string, extra: Row = {}): Row {
  return attachmentRow(id, {
    kind: 'link',
    title: 'Login flow',
    url: 'https://www.figma.com/file/abc123/Login-flow',
    fileId: null,
    fileName: null,
    mimeType: null,
    size: null,
    ...extra,
  });
}

export function imageRow(id: string, extra: Row = {}): Row {
  return attachmentRow(id, {
    title: 'screenshot.png',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    size: 20_480,
    imageWidth: 800,
    imageHeight: 600,
    ...extra,
  });
}

/** What the fake upload route answers for `file`. */
export function answerFor(file: File, id: string): UploadAnswer {
  return {
    id,
    url: `/files/${id}`,
    mimeType: file.type === '' ? 'application/octet-stream' : file.type,
    size: file.size,
    name: file.name,
  };
}

/** An uploader the test answers by hand: each call waits until `finish` or `fail`. */
export class FakeUploader {
  readonly calls: {
    request: UploadRequest;
    resolve: (result: UploadResult) => void;
  }[] = [];
  #next = 950;

  readonly upload: Uploader = (request) =>
    new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => {
        resolve({ ok: false, message: 'Upload canceled.', aborted: true });
      });
      this.calls.push({ request, resolve });
    });

  /** Answers call `index` with a stored file. */
  finish(index = 0): string {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`no upload ${String(index)}`);
    this.#next += 1;
    const id = uuidOf(this.#next);
    call.resolve({ ok: true, answer: answerFor(call.request.file, id) });
    return id;
  }

  fail(index: number, message: string): void {
    this.calls[index]?.resolve({ ok: false, message, aborted: false });
  }
}

export class AttachmentServer {
  readonly dispatched: { op: string; input: Record<string, unknown> }[] = [];
  readonly attachments = observable.array<Row>([], { deep: false });
  readonly issues = observable.array<Row>([], { deep: false });
  readonly connection = observable.box<'online' | 'offline'>('online');
  /** The refusal the next dispatch of an operation gets (consumed once). */
  readonly refusals = new Map<string, string>();
  holding = false;
  readonly held: (() => void)[] = [];
  #store: SyncStore | undefined;

  #rows(model: unknown): readonly Row[] {
    if (model === Attachment || model === 'Attachment') return this.attachments;
    if (model === Issue || model === 'Issue') return this.issues;
    if (model === User || model === 'User') {
      return [
        { id: ME, name: 'Ada Lovelace', displayName: 'Ada', email: 'a@x.test', active: true },
        { id: IRIS, name: 'Iris West', displayName: 'Iris', email: 'i@x.test', active: true },
      ];
    }
    if (model === Team || model === 'Team') {
      return [{ id: TEAM, key: 'ENG', name: 'Engineering', private: false, estimateScale: 'off' }];
    }
    if (model === TeamMembership || model === 'TeamMembership') {
      return [{ id: uuidOf(1), teamId: TEAM, userId: ME }];
    }
    if (model === WorkflowStatus) {
      return [
        { id: STATUS, teamId: TEAM, name: 'In Progress', category: 'started', color: 'yellow' },
      ];
    }
    if (model === Label) return [];
    return [];
  }

  /** The overlay as an operation's `optimistic` sees it (S4a's functions run unchanged). */
  #optimisticStore(): OptimisticStore {
    const rowsOf = (model: string) =>
      model === 'Attachment' ? this.attachments : this.#rows(model);
    return {
      now: new Date(),
      get: (model, ref) => {
        const id = model === 'User' && ref === 'me' ? ME : ref;
        return rowsOf(model).find((row) => row['id'] === id);
      },
      find: (model, fields) =>
        rowsOf(model).filter((row) =>
          Object.entries(fields).every(([key, value]) => row[key] === value),
        ),
      insert: (model, row: StoreRow & { readonly id: string }) => {
        if (model === 'Attachment') this.attachments.push({ ...row });
      },
      patch: (model, ref, changes) => {
        if (model !== 'Attachment') return;
        this.attachments.replace(
          this.attachments.map((row) => (row['id'] === ref ? { ...row, ...changes } : row)),
        );
      },
      remove: (model, ref) => {
        if (model === 'Attachment') {
          this.attachments.replace(this.attachments.filter((row) => row['id'] !== ref));
        }
      },
      archive: () => undefined,
      unarchive: () => undefined,
    };
  }

  asStore(): SyncStore {
    if (this.#store !== undefined) return this.#store;
    const connection = this.connection;
    const store = {
      status: 'ready',
      get connection() {
        return connection.get();
      },
      rejections: [],
      pending: [],
      openTeam: () => undefined,
      content: {
        state: () => 'ready',
        rows: () => ({}),
        open: () => ({ release: () => undefined }),
      },
      pool: {
        all: (model: unknown) => this.#rows(model),
        get: (model: unknown, id: string) => this.#rows(model).find((row) => row['id'] === id),
        findBy: (model: unknown, field: string, value: unknown) =>
          this.#rows(model).filter((row) => row[field] === value),
      },
      dispatch: (op: AnyOperation, input: Record<string, unknown>): Promise<MutationOutcome> => {
        this.dispatched.push({ op: op.name, input });
        const before = this.attachments.slice();
        // A refusal the overlay already knows throws here, as the real queue's dispatch does.
        runInAction(() => op.optimistic?.(this.#optimisticStore(), input));
        const refusal = this.refusals.get(op.name);
        const answer = (): MutationOutcome => {
          if (refusal === undefined) return { status: 'confirmed' };
          this.refusals.delete(op.name);
          runInAction(() => this.attachments.replace(before));
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
    // The replica as the sync client exposes it, narrowed to what the attachment UI reads.
    this.#store = store as unknown as SyncStore;
    return this.#store;
  }

  of(op: string): Record<string, unknown>[] {
    return this.dispatched.filter((entry) => entry.op === op).map((entry) => entry.input);
  }

  release(): void {
    this.holding = false;
    for (const answer of this.held.splice(0)) answer();
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

/** Every binding, M1's included (the build is still M0). */
export const ALL_KEYS: readonly Shortcut[] = SHORTCUTS.map((binding) => ({
  ...binding,
  milestone: 'M0' as const,
}));

/** The issue page's shortcut scope, as `IssuePage` sets it. */
function IssuePageScope() {
  usePageScope('issue-page');
  return null;
}

function RegistryProbe({ onRegistry }: { onRegistry: (registry: CommandRegistry) => void }) {
  const registry = useCommandRegistry();
  useEffect(() => {
    onRegistry(registry);
  }, [onRegistry, registry]);
  return null;
}

export interface AttachmentWorld {
  readonly server: AttachmentServer;
  readonly uploader: FakeUploader;
  readonly host: HTMLElement;
  readonly targets: TargetStore;
  readonly registry: CommandRegistry | undefined;
  unmount(): Promise<void>;
}

export async function mountAttachments(
  options: {
    attachments?: readonly Row[];
    issue?: Row;
    platform?: Platform;
    /** The read-only view: the page provides the server's answer instead of the replica. */
    server?: ServerContent;
    /** More of the page around the section (a comment box, say). */
    around?: ReactNode;
  } = {},
): Promise<AttachmentWorld> {
  installDomShims();
  const server = new AttachmentServer();
  runInAction(() => {
    server.attachments.replace([...(options.attachments ?? [])]);
    server.issues.replace([
      options.issue ?? issueRow(ISSUE_A, 42, { assigneeId: null, creatorId: ME }),
    ]);
  });
  const uploader = new FakeUploader();
  const app = new HarnessApp(server.asStore());
  const targets = new TargetStore();
  const holder: { registry?: CommandRegistry } = {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const section = <AttachmentsSection issueId={ISSUE_A} />;
  await act(async () => {
    root.render(
      <PlatformProvider platform={options.platform ?? 'mac'}>
        <AppContext value={app}>
          <SyncStoreProvider store={server.asStore()}>
            <TooltipProvider>
              <TargetContext value={targets}>
                <UploaderContext value={uploader.upload}>
                  <ShortcutProvider bindings={ALL_KEYS}>
                    <RegistryProbe
                      onRegistry={(registry) => {
                        holder.registry = registry;
                      }}
                    />
                    <IssuePageScope />
                    <div data-shortcut-scope="issue">
                      {options.around}
                      {options.server === undefined ? (
                        section
                      ) : (
                        <ServerContentContext value={options.server}>
                          {section}
                        </ServerContentContext>
                      )}
                    </div>
                  </ShortcutProvider>
                </UploaderContext>
              </TargetContext>
            </TooltipProvider>
          </SyncStoreProvider>
        </AppContext>
      </PlatformProvider>,
    );
    await Promise.resolve();
  });
  return {
    server,
    uploader,
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
}

/** The messages of the toasts on screen. */
export function toasts(): string[] {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  return [...visibleToasts, ...queuedToasts].map((toast) => toast.message);
}

/** Runs the action of the newest toast with `message` (Undo). */
export function toastAction(message: string): void {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  const toast = [...visibleToasts, ...queuedToasts].reverse().find((t) => t.message === message);
  if (toast?.action === undefined) throw new Error(`no toast action for "${message}"`);
  toast.action.onAction();
}

export function clearToasts(): void {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  for (const toast of [...visibleToasts, ...queuedToasts]) overlayManager.dismissToast(toast.id);
}

/** Presses a button as a pointer does (Radix menus open on `pointerdown`). */
export async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await act(async () => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
    await Promise.resolve();
  });
}

/** The row menu's item labels, after opening it. */
export async function openRowMenu(title: string): Promise<string[]> {
  await press(document.querySelector(`button[aria-label="Actions for ${title}"]`));
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

/** Opens the row menu and picks `item`. */
export async function pickRowMenu(title: string, item: string): Promise<void> {
  await openRowMenu(title);
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === item,
  );
  await press(entry);
}

/** Lets pending promises (an upload answer, a dispatch) settle inside `act`. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}
