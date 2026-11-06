import type { AnyOperation } from '../define.js';
import { createRegistry } from '../registry.js';
import {
  debugCreate,
  debugDelete,
  debugEcho,
  debugListItems,
  debugRename,
  debugTouch,
} from './debug.js';

export * from './debug.js';

/**
 * Every operation, listed explicitly (no filesystem globbing) so the client bundle can
 * tree-shake (PLAN-003 S1). Define each operation in `ops/<domain>.ts` (or a folder per
 * domain once it grows), export it from this file, and add it here.
 */
export const ALL_OPERATIONS: readonly AnyOperation[] = [
  debugEcho,
  debugTouch,
  debugListItems,
  debugCreate,
  debugRename,
  debugDelete,
];

/** The registry the executor, the HTTP surfaces and the client dispatch read from. */
export const registry = createRegistry(ALL_OPERATIONS);
