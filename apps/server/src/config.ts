/**
 * Server configuration (SPEC-004 §7).
 *
 * Everything comes from environment variables and is validated once at startup.
 * Errors name the variable and say how to fix it; secret values are never echoed.
 */
import path from 'node:path';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const ROLES = ['all', 'web', 'worker'] as const;

export interface Config {
  /** Public origin, e.g. `https://surface.example.com` (no trailing slash). */
  publicUrl: string;
  /** True when `publicUrl` is https; drives the cookie `Secure` flag. */
  secureCookies: boolean;
  sessionSecret: string;
  databaseUrl: string;
  /** `null` = no-SMTP mode (links are shown in the UI instead of emailed). */
  smtp: { url: string; from: string } | null;
  uploadMaxMb: number;
  mcpEnabled: boolean;
  setupToken: string | undefined;
  role: (typeof ROLES)[number];
  logLevel: (typeof LOG_LEVELS)[number];
  metricsEnabled: boolean;
  trustProxy: boolean;
  /** Port and interface the HTTP server listens on inside the container. */
  port: number;
  host: string;
  backup: { schedule: string | undefined; retention: string | undefined };
  /** Directory holding the built web app; `undefined` = default location. */
  webDir: string | undefined;
  /** Writable data volume (uploads, backups); always absolute. */
  dataDir: string;
  nodeEnv: 'production' | 'development' | 'test';
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(formatProblems(problems));
    this.name = 'ConfigError';
  }
}

function formatProblems(problems: string[]): string {
  return [
    'Surface cannot start: the configuration is invalid.',
    '',
    ...problems.map((p) => `  ✗ ${p}`),
    '',
    'Every setting is documented in .env.example.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const missing = (name: string, hint: string) => `${name} is missing. ${hint}`;

function bool(name: string, fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return fallback;
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off'].includes(v)) return false;
      ctx.addIssue({ code: 'custom', message: `${name} must be true or false (got "${value}").` });
      return z.NEVER;
    });
}

function int(name: string, fallback: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return fallback;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a whole number from ${min} to ${max} (got "${value}").`,
        });
        return z.NEVER;
      }
      return n;
    });
}

function oneOf<const T extends readonly [string, ...string[]]>(
  name: string,
  values: T,
  fallback: T[number],
) {
  const isOneOf = (v: string): v is T[number] => (values as readonly string[]).includes(v);
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return fallback;
      const v = value.trim().toLowerCase();
      if (isOneOf(v)) return v;
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be one of ${values.join(', ')} (got "${value}").`,
      });
      return z.NEVER;
    });
}

function protocolOf(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `value` with everything up to its last `@` (after the scheme) replaced by `***`, for error
 * messages: `https://u:p@host` and a scheme-less `u:p@host` alike, whatever the password holds,
 * `/` included (PLAN-001 S9, security review L4). An `@` in a path is hidden too: an origin has
 * none, so the message loses nothing it needs.
 */
function withoutCredentials(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)?.*@/is, '$1***@');
}

