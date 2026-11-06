/**
 * Errors as the executor logs them (CLAUDE.md rule 6). Drizzle's query errors carry the bound
 * parameters in `params`, `message` and `stack`, and parameters can be secrets (token hashes,
 * password hashes) or personal data. Log the SQL text and Postgres's own error fields instead.
 * Postgres `detail` is dropped too: for constraint violations it quotes the offending values.
 * Errors from database drivers other than Postgres are not expected here.
 */

export function loggableError(error: unknown): unknown {
  if (!isObject(error)) return error;

  if (typeof error.query === 'string' && 'params' in error) {
    return { type: 'DrizzleQueryError', query: error.query, cause: loggableError(error.cause) };
  }
  if (typeof error.code === 'string' && typeof error.severity === 'string') {
    // pg DatabaseError. Data exceptions (SQLSTATE class 22) quote the offending value in the
    // message and stack (`invalid input syntax for type uuid: "…"`), so keep only their code.
    const fields = error.code.startsWith('22')
      ? ['code', 'severity', 'routine']
      : ['message', 'code', 'severity', 'constraint', 'table', 'column', 'routine', 'stack'];
    return pick(error, fields, 'DatabaseError');
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
