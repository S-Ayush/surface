// What the executor gives handlers beyond the repo (PLAN-001 S3 follow-up, session E's handoff):
// `ctx.closeSessions` ends sessions in the operation's transaction and closes their sockets only
// after it commits (AC-8), `ctx.enqueueEmail` queues on that same transaction (PLAN-001 S4), and
// `ctx.audit` writes its line only for the attempt that committed (PLAN-001 S9).
// Against a scripted connection: no database (new integration tests are held, plans README §6).
import { userActor } from '@surface/domain';
import { createRegistry, defineOperation } from '@surface/operations';
import type { PoolClient } from 'pg';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Pool } from '../src/db/pool.js';
import { handler, type HandlerContext } from '../src/executor/context.js';
import { createExecutor } from '../src/executor/execute.js';
import { transactionRunner } from '../src/executor/transaction.js';
import type { EmailOutbox } from '../src/jobs/email.js';
import type { EmailJob } from '../src/mail/job.js';
import { captureLogs } from './helpers.js';

const endSessions = defineOperation({
  name: 'debug.endSessions',
  kind: 'mutation',
  domain: 'debug',
  summary: 'End sessions (test only)',
  description: 'Test fixture: runs a handler written by the test.',
  keywords: ['test', 'sessions'],
  input: z.object({}),
  output: z.object({}),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}],
  internal: true,
});

const ME = userActor({ userId: 'u1', role: 'member', memberships: [], sessionId: 's-mine' });
const EMAIL: EmailJob = {
  template: 'passwordReset',
  to: 'ada@example.com',
  workspaceName: 'Acme',
  link: 'https://surface.example.com/reset/abcdefghijklmnopqrstuvwxyz',
};

interface Script {
  /** Rows the `DELETE … RETURNING id` answers, per attempt. */
  readonly deleted?: readonly string[][];
  /** Make the first COMMIT fail as a serialization failure, so the transaction runs again. */
  readonly failFirstCommit?: boolean;
  /** Who registered the sync client: its `client_mutations` row, at seq 0. */
  readonly clientOwner?: string;
}

