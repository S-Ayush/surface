/**
 * The seed fixture that operation examples run against (SPEC-003 §11 rule 2). Examples name
 * things the way people do ("ENG", "me", "ENG-1"), so the seed must hold what they name.
 *
 * Until PLAN-001 S1 adds users and teams there is nothing to seed: the fixture is an admin with
 * no rows. PLAN-001 adds the actor's user row, the ENG team and its workflow, and each later
 * plan adds what its examples name.
 */
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import type { TestDatabase } from './db.js';
import { actorFor } from './helpers.js';

export interface SeedFixture {
  /** Who runs the examples: an admin, so permission checks pass where the data allows. */
  readonly actor: Actor;
}

export function seedFixture(_db: TestDatabase): Promise<SeedFixture> {
  return Promise.resolve({ actor: actorFor({ id: randomUUID(), role: 'admin' }) });
}
