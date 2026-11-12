// Internal to the decoders: not re-exported from the package (index.ts).
import { MissingUserIdError } from './errors.js';

/**
 * Throw `MissingUserIdError` when `value` is an object with no `userId`.
 * Checked before the schema, so a missing `userId` wins over any other problem:
 * an old client always learns it is outdated.
 */
export function requireUserId(value: unknown, what: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  if ('userId' in value && value.userId !== undefined) return;
  throw new MissingUserIdError(`Invalid ${what}: userId is missing. Reload the app to update it.`);
}
