import { OperationDefinitionError, type AnyOperation } from './define.js';

/** Read-only lookup of operations by name (ADR-0011). */
export interface OperationRegistry {
  get(name: string): AnyOperation | undefined;
  has(name: string): boolean;
  /** Every operation, in declaration order, including internal ones. */
  list(): readonly AnyOperation[];
  readonly size: number;
}

/** Builds a registry from an explicit list. Names must be unique (SPEC-003 §3.1). */
export function createRegistry(operations: Iterable<AnyOperation>): OperationRegistry {
  const byName = new Map<string, AnyOperation>();
  for (const op of operations) {
    if (byName.has(op.name)) {
      throw new OperationDefinitionError(op.name, [
        'name is already registered. Operation names must be unique',
      ]);
    }
    byName.set(op.name, op);
  }
  const all = Object.freeze([...byName.values()]);
  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    list: () => all,
    size: all.length,
  };
}
