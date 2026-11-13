/**
 * Simulation cases (PLAN-002 S9): a random start (users, lock mode, fixture
 * items) and a random sequence of steps. A step names a tab or user by index;
 * the index wraps around the tabs alive at that moment, so every generated
 * sequence is valid and shrinking keeps it valid.
 */
import fc from 'fast-check';
import {
  debugArchive,
  debugCreate,
  debugDelete,
  debugRename,
  debugTouch,
  debugUnarchive,
  draftDiscard,
  draftSave,
  issueCreate,
  issueUpdate,
} from '@surface/operations';
import { Issue } from '@surface/domain/model';
import type { Faults } from './network.js';
import type { Random } from './random.js';
import { isIssueServer, type IssueFixtures } from './server.js';
import type { Tab, World } from './world.js';

/**
 * A label as an issue step names it (PLAN-011 S4): by name, as `Group/Label`, or by id (`#id`).
 * `Size` is a group and `Nope` doesn't exist, so the server refuses both.
 */
export const LABEL_PICKS = [
  'Flaky',
  'Frontend',
  'Size/Small',
  'Size/Large',
  'Size/Large#id',
  'Size',
  'Nope',
] as const;
export type LabelPick = (typeof LABEL_PICKS)[number];

/**
 * A status as an issue step names it: the team's default, a name, Triage (refused in M1), or a
 * status of another team (unknown in this team), or `keep` (an update that leaves it).
 */
export const STATUS_PICKS = ['default', 'Todo', 'In Progress', 'Done', 'Triage', 'other'] as const;
export type StatusPick = (typeof STATUS_PICKS)[number];

/** The team the issue steps create in: the one first-run setup made (`@surface/server/testing`). */
export const ISSUE_TEAM = 'SIM';

export type Step =
  | { readonly t: 'create'; readonly tab: number; readonly item: number; readonly title: string }
  | { readonly t: 'rename'; readonly tab: number; readonly item: number; readonly title: string }
  | { readonly t: 'touch'; readonly tab: number; readonly item: number }
  /** Many touches from one tab at once: past the rate limit, mid-batch (sync-protocol §4.4). */
  | { readonly t: 'burst'; readonly tab: number; readonly item: number; readonly count: number }
  | { readonly t: 'delete'; readonly tab: number; readonly item: number }
  /** `debug.archive` and `debug.unarchive` (PLAN-011 S2, SPEC-011 §5.5). */
  | { readonly t: 'archive'; readonly tab: number; readonly item: number }
  | { readonly t: 'unarchive'; readonly tab: number; readonly item: number }
  /**
   * `issue.create` in SIM; refused for Triage, another team's status, a group or `Nope`. With
   * `reuse`, it takes the id of an earlier create (wrapped around them): refused with CONFLICT at
   * the insert, after the counter was taken, when that id is already stored (AC-2, E1).
   */
  | {
      readonly t: 'issueCreate';
      readonly tab: number;
      readonly title: string;
      readonly status: StatusPick;
      readonly labels: readonly LabelPick[];
      readonly reuse?: number | undefined;
    }
  /** `issue.update` of an issue an earlier step created (wrapped around them). */
  | {
      readonly t: 'issueUpdate';
      readonly tab: number;
      readonly issue: number;
      readonly status: StatusPick | 'keep';
      readonly addLabels: readonly LabelPick[];
      readonly removeLabels: readonly LabelPick[];
    }
  /**
   * `draft.save` and `draft.discard` (PLAN-012 S5) of one of a few keys, from any tab: tabs of
   * one user race on the same draft (E13), and each user's drafts reach only that user's tabs.
   */
  | { readonly t: 'draftSave'; readonly tab: number; readonly key: number; readonly title: string }
  | { readonly t: 'draftDiscard'; readonly tab: number; readonly key: number }
  | { readonly t: 'wait'; readonly ms: number }
  | { readonly t: 'faults'; readonly faults: Faults }
  | { readonly t: 'disconnect'; readonly tab: number }
  | { readonly t: 'offline'; readonly tab: number; readonly ms: number }
  | { readonly t: 'restart'; readonly downMs: number }
  | { readonly t: 'compact' }
  | { readonly t: 'crash'; readonly tab: number }
  | { readonly t: 'crashMidway'; readonly tab: number; readonly calls: number }
  | { readonly t: 'reload'; readonly tab: number }
  | { readonly t: 'open'; readonly user: number };

