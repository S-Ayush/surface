/**
 * SPEC-011 AC-14, §10 (PLAN-011 S8): the size of the Issue row and the worst-case eager replica.
 *
 * - Rows are generated over the §10 seed distribution, from every field of the `Issue` model (a
 *   new field fails the test until the generator gives it a realistic value), and serialised as
 *   compact JSON, the form a row is stored and sent in.
 * - **The row budget** (650 bytes on average) is measured as §10 measured its rows: without
 *   `groups`. §10's full and sparse rows (708 and 517 bytes) are what the model gives without it;
 *   with it they are 55 bytes or more larger, because a row carries its groups cut to the
 *   connection's (SPEC-002 Q8): `team:<id>`, and `user:<id>` of the viewer when they created or are
 *   assigned the issue. The stored row, groups included, is what the replica total counts. The
 *   user decided this reading of AC-14 on 2026-11-24 (SPEC-011 D19). Stored rows average
 *   ≈ 685 bytes, for information.
 * - **The worst-case replica** (§5.7, Q15) holds the live issues of the user's member teams plus
 *   the 5 largest on-demand teams, the user's own issues of the other public teams (created or
 *   assigned, through `user:<id>`), and the other eager models. At the reference scale (NFR-10:
 *   100,000 issues, 20 teams, 50 users) it fits the per-replica 35 MB budget on the seed's even
 *   team split (≈ 30 MiB), but not on a skewed one: on a Zipf(1) split it is ≈ 52 MiB (a user in
 *   3 teams) or ≈ 56 MiB (a lead in 5). It fits only while the followed teams hold at most ≈ 48 %
 *   of all issues. The user accepted that as a known limit for M1 (SPEC-011 D19); a size-based
 *   on-demand limit follows. The skewed cases are `it.fails`.
 *
 * The measured total of a real replica (IndexedDB, tombstones) is a perf test, held (plans README
 * §6). Deterministic: one seeded generator, no wall clock.
 */
import { describe, expect, it } from 'vitest';
import { keyBefore, jitterFromId } from './order-key.js';
import { utf8Length } from './sha1.js';
import { Issue } from './model/index.js';
import { uuidv7 } from './uuid.js';

/** SPEC-011 §10 and AC-14. */
const ROW_BUDGET_BYTES = 650;
/** sync-protocol §2: eager rows, uncompressed, per replica (SPEC-011 Q15). */
const REPLICA_BUDGET_BYTES = 35 * 1024 * 1024;

/** NFR-10, the reference scale. */
const REFERENCE = { issues: 100_000, teams: 20, users: 50 } as const;
/**
 * The seed's team split: NFR-10's issues spread evenly over its teams, the split §10's "a user in
 * teams holding 40k live issues has ≈ 24 MB" assumes (8 teams of 5,000). Every issue counts as
 * live: no auto-archive has run, the largest replica a workspace of this size can give.
 */
const SEED_TEAM_SPLIT: readonly number[] = Array.from(
  { length: REFERENCE.teams },
  () => REFERENCE.issues / REFERENCE.teams,
);
/** ADR-0020: "a user in two or three teams". The worst case takes three, the largest. */
const MEMBER_TEAMS = 3;
/** SPEC-011 §5.7: at most 5 on-demand teams, least recently opened dropped. */
const ON_DEMAND_TEAMS = 5;
/**
 * The other eager models a replica holds at the reference scale, each row counted at 1 KB (a Team
 * row, the largest of them, is under 600 bytes; a draft with a long description is larger, and a
 * user keeps a few): the workspace, 50 users, the user's preferences, 20 teams, every user in every
 * team (1,000 memberships), 10 statuses and 50 labels per team plus 50 workspace labels, and the
 * user's 10 drafts. Attachments (PLAN-014 S4a, eager issue children) add their own rows.
 */
/** Labels per team, in the generated rows and in the other eager rows alike. */
const LABELS_PER_TEAM = 50;
const OTHER_EAGER_ROWS =
  1 + 50 + 1 + 20 + 1_000 + REFERENCE.teams * 10 + (REFERENCE.teams * LABELS_PER_TEAM + 50) + 10;
