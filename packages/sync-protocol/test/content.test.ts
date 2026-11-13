// PLAN-011 S5a, SPEC-011 §5.2, AC-9 (codec part): the `GET /sync/content` query and frames.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ContentStreamReader,
  decodeContentFrame,
  decodeContentQuery,
  encodeContentQuery,
  encodeNdjsonLine,
  issueParent,
  MAX_CONTENT_PARENTS,
  MissingUserIdError,
  NdjsonDecoder,
  parentIssueId,
  ProtocolError,
  type ContentFrame,
  type ContentParent,
} from '../src/index.js';
import { propertyOptions, uuid } from './support/arbitraries.js';

const ID = '0192f5a4-1c2b-7d3e-8f40-123456789abc';
const OTHER = '0192f5a4-1c2b-7d3e-8f40-cba987654321';
const USER = '0190f4c4-0000-7000-8000-0000000005e1';
const HASH = 'a'.repeat(64);

/** The parsed query string of `GET /sync/content` as a server sees it. */
const parsed = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query));

const ids = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `0192f5a4-1c2b-7d3e-8f40-${i.toString(16).padStart(12, '0')}`,
  );

describe('the content query', () => {
  it('round-trips 1 to 50 distinct parents with userId and schemaHash', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(uuid, { minLength: 1, maxLength: MAX_CONTENT_PARENTS }),
        (issueIds) => {
          const query = { parents: issueIds.map(issueParent), userId: USER, schemaHash: HASH };
          expect(decodeContentQuery(parsed(encodeContentQuery(query)))).toEqual(query);
        },
      ),
      propertyOptions,
    );
  });

  it('lower-cases parents, so the answer’s ids match what was asked', () => {
    const query = decodeContentQuery({
      parents: `issue:${ID.toUpperCase()}`,
      userId: USER,
      schemaHash: HASH,
    });
    expect(query.parents).toEqual([`issue:${ID}`]);
    expect(parentIssueId(query.parents[0] ?? 'issue:')).toBe(ID);
  });

  it.each([
    ['no parents', { parents: '' }, /at least one parent/],
    ['no parents parameter', { parents: undefined }, /parents/],
    [
      `${MAX_CONTENT_PARENTS + 1} parents`,
      {
        parents: ids(MAX_CONTENT_PARENTS + 1)
          .map(issueParent)
          .join(','),
      },
      /at most 50 parents/,
    ],
    ['a parent of another kind', { parents: `project:${ID}` }, /issue:<uuid>/],
    ['a parent that is not a uuid', { parents: 'issue:ENG-12' }, /issue:<uuid>/],
    ['an empty item', { parents: `issue:${ID},` }, /issue:<uuid>/],
    ['a repeated parent', { parents: `issue:${ID},issue:${OTHER},issue:${ID}` }, /twice/],
    [
      'a repeated parent in another case',
      { parents: `issue:${ID},issue:${ID.toUpperCase()}` },
      /twice/,
    ],
    ['parents given twice (an array)', { parents: [`issue:${ID}`, `issue:${OTHER}`] }, /parents/],
    ['a userId that is not a uuid', { userId: 'ada' }, /userId/],
    ['no schemaHash', { schemaHash: undefined }, /schemaHash/],
  ])('refuses %s with ProtocolError (400)', (_case, change, message) => {
    const query = { parents: `issue:${ID}`, userId: USER, schemaHash: HASH, ...change };
    const decode = () => decodeContentQuery(query);
    expect(decode).toThrow(ProtocolError);
    expect(decode).toThrow(message);
    expect(decode).not.toThrow(MissingUserIdError);
  });

  it('accepts exactly 50 parents', () => {
    const parents = ids(MAX_CONTENT_PARENTS).map(issueParent).join(',');
    expect(decodeContentQuery({ parents, userId: USER, schemaHash: HASH }).parents).toHaveLength(
      MAX_CONTENT_PARENTS,
    );
  });

  it('refuses a query without userId with MissingUserIdError (426), whatever else is wrong', () => {
    expect(() => decodeContentQuery({ parents: '' })).toThrow(MissingUserIdError);
  });
});

