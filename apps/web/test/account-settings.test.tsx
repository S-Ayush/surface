// PLAN-001 S6, SPEC-001 §3.5: Settings → Account → Profile and Security, and the workspace logo.
// The flows run against fakes (no browser, no network); the screens render to a string. AC-15's
// e2e test (a profile change live in another client) is held; its parts are the optimistic test
// in operations and the store path tested here.
import { User, Workspace } from '@surface/domain/model';
import type { AnyOperation } from '@surface/operations';
import { CSRF_HEADER } from '@surface/sync-protocol';
import type { MutationOutcome, SyncStore } from '@surface/sync-client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session as AuthSession } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import {
  httpSettingsApi,
  SettingsApiContext,
  type Session,
  type SettingsApi,
} from '../src/features/files/api.js';
import { postOperation, UNREACHABLE } from '../src/features/files/operation.js';
import {
  IMAGE_TOO_LARGE,
  IMAGE_TYPE,
  imageProblem,
  uploadImage,
} from '../src/features/files/upload.js';
import { fileUrl } from '../src/features/files/url.js';
import { ProfileScreen } from '../src/features/profile/ProfileScreen.js';
import {
  changeAvatar,
  PROFILE_QUEUED_NOTE,
  profileChanges,
  profileProblems,
  removeAvatar,
  saveProfile,
} from '../src/features/profile/save.js';
import { deviceName, lastActiveText } from '../src/features/security/device.js';
import { changedText, changePassword } from '../src/features/security/password.js';
import { SessionsSection, SecurityScreen } from '../src/features/security/SecurityScreen.js';
import {
  SESSIONS_LOADING,
  SessionsFlow,
  type SessionsView,
} from '../src/features/security/sessions.js';
import { WorkspaceScreen } from '../src/features/workspace/WorkspaceScreen.js';
import { changeLogo, removeLogo } from '../src/features/workspace/save.js';
import { sessionList, userChangePassword } from '@surface/operations';

const NOW = new Date('2026-11-12T10:00:00.000Z');
const FILE = '01930000-0000-7000-8000-0000000000f1';
const THIS = '01930000-0000-7000-8000-0000000005e1';
const OTHER = '01930000-0000-7000-8000-0000000005e2';

const session = (id: string, current: boolean, lastUsedAt = NOW.toISOString()): Session => ({
  id,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  ip: '192.0.2.1',
  createdAt: NOW.toISOString(),
  lastUsedAt,
  current,
});

/** A store for the mutation helpers: records what it is sent, answers with `outcome`. */
function fakeStore(outcome: MutationOutcome = { status: 'confirmed' }, connection = 'online') {
  const sent: { op: string; input: unknown }[] = [];
  const store = {
    connection,
    dispatch: (op: AnyOperation, input: unknown) => {
      sent.push({ op: op.name, input });
      return Promise.resolve(outcome);
    },
  };
  return { store, sent };
}

const rejected = (code: string, message: string): MutationOutcome =>
  ({ status: 'rejected', error: { code, message } }) as unknown as MutationOutcome;

