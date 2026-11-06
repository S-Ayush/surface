// SPEC-004 AC-12: `surface doctor` reports each failure condition of §12 against
// real resources, one fixture per condition: E1 (database unreachable, plus the
// fail-fast credential and database errors), E3 (public URL), E5 (data volume),
// E6 (disk), E7 (newer schema), E8 (extension), SMTP. An older PostgreSQL and a
// missing contrib package can't be produced by postgres:17; see doctor.test.ts.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { extensionsCheck } from '../src/cli/doctor/checks.js';
import type { CheckId, CheckResult } from '../src/cli/doctor/checks.js';
import { doctorCommand, runDoctor, type DoctorOptions } from '../src/cli/doctor/doctor.js';
import { extensionFacts } from '../src/cli/doctor/probes.js';
import type { Config } from '../src/config.js';
import { ensureExtensions } from '../src/db/checks.js';
import { loadMigrations } from '../src/db/migrate.js';
import { StartupError } from '../src/startup-error.js';
import {
  createTestDatabase,
  silentLog,
  testDatabaseUrl,
  withAdmin,
  type TestDatabase,
} from './db.js';
import { freePort, testConfig, VALID_ENV } from './helpers.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function listening<T extends HttpServer | TcpServer>(server: T): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port assigned');
  return address.port;
}

/** A TCP server that greets like an SMTP server and records whether QUIT was sent. */
async function fakeSmtp(greeting: string) {
  const received: string[] = [];
  const server = createTcpServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => received.push(data));
    socket.on('error', () => undefined);
    socket.write(greeting);
  });
  return { port: await listening(server), received };
}

/** An HTTP server standing in for Surface behind SURFACE_URL. */
async function fakeSurface(status = 200, body: unknown = { status: 'ok' }) {
  const server = createHttpServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? status : 404, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify(body));
  });
  return `http://127.0.0.1:${await listening(server)}`;
}

function dataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'surface-data-'));
}

const plenty: DoctorOptions['disk'] = () =>
  Promise.resolve({ freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 });

const byId = (results: CheckResult[]) =>
  Object.fromEntries(results.map((r) => [r.id, r])) as Record<CheckId, CheckResult>;

let migrated: TestDatabase;
let publicUrl: string;
beforeAll(async () => {
  migrated = await createTestDatabase();
});
afterAll(() => migrated.drop());

/** A healthy setup, changed by `overrides`. */
async function doctor(overrides: Partial<Config> = {}, options: DoctorOptions = {}) {
  publicUrl = await fakeSurface();
  const config = testConfig({
    databaseUrl: migrated.url,
    dataDir: dataDir(),
    publicUrl,
    smtp: null,
    ...overrides,
  });
  return byId(await runDoctor({ config }, { disk: plenty, timeoutMs: 2_000, ...options }));
}

