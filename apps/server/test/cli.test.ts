// SPEC-004 §9: the `surface` CLI. Argument handling, `version`, the PLAN-001
// stubs, and config failures. Database commands: cli-migrate.int.test.ts, doctor.int.test.ts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { loadMigrations } from '../src/db/migrate.js';
import { formatVersion, versionReport } from '../src/cli/version.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

async function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const code = await runCli(argv, { out: (t) => (out += t), err: (t) => (err += t) }, { env });
  return { code, out, err };
}

describe('surface CLI', () => {
  it('prints usage listing every command with --help', async () => {
    const { code, out, err } = await cli(['--help']);
    expect(code).toBe(0);
    expect(err).toBe('');
    for (const command of [
      'serve',
      'migrate',
      'doctor',
      'version',
      'setup-token',
      'reset-password',
    ]) {
      expect(out).toContain(command);
    }
  });

  it.each([
    [['frobnicate'], 'Unknown command "frobnicate".'],
    [['doctor', '--verbose'], "Unknown option '--verbose'"],
    [['reset-password'], 'surface reset-password needs <email>'],
    [['version', 'extra'], 'surface version does not take "extra".'],
    [['migrate', '--json'], 'surface migrate does not support --json.'],
    [['-V', 'doctor'], '--version can\'t be combined with a command ("doctor").'],
  ])('rejects %j with exit code 2 and a pointer to --help', async (argv, message) => {
    const { code, out, err } = await cli(argv);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(message);
    expect(err).toContain('surface --help');
  });

  it('prints the version, commit and schema level without any configuration', async () => {
    const { code, out } = await cli(['version']);
    expect(code).toBe(0);
    const migrations = loadMigrations();
    expect(out).toMatch(/^Surface \d+\.\d+\.\d+\ncommit {2}\S+\n/);
    expect(out).toContain(`schema  ${migrations.at(-1)?.tag} (${migrations.length} migration`);
    expect((await cli(['-V'])).out).toBe(out);
  });

  it('prints the version as JSON with --json', async () => {
    const { code, out } = await cli(['version', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(versionReport());
  });

  it('names the newest migration as the schema level', () => {
    const report = versionReport({ version: '1.2.3', commit: 'abc1234' }, [
      { idx: 0, tag: '0000_a', hash: 'h0', statements: [] },
      { idx: 1, tag: '0001_b', hash: 'h1', statements: [] },
    ]);
    expect(report).toMatchObject({ version: '1.2.3', commit: 'abc1234', schema: '0001_b' });
    expect(formatVersion(report)).toContain('schema  0001_b (2 migrations)');
    expect(versionReport({ version: '1', commit: 'c' }, []).schema).toBeNull();
  });

  it.each([['reset-password', 'ada@example.com']])(
    'explains that %s is not available yet and exits 1',
    async (...argv) => {
      const { code, out, err } = await cli(argv);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain(`surface ${argv[0]} is not available in this version yet`);
    },
  );

  it.each([[[]], [['serve']], [['migrate']], [['setup-token']]])(
    'refuses to %j with an invalid configuration, naming each variable',
    async (argv) => {
      const { code, out, err } = await cli(argv, { SESSION_SECRET: 'too-short' });
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('SURFACE_URL is missing');
      expect(err).toContain('SESSION_SECRET must be at least 32 bytes');
      expect(err).not.toContain('too-short');
    },
  );

  it('reports an invalid configuration as a doctor problem and skips the rest', async () => {
    const { code, out } = await cli(['doctor'], {});
    expect(code).toBe(1);
    expect(out).toMatch(/✗ Configuration +SURFACE_URL is missing/);
    expect(out).toMatch(/- Database +skipped: fix the configuration first/);
    expect(out).toContain('1 problem, 0 warnings.');
  });

  // AC-6 through the real entry point: `surface` with no command means `serve`.
  // The 1 s budget is checked by hand, not here (SPEC-004 D7).
  it('exits 1 when started without a valid configuration', () => {
    const result = spawnSync(
      process.execPath,
      ['--conditions=@surface/source', '--import', 'tsx', 'src/cli/main.ts'],
      {
        cwd: serverRoot,
        env: { PATH: process.env.PATH, SESSION_SECRET: 'too-short' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SURFACE_URL is missing');
    expect(result.stdout).toBe('');
  });
});
