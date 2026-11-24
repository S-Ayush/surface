/**
 * The producer side of the `files-preview` queue (SPEC-014 §4.4; PLAN-014 S4b): what every role
 * needs to queue a preview, `web` included. The job itself is `files-preview.ts`; only the `all`
 * and `worker` roles run it. Kept apart so the executor (which queues) doesn't import the job
 * (which runs operations through the executor).
 */
import type { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { JobSender } from '../mail/job.js';

/** The queue (ADR-0024). Retries cover a busy decode queue or a database hiccup. */
export const PREVIEW_QUEUE = {
  name: 'files-preview',
  policy: 'stately',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  // A decode of a 25 MP image takes seconds; a job still running after 10 minutes is stuck.
  expireInSeconds: 10 * 60,
} as const;

/**
 * Creates the queue: every role that queues previews needs it, `web` included (§4.4). pg-boss's
 * `createQueue` leaves an existing queue as it is, so a change to `PREVIEW_QUEUE`'s options
 * reaches an installed database only through `updateQueue` (the policy can't change at all).
 */
export async function createPreviewQueue(boss: Pick<PgBoss, 'createQueue'>): Promise<void> {
  const { name, ...options } = PREVIEW_QUEUE;
  await boss.createQueue(name, options);
}

/** The job's data: the claimed file. */
export const PreviewPayload = z.object({ fileId: z.uuid() });

/**
 * Queues `fileId`'s preview on `client`, the operation transaction's connection: the job exists
 * only once that transaction commits. A connection, never the pool.
 */
export async function enqueuePreview(
  sender: JobSender,
  client: PoolClient,
  fileId: string,
): Promise<void> {
  await sender.send(
    PREVIEW_QUEUE.name,
    PreviewPayload.parse({ fileId }),
    // A job already queued for the file does the work: `send` then inserts nothing.
    { singletonKey: fileId, db: { executeSql: (text, values) => client.query(text, values) } },
  );
}

/** Where `ctx.enqueuePreview` queues (SPEC-014 §4.4). */
export interface PreviewOutbox {
  enqueue(client: PoolClient, fileId: string): Promise<void>;
}

/** Queues on pg-boss once startup has started it (requests are answered 503 until then). */
export function previewOutbox(sender: () => JobSender | undefined): PreviewOutbox {
  return {
    async enqueue(client, fileId) {
      const boss = sender();
      if (boss === undefined) throw new Error('The preview queue has not started yet');
      await enqueuePreview(boss, client, fileId);
    },
  };
}

/** Queues nothing: for executors built without a job queue (tests). */
export const NO_PREVIEWS: PreviewOutbox = { enqueue: () => Promise.resolve() };
