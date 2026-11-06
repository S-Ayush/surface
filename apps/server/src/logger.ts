/**
 * Structured JSON logging (SPEC-004 §10).
 *
 * Secrets never reach the logs: sensitive fields are redacted by path, and
 * tokens carried in URLs (magic links, resets, invites) are masked before the
 * request URL is logged.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import type { Config } from './config.js';

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'secret',
  'sessionSecret',
  'apiKey',
  'cookie',
  'authorization',
];

/** Redaction paths: header paths plus sensitive keys up to three levels deep. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/** Query parameters whose values are credentials. */
const SENSITIVE_QUERY_PARAMS = new Set(['token', 'code', 'secret', 'password', 'key']);

/** Path segments that carry a credential, e.g. `/invite/<token>`. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [/^(\/(?:api\/)?invite\/)[^/?#]+/];

/** Mask credentials in a request URL (path segments and query values). */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  let path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? '' : url.slice(queryStart + 1);

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    path = path.replace(pattern, `$1${REDACTED}`);
  }
  if (!query) return path;

  const params = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = decodeURIComponentSafe(eq === -1 ? pair : pair.slice(0, eq));
    return SENSITIVE_QUERY_PARAMS.has(name.toLowerCase()) && eq !== -1
      ? `${pair.slice(0, eq)}=${REDACTED}`
      : pair;
  });
  return `${path}?${params.join('&')}`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function loggerOptions(config: Pick<Config, 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    base: undefined, // no pid/hostname noise; containers add their own metadata
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip,
      }),
      res: (res: FastifyReply) => ({ statusCode: res.statusCode }),
      err: stdSerializers.err,
    },
  };
}

export function createLogger(
  config: Pick<Config, 'logLevel'>,
  destination?: DestinationStream,
): Logger {
  return destination ? pino(loggerOptions(config), destination) : pino(loggerOptions(config));
}
