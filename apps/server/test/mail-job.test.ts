// PLAN-001 S4: the `email-send` queue. A request enqueues on its own transaction's connection
// (so a rolled-back request sends nothing), the queue holds only a sealed payload, and the worker
// sends, gives up, or throws so pg-boss retries. Neither the queue, the logs nor the error that
// pg-boss stores ever carries the link (CLAUDE.md rule 6). Real pg-boss on Postgres was checked
// by hand (PLAN-001 S4 "As built"; new integration tests are on hold).
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  EMAIL_QUEUE,
  EMAIL_QUEUE_OPTIONS,
  enqueueEmail,
  processEmailJob,
  startEmailWorker,
  type EmailJob,
  type JobSender,
} from '../src/mail/job.js';
import { emailSealKey, seal, unseal } from '../src/mail/seal.js';
import type { Mailer, OutgoingEmail, SendOutcome } from '../src/mail/smtp.js';
import { captureLogs } from './helpers.js';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.js';

const SECRET = 'a'.repeat(64);
const key = emailSealKey(SECRET);
const TOKEN = 'magic-token-5f0c2a9e7b1d4c3a';
const email: EmailJob = {
  template: 'magicLink',
  to: 'ada@example.com',
  workspaceName: 'Acme',
  link: `https://surface.example.com/auth/magic?token=${TOKEN}`,
};

/** Records `send` calls the way pg-boss receives them. */
function fakeSender() {
  const calls: { name: string; data: unknown; options: unknown }[] = [];
  const sender: JobSender = {
    send: vi.fn((...args: unknown[]) => {
      const [name, data, options] = args;
      calls.push({ name: String(name), data, options });
      return Promise.resolve('job-1');
    }),
  };
  return { sender, calls };
}

function fakeMailer(outcome: SendOutcome) {
  const sent: OutgoingEmail[] = [];
  const mailer: Mailer = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve(outcome);
    },
    close: () => undefined,
  };
  return { mailer, sent };
}

