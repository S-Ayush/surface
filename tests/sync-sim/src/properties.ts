/**
 * The two properties' checks (SPEC-002 AC-2, AC-3), shared by the fake hub's
 * suite (`pnpm test`, `pnpm sim`) and the real server's (`pnpm test:int`).
 */
import { Issue, Label, Team, WorkflowStatus } from '@surface/domain/model';
import { expect } from 'vitest';
import {
  isCommentServer,
  isIssueServer,
  isWorkflowServer,
  type WorkflowState,
  type CommentState,
  type IssueFixtures,
  type IssueRecord,
  type IssueState,
} from './server.js';
import type { Outcome, SimulateOptions } from './simulate.js';
import { ISSUE_TEAM, itemId } from './steps.js';
import type { Tab } from './world.js';

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

/**
 * Whether the server must refuse a create for its input alone (§4.2, §4.6, INV-06). A create that
 * reuses a stored id is refused too (CONFLICT at the insert), which `issueConvergence` checks per id.
 */
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
 * The issues as a tab of `userId` holds them: a row's groups cut to its connection's (SPEC-002
 * Q6). Since PLAN-011 S4b a public team's issue is also in `user:<creatorId>` and
 * `user:<assigneeId>` (SPEC-011 §5.7), and another user's `user:` group never reaches the tab.
 * The sim's sockets name no `teams`, so they follow every member team: its `team:` groups stay.
 */
function asSeenBy(
  issues: Readonly<Record<string, IssueState>>,
  userId: string,
): Record<string, IssueState> {
  const seen = (group: unknown) =>
    typeof group === 'string' && (!group.startsWith('user:') || group === `user:${userId}`);
  return Object.fromEntries(
    Object.entries(issues).map(([id, issue]) => [
      id,
      { ...issue, groups: Array.isArray(issue.groups) ? issue.groups.filter(seen) : issue.groups },
    ]),
  );
}

/**
 * Drafts (PLAN-012 S5, SPEC-012 §4.3, AC-3, E13): property 1 for the debug items; every tab shows
 * exactly its user's stored drafts and nobody else's (the `user:<id>` group, rule 4); every stored
 * draft is in its owner's group only; and one user holds at most one draft per key, however the
 * saves and discards of several tabs interleave.
 */
export const draftConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    convergence.check(outcome);
    const { world } = outcome;
    const server = world.server;
    if (!isIssueServer(server)) throw new Error('The draft property needs the real server.');
    const stored = await server.drafts();
    const keys = new Set<string>();
    for (const [id, draft] of Object.entries(stored)) {
      expect(draft.groups, id).toEqual([`user:${String(draft.userId)}`]);
      const key = `${String(draft.userId)} ${String(draft.kind)} ${String(draft.teamId ?? draft.issueId)}`;
      expect(keys.has(key), `two drafts for ${key}`).toBe(false);
      keys.add(key);
    }
    for (const tab of world.live) {
      const mine = Object.fromEntries(
        Object.entries(stored)
          .filter(([, draft]) => draft.userId === tab.user.id)
          .map(([id, { groups: _groups, ...shown }]) => [id, shown]),
      );
      expect(world.draftView(tab), tab.name).toEqual(mine);
    }
  },
};

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
    for (const tab of world.live) {
      expect(world.issueView(tab), tab.name).toEqual(asSeenBy(issues, tab.user.id));
    }
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
    // Creates by id: a create may reuse an earlier one's id (AC-2), so the creates of one id
    // commit at most once, and a create the inputs refuse never commits.
    const byId = new Map<string, typeof world.dispatched>();
    for (const d of world.dispatched.filter((x) => x.op === 'issue.create')) {
      const id: unknown =
        typeof d.input === 'object' && d.input !== null ? Reflect.get(d.input, 'id') : undefined;
      if (typeof id === 'string') byId.set(id, [...(byId.get(id) ?? []), d]);
    }
    for (const [id, creates] of byId) {
      for (const d of creates) {
        if (refusedCreate(d.input, fixtures) && d.outcome !== undefined) {
          expect(d.outcome.status, `${d.key} should have been refused`).toBe('rejected');
        }
      }
      const confirmed = creates.filter((d) => d.outcome?.status === 'confirmed');
      expect(confirmed.length, `${id} committed more than once`).toBeLessThanOrEqual(1);
      if (confirmed.length === 1) expect(issues[id], id).toBeDefined();
      const refusedAll = creates.every((d) => refusedCreate(d.input, fixtures));
      if (refusedAll || creates.every((d) => d.outcome?.status === 'rejected')) {
        expect(issues[id], `${id} should have been refused`).toBeUndefined();
      }
    }
  },
};

/**
 * The thread rules of SPEC-013 §4.3 and §4.5 on the stored comments: a reply's parent exists, is
 * a top-level comment of the same issue (INV-19, so no reply under a hard-deleted comment), and
 * only top-level comments are resolved, with both fields set together. A placeholder (deleted,
 * `EMPTY_DOC`) always has a reply left (no orphan placeholder).
 */
