// SPEC-004 AC-12: `surface doctor` verdicts, one fixture per condition. Conditions
// a real PostgreSQL 17 cannot produce (an older server, a missing contrib package,
// a nearly full disk) are covered only here; the rest also run end to end in
// doctor.int.test.ts.
import { describe, expect, it } from 'vitest';
import {
  collationsCheck,
  configCheck,
  databaseCheck,
  dataDirCheck,
  describeError,
  diskCheck,
  extensionsCheck,
  migrationsCheck,
  postgresCheck,
  publicUrlCheck,
  smtpCheck,
  type CheckResult,
  type ExtensionFacts,
} from '../src/cli/doctor/checks.js';
import { doctorExitCode, formatReport, scrub, secretsOf } from '../src/cli/doctor/doctor.js';
import { smtpTarget } from '../src/cli/doctor/probes.js';
import { REDACTED } from '../src/logger.js';
import { testConfig } from './helpers.js';

const MiB = 1024 ** 2;
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('doctor verdicts', () => {
  it('lists every configuration problem', () => {
    const result = configCheck(['SURFACE_URL is missing.', 'SESSION_SECRET is missing.']);
    expect(result).toEqual({
      id: 'config',
      status: 'fail',
      message: 'SURFACE_URL is missing.\nSESSION_SECRET is missing.',
    });
    expect(configCheck([]).status).toBe('ok');
  });

  describe('database (E1)', () => {
    it('reports an unreachable database with its location and the reason', () => {
      const r = databaseCheck(
        'db:5432/surface',
        pgError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.2:5432'),
      );
      expect(r.status).toBe('fail');
      expect(r.message).toBe(
        'Could not reach the database at db:5432/surface (connect ECONNREFUSED 10.0.0.2:5432). Check that it is running and that DATABASE_URL points to it.',
      );
    });

    it.each([
      [
        '28P01',
        'password authentication failed for user "surface"',
        'rejected the username or password',
      ],
      ['28000', 'no pg_hba.conf entry for host', '?sslmode=require'],
      ['3D000', 'database "surface" does not exist', 'does not exist. Create it'],
    ])('explains %s and how to fix it', (code, serverMessage, advice) => {
      const r = databaseCheck('db:5432/surface', pgError(code, serverMessage));
      expect(r.status).toBe('fail');
      expect(r.message).toContain(advice);
      expect(r.message).toContain(serverMessage);
      expect(r.message).toContain('(database at db:5432/surface)');
    });

    it('describes a dual-stack connection failure by its first attempt', () => {
      const error = new AggregateError(
        [pgError('ECONNREFUSED', 'connect ECONNREFUSED ::1:5432')],
        '',
      );
      expect(describeError(error)).toBe('connect ECONNREFUSED ::1:5432');
    });
  });

  describe('PostgreSQL and extensions (E8)', () => {
    it('fails on PostgreSQL older than 17, saying which version runs', () => {
      const r = postgresCheck(160_004, '16.4');
      expect(r.status).toBe('fail');
      expect(r.message).toContain('needs PostgreSQL 17 or newer');
      expect(r.message).toContain('16.4');
      expect(postgresCheck(170_006, '17.6')).toEqual({
        id: 'postgres',
        status: 'ok',
        message: '17.6',
      });
    });

    it('fails with the problem startup reported for a missing collation', () => {
      const problem = 'The PostgreSQL collation "und-x-icu" is missing, so …';
      expect(collationsCheck(['und-x-icu'], problem)).toEqual({
        id: 'collations',
        status: 'fail',
        message: problem,
      });
    });

    it('lists the required collations when they are all present', () => {
      expect(collationsCheck(['und-x-icu'], undefined)).toEqual({
        id: 'collations',
        status: 'ok',
        message: 'und-x-icu available',
      });
    });

    const trgm = (facts: Partial<ExtensionFacts>): ExtensionFacts => ({
      name: 'pg_trgm',
      installed: false,
      available: true,
      canCreate: true,
      database: 'surface',
      ...facts,
    });

    it('fails when the extension is not available on the server', () => {
      const r = extensionsCheck([trgm({ available: false, canCreate: false })]);
      expect(r.status).toBe('fail');
      expect(r.message).toContain('pg_trgm is not available on this server');
      expect(r.message).toContain('contrib');
    });

    it('fails with the SQL an administrator must run when the user cannot create it', () => {
      const r = extensionsCheck([trgm({ canCreate: false })]);
      expect(r.status).toBe('fail');
      expect(r.message).toContain('run this in database "surface": CREATE EXTENSION pg_trgm;');
    });

    it('is fine when the extension is installed, or will be created at startup', () => {
      expect(extensionsCheck([trgm({ installed: true })])).toMatchObject({
        status: 'ok',
        message: 'pg_trgm installed',
      });
      expect(extensionsCheck([trgm({})])).toMatchObject({
        status: 'ok',
        message: 'pg_trgm will be created when Surface starts',
      });
    });
  });

  describe('migrations (E7)', () => {
    it('warns about pending migrations and says how to apply them', () => {
      const r = migrationsCheck({ kind: 'pending', pending: 2, total: 3 });
      expect(r.status).toBe('warn');
      expect(r.message).toContain('2 of 3 not applied yet');
      expect(r.message).toContain('surface migrate');
    });

    it('fails when the database is newer than this build', () => {
      const message =
        'Database was migrated by a newer Surface (9.9.9). Restore a backup or upgrade.';
      expect(migrationsCheck({ kind: 'incompatible', message })).toEqual({
        id: 'migrations',
        status: 'fail',
        message,
      });
    });

    it('is fine when every migration is applied', () => {
      expect(migrationsCheck({ kind: 'current', total: 4 })).toMatchObject({
        status: 'ok',
        message: 'all 4 applied',
      });
    });
  });

  describe('data directory (E5) and disk (E6)', () => {
    it.each([
      [{ path: '/data', state: 'missing' } as const, '/data does not exist. Mount a volume there'],
      [{ path: '/data', state: 'not-directory' } as const, '/data is not a directory'],
      [
        { path: '/data', state: 'not-writable', reason: 'EACCES', uid: 10001 } as const,
        'Make the volume writable by uid 10001, the user in the Surface image',
      ],
      [
        { path: '/srv', state: 'not-writable', reason: 'EROFS', uid: 501 } as const,
        'writable by uid 501, the user running Surface here; the image uses 10001',
      ],
    ])('fails for %j', (facts, message) => {
      const r = dataDirCheck(facts);
      expect(r.status).toBe('fail');
      expect(r.message).toContain(message);
    });

    it('fails below 100 MB free, warns below 1 GB, and is fine above', () => {
      expect(diskCheck('/data', 50 * MiB, 10_000 * MiB)).toMatchObject({
        status: 'fail',
        message: expect.stringContaining(
          'Only 50 MB free of 9.8 GB on /data. Free up space',
        ) as string,
      });
      expect(diskCheck('/data', 500 * MiB, 10_000 * MiB).status).toBe('warn');
      expect(diskCheck('/data', 5_000 * MiB, 10_000 * MiB)).toEqual({
        id: 'disk',
        status: 'ok',
        message: '4.9 GB free of 9.8 GB on /data',
      });
    });
  });

  describe('SMTP', () => {
    const target = { host: 'mail.example.com', port: 587, tls: false };

    it('fails when the server cannot be reached', () => {
      const r = smtpCheck(target, { kind: 'error', reason: 'connect ETIMEDOUT' });
      expect(r.status).toBe('fail');
      expect(r.message).toContain('mail.example.com:587 (connect ETIMEDOUT)');
    });

    it('fails when the server refuses with a non-220 greeting', () => {
      const r = smtpCheck(target, { kind: 'greeting', code: 554, line: '554 no service' });
      expect(r.status).toBe('fail');
      expect(r.message).toContain('"554 no service"');
    });

    it('is fine on a 220 greeting, and says credentials were not tried', () => {
      const r = smtpCheck(target, { kind: 'greeting', code: 220, line: '220 ready' });
      expect(r.status).toBe('ok');
      expect(r.message).toContain('checked when the first email is sent');
    });

    it('defaults to 587 for smtp:// and 465 for smtps://', () => {
      expect(smtpTarget('smtp://u:p@mail.example.com')).toEqual(target);
      expect(smtpTarget('smtps://mail.example.com')).toEqual({ ...target, port: 465, tls: true });
      expect(smtpTarget('smtp://[::1]:2525').host).toBe('::1');
    });
  });

  describe('public URL (E3)', () => {
    it('warns when SURFACE_URL cannot be reached, and why that matters', () => {
      const r = publicUrlCheck('https://s.example.com', { kind: 'error', reason: 'ENOTFOUND' });
      expect(r.status).toBe('warn');
      expect(r.message).toContain('People must open exactly https://s.example.com');
    });

    it('warns when SURFACE_URL answers but is not Surface', () => {
      const r = publicUrlCheck('https://s.example.com', {
        kind: 'response',
        status: 502,
        isSurface: false,
      });
      expect(r.status).toBe('warn');
      expect(r.message).toContain('answered 502 but not as Surface');
    });

    it('warns about plain http except on this machine', () => {
      const surface = { kind: 'response', status: 200, isSurface: true } as const;
      expect(publicUrlCheck('http://s.example.com', surface).status).toBe('warn');
      expect(publicUrlCheck('http://localhost:3000', surface).status).toBe('ok');
      expect(publicUrlCheck('https://s.example.com', surface)).toEqual({
        id: 'publicUrl',
        status: 'ok',
        message: 'https://s.example.com reaches Surface',
      });
    });
  });
});

