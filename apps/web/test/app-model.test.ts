// A store belongs to the session it was opened for. When the session changes (signing in again in
// another tab ends this one: SPEC-001 Q11, E10/E14), the new shell's first render must not read
// the previous session's replica: it would show another user's data for a frame, and a team page
// would see its team vanish as the stores swap and report it lost (SPEC-005 E5).
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type AuthClient, type Session } from '../src/app/auth.js';

const ADA: Session = { userId: 'u1', workspaceId: 'w1' };
const BEN: Session = { userId: 'u2', workspaceId: 'w1' };

async function signedIn(sessions: Session[]) {
  let next = 0;
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => Promise.resolve(sessions[Math.min(next++, sessions.length - 1)] ?? null),
    login: () => Promise.resolve({ ok: true }),
    logout: () => Promise.resolve(),
  };
  const auth = new AuthState(client, { wait: () => Promise.resolve() });
  await auth.ready();
  return { app: new AppModel(auth), auth };
}

const epochOf = (auth: AuthState) => (auth.snapshot.status === 'ready' ? auth.snapshot.epoch : -1);

// Never started: constructing a store opens nothing.
const storeFor = ({ userId, workspaceId }: Session) =>
  new SyncStore({
    models: PRODUCTION_MODELS,
    userId,
    workspaceId,
    locks: null,
    fetch: () => Promise.reject(new Error('not started')),
  });

describe('AppModel store', () => {
  it('is the open store while its session is the signed-in one', async () => {
    const { app, auth } = await signedIn([ADA]);
    const store = storeFor(ADA);
    app.openStore(store, epochOf(auth));
    expect(app.store).toBe(store);
  });

  it("isn't read once another session has begun, before its shell opens a store", async () => {
    const { app, auth } = await signedIn([ADA, BEN]);
    app.openStore(storeFor(ADA), epochOf(auth));
    await auth.recheck();
    expect(auth.snapshot).toMatchObject({ session: BEN });
    expect(app.store).toBeNull();
  });

  it('is the new session’s store once its shell opens one, whatever order the shells close in', async () => {
    const { app, auth } = await signedIn([ADA, ADA]);
    const old = storeFor(ADA);
    app.openStore(old, epochOf(auth));
    await auth.recheck();
    const fresh = storeFor(ADA);
    app.openStore(fresh, epochOf(auth));
    // The previous shell's cleanup runs late: it clears only its own store.
    app.closeStore(old);
    expect(app.store).toBe(fresh);
    app.closeStore(fresh);
    expect(app.store).toBeNull();
  });

  it('is gone after signing out', async () => {
    const { app, auth } = await signedIn([ADA]);
    app.openStore(storeFor(ADA), epochOf(auth));
    await auth.logout();
    expect(app.store).toBeNull();
  });
});