export function checkThreads(comments: Readonly<Record<string, CommentState>>): void {
  const replies = new Map<string, number>();
  for (const [id, c] of Object.entries(comments)) {
    if (typeof c.parentCommentId !== 'string') continue;
    const parent = comments[c.parentCommentId];
    expect(parent, `${id}: its parent is gone`).toBeDefined();
    expect(parent?.parentCommentId, `${id}: a reply to a reply`).toBeNull();
    expect(parent?.issueId, `${id}: a reply on another issue`).toBe(c.issueId);
    expect(c.resolvedAt, `${id}: a resolved reply`).toBeNull();
    replies.set(c.parentCommentId, (replies.get(c.parentCommentId) ?? 0) + 1);
  }
  for (const [id, c] of Object.entries(comments)) {
    expect(c.resolvedAt === null, `${id}: resolvedAt and resolvedById apart`).toBe(
      c.resolvedById === null,
    );
    if (c.deletedAt !== null) {
      expect(replies.get(id) ?? 0, `${id}: a placeholder without replies`).toBeGreaterThan(0);
      expect(c.body, id).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    }
  }
}

/**
 * Comment threads (SPEC-013 AC-5 for comments): the issue property, then every tab holds exactly
 * the server's comments, every field included, and the stored threads keep §4.3's rules. A
 * comment step's refusals (an edit of another's comment, a stale version, a reply to a reply or a
 * placeholder) are part of the run; a create the server refused never committed.
 */
export const commentConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    await issueConvergence.check(outcome);
    const { world } = outcome;
    const server = world.server;
    if (!isCommentServer(server)) throw new Error('The comment property needs the real server.');
    const comments = await server.comments();
    // A tab holds comments only for issues open in it (SPEC-011 §5.4): open every issue in every
    // tab, as a fresh look at each issue page would (PLAN-011 S5b).
    await world.showEverywhere(world.issueIds);
    for (const tab of world.live) {
      expect(world.commentView(tab), tab.name).toEqual(comments);
    }
    checkThreads(comments);
    for (const d of world.dispatched.filter((x) => x.op === 'comment.create')) {
      const id: unknown =
        typeof d.input === 'object' && d.input !== null ? Reflect.get(d.input, 'id') : undefined;
      if (d.outcome?.status === 'rejected' && typeof id === 'string') {
        expect(comments[id], `${d.key} was refused but committed`).toBeUndefined();
      }
    }
    expect(await server.reactionCount()).toBe(0);
  },
};

/** At most this many distinct emoji per comment and per issue (SPEC-013 D15). */
const EMOJI_CAP = 20;

/**
 * Reactions (SPEC-013 AC-5 and AC-22 for reactions; PLAN-013 S4): the issue property, then every
 * tab holds exactly the server's comments and reactions, and the stored reactions keep §4.2's
 * rules: each on a live comment of its own issue or on the issue itself (no reaction left on a
 * deleted or placeholder comment), unique per (subject, user, emoji) through the derived id, and
 * at most 20 distinct emoji per subject. Refusals (a placeholder's NOT_FOUND, the cap) are part of
 * the run.
 */
export const reactionConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    await issueConvergence.check(outcome);
    const { world } = outcome;
    const server = world.server;
    if (!isCommentServer(server)) throw new Error('The reaction property needs the real server.');
    const comments = await server.comments();
    const reactions = await server.reactions();
    // As `commentConvergence`: every issue open in every tab first (PLAN-011 S5b).
    await world.showEverywhere(world.issueIds);
    for (const tab of world.live) {
      expect(world.commentView(tab), tab.name).toEqual(comments);
      expect(world.reactionView(tab), tab.name).toEqual(reactions);
    }
    checkThreads(comments);
    const emojiBySubject = new Map<string, Set<unknown>>();
    const keys = new Set<string>();
    for (const [id, r] of Object.entries(reactions)) {
      const subject = typeof r.commentId === 'string' ? r.commentId : String(r.issueId);
      if (typeof r.commentId === 'string') {
        const comment = comments[r.commentId];
        expect(comment, `${id}: its comment is gone`).toBeDefined();
        expect(comment?.deletedAt, `${id}: on a placeholder`).toBeNull();
        expect(comment?.issueId, `${id}: on another issue's comment`).toBe(r.issueId);
      }
      const key = `${subject}:${String(r.userId)}:${String(r.emoji)}`;
      expect(keys.has(key), `${id}: a second ${key}`).toBe(false);
      keys.add(key);
      const set = emojiBySubject.get(subject) ?? new Set<unknown>();
      set.add(r.emoji);
      emojiBySubject.set(subject, set);
    }
    for (const [subject, set] of emojiBySubject) {
      expect(set.size, `${subject}: distinct emoji`).toBeLessThanOrEqual(EMOJI_CAP);
    }
  },
};