export interface Case {
  readonly seed: number;
  readonly users: number;
  /**
   * Users with no tab at the start: the first `open` for one of them starts
   * cold, bootstrapping under whatever faults are on by then.
   */
  readonly lateUsers: number;
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
  // Tabs behind the head re-bootstrap when they next connect (E8).
  fc.record({ t: fc.constant('compact') }),
  fc.record({ t: fc.constant('crash'), tab }),
  // A crash inside one event: between its IndexedDB transactions, or before
  // a mutation is saved.
  fc.record({ t: fc.constant('crashMidway'), tab, calls: fc.integer({ min: 1, max: 6 }) }),
  fc.record({ t: fc.constant('reload'), tab }),
  fc.record({ t: fc.constant('open'), user: index }),
];

/**
 * A burst runs one tab past the server's 120 mutations a minute, so a batch
 * is cut short by a 429 and the rest is resent after the client's own
 * backoff (it does not read `Retry-After`). Only the real server limits; the
 * fake hub's cases leave it out.
 */
const burst: fc.Arbitrary<Step> = fc.record({
  t: fc.constant('burst'),
  tab,
  item,
  count: fc.integer({ min: 121, max: 160 }),
});

export interface CaseOptions {
  /** Include `burst` steps (the real server's rate limit). */
  readonly bursts?: boolean;
}

/** Property 1 (AC-2): every kind of change, on colliding rows, with every fault. */
export function convergenceCase(options: CaseOptions = {}): fc.Arbitrary<Case> {
  const change = (arbitrary: fc.Arbitrary<Step>) => ({ weight: 4, arbitrary });
  const step = fc.oneof(
    change(fc.record({ t: fc.constant('create'), tab, item, title })),
    change(fc.record({ t: fc.constant('rename'), tab, item, title })),
    change(fc.record({ t: fc.constant('touch'), tab, item })),
    change(fc.record({ t: fc.constant('delete'), tab, item })),
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
    ...(options.bursts ? [{ weight: 1, arbitrary: burst }] : []),
  );
  return caseOf(step);
}

/**
 * Archive interleavings (SPEC-011 AC-18, sync-protocol §10 item 8): archive, unarchive, edits
 * and deletes on colliding rows, in any order, with every fault (socket drops included).
 */
export function archiveCase(options: CaseOptions = {}): fc.Arbitrary<Case> {
  const change = (arbitrary: fc.Arbitrary<Step>) => ({ weight: 4, arbitrary });
  const step = fc.oneof(
    change(fc.record({ t: fc.constant('archive'), tab, item })),
    change(fc.record({ t: fc.constant('unarchive'), tab, item })),
    change(fc.record({ t: fc.constant('create'), tab, item, title })),
    change(fc.record({ t: fc.constant('rename'), tab, item, title })),
    change(fc.record({ t: fc.constant('touch'), tab, item })),
    change(fc.record({ t: fc.constant('delete'), tab, item })),
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
    ...(options.bursts ? [{ weight: 1, arbitrary: burst }] : []),
  );
  return caseOf(step);
}

/** Property 2 (AC-3): only `debug.touch` on the user's own item, with every fault. */
export function exactlyOnceCase(options: CaseOptions = {}): fc.Arbitrary<Case> {
  const step = fc.oneof(
    { weight: 8, arbitrary: fc.record({ t: fc.constant('touch'), tab, item }) },
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
    ...(options.bursts ? [{ weight: 1, arbitrary: burst }] : []),
  );
  return caseOf(step);
}

/**
 * Mostly the exclusive group's labels, so adds that replace a label (E5–E7) are common; refused
 * picks (a group, an unknown label) are rare, so most creates commit.
 */
