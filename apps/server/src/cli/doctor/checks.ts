/**
 * `surface doctor` verdicts (SPEC-004 §9, AC-12). Each function turns facts
 * gathered by probes.ts into a result, without I/O, so every failure condition
 * has a fixture. Messages say what is wrong and how to fix it, and never contain
 * secrets: probes only pass on host names, paths and server replies.
 */
import { assertSupportedVersion } from '../../db/checks.js';
import { permanentProblem } from '../../db/pool.js';
import { dataDirProblem, type DataDirFacts } from '../../data-dir.js';
import { StartupError } from '../../startup-error.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export const CHECKS = {
  config: 'Configuration',
  database: 'Database',
  postgres: 'PostgreSQL version',
  collations: 'Collations',
  extensions: 'Extensions',
  migrations: 'Migrations',
  dataDir: 'Data directory',
  disk: 'Disk space',
  smtp: 'Email (SMTP)',
  publicUrl: 'Public URL',
} as const;

export type CheckId = keyof typeof CHECKS;

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  message: string;
}

const ok = (id: CheckId, message: string): CheckResult => ({ id, status: 'ok', message });
const warn = (id: CheckId, message: string): CheckResult => ({ id, status: 'warn', message });
const fail = (id: CheckId, message: string): CheckResult => ({ id, status: 'fail', message });
export const skip = (id: CheckId, message: string): CheckResult => ({
  id,
  status: 'skip',
  message,
});

/** `code: message` of an error, for the reason in parentheses. */
export function describeError(error: unknown): string {
  // Dual-stack connects (localhost = ::1 and 127.0.0.1) fail with an AggregateError
  // whose own message is empty; the first attempt's error says what happened.
  if (error instanceof AggregateError && !error.message && error.errors.length > 0) {
    return describeError(error.errors[0]);
  }
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (!message) return code ?? String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configCheck(problems: readonly string[]): CheckResult {
  if (problems.length === 0) return ok('config', 'valid');
  return fail('config', problems.join('\n'));
}

// ---------------------------------------------------------------------------
// Database (E1, plus the fail-fast cases of SPEC-004 §8 step 2)
// ---------------------------------------------------------------------------

/** `location` is host:port/database, never the URL (it holds the password). */
export function databaseCheck(location: string, error: unknown): CheckResult {
  if (error === undefined) return ok('database', `connected to ${location}`);
  const permanent = permanentProblem(error);
  if (permanent) return fail('database', `${permanent} (database at ${location})`);
  return fail(
    'database',
    `Could not reach the database at ${location} (${describeError(error)}). Check that it is running and that DATABASE_URL points to it.`,
  );
}

// ---------------------------------------------------------------------------
// PostgreSQL version, collations and extensions (E8)
// ---------------------------------------------------------------------------

export function postgresCheck(versionNum: number, versionText: string): CheckResult {
  try {
    assertSupportedVersion(versionNum, versionText);
  } catch (error) {
    if (error instanceof StartupError) return fail('postgres', error.message);
    throw error;
  }
  return ok('postgres', versionText);
}

/**
 * ICU collations (SPEC-004 §8 step 3, E8). `problem` is the message startup's own
 * check (`checkCollations`) produced, so doctor and startup word it alike.
 */
export function collationsCheck(
  names: readonly string[],
  problem: string | undefined,
): CheckResult {
  if (problem !== undefined) return fail('collations', problem);
  return ok('collations', `${names.join(', ')} available`);
}

export interface ExtensionFacts {
  name: string;
  installed: boolean;
  available: boolean;
  /** The database user may run CREATE EXTENSION for it (superuser, or a trusted extension and CREATE on the database). */
  canCreate: boolean;
  database: string;
}

export function extensionsCheck(facts: readonly ExtensionFacts[]): CheckResult {
  const problems: string[] = [];
  const toCreate: string[] = [];
  for (const f of facts) {
    if (f.installed) continue;
    if (!f.available) {
      problems.push(
        `The PostgreSQL extension ${f.name} is not available on this server. Install the PostgreSQL contrib package, or enable ${f.name} in your database provider's settings.`,
      );
    } else if (!f.canCreate) {
      problems.push(
        `The PostgreSQL extension ${f.name} is not installed and the database user is not allowed to create it. Ask a database administrator to run this in database "${f.database}": CREATE EXTENSION ${f.name};`,
      );
    } else {
      toCreate.push(f.name);
    }
  }
  if (problems.length > 0) return fail('extensions', problems.join('\n'));
  const names = facts.map((f) => f.name).join(', ');
  if (toCreate.length > 0) {
    return ok('extensions', `${toCreate.join(', ')} will be created when Surface starts`);
  }
  return ok('extensions', `${names} installed`);
}

// ---------------------------------------------------------------------------
// Migrations (E7)
// ---------------------------------------------------------------------------

export type MigrationFacts =
  | { kind: 'current'; total: number }
  | { kind: 'pending'; pending: number; total: number }
  /** The database is ahead of this build, or an applied migration was edited. */
  | { kind: 'incompatible'; message: string };

export function migrationsCheck(facts: MigrationFacts): CheckResult {
  switch (facts.kind) {
    case 'current':
      return ok('migrations', `all ${facts.total} applied`);
    case 'pending':
      return warn(
        'migrations',
        `${facts.pending} of ${facts.total} not applied yet. Surface applies them when it starts, or run: surface migrate`,
      );
    case 'incompatible':
      return fail('migrations', facts.message);
  }
}

// ---------------------------------------------------------------------------
// Data directory (E5) and disk space (E6)
// ---------------------------------------------------------------------------

/** Startup's E5 check, as a doctor line: the same facts and messages (`src/data-dir.ts`). */
export function dataDirCheck(facts: DataDirFacts): CheckResult {
  const problem = dataDirProblem(facts);
  return problem === undefined
    ? ok('dataDir', `${facts.path} is writable`)
    : fail('dataDir', problem);
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** Below this, uploads and backups are about to fail. */
export const DISK_FAIL_BYTES = 100 * MiB;
/** Below this, warn while there is still time to act. */
export const DISK_WARN_BYTES = 1 * GiB;

export function formatBytes(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GB`;
  if (bytes >= MiB) return `${Math.floor(bytes / MiB)} MB`;
  return `${Math.floor(bytes / 1024)} KB`;
}

export function diskCheck(path: string, freeBytes: number, totalBytes: number): CheckResult {
  const free = `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)} on ${path}`;
  if (freeBytes < DISK_FAIL_BYTES) {
    return fail(
      'disk',
      `Only ${free}. Free up space or grow the volume: uploads and backups fail when it is full.`,
    );
  }
  if (freeBytes < DISK_WARN_BYTES) {
    return warn('disk', `Only ${free}. Free up space or grow the volume soon.`);
  }
  return ok('disk', free);
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export interface SmtpTarget {
  host: string;
  port: number;
  /** smtps:// (TLS from the first byte) rather than smtp:// (STARTTLS). */
  tls: boolean;
}

export type SmtpOutcome =
  { kind: 'greeting'; code: number; line: string } | { kind: 'error'; reason: string };

export function smtpNotConfigured(): CheckResult {
  return skip(
    'smtp',
    'not configured: Surface runs without email and shows invite and reset links in the app instead',
  );
}

export function smtpCheck(target: SmtpTarget, outcome: SmtpOutcome): CheckResult {
  const where = `${target.host}:${target.port}`;
  if (outcome.kind === 'error') {
    return fail(
      'smtp',
      `Could not connect to the SMTP server at ${where} (${outcome.reason}). Check the host and port in SMTP_URL (usually 587 with smtp://, or 465 with smtps://) and that this host may connect to it.`,
    );
  }
  if (outcome.code !== 220) {
    return fail(
      'smtp',
      `The SMTP server at ${where} refused the connection: "${outcome.line}". Check SMTP_URL, or ask the mail provider whether this host is allowed.`,
    );
  }
  return ok(
    'smtp',
    `${where} is accepting connections (the user name and password are checked when the first email is sent)`,
  );
}