/** A fetch that answers each request with the next response, recording what it was sent. */
function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new TypeError('offline'));
  };
  return { fetchFn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeApi = (overrides: Partial<SettingsApi> = {}): SettingsApi => ({
  upload: () => Promise.resolve({ ok: true, id: FILE }),
  sessions: () =>
    Promise.resolve({
      ok: true,
      result: { sessions: [session(THIS, true), session(OTHER, false)], more: false },
    }),
  revokeSession: () => Promise.resolve({ ok: true, result: { revoked: true } }),
  revokeOtherSessions: () => Promise.resolve({ ok: true, result: { revoked: 1 } }),
  changePassword: () => Promise.resolve({ ok: true, result: { endedSessions: 2 } }),
  ...overrides,
});

describe('the device a session is on (SPEC-001 §3.5)', () => {
  it('names the browser and system from the User-Agent', () => {
    expect(deviceName(session(THIS, true).userAgent)).toBe('Firefox on macOS');
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      deviceName(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on Linux');
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(deviceName('curl/8.7.1')).toBe('curl');
    expect(deviceName('SomethingElse/1.0')).toBe('Unknown device');
    expect(deviceName(null)).toBe('Unknown device');
  });

  it('says when it was last active', () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(lastActiveText(ago(30_000), NOW)).toBe('Active now');
    expect(lastActiveText(ago(5 * 60_000), NOW)).toBe('Active 5 minutes ago');
    expect(lastActiveText(ago(3 * 3_600_000), NOW)).toBe('Active 3 hours ago');
    expect(lastActiveText(ago(26 * 3_600_000), NOW)).toBe('Active yesterday');
    expect(lastActiveText('2026-10-01T10:00:00.000Z', NOW)).toBe('Active on Oct 1, 2026');
  });
});

describe('the sessions list (SPEC-001 §3.5, AC-8)', () => {
  it('loads, and reloads after a revoke', async () => {
    const views: SessionsView[] = [];
    const revoked: string[] = [];
    let loads = 0;
    const flow = new SessionsFlow(
      fakeApi({
        sessions: () => {
          loads += 1;
          return fakeApi().sessions();
        },
        revokeSession: (id) => {
          revoked.push(id);
          return fakeApi().revokeSession(id);
        },
      }),
      (view) => views.push(view),
    );
    await flow.load();
    expect(flow.view.sessions.map((s) => s.id)).toEqual([THIS, OTHER]);
    await flow.revoke(OTHER);
    expect(revoked).toEqual([OTHER]);
    expect(loads).toBe(2);
    expect(views.some((view) => view.revoking === OTHER)).toBe(true);
    expect(flow.view.revoking).toBeNull();
  });

  it('keeps a refused revoke’s message after the reload', async () => {
    const flow = new SessionsFlow(
      fakeApi({
        revokeOtherSessions: () =>
          Promise.resolve({ ok: false, code: 'UNREACHABLE', message: UNREACHABLE }),
      }),
      () => undefined,
    );
    await flow.load();
    await flow.revokeOthers();
    expect(flow.view.error).toBe(UNREACHABLE);
  });

  it('runs one revoke at a time', async () => {
    let release: () => void = () => undefined;
    const calls: string[] = [];
    const flow = new SessionsFlow(
      fakeApi({
        revokeSession: (id) => {
          calls.push(id);
          return new Promise((resolve) => {
            release = () => resolve({ ok: true, result: { revoked: true } });
          });
        },
      }),
      () => undefined,
    );
    const first = flow.revoke(OTHER);
    await flow.revokeOthers();
    await flow.revoke(THIS);
    release();
    await first;
    expect(calls).toEqual([OTHER]);
  });

  it('drops an older load that answers late', async () => {
    const answers: ((sessions: Session[]) => void)[] = [];
    const flow = new SessionsFlow(
      fakeApi({
        sessions: () =>
          new Promise((resolve) =>
            answers.push((sessions) => resolve({ ok: true, result: { sessions, more: false } })),
          ),
      }),
      () => undefined,
    );
    const older = flow.load();
    const newer = flow.load();
    answers[1]?.([session(THIS, true)]);
    await newer;
    answers[0]?.([session(OTHER, false)]);
    await older;
    expect(flow.view.sessions.map((s) => s.id)).toEqual([THIS]);
  });

  it('marks this device, without Revoke, and offers Revoke all others', () => {
    const view: SessionsView = {
      ...SESSIONS_LOADING,
      loading: false,
      sessions: [session(THIS, true), session(OTHER, false)],
    };
    const html = renderToString(
      <SessionsSection
        view={view}
        flow={{ revoke: async () => {}, revokeOthers: async () => {} }}
        now={NOW}
      />,
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('This device');
    expect(html).toContain('192.0.2.1 · Active now');
    expect(html.match(/aria-label="Revoke the session on Firefox on macOS"/g)).toHaveLength(1);
    expect(html).toContain('Revoke all others');
  });

  it('offers no Revoke all others when this is the only session', () => {
    const view: SessionsView = {
      ...SESSIONS_LOADING,
      loading: false,
      sessions: [session(THIS, true)],
    };
    const html = renderToString(
      <SessionsSection
        view={view}
        flow={{ revoke: async () => {}, revokeOthers: async () => {} }}
      />,
    );
    expect(html).not.toContain('Revoke all others');
    expect(html).not.toContain('>Revoke<');
  });
});

describe('changing your password (SPEC-001 §3.5, E10)', () => {
  const values = { current: 'old passphrase', next: 'a new passphrase', again: 'a new passphrase' };

  it('asks for the current password, and the new one twice, before sending', async () => {
    let sent = 0;
    const api = fakeApi({
      changePassword: () => {
        sent += 1;
        return fakeApi().changePassword('', '');
      },
    });
    expect(await changePassword(api, { ...values, current: '' })).toMatchObject({
      problem: { field: 'currentPassword', message: 'Enter your current password.' },
    });
    expect(await changePassword(api, { ...values, again: 'something else' })).toMatchObject({
      problem: {
        field: 'newPassword',
        message: "The passwords don't match. Type the same one twice.",
      },
    });
    expect(await changePassword(api, { ...values, next: 'short', again: 'short' })).toMatchObject({
      problem: { field: 'newPassword' },
    });
    expect(sent).toBe(0);
  });

  it('shows a refusal on the field it names', async () => {
    const api = fakeApi({
      changePassword: () =>
        Promise.resolve({
          ok: false,
          code: 'INVALID_INPUT',
          message: 'Your current password is not right. Check it and try again.',
          field: 'currentPassword',
        }),
    });
    expect(await changePassword(api, values)).toEqual({
      phase: 'editing',
      busy: false,
      problem: {
        field: 'currentPassword',
        message: 'Your current password is not right. Check it and try again.',
      },
    });
  });

  it('says how many other sessions were logged out', async () => {
    expect(await changePassword(fakeApi(), values)).toEqual({ phase: 'changed', endedSessions: 2 });
    expect(changedText(0)).toBe('Password changed.');
    expect(changedText(1)).toBe('Password changed. 1 other session was logged out.');
    expect(changedText(2)).toBe('Password changed. 2 other sessions were logged out.');
  });
});

describe('the settings requests over HTTP', () => {
  it('sends an operation with the CSRF token and reads its result', async () => {
    const { fetchFn, calls } = fakeFetch(
      json(200, {
        ok: true,
        result: { nodes: [session(THIS, true)], pageInfo: { hasNextPage: true, endCursor: 'c' } },
      }),
    );
    const api = httpSettingsApi(fetchFn, () => 'surface_csrf=tok');
    expect(await api.sessions()).toEqual({
      ok: true,
      result: { sessions: [session(THIS, true)], more: true },
    });
    expect(calls[0]?.url).toBe(`/api/ops/${sessionList.name}`);
    expect(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER)).toBe('tok');
    expect(JSON.parse(typeof calls[0]?.init?.body === 'string' ? calls[0].init.body : '')).toEqual({
      input: { limit: 100 },
    });
  });

  it('reads the field a refusal names, and hides a server failure', async () => {
    const refusal = json(400, {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Your current password is not right.',
        correlationId: 'r',
        issues: [{ path: ['currentPassword'], message: 'x' }],
      },
    });
    const { fetchFn } = fakeFetch(
      refusal,
      json(500, { ok: false, error: { code: 'INTERNAL', message: 'stack' } }),
    );
    const input = { currentPassword: 'a', newPassword: 'b' };
    expect(await postOperation(fetchFn, userChangePassword, input)).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
      message: 'Your current password is not right.',
      field: 'currentPassword',
    });
    expect(await postOperation(fetchFn, userChangePassword, input)).toMatchObject({
      ok: false,
      message: UNREACHABLE,
    });
    // No answer at all.
    expect(await postOperation(fetchFn, userChangePassword, input)).toMatchObject({
      message: UNREACHABLE,
    });
  });
});