const labelPick: fc.Arbitrary<LabelPick> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('Size/Small', 'Size/Large', 'Size/Large#id') },
  { weight: 2, arbitrary: fc.constantFrom('Flaky', 'Frontend') },
  { weight: 1, arbitrary: fc.constantFrom('Size', 'Nope') },
);
const labelPicks = fc.array(labelPick, { maxLength: 2 });

/**
 * Issue numbering and labels (SPEC-011 AC-2, AC-4, E1, E3, E5–E7): creates (some refused) and
 * label edits from every tab, with every fault. Without compaction: the numbering check reads the
 * commit order from `sync_log`. Only the real server syncs issues.
 */
export function issueCase(options: CaseOptions = {}): fc.Arbitrary<Case> {
  const issueStep = (arbitrary: fc.Arbitrary<Step>) => ({ weight: 12, arbitrary });
  const step = fc.oneof(
    issueStep(
      fc.record({
        t: fc.constant('issueCreate'),
        tab,
        title,
        status: fc.constantFrom('default', 'default', ...STATUS_PICKS),
        labels: labelPicks,
        reuse: fc.option(index, { nil: undefined, freq: 6 }),
      }),
    ),
    issueStep(
      fc.record({
        t: fc.constant('issueUpdate'),
        tab,
        issue: index,
        status: fc.constantFrom('keep', 'keep', 'keep', ...STATUS_PICKS),
        addLabels: labelPicks,
        removeLabels: labelPicks,
      }),
    ),
    { weight: 1, arbitrary: fc.record({ t: fc.constant('rename'), tab, item, title }) },
    ...faultSteps.map((arbitrary) => ({
      weight: 1,
      arbitrary: arbitrary.map((s): Step => (s.t === 'compact' ? { t: 'wait', ms: 0 } : s)),
    })),
    ...(options.bursts ? [{ weight: 1, arbitrary: burst }] : []),
  );
  return caseOf(step);
}

/**
 * The draft keys the steps use: two composer teams and two comment issues. Opaque ids (the
 * server resolves none, SPEC-012 D23), so they need no rows.
 */
export const DRAFT_KEYS = [
  { kind: 'composer', teamId: '01930000-0000-7000-8000-0000000d7a01' },
  { kind: 'composer', teamId: '01930000-0000-7000-8000-0000000d7a02' },
  { kind: 'comment', issueId: '01930000-0000-7000-8000-0000000d7a03' },
  { kind: 'comment', issueId: '01930000-0000-7000-8000-0000000d7a04' },
] as const;

/** Draft saves and discards from every tab, with every fault (PLAN-012 S5, SPEC-012 E13, E19). */
export function draftCase(): fc.Arbitrary<Case> {
  const key = fc.nat(DRAFT_KEYS.length - 1);
  const step = fc.oneof(
    { weight: 8, arbitrary: fc.record({ t: fc.constant('draftSave'), tab, key, title }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('draftDiscard'), tab, key }) },
    ...faultSteps.map((arbitrary) => ({ weight: 1, arbitrary })),
  );
  return caseOf(step);
}

