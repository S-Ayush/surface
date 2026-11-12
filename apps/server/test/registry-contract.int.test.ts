// SPEC-003 §11 rule 2, second half: every public operation's examples run, through the real
// executor and handlers, against the seed fixture. Internal operations are exempt (PLAN-003
// S7): their examples need test-only fixtures. So are `systemOnly` ones (SPEC-003 §11): only the
// system actor may run them.
import type { Actor } from '@surface/domain';
import {
  debugEcho,
  debugTouch,
  isPublicOperation,
  registry,
  type AnyOperation,
} from '@surface/operations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAttemptStore } from '../src/auth/attempts.js';
import { createExecutor, type Executor } from '../src/executor/execute.js';
import { HANDLERS } from '../src/handlers/index.js';
import { createTestDatabase, silentLog, type TestDatabase } from './db.js';
import { seedFixture } from './seed.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

function executor(allowInternal: boolean): Executor {
  return createExecutor({
    pool: db.pool,
    registry,
    handlers: HANDLERS,
    log: silentLog,
    allowInternal,
    // For the links handlers issue (`ctx.links`, e.g. `user.createResetLink`).
    publicUrl: 'https://surface.example.com',
    // The sign-in lockout `user.changePassword` checks the current password against (AC-6).
    attempts: pgAttemptStore(db.pool),
  });
}

/** One line per example that did not succeed. */
async function exampleFailures(
  run: Executor,
  operations: readonly AnyOperation[],
  actor: Actor,
): Promise<string[]> {
  const failures: string[] = [];
  for (const op of operations) {
    for (const [i, example] of op.examples.entries()) {
      const result = await run.execute(op.name, example, actor);
      if (!result.ok) {
        failures.push(`${op.name} examples[${i}]: ${result.error.code}: ${result.error.message}`);
      }
    }
  }
  return failures;
}

describe('operation examples (contract)', () => {
  it('run for every public operation against the seed fixture', async () => {
    const { actor } = await seedFixture(db);
    const publicOps = registry.list().filter(isPublicOperation);
    expect(await exampleFailures(executor(false), publicOps, actor)).toEqual([]);
  });

  it('are reported when they fail, which is why internal operations are exempt', async () => {
    const { actor } = await seedFixture(db);
    // debug.touch's example names a debug item only its own tests create.
    expect(await exampleFailures(executor(true), [debugEcho, debugTouch], actor)).toEqual([
      expect.stringMatching(/^debug\.touch examples\[0\]: NOT_FOUND: /),
    ]);
  });
});