describe('uploading an image (ADR-0014; SPEC-001 §3.5)', () => {
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

  it('refuses a large or non-image file without sending it', async () => {
    expect(imageProblem({ size: 2 * 1024 * 1024 + 1, type: 'image/png' })).toBe(IMAGE_TOO_LARGE);
    expect(imageProblem({ size: 10, type: 'image/svg+xml' })).toBe(IMAGE_TYPE);
    expect(imageProblem({ size: 10, type: '' })).toBeNull();
    const { fetchFn, calls } = fakeFetch();
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    expect(await uploadImage(fetchFn, svg, 'avatar')).toEqual({ ok: false, message: IMAGE_TYPE });
    expect(calls).toEqual([]);
  });

  it('posts the bytes as the body, for the purpose, and answers the file id', async () => {
    const { fetchFn, calls } = fakeFetch(
      json(201, { ok: true, result: { id: FILE, url: `/files/${FILE}` } }),
    );
    expect(await uploadImage(fetchFn, png, 'logo')).toEqual({ ok: true, id: FILE });
    expect(calls[0]?.url).toBe('/files/upload?purpose=logo');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(png);
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('image/png');
  });

  it('shows the server’s refusal, and never a server failure', async () => {
    const { fetchFn } = fakeFetch(
      json(413, { ok: false, error: { code: 'INVALID_INPUT', message: IMAGE_TOO_LARGE } }),
      json(500, { ok: false, error: { code: 'INTERNAL', message: 'details' } }),
    );
    expect(await uploadImage(fetchFn, png, 'avatar')).toEqual({
      ok: false,
      message: IMAGE_TOO_LARGE,
    });
    expect(await uploadImage(fetchFn, png, 'avatar')).toEqual({ ok: false, message: UNREACHABLE });
    expect(await uploadImage(fetchFn, png, 'avatar')).toEqual({ ok: false, message: UNREACHABLE });
  });

  it('serves a file from /files/:id, and nothing for no file', () => {
    expect(fileUrl(FILE)).toBe(`/files/${FILE}`);
    expect(fileUrl(null)).toBeUndefined();
  });
});