const schema = z.object({
  SURFACE_URL: z
    .string({
      error: missing(
        'SURFACE_URL',
        'Set it to the address people open in the browser, e.g. https://surface.example.com',
      ),
    })
    .transform((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        url = new URL('invalid:');
      }
      // Echoed without anything before an `@` in the authority: it may be a password.
      const shown = withoutCredentials(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          message: `SURFACE_URL must be an absolute http(s) URL such as https://surface.example.com (got "${shown}").`,
        });
        return z.NEVER;
      }
      if (url.username || url.password) {
        ctx.addIssue({
          code: 'custom',
          message: `SURFACE_URL must not contain a user name or password (got "${shown}"). Remove the part before the @.`,
        });
        return z.NEVER;
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        ctx.addIssue({
          code: 'custom',
          message: `SURFACE_URL must be just the origin, without a path or query (got "${shown}"). Serving Surface under a sub-path is not supported.`,
        });
        return z.NEVER;
      }
      return url.origin;
    }),

  SESSION_SECRET: z
    .string({ error: missing('SESSION_SECRET', 'Generate one with: openssl rand -hex 32') })
    .regex(/^[0-9a-fA-F]{64,}$/, {
      // Never echo the value: it is a secret.
      message:
        'SESSION_SECRET must be at least 32 bytes written as hex (64+ characters 0-9, a-f). Generate one with: openssl rand -hex 32',
    }),

  DATABASE_URL: z
    .string()
    .optional()
    .refine((v) => v === undefined || ['postgres:', 'postgresql:'].includes(protocolOf(v) ?? ''), {
      // The URL contains a password; describe the problem without echoing it.
      message:
        'DATABASE_URL must be a PostgreSQL connection URL: postgres://user:password@host:5432/database',
    }),
  POSTGRES_PASSWORD: z.string().optional(),

  SMTP_URL: z
    .string()
    .optional()
    .refine((v) => v === undefined || ['smtp:', 'smtps:'].includes(protocolOf(v) ?? ''), {
      message:
        'SMTP_URL must look like smtp://user:password@host:587 (STARTTLS) or smtps://user:password@host:465 (TLS). Leave it unset to run without email.',
    }),
  SMTP_FROM: z.string().optional(),

  UPLOAD_MAX_MB: int('UPLOAD_MAX_MB', 25, 1, 10_240),
  MCP_ENABLED: bool('MCP_ENABLED', true),
  SURFACE_SETUP_TOKEN: z
    .string()
    .min(16, { message: 'SURFACE_SETUP_TOKEN must be at least 16 characters long.' })
    // The setup routes read at most 128 characters of token (SPEC-001 §6.1).
    .max(128, { message: 'SURFACE_SETUP_TOKEN must be at most 128 characters long.' })
    .optional(),
  SURFACE_ROLE: oneOf('SURFACE_ROLE', ROLES, 'all'),
  LOG_LEVEL: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
  METRICS_ENABLED: bool('METRICS_ENABLED', false),
  TRUST_PROXY: bool('TRUST_PROXY', true),
  PORT: int('PORT', 3000, 1, 65_535),
  HOST: z.string().optional(),
  BACKUP_SCHEDULE: z.string().optional(),
  BACKUP_RETENTION: z.string().optional(),
  SURFACE_WEB_DIR: z.string().optional(),
  DATA_DIR: z.string().optional(),
  NODE_ENV: oneOf('NODE_ENV', ['production', 'development', 'test'], 'production'),
});

/**
 * Rules spanning several variables. Checked separately from the schema so they
 * are reported together with field errors, not only after those are fixed.
 */
function crossFieldProblems(env: Record<string, string>): string[] {
  const problems: string[] = [];
  if (env.DATABASE_URL === undefined && env.POSTGRES_PASSWORD === undefined) {
    problems.push(
      'DATABASE_URL is missing. With the bundled database, set POSTGRES_PASSWORD (generate one with: openssl rand -hex 24). With your own PostgreSQL, set DATABASE_URL.',
    );
  }
  if (env.SMTP_URL !== undefined && env.SMTP_FROM === undefined) {
    problems.push(
      'SMTP_FROM is missing. It is required when SMTP_URL is set, e.g. Surface <surface@example.com>',
    );
  }
  return problems;
}

const KNOWN_KEYS = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

/**
 * Validate the environment and build the typed config.
 * @throws {ConfigError} listing every problem at once.
 */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // Only known keys; blank values (`FOO=`) count as unset.
  const env: Record<string, string> = {};
  for (const key of KNOWN_KEYS) {
    const value = rawEnv[key];
    if (value !== undefined && value.trim() !== '') env[key] = value.trim();
  }

  const parsed = schema.safeParse(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)),
    ...crossFieldProblems(env),
  ];
  if (!parsed.success || problems.length > 0) throw new ConfigError(problems);
  const e = parsed.data;

  return {
    publicUrl: e.SURFACE_URL,
    secureCookies: e.SURFACE_URL.startsWith('https:'),
    sessionSecret: e.SESSION_SECRET,
    databaseUrl:
      e.DATABASE_URL ??
      `postgres://surface:${encodeURIComponent(e.POSTGRES_PASSWORD ?? '')}@db:5432/surface`,
    smtp:
      e.SMTP_URL !== undefined && e.SMTP_FROM !== undefined
        ? { url: e.SMTP_URL, from: e.SMTP_FROM }
        : null,
    uploadMaxMb: e.UPLOAD_MAX_MB,
    mcpEnabled: e.MCP_ENABLED,
    setupToken: e.SURFACE_SETUP_TOKEN,
    role: e.SURFACE_ROLE,
    logLevel: e.LOG_LEVEL,
    metricsEnabled: e.METRICS_ENABLED,
    trustProxy: e.TRUST_PROXY,
    port: e.PORT,
    host: e.HOST ?? '0.0.0.0',
    backup: { schedule: e.BACKUP_SCHEDULE, retention: e.BACKUP_RETENTION },
    webDir: e.SURFACE_WEB_DIR,
    // The image sets /data (SPEC-004 §5); a relative path is resolved once, here.
    dataDir: path.resolve(e.DATA_DIR ?? '/data'),
    nodeEnv: e.NODE_ENV,
  };
}