// ---------------------------------------------------------------------------
// Public URL (E3)
// ---------------------------------------------------------------------------

export type PublicUrlOutcome =
  | { kind: 'response'; status: number; isSurface: boolean }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'error'; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function publicUrlCheck(publicUrl: string, outcome: PublicUrlOutcome): CheckResult {
  const mustMatch = `People must open exactly ${publicUrl}: from any other address, sign-in fails.`;
  if (outcome.kind === 'error') {
    return warn(
      'publicUrl',
      `Could not reach ${publicUrl} from this host (${outcome.reason}). That is normal if this host cannot resolve its own public name; otherwise check DNS and the reverse proxy. ${mustMatch}`,
    );
  }
  if (outcome.kind === 'redirect') {
    return warn(
      'publicUrl',
      `${publicUrl}/healthz redirects (${outcome.status}) to ${outcome.location}. Set SURFACE_URL to the address people end up on, or stop the reverse proxy from redirecting it. ${mustMatch}`,
    );
  }
  if (outcome.status !== 200 || !outcome.isSurface) {
    return warn(
      'publicUrl',
      `${publicUrl}/healthz answered ${outcome.status} but not as Surface. Check that the reverse proxy forwards this address to Surface. ${mustMatch}`,
    );
  }
  const url = new URL(publicUrl);
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return warn(
      'publicUrl',
      `${publicUrl} reaches Surface, but over plain http, so sign-in cookies travel unencrypted. Put Surface behind an HTTPS reverse proxy and set SURFACE_URL to the https:// address.`,
    );
  }
  return ok('publicUrl', `${publicUrl} reaches Surface`);
}
