/**
 * Operation errors (SPEC-003 §9): codes, their HTTP statuses, and the public error body.
 * Only `SurfaceError` messages reach callers; anything else becomes `INTERNAL`.
 */

export const ERROR_CODES = [
  'INVALID_INPUT',
  'UNKNOWN_OPERATION',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'RATE_LIMITED',
  'CLIENT_OUTDATED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly hint?: string;
}

/** One of several rows an ambiguous name matched. `label` is what a person would recognise. */
export interface ErrorCandidate {
  readonly id: string;
  readonly label: string;
}

export interface ErrorDetails {
  readonly issues?: readonly ErrorIssue[];
  readonly candidates?: readonly ErrorCandidate[];
  /** Seconds, for `RATE_LIMITED` (sent as `Retry-After`). */
  readonly retryAfter?: number;
}

/** SPEC-003 §9 "Error → HTTP status". */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNKNOWN_OPERATION: 404,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CLIENT_OUTDATED: 426,
  INTERNAL: 500,
};

/** The `error` member of a failed result: `{ ok: false, error }` (SPEC-003 §9). */
export interface OperationError extends ErrorDetails {
  readonly code: ErrorCode;
  readonly operation?: string;
  readonly message: string;
  readonly correlationId: string;
}

/** Never shows internals: the details go to the log under the same correlation id (E4). */
export const INTERNAL_MESSAGE = 'Something went wrong. The error has been logged.';

/** An expected failure with a public message. Anything else thrown becomes `INTERNAL`. */
export class SurfaceError extends Error {
  override readonly name = 'SurfaceError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
  }
}
