// SPEC-004 E5: a data volume Surface can't use (DATA_DIR, or its uploads folder) stops startup,
// before the database wait.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.js';
import { StartupError } from '../src/startup-error.js';
import { testConfig } from './helpers.js';

let server: RunningServer | undefined;
const made: string[] = [];

afterEach(async () => {
  await server?.app.close();
  await server?.pool.end();
  server = undefined;
  for (const dir of made.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'surface-data-'));
  made.push(dir);
  return dir;
}

/**
 * Starts against a closed local port. With `databaseWaitMs` at a minute, only a failure before the
 * database wait ends within the test's timeout.
 */
async function startWith(dataDir: string, databaseWaitMs = 60_000): Promise<unknown> {
  server = await startServer(
    testConfig({
      dataDir,
      databaseUrl: 'postgres://surface:pw@127.0.0.1:1/surface',
      port: 0,
      host: '127.0.0.1',
    }),
    { logger: pino({ level: 'silent' }), databaseWaitMs },
  );
  return server.ready.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function startupMessage(dataDir: string): Promise<string> {
  const error = await startWith(dataDir);
  expect(error).toBeInstanceOf(StartupError);
  return error instanceof Error ? error.message : '';
}

describe('startup with an unusable data volume (SPEC-004 E5)', () => {
  it('stops, before waiting for the database, when DATA_DIR does not exist', async () => {
    const missing = path.join(scratch(), 'nope');
    expect(await startupMessage(missing)).toBe(
      `${missing} does not exist. Mount a volume there, or point DATA_DIR at an existing directory.`,
    );
  });

  it('stops when DATA_DIR is a file', async () => {
    const file = path.join(scratch(), 'data');
    writeFileSync(file, '');
    expect(await startupMessage(file)).toContain(`${file} is not a directory.`);
  });

  it.skipIf(process.getuid?.() === 0)(
    'stops with the chown fix when DATA_DIR exists but Surface cannot write to it',
    async () => {
      const dir = scratch();
      chmodSync(dir, 0o500);
      const message = await startupMessage(dir);
      expect(message).toContain(`Surface cannot write to ${dir} (`);
      expect(message).toContain('chown -R 10001:10001');
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'stops when the uploads folder below a writable DATA_DIR cannot be written to (its own volume)',
    async () => {
      const dir = scratch();
      const uploads = path.join(dir, 'uploads');
      mkdirSync(uploads);
      chmodSync(uploads, 0o500);
      made.unshift(uploads);
      expect(await startupMessage(dir)).toContain(`Surface cannot write to ${uploads} (`);
    },
  );

  it('stops when the uploads folder is a file', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'uploads'), '');
    expect(await startupMessage(dir)).toContain(`${path.join(dir, 'uploads')} is not a directory.`);
  });

  it('names the directory and the error for an unexpected file-system error', async () => {
    const loop = path.join(scratch(), 'loop');
    symlinkSync(loop, loop);
    const message = await startupMessage(loop);
    expect(message).toContain(`Surface cannot write to ${loop} (`);
    expect(message).toContain('ELOOP');
  });

  it('creates a missing uploads folder, then goes on to the database', async () => {
    const dir = scratch();
    const error = await startWith(dir, 100);
    // The database wait is what fails, after the uploads folder exists.
    expect(String(error)).not.toContain(dir);
    expect(existsSync(path.join(dir, 'uploads'))).toBe(true);
  });
});
