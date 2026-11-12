import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  userActor,
  type Actor,
  type ApiKeyScope,
  type Membership,
  type Role,
} from '@surface/domain';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { ActorResolver } from '../src/http/ops.js';
import { loadConfig, type Config } from '../src/config.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';

export const VALID_ENV = {
  SURFACE_URL: 'https://surface.example.com',
  SESSION_SECRET: 'a'.repeat(64),
  POSTGRES_PASSWORD: 'pg-password',
} as const;

export function testConfig(overrides: Partial<Config> = {}): Config {
  // The OS temp directory exists and is writable, so a started server passes the E5 check.
  return {
    ...loadConfig({ ...VALID_ENV }),
    webDir: '/nonexistent-web-dir',
    dataDir: tmpdir(),
    ...overrides,
  };
}

/** Collects log lines as parsed JSON objects. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    },
    text: () => lines.map((l) => JSON.stringify(l)).join('\n'),
  };
}

export interface TestApp {
  app: FastifyInstance;
  lifecycle: Lifecycle;
  logs: ReturnType<typeof captureLogs>;
}

export async function testApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const config = testConfig({ logLevel: 'info', ...overrides });
  const logs = captureLogs();
  const lifecycle = new Lifecycle();
  const logger = createLogger(config, logs.stream);
  const app = await buildApp({
    config,
    lifecycle,
    logger,
    info: { version: '1.2.3', commit: 'test' },
  });
  return { app, lifecycle, logs };
}

/** A fake built web app: index.html plus one hashed asset. */
export function fakeWebDir(indexHtml = '<!doctype html><title>Surface</title>'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'surface-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), indexHtml);
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  return dir;
}

/** A local port with nothing listening on it (for child processes, which can't use port 0). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no TCP port assigned');
  return address.port;
}

export { systemActor } from '@surface/domain';

/**
 * The actor for a test user (PLAN-003 S3). Sessions build the same thing from the database in
 * PLAN-001 S3. Pass `via` for an API-key or MCP actor.
 */
export function actorFor(
  user: { id: string; role?: Role; memberships?: readonly Membership[] },
  via?: { kind: 'api' | 'mcp'; apiKey: ApiKeyScope },
): Actor {
  return userActor({
    userId: user.id,
    role: user.role ?? 'member',
    memberships: user.memberships ?? [],
    ...(via ? { via } : {}),
  });
}

/**
 * Test-only actor resolver: `x-test-actor: <name>` picks one of `actors`. It lives in `test/`
 * so production code can never construct it; sessions replace it in PLAN-001 S3.
 */
export function headerActor(actors: Readonly<Record<string, Actor>>): ActorResolver {
  return (request) => {
    const name = request.headers['x-test-actor'];
    return Promise.resolve(
      typeof name === 'string' && Object.hasOwn(actors, name) ? actors[name] : undefined,
    );
  };
}
