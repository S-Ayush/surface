// PLAN-002 S4: how one connection's deltas are cut into messages (SPEC-002 §4.3, Q5, Q6;
// sync-protocol §4.3). Every message is checked with the client's own decoder.
import { randomUUID } from 'node:crypto';
import {
  decodeServerMessage,
  encodeSocketMessage,
  type DeltasMessage,
} from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { DeltaWriter, type LogRow } from '../src/sync/delta-writer.js';
import { syncRegistry } from '../src/sync/registry.js';

const models = new Map(syncRegistry({ includeFixtures: true }).models.map((m) => [m.name, m]));
const me = randomUUID();
const other = randomUUID();
const team = `team:${randomUUID()}`;

let nextId = 0;
function row(over: Partial<LogRow> = {}): LogRow {
  const syncId = over.syncId ?? ++nextId;
  const modelId = over.modelId ?? randomUUID();
  const groups = over.groups ?? ['workspace'];
  return {
    syncId,
    model: 'DebugItem',
    modelId,
    action: 'U',
    data: { id: modelId, title: `t${syncId}`, counter: 0, syncGroups: groups },
    groups,
    clientId: null,
    clientSeq: null,
    ...over,
  };
}

function writer(since = 0, groups = ['workspace']) {
  const sent: DeltasMessage[] = [];
  const w = new DeltaWriter({
    models,
    groups: new Set(groups),
    clientId: me,
    since,
    send: (message) => {
      // What the client would decode, or throw on.
      const decoded = decodeServerMessage(encodeSocketMessage(message));
      if (decoded.t !== 'deltas') throw new Error('not deltas');
      sent.push(decoded);
    },
  });
  return { w, sent };
}

describe('a connection’s deltas', () => {
  it('chain prev from since through every message, at most 500 packets each', () => {
    nextId = 100;
    const { w, sent } = writer(100);
    w.add(Array.from({ length: 1200 }, () => row()));
    w.flush(true);
    expect(sent.map((m) => m.packets.length)).toEqual([500, 500, 200]);
    expect(sent.map((m) => m.prev)).toEqual([100, 600, 1100]);
    expect(sent.flatMap((m) => m.packets.map((p) => p.id))).toEqual(
      Array.from({ length: 1200 }, (_, i) => 101 + i),
    );
  });

  it('leave out rows of groups the connection is not in, and cut a shared row’s groups', () => {
    const { w, sent } = writer();
    const secret = row({ groups: [team] });
    const shared = row({ groups: ['workspace', team] });
    w.add([secret, shared]);
    w.flush(true);
    const packets = sent.flatMap((m) => m.packets);
    expect(packets.map((p) => p.id)).toEqual([shared.syncId]);
    expect(packets[0]).toMatchObject({ a: 'U', d: { id: shared.modelId, groups: ['workspace'] } });
    expect(JSON.stringify(sent)).not.toContain(team);
  });

  it('send archive, unarchive and delete as ids only', () => {
    const { w, sent } = writer();
    const id = randomUUID();
    w.add([
      row({ modelId: id, action: 'A' }),
      row({ modelId: id, action: 'V' }),
      row({ modelId: id, action: 'D', data: null }),
    ]);
    w.flush(true);
    expect(sent[0]?.packets.map((p) => ('mid' in p ? [p.a, p.mid] : p.a))).toEqual([
      ['A', id],
      ['V', id],
      ['D', id],
    ]);
  });

  it('never end a message on a D whose row’s U follows (a groups change, Q5)', () => {
    nextId = 0;
    const { w, sent } = writer();
    const moved = randomUUID();
    w.add(Array.from({ length: 499 }, () => row()));
    w.add([row({ modelId: moved, action: 'D', data: null }), row({ modelId: moved })]);
    w.flush(true);
    expect(sent.map((m) => m.packets.length)).toEqual([499, 2]);
    expect(sent[1]?.packets.map((p) => p.a)).toEqual(['D', 'U']);
  });

  it('send a D on its own when it ends the stream of a user who lost the row', () => {
    const { w, sent } = writer(0, ['workspace']);
    const moved = randomUUID();
    w.add([
      row({ modelId: moved, action: 'D', data: null, groups: ['workspace'] }),
      row({ modelId: moved, groups: [team] }),
    ]);
    w.flush(true);
    expect(sent.flatMap((m) => m.packets.map((p) => p.a))).toEqual(['D']);
  });

  it('hold back a partial message mid-range, and send it at the boundary', () => {
    const { w, sent } = writer();
    w.add(Array.from({ length: 700 }, () => row()));
    w.flush(false);
    expect(sent.map((m) => m.packets.length)).toEqual([500]);
    w.flush(true);
    expect(sent.map((m) => m.packets.length)).toEqual([500, 200]);
  });

  it('skip rows it has already taken in, so an overlap is never sent twice', () => {
    nextId = 0;
    const { w, sent } = writer(0);
    const rows = Array.from({ length: 10 }, () => row());
    w.add(rows.slice(0, 6));
    w.add(rows.slice(3));
    w.flush(true);
    expect(sent.flatMap((m) => m.packets.map((p) => p.id))).toEqual(rows.map((r) => r.syncId));
  });

  it('skip rows at or below since', () => {
    nextId = 0;
    const { w, sent } = writer(5);
    w.add(Array.from({ length: 8 }, () => row()));
    w.flush(true);
    expect(sent[0]?.packets.map((p) => p.id)).toEqual([6, 7, 8]);
    expect(sent[0]?.prev).toBe(5);
  });

  it('skip rows of a model the registry doesn’t sync', () => {
    const { w, sent } = writer();
    w.add([row({ model: 'Retired' })]);
    w.flush(true);
    expect(sent).toEqual([]);
  });
});

describe('acks', () => {
  it('confirm each of this client’s mutations once, on the last message of the range', () => {
    nextId = 0;
    const { w, sent } = writer();
    const mine = { clientId: me, clientSeq: 7 };
    w.add([row(mine), row(mine), row()]);
    w.add(Array.from({ length: 600 }, () => row()));
    w.flush(true);
    expect(sent.map((m) => m.ack)).toEqual([[], [{ clientId: me, seq: 7 }]]);
  });

  it('go alone when the mutation changed only rows this client can’t see', () => {
    const { w, sent } = writer();
    w.add([row({ groups: [team], clientId: me, clientSeq: 3 })]);
    w.flush(true);
    expect(sent).toEqual([{ t: 'deltas', prev: 0, packets: [], ack: [{ clientId: me, seq: 3 }] }]);
  });

  it('wait for the transaction boundary', () => {
    const { w, sent } = writer();
    w.add([row({ groups: [team], clientId: me, clientSeq: 3 })]);
    w.flush(false);
    expect(sent).toEqual([]);
  });

  it('are never sent for another client’s mutations', () => {
    const { w, sent } = writer();
    w.add([
      row({ clientId: other, clientSeq: 1 }),
      row({ groups: [team], clientId: other, clientSeq: 2 }),
    ]);
    w.flush(true);
    expect(sent.flatMap((m) => m.ack)).toEqual([]);
  });

  it('send nothing at all for a range with nothing for this connection', () => {
    const { w, sent } = writer();
    w.add([row({ groups: [team] })]);
    w.flush(true);
    expect(sent).toEqual([]);
  });
});
