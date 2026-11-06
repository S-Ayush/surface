/**
 * A startup problem the operator must fix (database unreachable, wrong
 * credentials, Postgres too old, missing extension, schema newer than the code).
 * The message says what is wrong and what to do; `serve()` logs it and exits 1.
 */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StartupError';
  }
}