/** One connection that records what it is sent, and answers as `script` says. */
function scriptedPool(script: Script = {}) {
  const log: string[] = [];
  let deletes = 0;
  let commits = 0;
  const client = {
    query(text: string, values: unknown[] = []) {
      const statement = text.replace(/\s+/g, ' ').trim();
      log.push(statement.split(' ').slice(0, 2).join(' '));
      if (statement.startsWith('DELETE FROM sessions')) {
        const ids = script.deleted?.[deletes++] ?? [];
        log.push(`  ${JSON.stringify(values)}`);
        return Promise.resolve({ rows: ids.map((id) => ({ id })), rowCount: ids.length });
      }
      if (statement.includes('FROM client_mutations WHERE client_id') && script.clientOwner) {
        const row = { user_id: script.clientOwner, last_seq: '0', stored: null };
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (statement === 'COMMIT' && script.failFirstCommit && commits++ === 0) {
        return Promise.reject(Object.assign(new Error('could not serialize'), { code: '40001' }));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  // Only `connect`, `query` and `release` are used; pg's overloads are more than a stand-in can match.
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, client, log };
}

function executorWith(
  pool: Pool,
  run: (ctx: HandlerContext) => Promise<void>,
  extra: { email?: EmailOutbox; closed?: string[][]; log?: Logger } = {},
) {
  return createExecutor({
    pool,
    registry: createRegistry([endSessions]),
    handlers: [
      handler(endSessions, async (ctx) => {
        await run(ctx);
        return {};
      }),
    ],
    log: extra.log ?? pino({ level: 'silent' }),
    allowInternal: true,
    backoff: () => 0,
    ...(extra.email ? { email: extra.email } : {}),
    ...(extra.closed ? { closeSessions: (ids) => void extra.closed?.push([...ids]) } : {}),
  });
}

describe('ctx.closeSessions', () => {
  it('ends the sessions in the operation and closes their sockets after it commits', async () => {
    const { pool, log } = scriptedPool({ deleted: [['s-laptop', 's-phone']] });
    const closed: string[][] = [];
    let ended: number | undefined;
    const executor = executorWith(
      pool,
      async (ctx) => {
        ended = await ctx.closeSessions('u1', { except: ctx.actor.sessionId ?? 'none' });
        // Nothing is closed while the transaction is open: a socket could reconnect meanwhile.
        expect(closed).toEqual([]);
      },
      { closed },
    );
    const outcome = await executor.execute('debug.endSessions', {}, ME);
    expect(outcome.ok).toBe(true);
    expect(ended).toBe(2);
    expect(closed).toEqual([['s-laptop', 's-phone']]);
    // The delete ran inside the transaction, keeping the caller's own session.
    expect(log).toEqual(['BEGIN ISOLATION', 'DELETE FROM', '  ["u1",null,"s-mine"]', 'COMMIT']);
  });

  it('closes nothing when the operation fails, since its delete rolls back', async () => {
    const { pool, log } = scriptedPool({ deleted: [['s-laptop']] });
    const closed: string[][] = [];
    const executor = executorWith(
      pool,
      async (ctx) => {
        await ctx.closeSessions('u1', { all: true });
        throw new Error('the handler fails after ending sessions');
      },
      { closed },
    );
    const outcome = await executor.execute('debug.endSessions', {}, ME);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(log).toContain('ROLLBACK');
    expect(closed).toEqual([]);
  });

  it('closes only what the attempt that committed ended, when the transaction is retried', async () => {
    const { pool } = scriptedPool({
      deleted: [['s-first-attempt'], ['s-second-attempt']],
      failFirstCommit: true,
    });
    const closed: string[][] = [];
    const executor = executorWith(
      pool,
      (ctx) => ctx.closeSessions('u1', { all: true }).then(() => undefined),
      {
        closed,
      },
    );
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(closed).toEqual([['s-second-attempt']]);
  });

  it('still answers ok when closing the sockets fails, since the operation committed', async () => {
    const { pool, log } = scriptedPool({ deleted: [['s-laptop']] });
    const executor = createExecutor({
      pool,
      registry: createRegistry([endSessions]),
      handlers: [
        handler(endSessions, async (ctx) => {
          await ctx.closeSessions('u1', { all: true });
          return {};
        }),
      ],
      log: pino({ level: 'silent' }),
      allowInternal: true,
      closeSessions: () => {
        throw new Error('the hub is gone');
      },
    });
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(log).toContain('COMMIT');
  });

  it('closes nothing when no session matched', async () => {
    const { pool } = scriptedPool({ deleted: [[]] });
    const closed: string[][] = [];
    let ended: number | undefined;
    const executor = executorWith(
      pool,
      async (ctx) => {
        ended = await ctx.closeSessions('u1', { only: 'someone-elses-session' });
      },
      { closed },
    );
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(ended).toBe(0);
    expect(closed).toEqual([]);
  });
});

describe('ctx.enqueueEmail', () => {
  it('queues on the operation’s own connection, so the email commits or rolls back with it', async () => {
    const { pool, client } = scriptedPool();
    const queued: { client: PoolClient; email: EmailJob }[] = [];
    const email: EmailOutbox = {
      enabled: true,
      enqueue: (on, job) => {
        queued.push({ client: on, email: job });
        return Promise.resolve(true);
      },
    };
    let result: boolean | undefined;
    const executor = executorWith(
      pool,
      async (ctx) => {
        result = await ctx.enqueueEmail(EMAIL);
      },
      { email },
    );
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(result).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.client).toBe(client);
    expect(queued[0]?.email).toEqual(EMAIL);
  });

  it('queues nothing and says so when SMTP isn’t configured', async () => {
    const { pool } = scriptedPool();
    let result: boolean | undefined;
    const executor = executorWith(pool, async (ctx) => {
      result = await ctx.enqueueEmail(EMAIL);
    });
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(result).toBe(false);
  });
});

describe('ctx.audit', () => {
  function audited(logs: ReturnType<typeof captureLogs>) {
    return logs.lines.filter((l) => l.audit === true).map((l) => [l.event, l.to, l.msg]);
  }

  it('logs the line of the attempt that committed, once, when the transaction is retried', async () => {
    const { pool, log } = scriptedPool({ failFirstCommit: true });
    const logs = captureLogs();
    let attempt = 0;
    const executor = executorWith(
      pool,
      (ctx) => {
        attempt += 1;
        ctx.audit(
          'user.role_changed',
          { userId: 'u2', from: 'member', to: `attempt ${attempt}` },
          'Role',
        );
        return Promise.resolve();
      },
      { log: pino({ level: 'info' }, logs.stream) },
    );
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(true);
    expect(log.filter((l) => l === 'COMMIT')).toHaveLength(2);
    expect(audited(logs)).toEqual([['user.role_changed', 'attempt 2', 'Role']]);
  });

  it('logs nothing when the operation fails and rolls back', async () => {
    const { pool } = scriptedPool();
    const logs = captureLogs();
    const executor = executorWith(
      pool,
      (ctx) => {
        ctx.audit('user.role_changed', { userId: 'u2' }, 'Role');
        return Promise.reject(new Error('the handler fails after recording a line'));
      },
      { log: pino({ level: 'info' }, logs.stream) },
    );
    expect((await executor.execute('debug.endSessions', {}, ME)).ok).toBe(false);
    expect(audited(logs)).toEqual([]);
  });

  it('logs the line of a sync mutation once it commits', async () => {
    const { pool, log } = scriptedPool({ clientOwner: 'u1' });
    const logs = captureLogs();
    const executor = executorWith(
      pool,
      (ctx) => {
        ctx.audit('user.role_changed', { userId: 'u2', from: 'member', to: 'admin' }, 'Role');
        return Promise.resolve();
      },
      { log: pino({ level: 'info' }, logs.stream) },
    );
    const origin = { clientId: '0190a0c0-0000-7000-8000-000000000001', seq: 1 };
    const outcome = await executor.executeSynced('debug.endSessions', {}, ME, origin);
    expect(outcome).toMatchObject({ kind: 'result', result: { seq: 1, status: 'ok' } });
    expect(log).toContain('COMMIT');
    expect(audited(logs)).toEqual([['user.role_changed', 'admin', 'Role']]);
  });

  it('logs nothing for a sync mutation that is rejected and rolled back to its savepoint', async () => {
    const { pool, log } = scriptedPool({ clientOwner: 'u1' });
    const logs = captureLogs();
    const executor = executorWith(
      pool,
      (ctx) => {
        ctx.audit('user.role_changed', { userId: 'u2' }, 'Role');
        return Promise.reject(new Error('the handler fails after recording a line'));
      },
      { log: pino({ level: 'info' }, logs.stream) },
    );
    const origin = { clientId: '0190a0c0-0000-7000-8000-000000000001', seq: 1 };
    const outcome = await executor.executeSynced('debug.endSessions', {}, ME, origin);
    expect(outcome).toMatchObject({ kind: 'result', result: { seq: 1, status: 'error' } });
    // The rejection is recorded and committed; only the mutation's own work was undone.
    expect(log).toContain('ROLLBACK TO');
    expect(log).toContain('COMMIT');
    expect(audited(logs)).toEqual([]);
  });
});

describe('transactionRunner (routes outside the executor)', () => {
  it('runs a route’s writes and its email on one connection, in one transaction', async () => {
    const { pool, client, log } = scriptedPool({ deleted: [['s-old']] });
    const withTransaction = transactionRunner(pool, { backoff: () => 0 });
    const seen: unknown[] = [];
    const ended = await withTransaction(async (on) => {
      seen.push(on);
      await on.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', ['u1']);
      return 'done';
    });
    expect(ended).toBe('done');
    expect(seen).toEqual([client]);
    expect(log).toEqual(['BEGIN ISOLATION', 'DELETE FROM', '  ["u1"]', 'COMMIT']);
  });

  it('rolls back when the route fails, so its email is never queued', async () => {
    const { pool, log } = scriptedPool();
    const withTransaction = transactionRunner(pool, { backoff: () => 0 });
    await expect(
      withTransaction(() => Promise.reject(new Error('the route fails'))),
    ).rejects.toThrow('the route fails');
    expect(log).toEqual(['BEGIN ISOLATION', 'ROLLBACK']);
  });
});
