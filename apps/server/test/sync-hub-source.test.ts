// PLAN-002 S4 review: catch-up reads the log a page at a time, each page its own statement on the
// pool, so a slow client holds no connection (SPEC-002 §4.3). The SQL itself runs against Postgres
// in `sync-groups.int.test.ts` (AC-11); here a fake answers the two statements catch-up sends.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { QueryClient } from '../src/sync/hub-source.js';
import { notifySessionsRevoked, pgSyncLogSource, sessionCloser } from '../src/sync/hub-source.js';

/** A `sync_log` behind `query` only: there is no `connect`, so nothing can be held. */
class FakePool implements QueryClient {
  ids: number[] = [];
  last = 0;

  constructor(count: number) {
    for (let id = 1; id <= count; id += 1) this.ids.push(id);
    this.last = count;
  }

  /** `synclog-prune`: deletes every row below `id`. */
  pruneBelow(id: number): void {
    this.ids = this.ids.filter((x) => x >= id);
  }

  query<R extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    const answer = (rows: Record<string, unknown>[]) => Promise.resolve({ rows: rows as R[] });
    if (text.includes('min(sync_id)')) {
      return answer([
        { last: String(this.last), oldest: this.ids.length ? String(this.ids[0]) : null },
      ]);
    }
    const [after, upTo, , , limit] = values.map(Number);
    if (after === undefined || upTo === undefined || limit === undefined) {
      throw new Error(`unexpected statement: ${text}`);
    }
    return answer(
      this.ids
        .filter((id) => id > after && id <= upTo)
        .slice(0, limit)
        .map((id) => ({
          id_text: String(id),
          model: 'DebugItem',
          model_id: randomUUID(),
          action: 'U',
          data: {},
          groups: ['workspace'],
          client_id: null,
          client_seq: null,
        })),
    );
  }
}

const request = (since: number, upTo: number) => ({
  since,
  upTo,
  groups: ['workspace'],
  clientId: randomUUID(),
  pageSize: 3,
});

/** What catch-up yields, as page ids or `too_old`; `between` runs while it waits after a page. */
async function drain(
  pool: FakePool,
  since: number,
  upTo: number,
  between: (page: number) => void = () => undefined,
): Promise<(number[] | 'too_old')[]> {
  const source = pgSyncLogSource({
    pool,
    listenClient: () => {
      throw new Error('not used');
    },
  });
  const seen: (number[] | 'too_old')[] = [];
  let page = 0;
  for await (const event of source.catchUp(request(since, upTo))) {
    seen.push(event.t === 'too_old' ? 'too_old' : event.rows.map((r) => r.syncId));
    page += 1;
    between(page);
  }
  return seen;
}

describe('catch-up from Postgres, page by page', () => {
  it('reads (since, upTo] in pages, each a statement on the pool', async () => {
    const pool = new FakePool(10);
    expect(await drain(pool, 2, 9)).toEqual([[3, 4, 5], [6, 7, 8], [9]]);
  });

  it('ends in resync(too_old) when a prune overtakes it while the client is slow', async () => {
    const pool = new FakePool(10);
    const seen = await drain(pool, 0, 10, (page) => {
      if (page === 1) pool.pruneBelow(6); // rows 4 and 5 are gone before page 2 is read
    });
    expect(seen).toEqual([[1, 2, 3], 'too_old']);
  });

  it('goes on when a prune deletes only rows it has already sent', async () => {
    const pool = new FakePool(10);
    const seen = await drain(pool, 0, 7, (page) => {
      if (page === 1) pool.pruneBelow(4);
    });
    expect(seen).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('asks for a resync when since is outside retention or ahead of the head', async () => {
    const pool = new FakePool(10);
    pool.pruneBelow(5);
    expect(await drain(pool, 3, 10)).toEqual(['too_old']);
    expect(await drain(pool, 4, 6)).toEqual([[5, 6]]);
    expect(await drain(pool, 11, 10)).toEqual(['too_old']);
  });
});

describe('sessions ended on any replica (PLAN-001 S3 review M2)', () => {
  /** A listen connection that records its statements and can be sent notifications. */
  class FakeListenClient extends EventEmitter {
    readonly statements: string[] = [];
    connect = () => Promise.resolve();
    query = (text: string) => {
      this.statements.push(text);
      return Promise.resolve({ rows: [] });
    };
    end = () => Promise.resolve();
  }

  it('listens for session_revoked and hands the ids to the hub', async () => {
    const client = new FakeListenClient();
    const source = pgSyncLogSource({
      pool: new FakePool(0),
      listenClient: () => client as unknown as pg.Client,
    });
    const revoked: (readonly string[])[] = [];
    let synced = 0;
    await source.listen(
      () => (synced += 1),
      (ids) => revoked.push(ids),
    );
    expect(client.statements).toEqual(['LISTEN sync', 'LISTEN session_revoked']);
    client.emit('notification', { channel: 'session_revoked', payload: 's1,s2' });
    client.emit('notification', { channel: 'sync', payload: '' });
    expect([revoked, synced]).toEqual([[['s1', 's2']], 1]);
  });

  it('closes here and notifies every replica, a worker without a hub included', async () => {
    const sent: unknown[][] = [];
    const pool: QueryClient = {
      query: <R extends Record<string, unknown>>(_text: string, values: unknown[] = []) => {
        sent.push(values);
        return Promise.resolve({ rows: [] as R[] });
      },
    };
    const closedHere: string[] = [];
    const hub = { closeSessions: (ids: Iterable<string>) => closedHere.push(...ids) };
    const log = { warn: () => undefined };
    sessionCloser({ hub, pool, log })(['s1']);
    sessionCloser({ hub: undefined, pool, log })(['s2']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closedHere).toEqual(['s1']);
    expect(sent).toEqual([
      ['session_revoked', 's1'],
      ['session_revoked', 's2'],
    ]);
  });

  it('notifies in batches of 100 ids, under the payload limit', async () => {
    const sent: unknown[][] = [];
    const pool: QueryClient = {
      query: <R extends Record<string, unknown>>(_text: string, values: unknown[] = []) => {
        sent.push(values);
        return Promise.resolve({ rows: [] as R[] });
      },
    };
    const ids = Array.from({ length: 150 }, () => randomUUID());
    await notifySessionsRevoked(pool, ids);
    expect(sent.map(([channel]) => channel)).toEqual(['session_revoked', 'session_revoked']);
    expect(sent.map(([, payload]) => String(payload).split(',').length)).toEqual([100, 50]);
    expect(String(sent[0]?.[1]).length).toBeLessThan(8000);
  });
});
