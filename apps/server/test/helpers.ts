import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';

export const VALID_ENV = {
  SURFACE_URL: 'https://surface.example.com',
  SESSION_SECRET: 'a'.repeat(64),
  POSTGRES_PASSWORD: 'pg-password',
} as const;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ ...VALID_ENV }), webDir: '/nonexistent-web-dir', ...overrides };
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
export function fakeWebDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'surface-web-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Surface</title>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
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
