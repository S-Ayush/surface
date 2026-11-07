// PLAN-001 S2: the decisions `pgSetupStore.complete` makes inside its transaction (SPEC-001 AC-1,
// E1), against a fake pg pool. The real transaction against Postgres (AC-2) is held (README §6)
// and was checked by hand (PLAN-001 S2 As built).
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { setupInputSchema } from '../src/setup/input.js';
import { pgSetupStore } from '../src/setup/store.js';
import { hashSetupToken } from '../src/setup/token.js';

const TOKEN = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789';

const input = setupInputSchema.parse({
  token: TOKEN,
  workspace: { name: 'Acme' },
  admin: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse battery' },
  team: { name: 'Engineering', key: 'ENG' },
});

interface State {
  token_hash: string | null;
  completed_at: Date | null;
}

/**
 * A checked-out pg client. Like pg, an `error` event with no listener ends the process; here it
 * is recorded as `crashed` instead, so the test can say so.
 */
class FakeClient extends EventEmitter {
  readonly statements: string[] = [];
  released: boolean | undefined;
  crashed = false;
  #broken = false;

  constructor(
    private readonly state: State,
    /** The connection dies while this statement runs. */
    private readonly dieOn?: string,
  ) {
    super();
  }

  query(text: string): Promise<{ rows: State[]; rowCount: number }> {
    this.statements.push(text);
    if (this.#broken) {
      return Promise.reject(new Error('Client has encountered a connection error'));
    }
    if (this.dieOn !== undefined && text.startsWith(this.dieOn)) {
      this.#broken = true;
      // pg emits 'error' from the socket, outside any query's call stack, then fails the query.
      return new Promise((_resolve, reject) => {
        setImmediate(() => {
          const error = new Error('terminating connection due to administrator command');
          if (this.listenerCount('error') === 0) this.crashed = true;
          else this.emit('error', error);
          reject(error);
        });
      });
    }
    if (text.startsWith('SELECT token_hash'))
      return Promise.resolve({ rows: [this.state], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  release(destroy?: boolean): void {
    this.released = destroy === true;
  }
}

function storeWith(client: FakeClient) {
  const pool = { connect: () => Promise.resolve(client) };
  // The store only calls `connect` on this path; the cast stands in for the rest of pg.Pool.
  return pgSetupStore(pool as unknown as pg.Pool);
}

const writes = (client: FakeClient) =>
  client.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));

describe('pgSetupStore.complete', () => {
  it('refuses a token that is not the current one, writing nothing (AC-1)', async () => {
    const client = new FakeClient({
      token_hash: hashSetupToken('OTHER-TOKEN'),
      completed_at: null,
    });
    expect(
      await storeWith(client).complete(input, { userAgent: undefined, ip: undefined }),
    ).toEqual({
      ok: false,
      reason: 'token',
    });
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(writes(client)).toEqual([]);
    expect(client.released).toBe(false);
  });

  it('refuses when setup is already complete, checked under the row lock (E1)', async () => {
    const client = new FakeClient({ token_hash: hashSetupToken(TOKEN), completed_at: new Date() });
    expect(
      await storeWith(client).complete(input, { userAgent: undefined, ip: undefined }),
    ).toEqual({
      ok: false,
      reason: 'complete',
    });
    expect(client.statements.slice(0, 2)).toEqual([
      'BEGIN',
      'SELECT token_hash, completed_at FROM setup_state WHERE id = 1 FOR UPDATE',
    ]);
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(writes(client)).toEqual([]);
  });

  it('survives the connection dying mid-transaction: the request fails, the process does not', async () => {
    const client = new FakeClient(
      { token_hash: hashSetupToken(TOKEN), completed_at: null },
      'SELECT token_hash',
    );
    await expect(
      storeWith(client).complete(input, { userAgent: undefined, ip: undefined }),
    ).rejects.toThrow('terminating connection');
    expect(client.crashed).toBe(false);
    expect(client.released).toBe(true); // a broken connection goes, it isn't reused
    expect(client.listenerCount('error')).toBe(0); // and the listener doesn't outlive the checkout
  });
});
