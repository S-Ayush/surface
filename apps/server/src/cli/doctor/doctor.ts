/**
 * `surface doctor` (SPEC-004 §9, AC-12): check everything an operator can get
 * wrong, report each item as ok / warning / problem / skipped, and exit 1 if
 * there is any problem. It runs next to a live server without disturbing it.
 */
import { pino } from 'pino';
import { buildInfo, type BuildInfo } from '../../build-info.js';
import { ConfigError, loadConfig, type Config } from '../../config.js';
import { REQUIRED_COLLATIONS } from '../../db/checks.js';
import { loadMigrations, type Migration } from '../../db/migrate.js';
import { createPool, databaseLocation } from '../../db/pool.js';
import { dataDirFacts, uploadsDir } from '../../data-dir.js';
import { REDACTED } from '../../logger.js';
import { EXIT, type CliIo } from '../io.js';
import {
  CHECKS,
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
  skip,
  smtpCheck,
  smtpNotConfigured,
  type CheckId,
  type CheckResult,
} from './checks.js';
import {
  collationProblem,
  diskFacts,
  extensionFacts,
  migrationFacts,
  postgresVersion,
  publicUrlProbe,
  smtpGreeting,
  smtpTarget,
  type DiskProbe,
} from './probes.js';

export interface DoctorOptions {
  migrations?: Migration[];
  /** Collations that must exist. Defaults to what startup requires. */
  collations?: readonly string[];
  /** Per network probe (SMTP, public URL). */
  timeoutMs?: number;
  disk?: DiskProbe;
}

function unexpected(id: CheckId, error: unknown): CheckResult {
  return {
    id,
    status: 'fail',
    message: `The check itself failed (${describeError(error)}). Run surface doctor again; if it keeps failing, report this message.`,
  };
}

type Report = (result: CheckResult) => void;

/**
 * Run a group of dependent checks. A probe that throws unexpectedly is reported
 * as a problem on the check it was making, and the group's remaining checks as
 * skipped, so the report always has one entry per check.
 */
async function group(
  ids: readonly CheckId[],
  run: (report: Report) => Promise<void>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    await run((result) => results.push(result));
  } catch (error) {
    const done = new Set(results.map((r) => r.id));
    const [failed, ...rest] = ids.filter((id) => !done.has(id));
    if (failed) results.push(unexpected(failed, error));
    for (const id of rest)
      results.push(skip(id, `skipped: the ${CHECKS[failed ?? id]} check failed`));
  }
  return results;
}

/** An independent check inside a group: its failure doesn't stop the others. */
async function attempt(id: CheckId, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    return unexpected(id, error);
  }
}

function databaseChecks(
  config: Config,
  migrations: Migration[],
  collations: readonly string[],
): Promise<CheckResult[]> {
  return group(
    ['database', 'postgres', 'collations', 'extensions', 'migrations'],
    async (report) => {
      const location = databaseLocation(config.databaseUrl);
      // One connection, no retries: doctor reports the state now (unlike startup's E1 wait).
      const pool = createPool(config.databaseUrl, pino({ level: 'silent' }), { max: 1 });
      try {
        try {
          await pool.query('SELECT 1');
        } catch (error) {
          const why = 'skipped: needs a database connection';
          report(databaseCheck(location, error));
          for (const id of ['postgres', 'collations', 'extensions', 'migrations'] as const) {
            report(skip(id, why));
          }
          return;
        }
        report(databaseCheck(location, undefined));

        const version = await postgresVersion(pool);
        const postgres = postgresCheck(version.num, version.text);
        report(postgres);
        if (postgres.status === 'fail') {
          const why = 'skipped: needs a supported PostgreSQL version';
          for (const id of ['collations', 'extensions', 'migrations'] as const) {
            report(skip(id, why));
          }
          return;
        }

        // Same order as startup (SPEC-004 §8 step 3): version, then collations.
        report(
          await attempt('collations', async () =>
            collationsCheck(collations, await collationProblem(pool, collations)),
          ),
        );

        report(
          await attempt('extensions', async () => extensionsCheck(await extensionFacts(pool))),
        );
        report(
          await attempt('migrations', async () =>
            migrationsCheck(await migrationFacts(pool, migrations)),
          ),
        );
      } finally {
        await pool.end().catch(() => undefined);
      }
    },
  );
}

function storageChecks(config: Config, disk: DiskProbe): Promise<CheckResult[]> {
  return group(['dataDir', 'disk'], async (report) => {
    const dir = await dataDirFacts(config.dataDir);
    let result = dataDirCheck(dir);
    if (dir.state === 'writable') {
      // The uploads folder is its own volume in compose (SPEC-004 E5). Startup creates it when
      // missing, so only one that exists can be a problem.
      const uploads = await dataDirFacts(uploadsDir(config.dataDir));
      if (uploads.state === 'writable') {
        result = dataDirCheck({ path: `${config.dataDir} and ${uploads.path}`, state: 'writable' });
      } else if (uploads.state !== 'missing') {
        result = dataDirCheck(uploads);
      }
    }
    report(result);
    if (dir.state === 'missing' || dir.state === 'not-directory') {
      report(skip('disk', 'skipped: needs the data directory'));
      return;
    }
    const { freeBytes, totalBytes } = await disk(config.dataDir);
    report(diskCheck(config.dataDir, freeBytes, totalBytes));
  });
}