const OTHER_EAGER_ROW_BYTES = 1024;

/** mulberry32: a small seeded generator, so every run measures the same rows. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks from `[value, weight]` pairs. */
function weighted<T>(random: () => number, choices: readonly (readonly [T, number])[]): T {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let at = random() * total;
  for (const [value, weight] of choices) {
    at -= weight;
    if (at < 0) return value;
  }
  const last = choices.at(-1);
  if (last === undefined) throw new Error('No choices.');
  return last[0];
}

const WORDS = [
  'fix',
  'login',
  'crash',
  'when',
  'opening',
  'the',
  'settings',
  'page',
  'on',
  'Safari',
  'add',
  'export',
  'to',
  'CSV',
  'slow',
  'search',
  'results',
  'for',
  'large',
  'teams',
  'update',
  'onboarding',
  'copy',
  'dark',
  'mode',
  'contrast',
];

/** A title of `length` characters at most, cut on a word boundary (§4.1 allows 255). */
function title(random: () => number, length: number): string {
  const words: string[] = [];
  let size = 0;
  while (size < length) {
    const word = WORDS[Math.floor(random() * WORDS.length)] ?? 'issue';
    if (size + word.length + 1 > length && words.length > 0) break;
    words.push(word);
    size += word.length + 1;
  }
  return words.join(' ');
}

/** The user whose replica the rows are measured in. */
const VIEWER = 0;
const EPOCH = Date.parse('2026-01-05T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The seed distribution of §10: titles of 10–80 characters (a third short), 0–3 labels (2 in a
 * quarter of the issues), an assignee on 70 %, an estimate on 40 %, a due date on 15 %, the status
 * categories of a working team, with their timestamps (INV-20), and the groups as the replica of
 * `VIEWER` holds them: `team:<id>`, and `user:<viewer>` on the viewer's own issues.
 */
function generateIssues(count: number, seed: number): Record<string, unknown>[] {
  const random = seeded(seed);
  const bytes = () => Uint8Array.from({ length: 10 }, () => Math.floor(random() * 256));
  const id = (at: number) => uuidv7(at, bytes());
  const teams = Array.from({ length: REFERENCE.teams }, () => id(EPOCH));
  const users = Array.from({ length: REFERENCE.users }, () => id(EPOCH));
  const viewer = users[VIEWER] ?? '';
  const statuses = new Map(teams.map((team) => [team, Array.from({ length: 6 }, () => id(EPOCH))]));
  const labels = new Map(
    teams.map((team) => [team, Array.from({ length: LABELS_PER_TEAM }, () => id(EPOCH))]),
  );
  const lowest = new Map<string, string | null>();
  const rows: Record<string, unknown>[] = [];
  for (let n = 0; n < count; n += 1) {
    const created = EPOCH + Math.floor(random() * 300 * DAY_MS);
    const issueId = id(created);
    const teamId = teams[n % teams.length] ?? '';
    const pick = <T>(list: readonly T[] | undefined): T | undefined =>
      list?.[Math.floor(random() * list.length)];
    const creatorId = pick(users) ?? '';
    const assigneeId = random() < 0.7 ? (pick(users) ?? null) : null;
    const category = weighted(random, [
      ['backlog', 20],
      ['unstarted', 25],
      ['started', 20],
      ['completed', 30],
      ['canceled', 5],
    ] as const);
    const later = (days: number) => new Date(created + days * DAY_MS).toISOString();
    const started = category === 'started' || category === 'completed';
    const labelCount = weighted(random, [
      [0, 30],
      [1, 35],
      [2, 25],
      [3, 10],
    ] as const);
    const sortOrder = keyBefore(lowest.get(teamId) ?? null, jitterFromId(issueId));
    lowest.set(teamId, sortOrder);
    const row: Record<string, unknown> = {
      id: issueId,
      teamId,
      number: Math.floor(n / teams.length) + 1,
      title: title(random, random() < 0.33 ? 10 + Math.floor(random() * 20) : 30 + random() * 50),
      statusId: pick(statuses.get(teamId)) ?? '',
      priority: Math.floor(random() * 5),
      assigneeId,
      labelIds: Array.from({ length: labelCount }, () => pick(labels.get(teamId)) ?? ''),
      estimate:
        random() < 0.4
          ? weighted(random, [
              [1, 1],
              [2, 1],
              [3, 1],
              [5, 1],
              [8, 1],
            ])
          : null,
      dueDate: random() < 0.15 ? later(14).slice(0, 10) : null,
      sortOrder,
      creatorId,
      startedAt: started ? later(2) : null,
      completedAt: category === 'completed' ? later(9) : null,
      canceledAt: category === 'canceled' ? later(5) : null,
      archivedAt: null,
      deletedAt: null,
      deletedById: null,
      groups: [
        `team:${teamId}`,
        ...(creatorId === viewer || assigneeId === viewer ? [`user:${viewer}`] : []),
      ],
      createdAt: new Date(created).toISOString(),
      updatedAt: later(10),
    };
    rows.push(row);
  }
  return rows;
}