describe('saving your profile (SPEC-001 §3.5, AC-15)', () => {
  const saved = { name: 'Ada Lovelace', displayName: 'ada', timezone: 'UTC' };

  it('sends only what changed, trimmed', async () => {
    expect(profileChanges(saved, { ...saved, name: ' Ada King ' })).toEqual({ name: 'Ada King' });
    const { store, sent } = fakeStore();
    expect(await saveProfile(store, saved, { ...saved, timezone: 'Europe/Berlin ' })).toEqual({
      kind: 'saved',
    });
    expect(sent).toEqual([{ op: 'user.updateProfile', input: { timezone: 'Europe/Berlin' } }]);
  });

  it('sends nothing unchanged or invalid; the fields say why', async () => {
    const { store, sent } = fakeStore();
    expect(await saveProfile(store, saved, saved)).toEqual({ kind: 'skipped' });
    const invalid = { ...saved, displayName: 'ada lovelace', timezone: 'Mars/Olympus' };
    expect(await saveProfile(store, saved, invalid)).toEqual({ kind: 'skipped' });
    expect(sent).toEqual([]);
    const problems = profileProblems({ ...invalid, name: ' ' });
    expect(problems.name).toBe('Name is required.');
    expect(problems.displayName).toMatch(/^Display name can use letters.*\.$/);
    expect(problems.timezone).toMatch(/is not a time zone.*\.$/);
  });

  it('shows a display name someone has on its field (E5)', async () => {
    const { store } = fakeStore(rejected('CONFLICT', 'That display name is taken. Try grace2.'));
    expect(await saveProfile(store, saved, { ...saved, displayName: 'grace' })).toEqual({
      kind: 'error',
      message: 'That display name is taken. Try grace2.',
      field: 'displayName',
    });
  });

  it('keeps an offline change queued, with a note', async () => {
    const { store } = fakeStore({ status: 'confirmed' }, 'offline');
    expect(await saveProfile(store, saved, { ...saved, name: 'Ada' })).toEqual({
      kind: 'queued',
      note: PROFILE_QUEUED_NOTE,
    });
  });

  it('uploads a new avatar, then sets it; a refused upload sets nothing', async () => {
    const { store, sent } = fakeStore();
    const file = new Blob(['x'], { type: 'image/png' });
    expect(await changeAvatar(fakeApi(), store, file)).toEqual({ ok: true });
    expect(sent).toEqual([{ op: 'user.updateProfile', input: { avatar: FILE } }]);
    const refused = fakeApi({ upload: () => Promise.resolve({ ok: false, message: IMAGE_TYPE }) });
    expect(await changeAvatar(refused, store, file)).toEqual({ ok: false, message: IMAGE_TYPE });
    expect(sent).toHaveLength(1);
    expect(await removeAvatar(store)).toEqual({ ok: true });
    expect(sent[1]).toEqual({ op: 'user.updateProfile', input: { avatar: null } });
  });
});

