/**
 * Simulation cases (PLAN-002 S9): a random start (users, lock mode, fixture
 * items) and a random sequence of steps. A step names a tab or user by index;
 * the index wraps around the tabs alive at that moment, so every generated
 * sequence is valid and shrinking keeps it valid.
 */
import fc from 'fast-check';
import { debugCreate, debugDelete, debugRename, debugTouch } from '@surface/operations';
import type { Faults } from './network.js';
import type { World } from './world.js';

export type Step =
  | { readonly t: 'create'; readonly tab: number; readonly item: number; readonly title: string }
  | { readonly t: 'rename'; readonly tab: number; readonly item: number; readonly title: string }
  | { readonly t: 'touch'; readonly tab: number; readonly item: number }
  | { readonly t: 'delete'; readonly tab: number; readonly item: number }
  | { readonly t: 'wait'; readonly ms: number }
  | { readonly t: 'faults'; readonly faults: Faults }
  | { readonly t: 'disconnect'; readonly tab: number }
  | { readonly t: 'offline'; readonly tab: number; readonly ms: number }
  | { readonly t: 'restart'; readonly downMs: number }
  | { readonly t: 'crash'; readonly tab: number }
  | { readonly t: 'crashMidway'; readonly tab: number; readonly calls: number }
  | { readonly t: 'reload'; readonly tab: number }
  | { readonly t: 'open'; readonly user: number };

export interface Case {
  readonly seed: number;
  readonly users: number;
  readonly webLocks: boolean;
  readonly steps: readonly Step[];
}

/** Item ids: a small fixed pool, so tabs collide on the same rows. */
export const ITEM_POOL = 6;
export function itemId(n: number): string {
  return `00000000-0000-7000-8000-${(n + 1).toString(16).padStart(12, '0')}`;
}

/** At most this many tabs are open at once (SPEC-002 AC-2: 3–6 clients). */
export const MAX_TABS = 6;

/**
 * A tab or user index, wrapped around the live tabs (3–6) or users (3–4).
 * 720 values is a multiple of every count up to 6, so none is favoured.
 */
const index = fc.nat(719);
const tab = index;
const item = fc.nat(ITEM_POOL - 1);
const title = fc.constantFrom('Alpha', 'Beta', 'Gamma', 'Delta', 'Épsilon', '日本');

const faults: fc.Arbitrary<Faults> = fc.record({
  dropRequest: fc.constantFrom(0, 0.1, 0.3),
  dropResponse: fc.constantFrom(0, 0.1, 0.3),
  hangResponse: fc.constantFrom(0, 0, 0.05, 0.2),
  maxDelayMs: fc.constantFrom(5, 50, 500, 3_000),
});

const faultSteps: fc.Arbitrary<Step>[] = [
  fc.record({ t: fc.constant('wait'), ms: fc.integer({ min: 0, max: 5_000 }) }),
  fc.record({ t: fc.constant('faults'), faults }),
  fc.record({ t: fc.constant('disconnect'), tab }),
  fc.record({ t: fc.constant('offline'), tab, ms: fc.integer({ min: 100, max: 60_000 }) }),
  fc.record({ t: fc.constant('restart'), downMs: fc.integer({ min: 0, max: 20_000 }) }),
  fc.record({ t: fc.constant('crash'), tab }),
  // A crash inside one event: between its IndexedDB transactions, or before
  // a mutation is saved.
  fc.record({ t: fc.constant('crashMidway'), tab, calls: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ t: fc.constant('reload'), tab }),
  fc.record({ t: fc.constant('open'), user: index }),
];

/** Property 1 (AC-2): every kind of change, on colliding rows, with every fault. */
export function convergenceCase(): fc.Arbitrary<Case> {
  const change = (arbitrary: fc.Arbitrary<Step>) => ({ weight: 4, arbitrary });
  const step = fc.oneof(
    change(fc.record({ t: fc.constant('create'), tab, item, title })),
    change(fc.record({ t: fc.constant('rename'), tab, item, title })),
    change(fc.record({ t: fc.constant('touch'), tab, item })),
    change(fc.record({ t: fc.constant('delete'), tab, item })),
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
  );
  return caseOf(step);
}

/** Property 2 (AC-3): only `debug.touch` on the user's own item, with every fault. */
export function exactlyOnceCase(): fc.Arbitrary<Case> {
  const step = fc.oneof(
    { weight: 8, arbitrary: fc.record({ t: fc.constant('touch'), tab, item }) },
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
  );
  return caseOf(step);
}

function caseOf(step: fc.Arbitrary<Step>): fc.Arbitrary<Case> {
  return fc.record({
    seed: fc.integer(),
    users: fc.integer({ min: 3, max: 4 }),
    webLocks: fc.boolean(),
    // `size: 'medium'`: long enough for faults to pile up (fast-check's
    // default size makes most sequences a handful of steps).
    steps: fc.array(step, { minLength: 1, maxLength: 80, size: 'medium' }),
  });
}

/** The index wraps around the tabs alive now; undefined when none is. */
function pick<T>(list: readonly T[], index: number): T | undefined {
  return list.length === 0 ? undefined : list[index % list.length];
}

export interface RunOptions {
  /**
   * Item a tab may touch, given the item index and the tab's user index.
   * Property 2 maps every touch to the user's own item.
   */
  readonly itemFor?: (item: number, user: number) => number;
}

/** Run one step against `world`. */
export async function apply(world: World, step: Step, options: RunOptions = {}): Promise<void> {
  const userIndex = (t: { user: { id: string } }) => world.users.findIndex((u) => u === t.user);
  const live = world.live;
  switch (step.t) {
    case 'create':
    case 'rename':
    case 'touch':
    case 'delete': {
      const target = pick(live, step.tab);
      if (target === undefined) return;
      const n = options.itemFor ? options.itemFor(step.item, userIndex(target)) : step.item;
      const id = itemId(n);
      if (step.t === 'create') world.dispatch(target, debugCreate, { id, title: step.title });
      else if (step.t === 'rename') world.dispatch(target, debugRename, { id, title: step.title });
      else if (step.t === 'touch') world.dispatch(target, debugTouch, { id });
      else world.dispatch(target, debugDelete, { id });
      return;
    }
    case 'wait':
      await world.run(step.ms);
      return;
    case 'faults':
      world.network.faults = step.faults;
      return;
    case 'disconnect':
      pick(live, step.tab)?.link.disconnect();
      return;
    case 'offline': {
      const target = pick(live, step.tab);
      if (target === undefined) return;
      target.link.setOnline(false);
      setTimeout(() => target.link.setOnline(true), step.ms);
      return;
    }
    case 'restart':
      world.network.serverDown();
      setTimeout(() => world.network.serverUpAgain(), step.downMs);
      return;
    case 'crash':
    case 'reload': {
      const target = pick(live, step.tab);
      if (target === undefined) return;
      if (step.t === 'crash') world.crash(target);
      else world.reload(target);
      return;
    }
    case 'crashMidway': {
      const target = pick(live, step.tab);
      if (target !== undefined) world.crashAfterStorageCalls(target, step.calls);
      return;
    }
    case 'open': {
      const user = pick(world.users, step.user);
      if (user !== undefined && live.length < MAX_TABS) world.open(user);
      return;
    }
  }
}

/** Every user has at least one tab open, so their queues end up sent (E5). */
export function reopenClosedUsers(world: World): void {
  for (const user of world.users) {
    if (!world.live.some((t) => t.user === user)) world.open(user);
  }
}
