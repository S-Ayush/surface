/**
 * The `email-send` queue (PLAN-001 S4, ADR-0010). A request never talks to the SMTP server: it
 * enqueues a job **on its own transaction's connection**, so the email goes out only if the
 * transaction commits, and a slow or failing SMTP server never holds a request or a lock. The
 * worker sends it and retries with backoff while the failure may pass.
 *
 * The job table works as the outbox here, not `event_outbox`: those rows are a public event
 * contract (webhooks, events.md), and an email job carries a credential (the link's token). The
 * payload is sealed (`seal.ts`), so the queue never holds a readable link.
 */
import type { PoolClient } from 'pg';
import type { Job, PgBoss, QueueOptions } from 'pg-boss';
import type { Logger } from 'pino';
import { z } from 'zod';
import { emailSealKey, seal, unseal, type SealKey } from './seal.js';
import {
  createMailer,
  maskSecrets,
  type Mailer,
  type MailerTimeouts,
  type SmtpSettings,
} from './smtp.js';
import { renderEmail } from './templates.js';

export const EMAIL_QUEUE = 'email-send';

/**
 * Retry policy: 5 retries with jittered exponential backoff from 15 s, capped at 5 min (roughly
 * 4–12 minutes in all), then the job fails; the last attempt logs an error. Delivery is at least
 * once: a lost `250` reply or an attempt that outlives `expireInSeconds` can send a duplicate.
 */
export const EMAIL_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 300,
  /** One attempt never runs longer than this (the mailer's own timeouts are shorter). */
  expireInSeconds: 120,
  /** Settled jobs go after a day; their payload is sealed anyway. */
  deleteAfterSeconds: 24 * 60 * 60,
} as const satisfies QueueOptions;

const Link = z.url({ protocol: /^https?$/ });
const Name = z.string().trim().min(1).max(200);

/** One email to send. Validated when enqueued and again when the worker opens it. */
export const EmailJobSchema = z.discriminatedUnion('template', [
  z.object({ template: z.literal('magicLink'), to: z.email(), workspaceName: Name, link: Link }),
  z.object({
    template: z.literal('passwordReset'),
    to: z.email(),
    workspaceName: Name,
    link: Link,
  }),
  z.object({
    template: z.literal('invite'),
    to: z.email(),
    workspaceName: Name,
    inviterName: Name,
    link: Link,
  }),
]);
export type EmailJob = z.infer<typeof EmailJobSchema>;

/** What the queue stores: nothing but the sealed email. */
const SealedPayload = z.object({ sealed: z.string() });
export type SealedPayload = z.infer<typeof SealedPayload>;

/** The part of pg-boss that enqueues. */
export type JobSender = Pick<PgBoss, 'send'>;

/**
 * Queues `email` on `client`, the request transaction's connection: it is sent only once that
 * transaction commits, and never if it rolls back. Returns the job id. A connection, never the
 * pool: on the pool the job would commit at once, whatever the request does.
 */
export async function enqueueEmail(
  sender: JobSender,
  client: PoolClient,
  key: SealKey,
  email: EmailJob,
): Promise<string | null> {
  const valid = EmailJobSchema.parse(email);
  const data: SealedPayload = { sealed: seal(key, JSON.stringify(valid)) };
  return sender.send(EMAIL_QUEUE, data, {
    db: { executeSql: (text, values) => client.query(text, values) },
  });
}

export type EmailJobResult =
  | { readonly status: 'sent'; readonly messageId: string }
  /** The SMTP server refused it for good; retrying would not help. */
  | { readonly status: 'rejected' }
  /** The payload could not be opened (another `SESSION_SECRET`, or not an email job). */
  | { readonly status: 'unreadable' };

export interface EmailWorkerDeps {
  readonly mailer: Mailer;
  readonly key: SealKey;
  readonly log: Logger;
}

/** The job as pg-boss hands it over; `retryCount` is 0 on the first attempt. */
export interface EmailJobAttempt {
  readonly id: string;
  readonly data: unknown;
  readonly retryCount: number;
}

/**
 * Sends one job's email. Throws on a failure that may pass (connection, timeout, 4xx), so
 * pg-boss retries; the error names only the SMTP error code, since pg-boss stores it.
 */
