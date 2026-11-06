/**
 * Operation errors (SPEC-003 §9). PLAN-003 S2 adds the class and the codes the resolvers need;
 * S4 adds the HTTP status mapping and correlation ids.
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
}

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
