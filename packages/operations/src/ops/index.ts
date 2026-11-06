import type { AnyOperation } from '../define.js';
import { createRegistry } from '../registry.js';

/**
 * Every operation, listed explicitly (no filesystem globbing) so the client bundle can
 * tree-shake (PLAN-003 S1). Define each operation in `ops/<domain>/<verb>.ts`, export it from
 * `index.ts`, and add it here. PLAN-003 S4 adds `debug.echo` and `debug.touch`; PLAN-001 adds
 * the first product domains.
 */
export const ALL_OPERATIONS: readonly AnyOperation[] = [];

/** The registry the executor, the HTTP surfaces and the client dispatch read from. */
export const registry = createRegistry(ALL_OPERATIONS);
