import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  decodeClientMessage,
  decodeServerMessage,
  decodeSocketConnectParams,
  encodeSocketConnectParams,
  encodeSocketMessage,
  MAX_PACKETS_PER_MESSAGE,
  MissingUserIdError,
  ProtocolError,
} from '../src/index.js';
import {
  clientMessage,
  hash,
  propertyOptions,
  serverMessage,
  syncId,
  uuid,
  viaJson,
} from './support/arbitraries.js';

const ID = '0192f5a4-1c2b-7d3e-8f40-123456789abc';
const USER = '0192f5a4-1c2b-7d3e-8f40-0000000000aa';
const row = (id = ID) => ({ id, title: 'x' });

describe('server messages', () => {
  it('round-trip unchanged', () => {
    fc.assert(
      fc.property(serverMessage, (message) => {
        expect(decodeServerMessage(encodeSocketMessage(message))).toEqual(viaJson(message));
      }),
      propertyOptions,
    );
  });

  it('decode every packet action from sync-protocol.md §4.3', () => {
    const message = decodeServerMessage(
      JSON.stringify({
        t: 'deltas',
        prev: 18234,
        packets: [
          { id: 18235, a: 'I', m: 'Issue', d: row() },
          { id: 18236, a: 'U', m: 'Issue', d: row() },
          { id: 18237, a: 'A', m: 'Issue', d: row() },
          { id: 18238, a: 'V', m: 'Issue', d: row() },
          { id: 18239, a: 'D', m: 'Comment', mid: ID },
          { id: 18240, a: 'G', added: [`team:${ID}`], removed: [] },
        ],
        ack: [{ clientId: ID, seq: 57 }],
      }),
    );
    expect(message.t === 'deltas' && message.packets.map((p) => p.a)).toEqual([
      'I',
      'U',
      'A',
      'V',
      'D',
      'G',
    ]);
  });

  // SPEC-011 §5.5, AC-18 (codec): v0.7 archive packets carry the full row; a delete only its id.
  describe('archive state on the wire (v0.7)', () => {
    const one = (packet: Record<string, unknown>) =>
      JSON.stringify({
        t: 'deltas',
        prev: 0,
        packets: [{ id: 1, m: 'Label', ...packet }],
        ack: [],
      });
    const archivedRow = { id: ID, name: 'Bug', archivedAt: '2026-11-12T10:00:00.000Z' };

    it.each(['A', 'V'])('decodes an %s packet with its full row', (a) => {
      const message = decodeServerMessage(one({ a, d: archivedRow }));
      expect(message).toEqual({
        t: 'deltas',
        prev: 0,
        packets: [{ id: 1, a, m: 'Label', d: archivedRow }],
        ack: [],
      });
    });

    it.each([
      ['an A packet without a row', { a: 'A', mid: ID }],
      ['a V packet without a row', { a: 'V', mid: ID }],
      ['an A packet whose row has no id', { a: 'A', d: { name: 'Bug' } }],
      ['an A packet with both a row and mid', { a: 'A', d: archivedRow, mid: ID }],
      ['a V packet with both a row and mid', { a: 'V', d: archivedRow, mid: ID }],
      ['a D packet with a row', { a: 'D', d: archivedRow }],
      ['a D packet with both mid and a row', { a: 'D', mid: ID, d: archivedRow }],
    ])('refuses %s', (_case, packet) => {
      expect(() => decodeServerMessage(one(packet))).toThrow(ProtocolError);
    });

    it('still decodes a D packet with only the id', () => {
      const message = decodeServerMessage(one({ a: 'D', mid: ID }));
      expect(message.t === 'deltas' && message.packets[0]).toEqual({
        id: 1,
        a: 'D',
        m: 'Label',
        mid: ID,
      });
    });
  });

  it('accepts acks without packets, for mutations whose rows this client cannot see', () => {
    const message = decodeServerMessage(
      JSON.stringify({ t: 'deltas', prev: 7, packets: [], ack: [{ clientId: ID, seq: 1 }] }),
    );
    expect(message).toEqual({ t: 'deltas', prev: 7, packets: [], ack: [{ clientId: ID, seq: 1 }] });
  });

  const deltas = (prev: number, ids: number[], ack: unknown[] = []) =>
    JSON.stringify({
      t: 'deltas',
      prev,
      packets: ids.map((id) => ({ id, a: 'D', m: 'Issue', mid: ID })),
      ack,
    });

  it.each([
    ['a first packet id equal to prev', deltas(5, [5, 6])],
    ['a first packet id below prev', deltas(5, [4])],
    ['decreasing packet ids', deltas(5, [7, 6])],
    ['duplicate packet ids', deltas(5, [6, 6])],
    ['no packets and no acks', deltas(5, [])],
    [
      'an I packet without a row',
      JSON.stringify({ t: 'deltas', prev: 0, packets: [{ id: 1, a: 'I', m: 'Issue' }], ack: [] }),
    ],
    [
      'a D packet without mid',
      JSON.stringify({ t: 'deltas', prev: 0, packets: [{ id: 1, a: 'D', m: 'Issue' }], ack: [] }),
    ],
    [
      'an unknown packet action',
      JSON.stringify({
        t: 'deltas',
        prev: 0,
        packets: [{ id: 1, a: 'X', m: 'Issue', mid: ID }],
        ack: [],
      }),
    ],
    ['an ack with seq 0', deltas(5, [6], [{ clientId: ID, seq: 0 }])],
    ['an unknown resync reason', JSON.stringify({ t: 'resync', reason: 'bored' })],
    [
      'presence, which is not part of v0',
      JSON.stringify({ t: 'presence', subject: 'issue:1', users: [] }),
    ],
    ['text that is not JSON', '{"t":"ping"'],
  ])('rejects %s', (_case, text) => {
    expect(() => decodeServerMessage(text)).toThrow(ProtocolError);
  });

  it(`caps a deltas message at ${MAX_PACKETS_PER_MESSAGE} packets`, () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(() => decodeServerMessage(deltas(0, ids(MAX_PACKETS_PER_MESSAGE)))).not.toThrow();
    expect(() => decodeServerMessage(deltas(0, ids(MAX_PACKETS_PER_MESSAGE + 1)))).toThrow(
      ProtocolError,
    );
  });

  it('names the offending packet when ids go backwards', () => {
    expect(() => decodeServerMessage(deltas(5, [6, 8, 7]))).toThrow(
      'Invalid server message at packets.2.id: packet ids must be strictly increasing and greater than prev',
    );
  });
});