const SAMPLE = 20_000;
const rows = generateIssues(SAMPLE, 20261116);
const sizeOf = (row: unknown) => utf8Length(JSON.stringify(row));
const averageOf = (list: readonly unknown[]) =>
  list.reduce<number>((sum, row) => sum + sizeOf(row), 0) / list.length;
/** As §10 measured rows: without the connection-dependent `groups`. */
const rowAverage = averageOf(rows.map(({ groups: _groups, ...row }) => row));
/** As a replica stores rows: with their groups. */
const storedAverage = averageOf(rows);
/** The least a stored row adds for its groups: its team group. */
const TEAM_GROUP_BYTES = sizeOf({ groups: [`team:${'0'.repeat(36)}`] }) - sizeOf({});

describe('the Issue row (AC-14)', () => {
  it('is generated with every field of the Issue model, each valid on the wire', () => {
    const fields = Object.keys(Issue.fields).sort();
    for (const row of rows.slice(0, 200)) {
      expect(Object.keys(row).sort()).toEqual(fields);
      for (const [name, field] of Object.entries(Issue.fields)) {
        expect(field.schema.safeParse(row[name]).success, `${name}: ${String(row[name])}`).toBe(
          true,
        );
      }
    }
  });

  it(`averages at most ${ROW_BUDGET_BYTES} bytes of compact JSON over the seed distribution, as §10 measures it`, () => {
    expect(rowAverage).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
    // §10's measured rows bracket the average: a sparse row (517 bytes) to a full one (708).
    expect(rowAverage).toBeGreaterThan(517);
    // Stored, each row also carries at least its team group.
    expect(storedAverage - rowAverage).toBeGreaterThanOrEqual(TEAM_GROUP_BYTES);
  });
});

/**
 * The share of every other public team's issues the user created or is assigned: each issue has a
 * creator and, on 70 %, an assignee, spread over the users.
 */
const OWN_SHARE = (1 + 0.7) / REFERENCE.users;

/**
 * The issue rows of the worst-case replica over `split` (issues per team): the largest
 * `memberTeams` teams as the user's, the next 5 largest opened on demand, and the user's own
 * issues of every other team.
 */
function worstCaseRows(split: readonly number[], memberTeams: number): number {
  const bySize = [...split].sort((a, b) => b - a);
  const followed = memberTeams + ON_DEMAND_TEAMS;
  return (
    bySize.slice(0, followed).reduce((a, b) => a + b, 0) +
    bySize.slice(followed).reduce((a, b) => a + b, 0) * OWN_SHARE
  );
}

/** A replica of `issueRows` stored Issue rows and the other eager rows, in bytes. */
const replicaBytes = (issueRows: number) =>
  issueRows * storedAverage + OTHER_EAGER_ROWS * OTHER_EAGER_ROW_BYTES;

/**
 * A skewed split for AC-14's "not only the seed's team split": Zipf with s = 1 over NFR-10's 20
 * teams, team k holding (1/k) / H(20) of the issues. Its 8 largest teams hold ≈ 75.5 % of them,
 * its 10 largest ≈ 81.4 %.
 */
