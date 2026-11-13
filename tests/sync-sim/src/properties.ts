/**
 * The two properties' checks (SPEC-002 AC-2, AC-3), shared by the fake hub's
 * suite (`pnpm test`, `pnpm sim`) and the real server's (`pnpm test:int`).
 */
import { expect } from 'vitest';
import { isIssueServer, type IssueFixtures, type IssueRecord } from './server.js';
import type { Outcome, SimulateOptions } from './simulate.js';
import { itemId } from './steps.js';

export interface Property {
  readonly options: SimulateOptions;
  readonly check: (outcome: Outcome) => void | Promise<void>;
}

/** Property 1: each tab shows exactly the server's rows, with nothing pending. */
export const convergence = {
  options: { seedItems: () => [0, 1, 2] },
  check: ({ world, server }: Outcome): void => {
    expect(world.problems).toEqual([]);
    for (const tab of world.live) {
      expect(tab.store.pending, tab.name).toEqual([]);
      expect(world.view(tab), tab.name).toEqual(server.items);
    }
  },
} satisfies Property;

/**
 * Archive interleavings (SPEC-011 AC-18): property 1, then every user opens one more tab on an
 * empty replica, which bootstraps; every tab, the ones that applied the stream of `A`, `V`, `U`
 * and `D` packets and the ones that warm-started from it, equals that fresh bootstrap,
 * `archivedAt` and `$archived` included, and the two agree on every row.
 */
export const archiveConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    convergence.check(outcome);
    const { world } = outcome;
    const streamed = world.live;
    const fresh = world.users.map((user) => world.open(user, { fresh: true }));
    await world.quiesce();
    expect(world.problems).toEqual([]);
    for (const tab of fresh) {
      const bootstrapped = world.view(tab);
      expect(bootstrapped, tab.name).toEqual(outcome.server.items);
      for (const [id, item] of Object.entries(bootstrapped)) {
        expect(item.archived, `${tab.name} ${id}`).toBe(item.archivedAt !== null);
      }
      for (const other of streamed) expect(world.view(other), other.name).toEqual(bootstrapped);
    }
  },
};

/** Property 2: every saved touch is applied exactly once, and none is rejected. */
export const exactlyOnce: Property = {
  options: {
    seedItems: (users) => Array.from({ length: users }, (_, n) => n),
    itemFor: (_item, user) => user,
  },
  check: ({ world, server }) => {
    expect(world.problems).toEqual([]);
    const dispatched = new Set(world.dispatched.map((d) => d.key));
    const saved = [...world.saved].filter(([, { op }]) => op === 'debug.touch');
    // Only dispatches are saved, and a tab that never crashed loses none.
    for (const [key] of saved) expect(dispatched, key).toContain(key);
    const kept = new Set(saved.map(([key]) => key));
    const survivors = new Set(world.live.map((tab) => tab.name));
    for (const d of world.dispatched) {
      if (survivors.has(d.tab)) expect(kept, `${d.tab} ${d.key}`).toContain(d.key);
    }
    world.users.forEach((user, n) => {
      const id = itemId(n);
      const touches = saved.filter(
        ([, { input }]) =>
          typeof input === 'object' && input !== null && Reflect.get(input, 'id') === id,
      );
      expect(server.items[id]?.counter, user.name).toBe(touches.length);
    });
    const rejected = world.dispatched.filter((d) => d.outcome?.status === 'rejected');
    expect(rejected).toEqual([]);
    for (const tab of world.live) expect(world.view(tab), tab.name).toEqual(server.items);
  },
};

/** Commit order of one team's issues: each number one more than the last, from 1 (E1, E3). */
export function checkNumbering(rows: readonly IssueRecord[]): void {
  const teams = new Map<string, IssueRecord[]>();
  for (const row of rows) teams.set(row.teamId, [...(teams.get(row.teamId) ?? []), row]);
  for (const [team, issues] of teams) {
    expect(
      issues.every((i) => i.insertedAt !== null),
      team,
    ).toBe(true);
    const inCommitOrder = [...issues].sort((a, b) => (a.insertedAt ?? 0) - (b.insertedAt ?? 0));
    // Gap-free in commit order: a refused create takes no number (E1).
    expect(
      inCommitOrder.map((i) => i.number),
      team,
    ).toEqual(inCommitOrder.map((_, n) => n + 1));
    // Each new issue goes first: its key is below every earlier one, so no two are equal and the
    // key was read after the counter's lock (SPEC-011 §4.5, E3).
    inCommitOrder.forEach((issue, n) => {
      const earlier = inCommitOrder[n - 1];
      if (earlier !== undefined) expect(issue.sortOrder < earlier.sortOrder, issue.id).toBe(true);
    });
  }
}

/** Whether the server must refuse a create with this input (§4.2, §4.6, INV-06). */
function refusedCreate(input: unknown, fixtures: IssueFixtures): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const status: unknown = Reflect.get(input, 'status');
  const labels: unknown = Reflect.get(input, 'labels');
  return (
    status === 'Triage' ||
    status === fixtures.otherTeamStatusId ||
    (Array.isArray(labels) && labels.some((l) => l === 'Size' || l === 'Nope'))
  );
}

/**
 * Issue numbering and labels (SPEC-011 AC-2, AC-4, E1, E3, E5–E7): property 1 for the debug
 * items; every tab shows exactly the server's issues, numbers and sort keys included; numbers are
 * gap-free in commit order with distinct keys; no issue holds two labels of the exclusive group,
 * a group, or a label twice; and a create the server must refuse never committed, while every
 * confirmed one did.
 */
export const issueConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    convergence.check(outcome);
    const { world } = outcome;
    const server = world.server;
    if (!isIssueServer(server) || server.issueFixtures === undefined) {
      throw new Error('The issue property needs a server with issue fixtures.');
    }
    const fixtures = server.issueFixtures;
    const issues = await server.issues();
    for (const tab of world.live) expect(world.issueView(tab), tab.name).toEqual(issues);
    const rows = await server.issueRows();
    checkNumbering(rows);
    const small = fixtures.labels['Size/Small'] ?? '';
    const large = fixtures.labels['Size/Large'] ?? '';
    const group = fixtures.labels['Size'] ?? '';
    const known = new Set(Object.values(fixtures.labels));
    for (const row of rows) {
      const has = (id: string) => row.labelIds.includes(id);
      expect(has(small) && has(large), `${row.id} has both Size labels`).toBe(false);
      expect(has(group), `${row.id} has the group`).toBe(false);
      expect(
        row.labelIds.every((id) => known.has(id)),
        row.id,
      ).toBe(true);
      expect(new Set(row.labelIds).size, row.id).toBe(row.labelIds.length);
    }
    for (const d of world.dispatched.filter((x) => x.op === 'issue.create')) {
      const id: unknown =
        typeof d.input === 'object' && d.input !== null ? Reflect.get(d.input, 'id') : undefined;
      if (typeof id !== 'string') continue;
      if (refusedCreate(d.input, fixtures)) {
        expect(issues[id], `${d.key} should have been refused`).toBeUndefined();
        if (d.outcome !== undefined) expect(d.outcome.status, d.key).toBe('rejected');
      } else if (d.outcome?.status === 'confirmed') {
        expect(issues[id], d.key).toBeDefined();
      }
    }
  },
};
