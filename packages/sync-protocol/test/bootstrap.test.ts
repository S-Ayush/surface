import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeBootstrapFrame,
  decodeBootstrapQuery,
  encodeBootstrapQuery,
  encodeNdjsonLine,
  MissingUserIdError,
  NdjsonDecoder,
  ProtocolError,
} from '../src/index.js';
import { bootstrapFrame, propertyOptions, uuid, viaJson } from './support/arbitraries.js';

const ID = '0192f5a4-1c2b-7d3e-8f40-123456789abc';
const HASH = 'a'.repeat(64);

describe('bootstrap frames', () => {
  it('round-trip through NDJSON unchanged', () => {
    fc.assert(
      fc.property(fc.array(bootstrapFrame, { maxLength: 20 }), (frames) => {
        const decoder = new NdjsonDecoder();
        const text = frames.map(encodeNdjsonLine).join('');
        const decoded = [...decoder.push(text), ...decoder.end()].map(decodeBootstrapFrame);
        expect(decoded).toEqual(viaJson(frames));
      }),
      propertyOptions,
    );
  });

  it('accepts the sync-protocol.md §4.1 example', () => {
    const meta = decodeBootstrapFrame({
      t: 'meta',
      schemaHash: HASH,
      lastSyncId: 18234,
      groups: ['workspace', `team:${ID}`, `user:${ID}`],
      serverTime: '2026-11-06T10:00:00.000Z',
      rows: 151234,
    });
    expect(meta).toMatchObject({ t: 'meta', lastSyncId: 18234 });
    expect(decodeBootstrapFrame({ t: 'row', m: 'Team', d: { id: ID, key: 'ENG' } })).toEqual({
      t: 'row',
      m: 'Team',
      d: { id: ID, key: 'ENG' },
    });
    expect(decodeBootstrapFrame({ t: 'end', rows: 151234 })).toEqual({ t: 'end', rows: 151234 });
  });

  it('keeps every row field but drops unknown frame keys, so additive changes stay compatible', () => {
    const frame = decodeBootstrapFrame({
      t: 'row',
      m: 'Team',
      d: { id: ID, extra: 1 },
      future: true,
    });
    expect(frame).toEqual({ t: 'row', m: 'Team', d: { id: ID, extra: 1 } });
  });

  it.each([
    ['an unknown frame type', { t: 'rows' }],
    [
      'a meta frame without a schema hash',
      { t: 'meta', lastSyncId: 1, groups: [], serverTime: '2026-11-06T10:00:00Z', rows: 0 },
    ],
    [
      'a meta frame with an unknown sync group',
      {
        t: 'meta',
        schemaHash: HASH,
        lastSyncId: 1,
        groups: ['team:ENG'],
        serverTime: '2026-11-06T10:00:00Z',
        rows: 0,
      },
    ],
    [
      'a negative lastSyncId',
      {
        t: 'meta',
        schemaHash: HASH,
        lastSyncId: -1,
        groups: [],
        serverTime: '2026-11-06T10:00:00Z',
        rows: 0,
      },
    ],
    [
      'a lastSyncId beyond 2^53',
      {
        t: 'meta',
        schemaHash: HASH,
        lastSyncId: 2 ** 60,
        groups: [],
        serverTime: '2026-11-06T10:00:00Z',
        rows: 0,
      },
    ],
    [
      'a meta frame without a row count',
      {
        t: 'meta',
        schemaHash: HASH,
        lastSyncId: 1,
        groups: [],
        serverTime: '2026-11-06T10:00:00Z',
      },
    ],
    ['a row without an id', { t: 'row', m: 'Team', d: { key: 'ENG' } }],
    ['a row with a non-UUID id', { t: 'row', m: 'Team', d: { id: 42 } }],
    ['a row with a lowercase model name', { t: 'row', m: 'team', d: { id: ID } }],
    ['an end frame with a fractional count', { t: 'end', rows: 1.5 }],
  ])('rejects %s', (_case, frame) => {
    expect(() => decodeBootstrapFrame(frame)).toThrow(ProtocolError);
  });

  it('accepts archived as either boolean, so a server may always send it', () => {
    for (const archived of [true, false]) {
      expect(decodeBootstrapFrame({ t: 'row', m: 'Team', d: { id: ID }, archived })).toMatchObject({
        archived,
      });
    }
    expect(() => decodeBootstrapFrame({ t: 'row', m: 'Team', d: { id: ID }, archived: 1 })).toThrow(
      ProtocolError,
    );
  });

  it('does not echo row data in errors, since rows can hold user content', () => {
    const attempt = () =>
      decodeBootstrapFrame({ t: 'row', m: 'Team', d: { id: 'secret-token-123' } });
    expect(attempt).toThrow(/^Invalid bootstrap frame at d\.id:/);
    expect(attempt).not.toThrow(/secret-token-123/);
  });
});