export async function processEmailJob(
  job: EmailJobAttempt,
  { mailer, key, log }: EmailWorkerDeps,
): Promise<EmailJobResult> {
  const email = openPayload(job.data, key);
  if (email === undefined) {
    log.error(
      { jobId: job.id },
      'email job could not be opened; was SESSION_SECRET changed? The email was not sent',
    );
    return { status: 'unreadable' };
  }
  const outcome = await mailer.send({ to: email.to, ...renderEmail(email) });
  const context = { jobId: job.id, template: email.template, attempt: job.retryCount + 1 };
  if (outcome.ok) {
    log.info({ ...context, messageId: outcome.messageId }, 'email sent');
    return { status: 'sent', messageId: outcome.messageId };
  }
  // A server's reply can quote what it refused: never log the link or its token (rule 6). The
  // recipient's address may still appear, as SMTP replies routinely quote it.
  const smtp = maskSecrets(outcome.failure, linkSecrets(email.link));
  if (outcome.permanent) {
    log.error({ ...context, smtp }, 'the SMTP server refused the email');
    return { status: 'rejected' };
  }
  if (job.retryCount >= EMAIL_QUEUE_OPTIONS.retryLimit) {
    log.error({ ...context, smtp }, 'email not sent; gave up after the last retry');
  } else {
    log.warn({ ...context, smtp }, 'email not sent yet; will retry');
  }
  throw new Error(`SMTP send failed (${outcome.failure.code ?? 'unknown error'})`);
}

/** The link and the parts of it that carry its token (a query value or the last path segment). */
function linkSecrets(link: string): string[] {
  const url = new URL(link);
  const segment = url.pathname.split('/').at(-1) ?? '';
  const parts = [...url.searchParams.values(), segment, decodeSafe(segment)];
  // Short parts are words like `reset`, not tokens.
  return [link, ...parts.filter((part) => part.length >= 12)];
}

function decodeSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function openPayload(data: unknown, key: SealKey): EmailJob | undefined {
  const payload = SealedPayload.safeParse(data);
  if (!payload.success) return undefined;
  const plain = unseal(key, payload.data.sealed);
  if (plain === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return undefined;
  }
  const email = EmailJobSchema.safeParse(parsed);
  return email.success ? email.data : undefined;
}

export interface EmailWorkerOptions {
  readonly smtp: SmtpSettings;
  readonly sessionSecret: string;
  readonly log: Logger;
  /** Seconds between polls when the queue is idle (tests make it short). */
  readonly pollingIntervalSeconds?: number;
  readonly timeouts?: MailerTimeouts;
}

/** Creates the queue. Every process that enqueues needs it, so the `web` role too. */
export async function createEmailQueue(boss: Pick<PgBoss, 'createQueue'>): Promise<void> {
  await boss.createQueue(EMAIL_QUEUE, EMAIL_QUEUE_OPTIONS);
}

export interface EmailWorker {
  /** Stops taking jobs (an email being sent finishes first). `boss.stop()` also covers it. */
  stop(): Promise<void>;
}

/** Starts sending queued emails (the `all` and `worker` roles, with SMTP configured). */
export async function startEmailWorker(
  boss: Pick<PgBoss, 'createQueue' | 'work' | 'offWork'>,
  { smtp, sessionSecret, log, pollingIntervalSeconds = 2, timeouts }: EmailWorkerOptions,
): Promise<EmailWorker> {
  const mailer = createMailer(smtp, timeouts);
  const deps: EmailWorkerDeps = {
    mailer,
    key: emailSealKey(sessionSecret),
    log: log.child({ component: 'mail' }),
  };
  await createEmailQueue(boss);
  await boss.work(
    EMAIL_QUEUE,
    { pollingIntervalSeconds, batchSize: 1 },
    // One job per call (`batchSize: 1`); the result is stored as the job's output.
    async ([job]: Job<unknown>[]) => (job === undefined ? undefined : processEmailJob(job, deps)),
  );
  return {
    stop: async () => {
      await boss.offWork(EMAIL_QUEUE);
      mailer.close();
    },
  };
}