function databaseUrlWith(changes: { password?: string; database?: string; port?: number }) {
  const url = new URL(migrated.url);
  if (changes.password !== undefined) url.password = changes.password;
  if (changes.database !== undefined) url.pathname = `/${changes.database}`;
  if (changes.port !== undefined) url.port = String(changes.port);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('surface doctor', () => {
  it('passes every check on a healthy installation', async () => {
    const smtp = await fakeSmtp('220 mail.test ESMTP ready\r\n');
    const r = await doctor({
      smtp: { url: `smtp://mailer:secret@127.0.0.1:${smtp.port}`, from: 'x@example.com' },
    });
    expect(Object.values(r).map((c) => [c.id, c.status])).toEqual([
      ['config', 'ok'],
      ['database', 'ok'],
      ['postgres', 'ok'],
      ['extensions', 'ok'],
      ['migrations', 'ok'],
      ['dataDir', 'ok'],
      ['disk', 'ok'],
      ['smtp', 'ok'],
      ['publicUrl', 'ok'],
    ]);
    expect(r.postgres.message).toMatch(/^1[7-9]\./);
    expect(r.extensions.message).toBe('pg_trgm installed');
    expect(r.publicUrl.message).toBe(`${publicUrl} reaches Surface`);
    await expect.poll(() => smtp.received.join('')).toBe('QUIT\r\n');
  });

  describe('database', () => {
    it('reports an unreachable database (E1) and skips what depends on it', async () => {
      const port = await freePort();
      const r = await doctor({ databaseUrl: databaseUrlWith({ port }) });
      expect(r.database.status).toBe('fail');
      const host = new URL(migrated.url).hostname;
      expect(r.database.message).toContain(`Could not reach the database at ${host}:${port}/`);
      expect(r.database.message).toContain('ECONNREFUSED');
      for (const id of ['postgres', 'extensions', 'migrations'] as const) {
        expect(r[id]).toMatchObject({
          status: 'skip',
          message: 'skipped: needs a database connection',
        });
      }
      expect(r.dataDir.status).toBe('ok');
    });

    it('reports wrong credentials without printing the password', async () => {
      const password = `wrong-${randomBytes(6).toString('hex')}`;
      const r = await doctor({ databaseUrl: databaseUrlWith({ password }) });
      expect(r.database.status).toBe('fail');
      expect(r.database.message).toContain('rejected the username or password');
      expect(r.database.message).toContain('28P01');
      expect(JSON.stringify(r)).not.toContain(password);
    });

    it('reports a database that does not exist', async () => {
      const r = await doctor({ databaseUrl: databaseUrlWith({ database: 'no_such_db' }) });
      expect(r.database.status).toBe('fail');
      expect(r.database.message).toContain('does not exist. Create it');
    });
  });

  describe('extensions (E8)', () => {
    let empty: TestDatabase;
    const role = `doctor_${randomBytes(4).toString('hex')}`;
    const rolePassword = randomBytes(12).toString('hex');
    beforeAll(async () => {
      empty = await createTestDatabase({ migrated: false });
      await withAdmin((c) => c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`));
    });
    afterAll(async () => {
      await empty.drop();
      await withAdmin((c) => c.query(`DROP ROLE IF EXISTS ${role}`));
    });

    const roleUrl = () => {
      const url = new URL(testDatabaseUrl(empty.name));
      url.username = role;
      url.password = rolePassword;
      return url.toString();
    };

    /** The message startup gives (ensureExtensions), to compare with doctor's. */
    async function startupMessage(databaseUrl: string, extensions: string[]): Promise<string> {
      const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await ensureExtensions(pool, silentLog, extensions);
      } catch (error) {
        if (error instanceof StartupError) return error.message;
        throw error;
      } finally {
        await pool.end();
      }
      throw new Error('startup accepted the extensions');
    }

    it('fails with the SQL to run when the user may not create pg_trgm', async () => {
      const r = await doctor({ databaseUrl: roleUrl() });
      expect(r.extensions.status).toBe('fail');
      expect(r.extensions.message).toContain(
        `run this in database "${empty.name}": CREATE EXTENSION pg_trgm;`,
      );
      // Doctor and startup must say the same thing (doctor can't call startup's check: it creates).
      expect(r.extensions.message).toBe(await startupMessage(roleUrl(), ['pg_trgm']));
    });

    it('words an unavailable extension exactly like startup does', async () => {
      const pool = new pg.Pool({ connectionString: empty.url, max: 1 });
      try {
        const facts = await extensionFacts(pool, ['no_such_extension']);
        expect(extensionsCheck(facts).message).toBe(
          await startupMessage(empty.url, ['no_such_extension']),
        );
      } finally {
        await pool.end();
      }
    });

    it('accepts a missing pg_trgm the user may create, and changes nothing', async () => {
      const r = await doctor({ databaseUrl: empty.url });
      expect(r.extensions).toMatchObject({
        status: 'ok',
        message: 'pg_trgm will be created when Surface starts',
      });
      // Read-only: no extension created, no migration history started.
      const { rows } = await empty.pool.query<{ ext: boolean; history: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ext,
                to_regclass('schema_migrations') IS NOT NULL AS history`,
      );
      expect(rows[0]).toEqual({ ext: false, history: false });
    });

    it('warns that migrations are pending on a fresh database, without failing', async () => {
      const r = await doctor({ databaseUrl: empty.url });
      expect(r.migrations.status).toBe('warn');
      const total = loadMigrations().length;
      expect(r.migrations.message).toMatch(
        new RegExp(`^${total} of ${total} not applied yet\\. .*surface migrate$`),
      );
    });
  });

  describe('migrations (E7)', () => {
    let db: TestDatabase;
    afterEach(() => db.drop());

    it('fails when the database was migrated by a newer Surface', async () => {
      db = await createTestDatabase();
      await db.pool.query(
        "INSERT INTO schema_migrations (idx, tag, hash, applied_by_version) VALUES (999, '0999_future', 'x', '9.9.9')",
      );
      const r = await doctor({ databaseUrl: db.url });
      expect(r.migrations.status).toBe('fail');
      expect(r.migrations.message).toContain('Database was migrated by a newer Surface (9.9.9)');
    });

    it('fails when an applied migration was edited', async () => {
      db = await createTestDatabase();
      await db.pool.query("UPDATE schema_migrations SET hash = 'edited' WHERE idx = 0");
      const r = await doctor({ databaseUrl: db.url });
      expect(r.migrations.status).toBe('fail');
      expect(r.migrations.message).toContain('has changed since it was applied');
    });
  });

  describe('data directory (E5) and disk (E6)', () => {
    it('fails when the data directory does not exist, and skips the disk check', async () => {
      const missing = path.join(dataDir(), 'nope');
      const r = await doctor({ dataDir: missing });
      expect(r.dataDir).toMatchObject({
        status: 'fail',
        message: expect.stringContaining(`${missing} does not exist`) as string,
      });
      expect(r.disk.status).toBe('skip');
    });

    it('fails when the data directory is a file', async () => {
      const file = path.join(dataDir(), 'file');
      writeFileSync(file, '');
      expect((await doctor({ dataDir: file })).dataDir.message).toContain('is not a directory');
    });

    it('fails when a parent of the data directory is a file', async () => {
      const file = path.join(dataDir(), 'file');
      writeFileSync(file, '');
      const r = await doctor({ dataDir: path.join(file, 'data') });
      expect(r.dataDir).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('is not a directory') as string,
      });
      expect(r.disk.status).toBe('skip');
    });

    it('reports a probe that throws on its own check and keeps one entry per check', async () => {
      const r = await doctor({}, { disk: () => Promise.reject(new Error('statfs exploded')) });
      expect(Object.keys(r)).toEqual([
        'config',
        'database',
        'postgres',
        'extensions',
        'migrations',
        'dataDir',
        'disk',
        'smtp',
        'publicUrl',
      ]);
      expect(r.dataDir.status).toBe('ok');
      expect(r.disk).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('The check itself failed (statfs exploded)') as string,
      });
    });

    it('fails when the data directory is not writable, naming the uid', async () => {
      const dir = dataDir();
      chmodSync(dir, 0o500);
      closers.push(() => Promise.resolve(chmodSync(dir, 0o700)));
      const r = await doctor({ dataDir: dir });
      expect(r.dataDir.status).toBe('fail');
      expect(r.dataDir.message).toContain(`Surface cannot write to ${dir} (`);
      expect(r.dataDir.message).toContain('chown -R 10001:10001');
    });

    it('leaves nothing behind in a writable data directory', async () => {
      const dir = dataDir();
      expect((await doctor({ dataDir: dir })).dataDir.status).toBe('ok');
      expect(readdirSync(dir)).toEqual([]);
    });

    it('measures the real free space of the data directory', async () => {
      const config = testConfig({
        databaseUrl: migrated.url,
        dataDir: dataDir(),
        publicUrl: await fakeSurface(),
      });
      const r = byId(await runDoctor({ config }));
      expect(r.disk.message).toMatch(/free of .* on /);
    });

    it('fails when the disk is nearly full', async () => {
      const r = await doctor(
        {},
        { disk: () => Promise.resolve({ freeBytes: 10 * 1024 ** 2, totalBytes: 1024 ** 3 }) },
      );
      expect(r.disk.status).toBe('fail');
      expect(r.disk.message).toContain('Only 10 MB free');
    });
  });

  describe('SMTP', () => {
    const smtp = (url: string) => ({ smtp: { url, from: 'Surface <s@example.com>' } });

    it('skips email when SMTP is not configured', async () => {
      expect((await doctor()).smtp).toMatchObject({ status: 'skip' });
    });

    it('fails when the SMTP server cannot be reached', async () => {
      const port = await freePort();
      const r = await doctor(smtp(`smtp://127.0.0.1:${port}`));
      expect(r.smtp.status).toBe('fail');
      expect(r.smtp.message).toContain(`SMTP server at 127.0.0.1:${port} (connect ECONNREFUSED`);
    });

    it('fails when the SMTP server refuses the connection', async () => {
      const server = await fakeSmtp('554 5.7.1 no service for you\r\n');
      const r = await doctor(smtp(`smtp://127.0.0.1:${server.port}`));
      expect(r.smtp.status).toBe('fail');
      expect(r.smtp.message).toContain('"554 5.7.1 no service for you"');
    });

    it('fails when smtps:// points at a server without TLS', async () => {
      const server = await fakeSmtp('220 plain text\r\n');
      const r = await doctor(smtp(`smtps://127.0.0.1:${server.port}`));
      expect(r.smtp.status).toBe('fail');
    });

    it('fails when the server never greets', async () => {
      const server = createTcpServer((socket) => socket.on('error', () => undefined));
      const port = await listening(server);
      const r = await doctor(smtp(`smtp://127.0.0.1:${port}`), { timeoutMs: 200 });
      expect(r.smtp.message).toContain('no greeting within 0.2 s');
    });

    it('exits even when the SMTP server never closes after QUIT', async () => {
      const sockets: Socket[] = [];
      const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
        sockets.push(socket);
        socket.on('error', () => undefined);
        socket.write('220 ready, and I never hang up\r\n');
      });
      const port = await listening(server);
      closers.push(() => Promise.resolve(sockets.forEach((s) => s.destroy())));

      // The real symptom: an open socket kept the `surface doctor` process alive.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--conditions=@surface/source', '--import', 'tsx', 'src/cli/main.ts', 'doctor'],
        {
          cwd: serverRoot,
          env: {
            PATH: process.env.PATH,
            ...VALID_ENV,
            SURFACE_URL: `http://127.0.0.1:${await freePort()}`,
            DATABASE_URL: migrated.url,
            DATA_DIR: dataDir(),
            SMTP_URL: `smtp://127.0.0.1:${port}`,
            SMTP_FROM: 'Surface <s@example.com>',
          },
          timeout: 15_000,
        },
      );
      expect(stdout).toMatch(/✓ Email \(SMTP\) +127\.0\.0\.1:\d+ is accepting connections/);
      expect(sockets.length).toBe(1);
    });

    it('accepts a multi-line greeting', async () => {
      const server = await fakeSmtp('220-mail.test\r\n220-more text\r\n220 ready\r\n');
      expect((await doctor(smtp(`smtp://127.0.0.1:${server.port}`))).smtp.status).toBe('ok');
    });
  });

  describe('public URL (E3)', () => {
    it('warns, without failing, when SURFACE_URL cannot be reached', async () => {
      const port = await freePort();
      const r = await doctor({ publicUrl: `http://127.0.0.1:${port}` });
      expect(r.publicUrl.status).toBe('warn');
      expect(r.publicUrl.message).toContain('ECONNREFUSED');
    });

    it('warns, naming the target, when SURFACE_URL redirects elsewhere', async () => {
      const server = createHttpServer((_request, response) => {
        response.writeHead(301, { location: 'https://www.surface.example.com/healthz' });
        response.end();
      });
      const r = await doctor({ publicUrl: `http://127.0.0.1:${await listening(server)}` });
      expect(r.publicUrl.status).toBe('warn');
      // Reported, not followed: nothing is requested from www.surface.example.com.
      expect(r.publicUrl.message).toContain(
        'redirects (301) to https://www.surface.example.com/healthz. Set SURFACE_URL to the address people end up on',
      );
    });

    it('warns when SURFACE_URL answers with something other than Surface', async () => {
      const r = await doctor({ publicUrl: await fakeSurface(502, { error: 'bad gateway' }) });
      expect(r.publicUrl.status).toBe('warn');
      expect(r.publicUrl.message).toContain('answered 502 but not as Surface');
    });
  });

  it.each([[false], [true]])(
    'exits 1 on problems and never echoes secrets (json: %s)',
    async (json) => {
      // A quote and a backslash: JSON escaping must not let them slip past the scrubber.
      const dbPassword = `db"\\${randomBytes(6).toString('hex')}`;
      const smtpPassword = `smtp-${randomBytes(6).toString('hex')}`;
      let out = '';
      const code = await doctorCommand(
        { out: (t) => (out += t), err: (t) => (out += t) },
        {
          json,
          env: {
            ...VALID_ENV,
            // Nothing listens there: a warning, and no request leaves the machine.
            SURFACE_URL: `http://127.0.0.1:${await freePort()}`,
            DATABASE_URL: databaseUrlWith({ password: encodeURIComponent(dbPassword) }),
            DATA_DIR: dataDir(),
            SMTP_URL: `smtp://mailer:${smtpPassword}@127.0.0.1:${await freePort()}`,
            SMTP_FROM: 'Surface <s@example.com>',
          },
          disk: plenty,
          timeoutMs: 500,
        },
      );
      expect(code).toBe(1);
      if (json) {
        expect(JSON.parse(out)).toMatchObject({ ok: false });
      } else {
        expect(out).toMatch(/✗ Database +The database rejected the username or password/);
        expect(out).toMatch(/✗ Email \(SMTP\) +Could not connect/);
        expect(out).toContain('2 problems, 1 warning.');
      }
      expect(out).not.toContain(dbPassword);
      expect(out).not.toContain(JSON.stringify(dbPassword).slice(1, -1));
      expect(out).not.toContain(encodeURIComponent(dbPassword));
      expect(out).not.toContain(smtpPassword);
      expect(out).not.toContain(VALID_ENV.SESSION_SECRET);
    },
  );

  it('prints machine-readable JSON with --json', async () => {
    let out = '';
    const code = await doctorCommand(
      { out: (t) => (out += t), err: (t) => (out += t) },
      {
        json: true,
        env: {
          ...VALID_ENV,
          SURFACE_URL: `http://127.0.0.1:${await freePort()}`,
          DATABASE_URL: migrated.url,
          DATA_DIR: dataDir(),
        },
        disk: plenty,
        timeoutMs: 500,
      },
    );
    const report = JSON.parse(out) as { ok: boolean; checks: { id: string; label: string }[] };
    // Nothing answers at SURFACE_URL: a warning only.
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toContain('migrations');
    expect(report.checks[0]).toMatchObject({ id: 'config', label: 'Configuration', status: 'ok' });
  });
});