describe('bootstrap query', () => {
  it('round-trips through a query string', () => {
    fc.assert(
      fc.property(fc.record({ userId: uuid }), (query) => {
        const parsed = Object.fromEntries(new URLSearchParams(encodeBootstrapQuery(query)));
        expect(decodeBootstrapQuery(parsed)).toEqual(query);
      }),
      propertyOptions,
    );
  });

  // SPEC-002 E14: an old client gets 426 and reloads.
  it('says the client is outdated when the query has no userId', () => {
    expect(() => decodeBootstrapQuery({})).toThrow(MissingUserIdError);
    expect(() => decodeBootstrapQuery({})).toThrow(
      'Invalid bootstrap query: userId is missing. Reload the app to update it.',
    );
  });

  it.each([
    ['not a UUID', 'sim-1'],
    ['empty', ''],
    ['repeated', [ID, ID]],
  ])('rejects a userId that is %s as malformed, not as an old client', (_case, userId) => {
    expect(() => decodeBootstrapQuery({ userId })).toThrow(ProtocolError);
    expect(() => decodeBootstrapQuery({ userId })).not.toThrow(MissingUserIdError);
  });

  it('ignores other parameters', () => {
    expect(decodeBootstrapQuery({ userId: ID, since: '4' })).toEqual({ userId: ID });
  });

  describe('partial bootstrap (v0.8)', () => {
    const TEAM_A = '0190f0c0-0000-7000-8000-00000000000a';
    const TEAM_B = '0190f0c0-0000-7000-8000-00000000000b';

    it('reads groups as a comma-separated list of team groups, with the schema hash', () => {
      const groups = [`team:${TEAM_A}`, `team:${TEAM_B}`] as const;
      const query = { userId: ID, groups: [...groups], schemaHash: HASH };
      const text = encodeBootstrapQuery(query);
      expect(decodeBootstrapQuery(Object.fromEntries(new URLSearchParams(text)))).toEqual(query);
      expect(
        decodeBootstrapQuery({ userId: ID, groups: `team:${TEAM_A}`, schemaHash: HASH }),
      ).toEqual({ userId: ID, groups: [`team:${TEAM_A}`], schemaHash: HASH });
    });

    it('refuses groups without a schema hash (400, unlike another hash: 426)', () => {
      expect(() => decodeBootstrapQuery({ userId: ID, groups: `team:${TEAM_A}` })).toThrow(
        /needs schemaHash/,
      );
    });

    it.each([
      ['an empty list', ''],
      ['the workspace group', 'workspace'],
      ['a user group', `user:${ID}`],
      ['a team that is not a uuid', 'team:ENG'],
      ['a repeated team', `team:${TEAM_A},team:${TEAM_A}`],
      [
        'too many teams',
        Array.from(
          { length: 101 },
          (_, i) => `team:${TEAM_A.slice(0, -3)}${String(i).padStart(3, '0')}`,
        ).join(','),
      ],
    ])('refuses %s', (_name, groups) => {
      expect(() => decodeBootstrapQuery({ userId: ID, groups, schemaHash: HASH })).toThrow(
        ProtocolError,
      );
    });

    it('refuses a malformed schema hash', () => {
      expect(() => decodeBootstrapQuery({ userId: ID, schemaHash: 'abc' })).toThrow(ProtocolError);
    });
  });
});