/** A UUIDv7 from the case's randomness, as `issue.create` takes, so a case replays exactly. */
function uuidV7From(random: Random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = '7';
  hex[16] = (8 + Math.floor(random() * 4)).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function labelRef(pick: LabelPick, fixtures: IssueFixtures): string {
  if (pick.endsWith('#id')) return fixtures.labels[pick.slice(0, -3)] ?? pick;
  return pick;
}

function statusRef(pick: StatusPick, fixtures: IssueFixtures): string | undefined {
  if (pick === 'default') return undefined;
  if (pick === 'other') return fixtures.otherTeamStatusId;
  return pick;
}

function caseOf(step: fc.Arbitrary<Step>): fc.Arbitrary<Case> {
  return fc.record({
    // Not shrunk: a new seed reshuffles every fault, so a shrunk case would
    // no longer show the failure it came from.
    seed: fc.noShrink(fc.integer()),
    users: fc.integer({ min: 3, max: 4 }),
    lateUsers: fc.integer({ min: 0, max: 2 }),
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

/** The live tabs whose store has loaded, so a dispatch is queued rather than refused. */
function readyTabs(live: readonly Tab[]): Tab[] {
  return live.filter(({ store }) => store.status === 'ready');
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
    case 'delete':
    case 'archive':
    case 'unarchive': {
      const target = pick(live, step.tab);
      if (target === undefined) return;
      const n = options.itemFor ? options.itemFor(step.item, userIndex(target)) : step.item;
      const id = itemId(n);
      if (step.t === 'create') world.dispatch(target, debugCreate, { id, title: step.title });
      else if (step.t === 'rename') world.dispatch(target, debugRename, { id, title: step.title });
      else if (step.t === 'touch') world.dispatch(target, debugTouch, { id });
      else if (step.t === 'archive') world.dispatch(target, debugArchive, { id });
      else if (step.t === 'unarchive') world.dispatch(target, debugUnarchive, { id });
      else world.dispatch(target, debugDelete, { id });
      return;
    }
    case 'burst': {
      const target = pick(live, step.tab);
      if (target === undefined) return;
      const n = options.itemFor ? options.itemFor(step.item, userIndex(target)) : step.item;
      for (let i = 0; i < step.count; i += 1) {
        world.dispatch(target, debugTouch, { id: itemId(n) });
      }
      return;
    }
    case 'issueCreate': {
      // Only a loaded tab: a store still loading refuses the dispatch ("Changes cannot be saved
      // yet"), and a step that never reaches the server tests nothing.
      const target = pick(readyTabs(live), step.tab);
      const fixtures = isIssueServer(world.server) ? world.server.issueFixtures : undefined;
      if (target === undefined || fixtures === undefined) return;
      const fresh = uuidV7From(world.random);
      const reused = step.reuse === undefined ? undefined : pick(world.issueIds, step.reuse);
      const id = reused ?? fresh;
      const status = statusRef(step.status, fixtures);
      const labels = step.labels.map((l) => labelRef(l, fixtures));
      const input = {
        id,
        team: ISSUE_TEAM,
        title: step.title,
        ...(status === undefined ? {} : { status }),
        ...(labels.length === 0 ? {} : { labels }),
      };
      if (world.dispatch(target, issueCreate, input) && reused === undefined)
        world.issueIds.push(id);
      return;
    }
    case 'issueUpdate': {
      const target = pick(readyTabs(live), step.tab);
      // Mostly an issue the tab shows, as a user edits what is on screen; a refused create's id
      // only when the tab shows none (that update is refused with NOT_FOUND).
      const shown = world.issueIds.filter((id) => target?.store.pool.get(Issue, id) !== undefined);
      const issue = pick(shown.length > 0 ? shown : world.issueIds, step.issue);
      const fixtures = isIssueServer(world.server) ? world.server.issueFixtures : undefined;
      if (target === undefined || issue === undefined || fixtures === undefined) return;
      const status = step.status === 'keep' ? undefined : statusRef(step.status, fixtures);
      const add = step.addLabels.map((l) => labelRef(l, fixtures));
      const remove = step.removeLabels.map((l) => labelRef(l, fixtures));
      world.dispatch(target, issueUpdate, {
        issue,
        ...(status === undefined ? {} : { status }),
        ...(add.length === 0 ? {} : { addLabels: add }),
        ...(remove.length === 0 ? {} : { removeLabels: remove }),
      });
      return;
    }
    case 'draftSave':
    case 'draftDiscard': {
      const target = pick(readyTabs(live), step.tab);
      const key = DRAFT_KEYS[step.key % DRAFT_KEYS.length];
      if (target === undefined || key === undefined) return;
      if (step.t === 'draftDiscard') {
        world.dispatch(target, draftDiscard, { ...key });
        return;
      }
      const data =
        key.kind === 'composer'
          ? {
              title: step.title,
              description: null,
              statusId: null,
              priority: 0,
              assigneeId: null,
              labelIds: [],
              estimate: null,
              dueDate: null,
            }
          : {
              text: {
                type: 'doc' as const,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: step.title }] }],
              },
            };
      world.dispatch(target, draftSave, { id: uuidV7From(world.random), ...key, data });
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
    case 'compact':
      world.server.compactLog();
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
