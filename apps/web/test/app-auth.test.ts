// The pre-auth client (until PLAN-001 S3): setup state from `GET /setup/status`, nobody signed in.
import { describe, expect, it } from 'vitest';
import { AuthState, preAuthClient } from '../src/app/auth.js';

const reply = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('preAuthClient', () => {
  it('reads setup state from /setup/status', async () => {
    const urls: string[] = [];
    const client = preAuthClient((url) => {
      urls.push(url);
      return reply(200, { ok: true, result: { complete: false, tokenValid: false } })();
    });
    await expect(client.capabilities()).resolves.toEqual({ setupComplete: false, smtp: false });
    expect(urls).toEqual(['/setup/status']);
    await expect(client.session()).resolves.toBeNull();
  });

  it('fails on an error status or an unexpected body, so the app says the server is unreachable', async () => {
    const down = new AuthState(preAuthClient(reply(503, { ok: false })));
    expect((await down.ready()).status).toBe('failed');
    const odd = new AuthState(preAuthClient(reply(200, { ok: true, result: { done: 1 } })));
    expect((await odd.ready()).status).toBe('failed');
  });
});
