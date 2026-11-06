/**
 * Errors as the executor logs them (CLAUDE.md rule 6). Drizzle's query errors carry the bound
 * parameters in `params`, `message` and `stack`, and parameters can be secrets (token hashes,
 * password hashes) or personal data. Log the SQL text and Postgres's own error fields instead.
 * Postgres `detail` is dropped too: for constraint violations it quotes the offending values.
 */

export function loggableError(error: unknown): unknown {
  if (!isObject(error)) return error;

  if (typeof error.query === 'string' && 'params' in error) {
    return { type: 'DrizzleQueryError', query: error.query, cause: loggableError(error.cause) };
  }
  if (typeof error.code === 'string' && typeof error.severity === 'string') {
    // pg DatabaseError: its message and stack never include parameters.
    return pick(
      error,
      ['message', 'code', 'severity', 'constraint', 'table', 'column', 'routine', 'stack'],
      'DatabaseError',
    );
  }
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause !== undefined ? { cause: loggableError(error.cause) } : {}),
    };
  }
  return error;
}

function pick(source: Record<string, unknown>, keys: readonly string[], type: string) {
  const out: Record<string, unknown> = { type };
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
