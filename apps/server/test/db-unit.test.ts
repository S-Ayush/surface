import { describe, expect, it } from 'vitest';
import { assertSupportedVersion } from '../src/db/checks.js';
import { LOCKS } from '../src/db/locks.js';
import { loadMigrations } from '../src/db/migrate.js';
import { databaseLocation, permanentProblem } from '../src/db/pool.js';
import { StartupError } from '../src/startup-error.js';
import { writeMigrations } from './db.js';

describe('assertSupportedVersion (E8)', () => {
  it('accepts PostgreSQL 17 and newer', () => {
    expect(() => assertSupportedVersion(170000, '17.0')).not.toThrow();
    expect(() => assertSupportedVersion(180002, '18.2')).not.toThrow();
  });

  it('rejects older servers with an explicit instruction', () => {
    expect(() => assertSupportedVersion(160004, '16.4 (Debian)')).toThrowError(
      new StartupError(
        'Surface needs PostgreSQL 17 or newer, but the database is running 16.4 (Debian). Upgrade PostgreSQL (the bundled compose file uses postgres:17).',
      ),
    );
    expect(() => assertSupportedVersion(Number.NaN, 'unknown')).toThrow(StartupError);
  });
});

describe('loadMigrations', () => {
  it('reads the shipped migrations in journal order', () => {
    const migrations = loadMigrations();
    expect(migrations[0]).toMatchObject({ idx: 0, tag: '0000_extensions' });
    expect(migrations[0]?.statements).toEqual([
      expect.stringContaining('CREATE EXTENSION IF NOT EXISTS pg_trgm'),
    ]);
    expect(migrations.map((m) => m.idx)).toEqual(migrations.map((_, i) => i));
  });

  it('splits statements on drizzle breakpoints and hashes file contents', () => {
    const dir = writeMigrations([
      {
        tag: '0000_a',
        sql: 'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE INDEX a_id ON a (id);\n',
      },
      { tag: '0001_b', sql: 'CREATE TABLE b (id int);' },
    ]);
    const [a, b] = loadMigrations(dir);
    expect(a?.statements).toEqual(['CREATE TABLE a (id int);', 'CREATE INDEX a_id ON a (id);']);
    expect(b?.statements).toEqual(['CREATE TABLE b (id int);']);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.hash).not.toBe(b?.hash);
  });
});

describe('advisory lock keys', () => {
  it('are unique 64-bit values', () => {
    const keys = Object.values(LOCKS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(BigInt(k) < 2n ** 63n).toBe(true);
  });
});

describe('databaseLocation', () => {
  it('describes where the database is without credentials', () => {
    expect(databaseLocation('postgres://surface:s3cret@db:5432/surface')).toBe('db:5432/surface');
    expect(databaseLocation('postgresql://u:p@pg.example.com/app?sslmode=require')).toBe(
      'pg.example.com:5432/app',
    );
    expect(databaseLocation('not a url')).not.toContain('not a url');
  });
});

describe('permanentProblem', () => {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('gives pg_hba rejections their own advice, with the server reason', () => {
    const problem = permanentProblem(
      pgError(
        '28000',
        'no pg_hba.conf entry for host "10.0.0.5", user "surface", database "surface", no encryption',
      ),
    );
    expect(problem).toMatch(/^The database server refused this connection \(pg_hba\.conf\)/);
    expect(problem).toContain('?sslmode=require');
    expect(problem).toContain('(28000: no pg_hba.conf entry for host "10.0.0.5"');
  });

  it('keeps wrong passwords and missing databases distinct', () => {
    expect(permanentProblem(pgError('28P01', 'password authentication failed'))).toMatch(
      /^The database rejected the username or password/,
    );
    expect(permanentProblem(pgError('3D000', 'database "x" does not exist'))).toMatch(
      /^The database named in DATABASE_URL does not exist/,
    );
  });

  it('treats everything else as transient', () => {
    expect(
      permanentProblem(pgError('57P03', 'the database system is starting up')),
    ).toBeUndefined();
    expect(
      permanentProblem(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ).toBeUndefined();
  });
});
