// SPEC-004 §7 `TRUST_PROXY` (D6): `true` trusts exactly one reverse proxy, and only when it
// connects from a loopback, private or link-local address. The client address is then the entry
// that proxy appended to X-Forwarded-For, never one the client sent itself, and a client that
// reaches the server directly from a public address can't set it at all. Sign-in limits count
// attempts per address (ADR-0007), so a spoofable address would bypass them.
import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/http/client-address.js';
import { testApp } from './helpers.js';

const PROXY = '172.18.0.2'; // the reverse proxy's container address
const CLIENT = '203.0.113.9'; // what the proxy saw and appended
const SPOOFED = '198.51.100.66'; // what the client claimed
const PUBLIC_PEER = '8.8.4.4'; // a client that reached the published port directly

interface Seen {
  ip: string;
  protocol: string;
  host: string;
}

/** What the server made of one request: client address, scheme and host. */
async function seen(
  trustProxy: boolean,
  remoteAddress: string,
  headers: Record<string, string> = {},
): Promise<Seen> {
  const { app } = await testApp({ trustProxy });
  try {
    app.get('/test/seen', (request) => ({
      ip: request.ip,
      protocol: request.protocol,
      host: request.host,
    }));
    const res = await app.inject({
      url: '/test/seen',
      remoteAddress,
      headers: { host: 'internal:3000', ...headers },
    });
    return res.json<Seen>();
  } finally {
    await app.close();
  }
}

describe('client address behind the reverse proxy', () => {
  it('is the address the proxy appended, not one the client sent', async () => {
    const r = await seen(true, PROXY, { 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` });
    expect(r.ip).toBe(CLIENT);
  });

  it('is the address the proxy set when it replaces the header', async () => {
    expect((await seen(true, PROXY, { 'x-forwarded-for': CLIENT })).ip).toBe(CLIENT);
  });

  it("is the proxy's own address when the proxy sends no X-Forwarded-For", async () => {
    expect((await seen(true, PROXY)).ip).toBe(PROXY);
  });

  it("takes the scheme and host from the proxy's last X-Forwarded-Proto and -Host entries", async () => {
    const r = await seen(true, PROXY, {
      'x-forwarded-proto': 'http, https',
      'x-forwarded-host': 'evil.example, surface.example.com',
    });
    expect([r.protocol, r.host]).toEqual(['https', 'surface.example.com']);
  });

  it('trusts a proxy on loopback or an IPv4-mapped private address', async () => {
    const headers = { 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` };
    expect((await seen(true, '127.0.0.1', headers)).ip).toBe(CLIENT);
    expect((await seen(true, '::ffff:10.0.0.7', headers)).ip).toBe(CLIENT);
  });
});

describe('client address without a trusted proxy', () => {
  const forged = {
    'x-forwarded-for': SPOOFED,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example',
  };

  it('ignores forwarded headers from a peer with a public address, even with TRUST_PROXY on', async () => {
    expect(await seen(true, PUBLIC_PEER, forged)).toEqual({
      ip: PUBLIC_PEER,
      protocol: 'http',
      host: 'internal:3000',
    });
  });

  it('ignores forwarded headers entirely when TRUST_PROXY is off', async () => {
    expect(await seen(false, PROXY, forged)).toEqual({
      ip: PROXY,
      protocol: 'http',
      host: 'internal:3000',
    });
  });
});

describe('private addresses a proxy may connect from', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['10.20.30.40', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.255.255', false],
    ['172.32.0.1', false],
    ['192.168.1.10', true],
    ['169.254.1.1', true],
    ['100.64.0.1', true], // shared address space (CGNAT, Tailscale)
    ['100.128.0.1', false],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['::ffff:192.168.1.10', true],
    ['::ffff:8.8.8.8', false],
    ['8.8.8.8', false],
    ['2001:4860:4860::8888', false],
    ['not an address', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});
