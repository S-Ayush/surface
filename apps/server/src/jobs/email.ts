/**
 * Queuing email from a request (PLAN-001 S4, "via the outbox"): handlers through
 * `ctx.enqueueEmail`, routes through the deps they are given. The email is queued on the
 * caller's own transaction, so it is sent only if that transaction commits; the SMTP
 * conversation happens later, in a worker (`startEmailWorker`).
 */
import type { PoolClient } from 'pg';
import { enqueueEmail, type EmailJob, type JobSender } from '../mail/job.js';
import { emailSealKey } from '../mail/seal.js';

export interface EmailOutbox {
  /** Whether SMTP is configured (`SMTP_URL` and `SMTP_FROM`). Without it nothing is queued. */
  readonly enabled: boolean;
  /**
   * Queues `email` on `client`, the caller's open transaction. Returns `false`, queuing
   * nothing, when SMTP isn't configured: the caller then offers the link another way.
   */
  enqueue(client: PoolClient, email: EmailJob): Promise<boolean>;
}

export interface EmailOutboxOptions {
  readonly enabled: boolean;
  readonly sessionSecret: string;
  /** pg-boss, once startup has started it; `undefined` before. */
  readonly sender: () => JobSender | undefined;
}

export function emailOutbox({ enabled, sessionSecret, sender }: EmailOutboxOptions): EmailOutbox {
  const key = emailSealKey(sessionSecret);
  return {
    enabled,
    async enqueue(client, email) {
      if (!enabled) return false;
      const boss = sender();
      // Requests are answered 503 until startup has started the queue (`Lifecycle.everReady`).
      if (boss === undefined) throw new Error('The email queue has not started yet');
      await enqueueEmail(boss, client, key, email);
      return true;
    },
  };
}

/** No SMTP: nothing is ever queued. For tests and for apps built without mail. */
export const NO_EMAIL: EmailOutbox = {
  enabled: false,
  enqueue: () => Promise.resolve(false),
};