describe('client messages', () => {
  it('round-trip unchanged', () => {
    fc.assert(
      fc.property(clientMessage, (message) => {
        expect(decodeClientMessage(encodeSocketMessage(message))).toEqual(message);
      }),
      propertyOptions,
    );
  });

  it('rejects messages the server does not accept from clients', () => {
    expect(() => decodeClientMessage('{"t":"ping"}')).toThrow(ProtocolError);
  });

  it('takes subscribe and unsubscribe with 1 to 100 team ids (v0.8)', () => {
    const teams = (n: number) =>
      Array.from({ length: n }, (_, i) => `${ID.slice(0, -3)}${String(i).padStart(3, '0')}`);
    for (const t of ['subscribe', 'unsubscribe'] as const) {
      expect(decodeClientMessage(JSON.stringify({ t, teams: [ID] }))).toEqual({ t, teams: [ID] });
      expect(() => decodeClientMessage(JSON.stringify({ t, teams: teams(100) }))).not.toThrow();
      for (const bad of [[], teams(101), ['ENG'], undefined]) {
        expect(() => decodeClientMessage(JSON.stringify({ t, teams: bad }))).toThrow(ProtocolError);
      }
    }
  });
});

describe('subscription acks (v0.8)', () => {
  it.each(['subscribed', 'unsubscribed'] as const)('decodes %s with its teams and at', (t) => {
    expect(decodeServerMessage(JSON.stringify({ t, teams: [ID], at: 7 }))).toEqual({
      t,
      teams: [ID],
      at: 7,
    });
    expect(decodeServerMessage(JSON.stringify({ t, teams: [], at: 0 }))).toEqual({
      t,
      teams: [],
      at: 0,
    });
    for (const bad of [{ teams: [ID] }, { teams: ['ENG'], at: 1 }, { teams: [ID], at: -1 }]) {
      expect(() => decodeServerMessage(JSON.stringify({ t, ...bad }))).toThrow(ProtocolError);
    }
  });
});