describe('content frames', () => {
  const frames: ContentFrame[] = [
    { t: 'meta', lastSyncId: 18234, parents: [`issue:${ID}`], rows: 2 },
    {
      t: 'row',
      m: 'IssueContent',
      d: { id: ID, issueId: ID, teamId: OTHER, description: { type: 'doc' }, version: 3 },
    },
    { t: 'row', m: 'IssueHistory', d: { id: OTHER, issueId: ID } },
    { t: 'end', rows: 2 },
  ];

  it('accept the sync-protocol.md §4.2 example and round-trip through NDJSON', () => {
    const decoder = new NdjsonDecoder();
    const text = frames.map(encodeNdjsonLine).join('');
    expect([...decoder.push(text), ...decoder.end()].map(decodeContentFrame)).toEqual(frames);
  });

  it.each([
    ['a meta with a malformed parent', { t: 'meta', lastSyncId: 1, parents: ['ENG-1'], rows: 0 }],
    ['a meta without rows', { t: 'meta', lastSyncId: 1, parents: [] }],
    ['a row without an id', { t: 'row', m: 'IssueContent', d: { issueId: ID } }],
    ['a row with a lower-case model', { t: 'row', m: 'issueContent', d: { id: ID } }],
    ['an end with a negative count', { t: 'end', rows: -1 }],
    ['an unknown frame', { t: 'gap' }],
  ])('refuse %s', (_case, value) => {
    expect(() => decodeContentFrame(value)).toThrow(ProtocolError);
  });
});

describe('ContentStreamReader', () => {
  const meta = (rows: number, parents: ContentParent[] = [`issue:${ID}`]) => ({
    t: 'meta',
    lastSyncId: 7,
    parents,
    rows,
  });
  const row = { t: 'row', m: 'IssueContent', d: { id: ID, issueId: ID } };
  const end = (rows: number) => ({ t: 'end', rows });
  const read = (values: unknown[], requested?: ContentParent[]) => {
    const reader = new ContentStreamReader(requested);
    for (const value of values) reader.read(value);
    return reader.finish();
  };

  it('accepts a whole answer, also one with no rows', () => {
    expect(read([meta(2), row, row, end(2)])).toMatchObject({ rows: 2, meta: { lastSyncId: 7 } });
    expect(read([meta(0, []), end(0)])).toMatchObject({ rows: 0, meta: { parents: [] } });
  });

  it('detects a truncated stream: no end frame, or fewer rows than announced', () => {
    expect(() => read([meta(2), row, row])).toThrow('it ended before the end frame');
    expect(() => read([meta(2), row])).toThrow(ProtocolError);
    expect(() => read([])).toThrow(ProtocolError);
    expect(() => read([meta(2), row, end(1)])).toThrow('1 rows received, meta announced 2');
  });

  it('refuses frames out of order or counts that disagree', () => {
    expect(() => read([row, meta(1), end(1)])).toThrow('row before meta');
    expect(() => read([end(0)])).toThrow('end before meta');
    expect(() => read([meta(0), meta(0), end(0)])).toThrow('second meta frame');
    expect(() => read([meta(1), row, row, end(2)])).toThrow('more rows than the 1 meta announced');
    expect(() => read([meta(1), row, end(2)])).toThrow('end announced 2');
    expect(() => read([meta(0), end(0), row])).toThrow('data after end');
  });

  it('refuses a meta naming a parent that was not requested, or one twice', () => {
    const asked: ContentParent[] = [`issue:${ID}`];
    expect(read([meta(0), end(0)], asked).meta.parents).toEqual(asked);
    expect(() => read([meta(0, [`issue:${OTHER}`]), end(0)], asked)).toThrow('not requested');
    expect(() => read([meta(0, [`issue:${ID}`, `issue:${ID}`]), end(0)])).toThrow('twice');
  });
});
