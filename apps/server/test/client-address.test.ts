// SPEC-004 §7 `TRUST_PROXY` (D6): `true` trusts exactly one reverse proxy, so the client address
// is the one that proxy appended to X-Forwarded-For, never an entry the client sent itself.
// Sign-in limits count attempts per address (ADR-0007), so a spoofable address bypasses them.
import { afterEach, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.app.close();
});

const PROXY = '172.18.0.2'; // the reverse proxy's container address
const CLIENT = '203.0.113.9'; // what the proxy saw and appended
const SPOOFED = '198.51.100.66'; // what the client claimed

/** The client address the request log recorded for one request. */
async function loggedAddress(headers: Record<string, string>): Promise<unknown> {
  // Health probes aren't logged; any other route is.
  await t.app.inject({ url: '/api/nope', remoteAddress: PROXY, headers });
  const line = t.logs.lines.find((l) => l.msg === 'incoming request');
  const req: unknown = line?.req;
  return typeof req === 'object' && req !== null ? Reflect.get(req, 'remoteAddress') : undefined;
}

describe('client address', () => {
  it('is the address the one trusted proxy appended, not one the client sent', async () => {
    t = await testApp({ trustProxy: true });
    expect(await loggedAddress({ 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` })).toBe(CLIENT);
  });

  it('is the address the proxy set when it replaces the header', async () => {
    t = await testApp({ trustProxy: true });
    expect(await loggedAddress({ 'x-forwarded-for': CLIENT })).toBe(CLIENT);
  });

  it('ignores X-Forwarded-For entirely when no proxy is trusted', async () => {
    t = await testApp({ trustProxy: false });
    expect(await loggedAddress({ 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` })).toBe(PROXY);
  });
});