describe('doctor report', () => {
  const results: CheckResult[] = [
    { id: 'config', status: 'ok', message: 'valid' },
    { id: 'database', status: 'fail', message: 'first line\nsecond line' },
    { id: 'smtp', status: 'skip', message: 'not configured' },
    { id: 'publicUrl', status: 'warn', message: 'unreachable' },
  ];

  it('marks each check, aligns continuation lines and sums up', () => {
    expect(formatReport(results, { version: '1.0.0', commit: 'abc' })).toBe(
      [
        'Surface doctor · version 1.0.0 (abc)',
        '',
        '✓ Configuration       valid',
        '✗ Database            first line',
        '                      second line',
        '- Email (SMTP)        not configured',
        '! Public URL          unreachable',
        '',
        '1 problem, 1 warning. Fix the ✗ items, then run surface doctor again.',
        '',
      ].join('\n'),
    );
  });

  it('exits 1 on any problem, 0 with only warnings', () => {
    expect(doctorExitCode(results)).toBe(1);
    expect(doctorExitCode(results.filter((r) => r.status !== 'fail'))).toBe(0);
  });

  it('never prints a secret, even when a server echoes it', () => {
    const config = testConfig({
      databaseUrl: 'postgres://surface:p%40ss-word-0123@db:5432/surface',
      smtp: { url: 'smtp://mailer:smtp-secret-0123@mail:587', from: 'x@example.com' },
      setupToken: 'setup-token-0123456789',
    });
    const secrets = secretsOf(config);
    const text = `p@ss-word-0123 p%40ss-word-0123 smtp-secret-0123 setup-token-0123456789 ${config.sessionSecret}`;
    expect(scrub(text, secrets)).toBe(Array(5).fill(REDACTED).join(' '));
  });

  it('leaves short passwords alone, so ordinary words in the report survive', () => {
    const config = testConfig({ databaseUrl: 'postgres://surface:surface@localhost:5432/surface' });
    expect(secretsOf(config)).toEqual([config.sessionSecret]);
  });
});