function smtpChecks(config: Config, timeoutMs: number): Promise<CheckResult[]> {
  return group(['smtp'], async (report) => {
    if (!config.smtp) {
      report(smtpNotConfigured());
      return;
    }
    const target = smtpTarget(config.smtp.url);
    report(smtpCheck(target, await smtpGreeting(target, timeoutMs)));
  });
}

function publicUrlChecks(config: Config, timeoutMs: number): Promise<CheckResult[]> {
  return group(['publicUrl'], async (report) => {
    report(publicUrlCheck(config.publicUrl, await publicUrlProbe(config.publicUrl, timeoutMs)));
  });
}

/** The result of loading the configuration: a valid config, or its problems. */
export type DoctorInput = { config: Config } | { problems: readonly string[] };

/** Run every check. Independent groups run concurrently, so timeouts don't add up. */
export async function runDoctor(
  input: DoctorInput,
  options: DoctorOptions = {},
): Promise<CheckResult[]> {
  if ('problems' in input) {
    const why = 'skipped: fix the configuration first';
    const others = Object.keys(CHECKS).filter((id): id is CheckId => id !== 'config');
    return [configCheck(input.problems), ...others.map((id) => skip(id, why))];
  }
  const { config } = input;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const migrations = options.migrations ?? loadMigrations();

  const groups = await Promise.all([
    databaseChecks(config, migrations, options.collations ?? REQUIRED_COLLATIONS),
    storageChecks(config, options.disk ?? diskFacts),
    smtpChecks(config, timeoutMs),
    publicUrlChecks(config, timeoutMs),
  ]);
  return [configCheck([]), ...groups.flat()];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MIN_SCRUB_LENGTH = 12;

/** Secret values that must never be printed, even if a server echoes them. */
export function secretsOf(config: Config): string[] {
  const passwordOf = (url: string | undefined) => {
    if (!url) return undefined;
    try {
      return decodeURIComponent(new URL(url).password) || undefined;
    } catch {
      return undefined;
    }
  };
  return [
    config.sessionSecret,
    config.setupToken,
    passwordOf(config.databaseUrl),
    passwordOf(config.smtp?.url),
    // Probes never put secrets into messages; this is a backstop for generated
    // secrets. Short ones are often ordinary words (the dev database password is
    // "surface") that also appear in host names, database names and paths.
  ].filter((s): s is string => s !== undefined && s.length >= MIN_SCRUB_LENGTH);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.replaceAll(secret, REDACTED).replaceAll(encodeURIComponent(secret), REDACTED);
  }
  return result;
}

const SYMBOL = { ok: '✓', warn: '!', fail: '✗', skip: '-' } as const;
const LABEL_WIDTH = Math.max(...Object.values(CHECKS).map((l) => l.length)) + 2;

export function formatReport(results: readonly CheckResult[], info: BuildInfo): string {
  const indent = ' '.repeat(LABEL_WIDTH + 2);
  const lines = [`Surface doctor · version ${info.version} (${info.commit})`, ''];
  for (const r of results) {
    const [first = '', ...rest] = r.message.split('\n');
    lines.push(`${SYMBOL[r.status]} ${CHECKS[r.id].padEnd(LABEL_WIDTH)}${first}`);
    for (const line of rest) lines.push(`${indent}${line}`);
  }
  const problems = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push('');
  if (problems > 0) {
    lines.push(
      `${count(problems, 'problem')}, ${count(warnings, 'warning')}. Fix the ✗ items, then run surface doctor again.`,
    );
  } else if (warnings > 0) {
    lines.push(`No problems, ${count(warnings, 'warning')}.`);
  } else {
    lines.push('All checks passed.');
  }
  return `${lines.join('\n')}\n`;
}

export function doctorExitCode(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === 'fail') ? EXIT.failure : EXIT.ok;
}

export function loadDoctorInput(env?: NodeJS.ProcessEnv): DoctorInput {
  try {
    return { config: loadConfig(env) };
  } catch (error) {
    if (error instanceof ConfigError) return { problems: error.problems };
    throw error;
  }
}

export interface DoctorCommandOptions extends DoctorOptions {
  json: boolean;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function doctorCommand(
  io: CliIo,
  { json, env, ...options }: DoctorCommandOptions,
): Promise<number> {
  const input = loadDoctorInput(env);
  const secrets = 'config' in input ? secretsOf(input.config) : [];
  // Scrub the messages themselves, before any formatting or JSON escaping.
  const results = (await runDoctor(input, options)).map((r) => ({
    ...r,
    message: scrub(r.message, secrets),
  }));
  const info = buildInfo();
  const text = json
    ? `${JSON.stringify({
        ok: doctorExitCode(results) === EXIT.ok,
        version: info.version,
        commit: info.commit,
        checks: results.map((r) => ({ ...r, label: CHECKS[r.id] })),
      })}\n`
    : formatReport(results, info);
  io.out(text);
  return doctorExitCode(results);
}