describe('connect parameters', () => {
  it('round-trip through a query string', () => {
    fc.assert(
      fc.property(
        fc.record({ since: syncId, clientId: uuid, userId: uuid, schemaHash: hash }),
        (params) => {
          const query = Object.fromEntries(new URLSearchParams(encodeSocketConnectParams(params)));
          expect(decodeSocketConnectParams(query)).toEqual(params);
        },
      ),
      propertyOptions,
    );
  });

  it('carries teams (v0.8): absent, empty and listed differ', () => {
    const base = { since: 3, clientId: ID, userId: USER, schemaHash: 'b'.repeat(64) };
    const roundTrip = (params: typeof base & { teams?: string[] }) =>
      decodeSocketConnectParams(
        Object.fromEntries(new URLSearchParams(encodeSocketConnectParams(params))),
      );
    expect(roundTrip(base)).toEqual(base);
    expect(roundTrip({ ...base, teams: [] })).toEqual({ ...base, teams: [] });
    expect(roundTrip({ ...base, teams: [ID, USER] })).toEqual({ ...base, teams: [ID, USER] });
  });

  it.each([
    ['a team that is not a uuid', 'ENG'],
    ['an empty entry', `${ID},`],
    ['more than 100 teams', Array.from({ length: 101 }, () => ID).join(',')],
  ])('rejects teams with %s', (_case, teams) => {
    const query = { since: '0', clientId: ID, userId: USER, schemaHash: 'b'.repeat(64), teams };
    expect(() => decodeSocketConnectParams(query)).toThrow(ProtocolError);
  });

  it.each(['', '-1', '01', '1.5', '1e3', ' 1', '9007199254740993'])('rejects since=%j', (since) => {
    expect(() =>
      decodeSocketConnectParams({ since, clientId: ID, userId: USER, schemaHash: 'b'.repeat(64) }),
    ).toThrow(ProtocolError);
  });

  it('rejects a missing schema hash', () => {
    expect(() => decodeSocketConnectParams({ since: '0', clientId: ID, userId: USER })).toThrow(
      ProtocolError,
    );
  });

  // SPEC-002 E14: the hub answers an old client with resync(schema), which it
  // already turns into the reload banner; a refused upgrade it can't read.
  it('says the client is outdated when it has no userId, even with other problems', () => {
    const query = { since: '0', clientId: ID, schemaHash: 'b'.repeat(64) };
    expect(() => decodeSocketConnectParams(query)).toThrow(MissingUserIdError);
    expect(() => decodeSocketConnectParams({ since: '-1' })).toThrow(MissingUserIdError);
  });

  it.each([
    ['not a UUID', 'sim-1'],
    ['empty', ''],
    ['repeated', [ID, ID]],
  ])('rejects a userId that is %s as malformed, not as an old client', (_case, userId) => {
    const query = { since: '0', clientId: ID, schemaHash: 'b'.repeat(64), userId };
    expect(() => decodeSocketConnectParams(query)).toThrow(ProtocolError);
    expect(() => decodeSocketConnectParams(query)).not.toThrow(MissingUserIdError);
  });
});

describe('close codes', () => {
  it('match sync-protocol.md', () => {
    expect(CloseCode).toEqual({ ServiceRestart: 1012, SessionRevoked: 4001 });
  });
});