// ---------------------------------------------------------------------------------------------
// The workflow (PLAN-010 S5, SPEC-010 AC-19, E3, E16, E17).

/** What a tab shows of SIM's workflow: its default, its statuses and the labels it can use. */
interface WorkflowView {
  readonly defaultStatusId: unknown;
  readonly statuses: readonly string[];
  readonly labels: readonly string[];
}

function workflowOf(state: WorkflowState): WorkflowView {
  const team = state.teams.find((t) => t.key === ISSUE_TEAM);
  if (team === undefined) throw new Error(`No ${ISSUE_TEAM} team on the server.`);
  return {
    defaultStatusId: team.defaultStatusId,
    statuses: state.statuses
      .filter((s) => s.teamId === team.id)
      .map((s) => s.id)
      .sort(),
    labels: state.labels
      .filter((l) => l.teamId === null || l.teamId === team.id)
      .map((l) => l.id)
      .sort(),
  };
}

function workflowView(tab: Tab, teamId: string): WorkflowView {
  const pool = tab.store.pool;
  return {
    defaultStatusId: pool.get(Team, teamId)?.defaultStatusId,
    statuses: pool
      .all(WorkflowStatus)
      .filter((s) => s.teamId === teamId)
      .map((s) => s.id)
      .sort(),
    labels: pool
      .all(Label)
      .filter((l) => l.teamId === null || l.teamId === teamId)
      .map((l) => l.id)
      .sort(),
  };
}

/** Whether a replica's issues name only statuses and labels the same replica holds. */
function checkNoDanglingRefs(tab: Tab): void {
  const pool = tab.store.pool;
  const statuses = new Set(pool.all(WorkflowStatus).map((s) => s.id));
  const labels = new Set(pool.all(Label).map((l) => l.id));
  for (const issue of pool.all(Issue)) {
    expect(statuses.has(issue.statusId), `${tab.name} ${issue.id} status`).toBe(true);
    for (const id of issue.labelIds) {
      expect(labels.has(id), `${tab.name} ${issue.id} label ${id}`).toBe(true);
    }
  }
}

const REQUIRED_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];

/**
 * The stored workflow after a run: INV-04 (every team keeps a status of each editable category,
 * one Duplicate and one Triage, so of two concurrent deletes of a category's last two statuses
 * one is refused, E3), INV-05 (the default is a Backlog or Unstarted status of its team, E17),
 * and no issue names a status or label that is gone (AC-19, E16).
 */
export function checkWorkflow(
  state: WorkflowState,
  issues: Readonly<Record<string, IssueState>>,
): void {
  for (const team of state.teams) {
    const own = state.statuses.filter((s) => s.teamId === team.id);
    for (const category of REQUIRED_CATEGORIES) {
      expect(
        own.some((s) => s.category === category),
        `${team.key} has no ${category} status`,
      ).toBe(true);
    }
    expect(
      own.filter((s) => s.category === 'duplicate'),
      `${team.key} Duplicate`,
    ).toHaveLength(1);
    expect(
      own.filter((s) => s.category === 'triage'),
      `${team.key} Triage`,
    ).toHaveLength(1);
    const fallback = own.find((s) => s.id === team.defaultStatusId);
    expect(fallback, `${team.key} default status`).toBeDefined();
    expect(['backlog', 'unstarted'], `${team.key} default category`).toContain(fallback?.category);
  }
  const statuses = new Set(state.statuses.map((s) => s.id));
  const labels = new Set(state.labels.map((l) => l.id));
  for (const [id, issue] of Object.entries(issues)) {
    expect(statuses.has(String(issue.statusId)), `${id} names a deleted status`).toBe(true);
    const named = Array.isArray(issue.labelIds) ? issue.labelIds.map(String) : [];
    for (const label of named) expect(labels.has(label), `${id} names deleted ${label}`).toBe(true);
  }
}

/**
 * The workflow property: the issue property, the stored workflow's invariants (`checkWorkflow`),
 * no replica naming a status or label it doesn't hold, and every replica, streamed or freshly
 * bootstrapped, showing the server's SIM workflow.
 */
export const workflowConvergence: Property = {
  options: convergence.options,
  check: async (outcome) => {
    await issueConvergence.check(outcome);
    const { world } = outcome;
    const server = world.server;
    if (!isWorkflowServer(server)) throw new Error('The workflow property needs the real server.');
    const state = await server.workflow();
    checkWorkflow(state, await server.issues());
    const expected = workflowOf(state);
    const teamId = state.teams.find((t) => t.key === ISSUE_TEAM)?.id ?? '';
    const streamed = world.live;
    const fresh = world.users.map((user) => world.open(user, { fresh: true }));
    await world.quiesce();
    expect(world.problems).toEqual([]);
    for (const tab of [...streamed, ...fresh]) {
      expect(workflowView(tab, teamId), tab.name).toEqual(expected);
      checkNoDanglingRefs(tab);
    }
  },
};
