/**
 * Fact gathering for `surface doctor`. Read-only: it never creates extensions,
 * applies migrations or leaves files behind. Network probes go only to the
 * operator's own database, SMTP server and SURFACE_URL, each with a timeout.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, stat, statfs, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { REQUIRED_EXTENSIONS } from '../../db/checks.js';
import { migrationStatus, type Migration } from '../../db/migrate.js';
import type { Pool } from '../../db/pool.js';
import { StartupError } from '../../startup-error.js';
import {
  describeError,
  type DataDirFacts,
  type ExtensionFacts,
  type MigrationFacts,
  type PublicUrlOutcome,
  type SmtpOutcome,
  type SmtpTarget,
} from './checks.js';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export async function postgresVersion(pool: Pool): Promise<{ num: number; text: string }> {
  const { rows } = await pool.query<{ num: string; text: string }>(
    "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS text",
  );
  const row = rows[0];
  if (!row) throw new Error('the server did not report its version');
  return { num: Number(row.num), text: row.text };
}

export async function extensionFacts(
  pool: Pool,
  names: readonly string[] = REQUIRED_EXTENSIONS,
): Promise<ExtensionFacts[]> {
  const facts: ExtensionFacts[] = [];
  for (const name of names) {
    // Since PostgreSQL 13 a "trusted" extension (pg_trgm is one) can be created
    // by any user with CREATE on the database; others need a superuser.
    const { rows } = await pool.query<Omit<ExtensionFacts, 'name'>>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS installed,
         EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = $1) AS available,
         COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
           OR (has_database_privilege(current_database(), 'CREATE')
               AND COALESCE((SELECT v.trusted
                               FROM pg_available_extensions a
                               JOIN pg_available_extension_versions v
                                 ON v.name = a.name AND v.version = a.default_version
                              WHERE a.name = $1), false)) AS "canCreate",
         current_database() AS database`,
      [name],
    );
    const row = rows[0];
    if (!row) throw new Error(`no answer about the extension ${name}`);
    facts.push({ name, ...row });
  }
  return facts;
}

export async function migrationFacts(pool: Pool, migrations: Migration[]): Promise<MigrationFacts> {
  const total = migrations.length;
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS exists",
  );
  if (!rows[0]?.exists) return { kind: 'pending', pending: total, total };

  try {
    await migrationStatus(pool, migrations);
    return { kind: 'current', total };
  } catch (error) {
    // Unknown (E7) or edited migrations: the same verdict startup would reach.
    if (error instanceof StartupError) return { kind: 'incompatible', message: error.message };
  }
  const applied = await pool.query<{ tag: string }>('SELECT tag FROM schema_migrations');
  const done = new Set(applied.rows.map((r) => r.tag));
  return { kind: 'pending', pending: migrations.filter((m) => !done.has(m.tag)).length, total };
}

// ---------------------------------------------------------------------------
// Data directory and disk
// ---------------------------------------------------------------------------

export async function dataDirFacts(dir: string): Promise<DataDirFacts> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { path: dir, state: 'not-directory' };
  } catch (error) {
    switch ((error as { code?: unknown }).code) {
      case 'ENOENT':
        return { path: dir, state: 'missing' };
      case 'ENOTDIR': // a parent is a file: /etc/hosts/data
        return { path: dir, state: 'not-directory' };
      case 'EACCES': // a parent directory can't be searched
        return {
          path: dir,
          state: 'not-writable',
          reason: describeError(error),
          uid: process.getuid?.(),
        };
      default:
        throw error;
    }
  }

  // Write a real file: permission bits alone miss read-only mounts and ACLs.
  const probe = path.join(dir, `.surface-doctor-${randomBytes(6).toString('hex')}`);
  let created = false;
  try {
    const handle = await open(
      probe,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    );
    created = true;
    await handle.close();
    return { path: dir, state: 'writable' };
  } catch (error) {
    return {
      path: dir,
      state: 'not-writable',
      reason: describeError(error).replace(probe, dir),
      uid: process.getuid?.(),
    };
  } finally {
    // Doctor leaves nothing behind, even if closing the file failed.
    if (created) await unlink(probe).catch(() => undefined);
  }
}

export interface DiskFacts {
  freeBytes: number;
  totalBytes: number;
}

export type DiskProbe = (dir: string) => Promise<DiskFacts>;

export const diskFacts: DiskProbe = async (dir) => {
  const s = await statfs(dir);
  // bavail: blocks available to unprivileged users, which is what Surface runs as.
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
};

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export function smtpTarget(smtpUrl: string): SmtpTarget {
  const url = new URL(smtpUrl);
  const isTls = url.protocol === 'smtps:';
  return {
    // Brackets are part of URL.hostname for IPv6; sockets want the bare address.
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : isTls ? 465 : 587,
    tls: isTls,
  };
}

/**
 * Connect and read the server's greeting (RFC 5321 §4.2: "220" means ready).
 * Credentials are not sent: that would need a full SMTP client, and the
 * connection is what operators most often get wrong (host, port, firewall).
 */
