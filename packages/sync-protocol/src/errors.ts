import type { z } from 'zod';

/**
 * A message or stream that does not match the sync protocol. The message names
 * the failing path and rule, never the payload, because rows can hold user data
 * that must not reach logs (CLAUDE.md rule 6).
 */
export class ProtocolError extends Error {
  override readonly name: string = 'ProtocolError';
}

/**
 * A mutate body, bootstrap query or socket query without `userId`: a client
 * from before sync-protocol v0.5. The server answers so that it reloads
 * (`426 CLIENT_OUTDATED`, or `resync(schema)` on the socket) instead of having
 * its queue refused as invalid (SPEC-002 E14). A `userId` that is present but
 * invalid is a plain `ProtocolError`.
 */
export class MissingUserIdError extends ProtocolError {
  override readonly name: string = 'MissingUserIdError';
}

/** Validate `value` with `schema`, or throw a `ProtocolError` that describes the first issue. */
export function decodeWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
  throw new ProtocolError(`Invalid ${what}${where}: ${issue?.message ?? 'unknown problem'}`);
}

/** Parse JSON text, or throw a `ProtocolError` without echoing the text. */
export function parseJson(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new ProtocolError(`Invalid ${what}: not valid JSON`);
  }
}