const ZIPF_TEAM_SPLIT: readonly number[] = (() => {
  const weights = Array.from({ length: REFERENCE.teams }, (_, k) => 1 / (k + 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((weight) => (REFERENCE.issues * weight) / sum);
})();
/** A lead, in more teams than ADR-0020's "two or three". */
const LEAD_MEMBER_TEAMS = 5;

/**
 * The largest share of all issues the followed teams (members and on-demand, however many) can
 * hold with the replica within 35 MB, the user's own issues of the other teams counted:
 * share · N + OWN_SHARE · (1 − share) · N stored rows fit what the budget leaves for issues.
 */
const LARGEST_FOLLOWED_SHARE =
  ((REPLICA_BUDGET_BYTES - OTHER_EAGER_ROWS * OTHER_EAGER_ROW_BYTES) /
    storedAverage /
    REFERENCE.issues -
    OWN_SHARE) /
  (1 - OWN_SHARE);

const MIB = 1024 * 1024;
const shareOf = (split: readonly number[], teams: number) =>
  [...split]
    .sort((a, b) => b - a)
    .slice(0, teams)
    .reduce((a, b) => a + b, 0) / REFERENCE.issues;

describe('the worst-case replica (AC-14, §5.7, Q15)', () => {
  it('holds the member teams, the 5 largest on-demand teams and the user’s own issues within 35 MB, on the seed’s even split', () => {
    expect(SEED_TEAM_SPLIT.reduce((a, b) => a + b, 0)).toBe(REFERENCE.issues);
    const issueRows = worstCaseRows(SEED_TEAM_SPLIT, MEMBER_TEAMS);
    expect(issueRows).toBeGreaterThanOrEqual(40_000);
    expect(replicaBytes(issueRows)).toBeLessThanOrEqual(REPLICA_BUDGET_BYTES);
  });

  // Open for the user (PLAN-011 S8 As built): on a skewed split the worst case is over budget.
  // `it.fails` keeps the gap visible in the gate, and turns red once the budget or the replica
  // changes enough to pass, so the record is updated then.
  it.fails('stays within 35 MB on a Zipf(1) team split, a user in 3 teams', () => {
    const total = replicaBytes(worstCaseRows(ZIPF_TEAM_SPLIT, MEMBER_TEAMS));
    expect(total).toBeLessThanOrEqual(REPLICA_BUDGET_BYTES);
  });

  it.fails('stays within 35 MB on a Zipf(1) team split, a lead in 5 teams', () => {
    const total = replicaBytes(worstCaseRows(ZIPF_TEAM_SPLIT, LEAD_MEMBER_TEAMS));
    expect(total).toBeLessThanOrEqual(REPLICA_BUDGET_BYTES);
  });

  it('records the measurements of PLAN-011 S8 As built', () => {
    expect(ZIPF_TEAM_SPLIT.reduce((a, b) => a + b, 0)).toBeCloseTo(REFERENCE.issues, 6);
    const mib = (memberTeams: number, split: readonly number[]) =>
      Math.round(replicaBytes(worstCaseRows(split, memberTeams)) / MIB);
    const percent = (share: number) => Math.round(share * 100);
    expect({
      row: Math.round(rowAverage),
      stored: Math.round(storedAverage),
      even: mib(MEMBER_TEAMS, SEED_TEAM_SPLIT),
      zipfMember: mib(MEMBER_TEAMS, ZIPF_TEAM_SPLIT),
      zipfLead: mib(LEAD_MEMBER_TEAMS, ZIPF_TEAM_SPLIT),
      zipfTop8: percent(shareOf(ZIPF_TEAM_SPLIT, MEMBER_TEAMS + ON_DEMAND_TEAMS)),
      zipfTop10: percent(shareOf(ZIPF_TEAM_SPLIT, LEAD_MEMBER_TEAMS + ON_DEMAND_TEAMS)),
      largestShare: percent(LARGEST_FOLLOWED_SHARE),
    }).toEqual({
      row: 628,
      stored: 685,
      even: 30,
      zipfMember: 52,
      zipfLead: 56,
      zipfTop8: 76,
      zipfTop10: 81,
      largestShare: 48,
    });
  });
});