/** How long a server may take to close after QUIT before we drop the connection. */
const QUIT_GRACE_MS = 1_000;

export function smtpGreeting(target: SmtpTarget, timeoutMs: number): Promise<SmtpOutcome> {
  return new Promise((resolve) => {
    const socket = target.tls
      ? tls.connect({
          host: target.host,
          port: target.port,
          // SNI carries host names only (RFC 6066 §3).
          ...(net.isIP(target.host) ? {} : { servername: target.host }),
        })
      : net.connect({ host: target.host, port: target.port });
    let buffer = '';
    let settled = false;

    const finish = (outcome: SmtpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.kind === 'greeting' && outcome.code === 220) {
        // Be polite: say goodbye instead of dropping the connection. A server
        // that never closes must not keep `surface doctor` running.
        socket.end('QUIT\r\n');
        setTimeout(() => socket.destroy(), QUIT_GRACE_MS).unref();
      } else {
        socket.destroy();
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ kind: 'error', reason: `no greeting within ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // A multi-line greeting is "220-..." lines ending with "220 ...".
      for (const line of buffer.split('\r\n')) {
        const match = /^(\d{3})(?: |$)/.exec(line);
        if (match?.[1]) {
          finish({ kind: 'greeting', code: Number(match[1]), line: line.slice(0, 200) });
          return;
        }
      }
      if (buffer.length > 4096) finish({ kind: 'error', reason: 'the server did not speak SMTP' });
    });
    socket.on('error', (error) => finish({ kind: 'error', reason: describeError(error) }));
    socket.on('close', () => finish({ kind: 'error', reason: 'the server closed the connection' }));
  });
}

// ---------------------------------------------------------------------------
// Public URL
// ---------------------------------------------------------------------------

/**
 * GET `<SURFACE_URL>/healthz`, the same route the Docker health check uses.
 * Redirects are reported, not followed: browsers that are redirected end up on
 * another origin, where sign-in fails (E3), and following them could leave the
 * operator's own network (SPEC-004 §14 D2).
 */
export async function publicUrlProbe(
  publicUrl: string,
  timeoutMs: number,
): Promise<PublicUrlOutcome> {
  try {
    const response = await fetch(`${publicUrl}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return {
        kind: 'redirect',
        status: response.status,
        location: response.headers.get('location') ?? '(no Location header)',
      };
    }
    const body: unknown = await response.json().catch(() => undefined);
    const isSurface =
      typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok';
    return { kind: 'response', status: response.status, isSurface };
  } catch (error) {
    // fetch wraps the useful part (ECONNREFUSED, ENOTFOUND, timeout) in `cause`.
    const cause = (error as { cause?: unknown }).cause;
    return { kind: 'error', reason: describeError(cause ?? error) };
  }
}
