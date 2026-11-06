// Unit tests never reach the network (CLAUDE.md, Testing): the shared Vitest
// preset (`packages/config/vitest-no-network.js`) fails non-local connections.
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 192.0.2.0/24 is TEST-NET-1: never routable, so a leak hangs instead of succeeding.
const OUTSIDE = '192.0.2.1';
const blocked = (host: string) =>
  new RegExp(
    `^Unit tests must not use the network \\(tried to connect to ${host.replaceAll('.', '\\.')}\\)`,
  );

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

async function connectionError(socket: net.Socket): Promise<unknown> {
  try {
    const args: unknown[] = await once(socket, 'error');
    return args[0];
  } finally {
    socket.destroy();
  }
}

/** Starts `server` with `start` and waits until it listens. */
async function listen(server: Server | net.Server, start: () => void): Promise<void> {
  const ready = once(server, 'listening');
  start();
  await ready;
}

async function close(server: Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('unit tests cannot reach the network', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails fetch to an outside host before any packet is sent', async () => {
    // The timeout only matters if the guard regresses: then it fails fast, not at 5 s.
    const error = await fetch(`http://${OUTSIDE}/`, { signal: AbortSignal.timeout(2_000) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // fetch wraps the socket error: TypeError('fetch failed', { cause }).
    const cause = error instanceof Error ? error.cause : undefined;
    expect(errorCode(cause)).toBe('ERR_UNIT_TEST_NETWORK');
    expect(cause instanceof Error ? cause.message : '').toMatch(blocked(OUTSIDE));
  });

  it('fails a raw socket with an error event, like a refused connection', async () => {
    const socket = net.connect({ host: OUTSIDE, port: 443 });
    expect(await connectionError(socket)).toSatisfy(
      (e) => errorCode(e) === 'ERR_UNIT_TEST_NETWORK',
    );
  });

  it('fails a hostname before it is looked up in DNS', async () => {
    // DNS would answer ENOTFOUND for `.invalid`; the guard answers first.
    const error = await connectionError(net.connect({ host: 'surface.invalid', port: 80 }));
    expect(error instanceof Error ? error.message : '').toMatch(blocked('surface.invalid'));
  });

  it('fails a hostname that only looks like a loopback address', async () => {
    const error = await connectionError(net.connect({ host: '127.example.invalid', port: 80 }));
    expect(errorCode(error)).toBe('ERR_UNIT_TEST_NETWORK');
  });

  it('lets a database client reject cleanly, with no stray timer firing later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = new pg.Client({ host: OUTSIDE, port: 5432, connectionTimeoutMillis: 50 });
    const error = await client.connect().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorCode(error)).toBe('ERR_UNIT_TEST_NETWORK');
    // A thrown (not emitted) guard error left pg's connect timer running; it then
    // destroyed the socket with no listener and crashed the run.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a fake server on 127.0.0.1', async () => {
    const server = createServer((_req, res) => res.end('fake'));
    await listen(server, () => server.listen(0, '127.0.0.1'));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected a TCP address');
      expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe('fake');
    } finally {
      await close(server);
    }
  });

  it('allows connecting to the address a server reports for listen(0)', async () => {
    // With no host, the server reports `::` (or `0.0.0.0` without IPv6): both are this machine.
    const server = net.createServer((socket) => socket.end());
    await listen(server, () => server.listen(0));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected a TCP address');
      const socket = net.connect({ host: address.address, port: address.port });
      await once(socket, 'connect');
      socket.destroy();
    } finally {
      await close(server);
    }
  });

  it('allows a Unix socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surface-'));
    const path = join(dir, 's.sock');
    const server = net.createServer((socket) => socket.end());
    await listen(server, () => server.listen(path));
    try {
      const socket = net.connect(path);
      await once(socket, 'connect');
      socket.destroy();
    } finally {
      await close(server);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