describe('the workspace logo (SPEC-001 §3.6; PLAN-001 S6)', () => {
  it('uploads the logo, then sets it; removing sets null', async () => {
    const { store, sent } = fakeStore();
    const file = new Blob(['x'], { type: 'image/png' });
    const purposes: string[] = [];
    const api = fakeApi({
      upload: (_file, purpose) => {
        purposes.push(purpose);
        return Promise.resolve({ ok: true, id: FILE });
      },
    });
    expect(await changeLogo(api, store, file)).toEqual({ ok: true });
    expect(await removeLogo(store)).toEqual({ ok: true });
    expect(purposes).toEqual(['logo']);
    expect(sent).toEqual([
      { op: 'workspace.update', input: { logo: FILE } },
      { op: 'workspace.update', input: { logo: null } },
    ]);
  });

  it('shows a refusal', async () => {
    const { store } = fakeStore(
      rejected('FORBIDDEN', 'Only Admins can change the workspace logo.'),
    );
    expect(await changeLogo(fakeApi(), store, new Blob(['x']))).toEqual({
      ok: false,
      message: 'Only Admins can change the workspace logo.',
    });
  });
});

const ME = '01930000-0000-7000-8000-00000000ada1';

/** Only what these screens read; the real store is covered by sync-client's own tests. */
class FakeApp extends AppModel {
  readonly #store: SyncStore;
  constructor(user: object | undefined, workspace: object | undefined) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.#store = {
      status: 'ready',
      connection: 'online',
      pool: {
        get: (model: unknown, id: string) => (model === User && id === ME ? user : undefined),
        all: (model: unknown) => (model === Workspace && workspace ? [workspace] : []),
      },
    } as unknown as SyncStore;
  }
  override get store(): SyncStore | null {
    return this.#store;
  }
  override get session(): AuthSession {
    return { userId: ME, workspaceId: 'w-1' };
  }
}

const render = (app: AppModel, node: React.ReactNode) =>
  renderToString(
    <AppContext value={app}>
      <SettingsApiContext value={fakeApi()}>{node}</SettingsApiContext>
    </AppContext>,
  ).replaceAll('<!-- -->', '');

describe('the account screens', () => {
  const ada = {
    id: ME,
    name: 'Ada Lovelace',
    displayName: 'ada',
    timezone: 'Europe/London',
    avatarFileId: FILE,
  };

  it('Profile shows your avatar and fields to edit', () => {
    const html = render(new FakeApp(ada, undefined), <ProfileScreen params={{}} />);
    expect(html).toContain(`src="/files/${FILE}"`);
    expect(html).toContain('aria-label="Remove the avatar"');
    expect(html).toContain('alt="Your avatar"');
    expect(html).toContain('value="Ada Lovelace"');
    expect(html).toContain('value="ada"');
    expect(html).toContain('value="Europe/London"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('Profile shows initials, and no Remove, without an avatar', () => {
    const html = render(
      new FakeApp({ ...ada, avatarFileId: null }, undefined),
      <ProfileScreen params={{}} />,
    );
    expect(html).not.toContain('/files/');
    expect(html).not.toContain('Remove the avatar');
    expect(html).toContain('>AL<');
  });

  it('Security has the password form and the sessions list', () => {
    const html = render(new FakeApp(ada, undefined), <SecurityScreen params={{}} />);
    expect(html).toContain('Current password');
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('Sessions');
  });

  it('Workspace shows the logo with the name', () => {
    const html = render(
      new FakeApp(ada, { id: 'w-1', name: 'Acme', logoFileId: FILE }),
      <WorkspaceScreen params={{}} />,
    );
    expect(html).toContain(`src="/files/${FILE}"`);
    expect(html).toContain('aria-label="Remove the logo"');
    expect(html).toContain('alt="The workspace logo"');
    expect(html).toContain('value="Acme"');
  });
});
