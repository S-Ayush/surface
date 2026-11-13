// PLAN-011 S3, SPEC-011 §4.5, AC-2 (unit part over the statement order): a new issue's number
// comes from one upsert of the team's counter (a team without a row gets one), and its sort key
// is read after that upsert, so the counter row's lock orders concurrent creates in one team and
// two of them never compute a key from the same lowest key. The concurrent run against Postgres is
// the sync property suite's (PLAN-011 S4).
import { isFractionalKey, JITTER_LENGTH } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { firstSortKey, newIssuePosition, nextIssueNumber } from '../src/issues/numbering.js';
import { recordingDb } from './support/scripted-db.js';

const ENG = '0190f0c0-0000-7000-8000-00000000e000';

/** A team whose counter is at `last` (absent: no row yet) and whose lowest key is `lowest`. */
function team(last: number | undefined, lowest: string | undefined) {
  let counter = last;
  return recordingDb((text) => {
    if (text.startsWith('insert into "team_issue_counters"')) {
      counter = (counter ?? 0) + 1;
      return [[counter]];
    }
    if (text.startsWith('select "sort_order" from "issues"')) {
      return lowest === undefined ? [] : [[lowest]];
    }
    return [];
  });
}

describe('nextIssueNumber', () => {
  it('takes the number with one upsert of the counter, the table’s documented form', async () => {
    const { db, statements } = team(undefined, undefined);
    expect(await nextIssueNumber(db, ENG)).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe(
      'insert into "team_issue_counters" ("team_id", "last_number") values ($1, $2) on conflict ("team_id") do update set "last_number" = "team_issue_counters"."last_number" + 1 returning "last_number"',
    );
    expect(statements[0]?.params).toEqual([ENG, 1]);
  });

  it('counts on from the stored number', async () => {
    const { db } = team(41, undefined);
    expect(await nextIssueNumber(db, ENG)).toBe(42);
    expect(await nextIssueNumber(db, ENG)).toBe(43);
  });
});

describe('firstSortKey', () => {
  it('reads the team’s lowest key in byte order and returns a key before it', async () => {
    const { db, statements } = team(0, 'a0V001');
    const key = await firstSortKey(db, ENG);
    expect(isFractionalKey(key)).toBe(true);
    expect(key < 'a0V001').toBe(true);
    expect(statements[0]?.text).toBe(
      'select "sort_order" from "issues" where "issues"."team_id" = $1 order by "issues"."sort_order" COLLATE "C" limit $2',
    );
    expect(statements[0]?.params).toEqual([ENG, 1]);
  });

  it('gives the first issue of a team a key of its own, with random jitter', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) keys.add(await firstSortKey(team(0, undefined).db, ENG));
    // 50 draws from ~14.5 million jitters repeat once in ~12,000 runs, two repeats almost never:
    // more than one means the jitter isn't random.
    expect(keys.size).toBeGreaterThanOrEqual(49);
    for (const key of keys) expect(key).toHaveLength(2 + JITTER_LENGTH);
  });
});

describe('newIssuePosition', () => {
  it('takes the counter (and its lock) before it reads the lowest key', async () => {
    const { db, statements } = team(6, 'a0V001');
    const position = await newIssuePosition(db, ENG);
    expect(position.number).toBe(7);
    expect(position.sortOrder < 'a0V001').toBe(true);
    expect(statements.map(({ text }) => text.split(' ').slice(0, 3).join(' '))).toEqual([
      'insert into "team_issue_counters"',
      'select "sort_order" from',
    ]);
  });
});