describe('enqueueEmail', () => {
  it('queues on the given connection, so the job commits or rolls back with the request', async () => {
    const { sender, calls } = fakeSender();
    const query = vi.fn(() => Promise.resolve({ rows: [{ id: 'job-1' }] }));
    const client = { query } as unknown as PoolClient;

    await expect(enqueueEmail(sender, client, key, email)).resolves.toBe('job-1');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.name).toBe(EMAIL_QUEUE);
    // pg-boss runs its INSERT through `db`, which is the request's connection.
    const db = (call?.options as { db: { executeSql(text: string, values: unknown[]): unknown } })
      .db;
    await db.executeSql('INSERT …', [1, 2]);
    expect(query).toHaveBeenCalledWith('INSERT …', [1, 2]);
  });

  it('stores only a sealed payload: no address, link or token in the queue', async () => {
    const { sender, calls } = fakeSender();
    await enqueueEmail(sender, { query: vi.fn() } as unknown as PoolClient, key, email);
    const data = calls[0]?.data;
    expect(Object.keys(data as object)).toEqual(['sealed']);
    const stored = JSON.stringify(data);
    for (const secret of [TOKEN, 'ada@example.com', 'surface.example.com']) {
      expect(stored).not.toContain(secret);
    }
    expect(JSON.parse(unseal(key, (data as { sealed: string }).sealed) ?? '')).toEqual(email);
  });

  it('refuses an email it could not send before touching the queue', async () => {
    const { sender, calls } = fakeSender();
    const client = { query: vi.fn() } as unknown as PoolClient;
    const bad = [
      { ...email, to: 'not an address' },
      { ...email, link: 'javascript:alert(1)' },
      { ...email, workspaceName: '  ' },
      { template: 'invite', to: 'a@b.co', workspaceName: 'Acme', link: email.link },
    ];
    for (const value of bad) {
      await expect(enqueueEmail(sender, client, key, value as EmailJob)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
});

describe('processEmailJob', () => {
  const job = (data: unknown, retryCount = 0) => ({ id: 'job-7', data, retryCount });
  const sealed = (value: unknown) => ({ sealed: seal(key, JSON.stringify(value)) });

  it('renders and sends the email, and logs no link', async () => {
    const logs = captureLogs();
    const { mailer, sent } = fakeMailer({ ok: true, messageId: '<m1@example.com>' });
    const result = await processEmailJob(job(sealed(email)), {
      mailer,
      key,
      log: pino({ level: 'info' }, logs.stream),
    });

    expect(result).toEqual({ status: 'sent', messageId: '<m1@example.com>' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ada@example.com');
    expect(sent[0]?.subject).toBe('Your login link for Acme');
    expect(sent[0]?.text).toContain(email.link);
    expect(logs.lines).toEqual([
      expect.objectContaining({ msg: 'email sent', jobId: 'job-7', template: 'magicLink' }),
    ]);
    expect(logs.text()).not.toContain(TOKEN);
  });

  it('gives up without retrying when the server refuses the email for good', async () => {
    const logs = captureLogs();
    const { mailer } = fakeMailer({
      ok: false,
      permanent: true,
      failure: { code: 'EENVELOPE', responseCode: 550, message: '550 No such user' },
    });
    const result = await processEmailJob(job(sealed(email)), {
      mailer,
      key,
      log: pino({ level: 'info' }, logs.stream),
    });
    expect(result).toEqual({ status: 'rejected' });
    expect(logs.lines[0]).toMatchObject({ level: 50, smtp: { responseCode: 550 } });
  });

  it('throws so pg-boss retries a failure that may pass, naming only the error code', async () => {
    const logs = captureLogs();
    const { mailer } = fakeMailer({
      ok: false,
      permanent: false,
      failure: { code: 'ECONNECTION', message: 'connect ECONNREFUSED' },
    });
    const run = processEmailJob(job(sealed(email)), {
      mailer,
      key,
      log: pino({ level: 'info' }, logs.stream),
    });
    await expect(run).rejects.toThrow('SMTP send failed (ECONNECTION)');
    await run.catch((error: unknown) => {
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain('ada@example.com');
    });
    expect(logs.lines[0]).toMatchObject({ level: 40, jobId: 'job-7', attempt: 1 });
  });

  it('logs an error when the last retry fails too', async () => {
    const failing = (): SendOutcome => ({
      ok: false,
      permanent: false,
      failure: { code: 'ETIMEDOUT', message: 'Connection timeout' },
    });
    const last = EMAIL_QUEUE_OPTIONS.retryLimit;
    for (const [retryCount, level] of [
      [last - 1, 40],
      [last, 50],
    ] as const) {
      const logs = captureLogs();
      const { mailer } = fakeMailer(failing());
      await expect(
        processEmailJob(job(sealed(email), retryCount), {
          mailer,
          key,
          log: pino({ level: 'info' }, logs.stream),
        }),
      ).rejects.toThrow('SMTP send failed (ETIMEDOUT)');
      expect(logs.lines[0]).toMatchObject({ level, attempt: retryCount + 1 });
    }
  });

  it('masks the link and its token when the server quotes them back', async () => {
    const invite: EmailJob = {
      template: 'invite',
      to: 'ada@example.com',
      workspaceName: 'Acme',
      inviterName: 'Iris',
      link: `https://surface.example.com/invite/${TOKEN}`,
    };
    for (const [value, permanent] of [
      [email, true],
      [email, false],
      [invite, true],
    ] as const) {
      const logs = captureLogs();
      const { mailer } = fakeMailer({
        ok: false,
        permanent,
        failure: {
          code: 'EMESSAGE',
          responseCode: permanent ? 554 : 451,
          message: `Content filter: blocked ${value.link} (token ${TOKEN})`,
        },
      });
      await processEmailJob(job(sealed(value)), {
        mailer,
        key,
        log: pino({ level: 'info' }, logs.stream),
      }).catch(() => undefined);
      expect(logs.lines).toHaveLength(1);
      expect(logs.text()).toContain('Content filter: blocked [redacted] (token [redacted])');
      expect(logs.text()).not.toContain(TOKEN);
    }
  });

  it('drops a payload it cannot open, without sending or retrying', async () => {
    const otherKey = emailSealKey('b'.repeat(64));
    const unreadable = [
      { sealed: seal(otherKey, JSON.stringify(email)) },
      { sealed: 'v1.garbage.garbage' },
      sealed({ ...email, template: 'unknown' }),
      { sealed: seal(key, 'not json') },
      email,
      null,
    ];
    for (const data of unreadable) {
      const logs = captureLogs();
      const { mailer, sent } = fakeMailer({ ok: true, messageId: 'x' });
      const result = await processEmailJob(job(data), {
        mailer,
        key,
        log: pino({ level: 'info' }, logs.stream),
      });
      expect(result).toEqual({ status: 'unreadable' });
      expect(sent).toHaveLength(0);
      expect(logs.text()).not.toContain(TOKEN);
    }
  });
});

describe('startEmailWorker', () => {
  let smtp: FakeSmtp | undefined;
  afterEach(async () => {
    await smtp?.close();
    smtp = undefined;
  });

  it('creates the queue with its retry policy and sends what the queue hands it', async () => {
    smtp = await startFakeSmtp();
    let handler:
      ((jobs: { id: string; data: unknown; retryCount: number }[]) => Promise<unknown>) | undefined;
    const boss = {
      createQueue: vi.fn(() => Promise.resolve()),
      work: vi.fn((_name: string, _options: unknown, fn: typeof handler) => {
        handler = fn;
        return Promise.resolve('worker-1');
      }),
      offWork: vi.fn(() => Promise.resolve()),
    };

    const worker = await startEmailWorker(boss as never, {
      smtp: { url: `smtp://127.0.0.1:${smtp.port}`, from: 'Surface <surface@example.com>' },
      sessionSecret: SECRET,
      log: pino({ level: 'silent' }),
    });

    expect(boss.createQueue).toHaveBeenCalledWith(EMAIL_QUEUE, EMAIL_QUEUE_OPTIONS);
    expect(boss.work).toHaveBeenCalledWith(
      EMAIL_QUEUE,
      expect.objectContaining({ batchSize: 1 }),
      expect.any(Function),
    );
    const { sender, calls } = fakeSender();
    await enqueueEmail(sender, { query: vi.fn() } as unknown as PoolClient, key, email);
    const result = await handler?.([{ id: 'job-9', data: calls[0]?.data, retryCount: 0 }]);
    await worker.stop();

    expect(result).toMatchObject({ status: 'sent' });
    expect(boss.offWork).toHaveBeenCalledWith(EMAIL_QUEUE);
    const mail = await smtp.nextMessage();
    expect(mail.to).toEqual(['ada@example.com']);
    expect(mail.decoded).toContain(email.link);
  });
});
