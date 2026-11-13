/** `DraftAccess` over the operation's Postgres transaction, and the draft output shape. */
import type { DraftSchema } from '@surface/operations';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { drafts, users } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import type { DraftAccess, DraftRow } from './core.js';

export function draftOutput(row: DraftRow): z.input<typeof DraftSchema> {
  return {
    id: row.id,
    kind: row.kind,
    teamId: row.teamId,
    issueId: row.issueId,
    data: toJson(row.data),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Json = z.input<typeof DraftSchema>['data'];

/** jsonb comes back as parsed JSON; anything else would be a bug in the column, so say null. */
function toJson(value: unknown): Json {
  return isJson(value) ? value : null;
}

function isJson(value: unknown): value is Json {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && Object.values(value).every(isJson);
}

export function draftAccess(ctx: HandlerContext): DraftAccess {
  const { tx } = ctx;
  return {
    async lockOwner(userId) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('no key update');
    },
    async find(userId, key) {
      const [row] = await tx
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.kind, key.kind),
            key.kind === 'composer'
              ? eq(drafts.teamId, key.teamId)
              : eq(drafts.issueId, key.issueId),
          ),
        );
      return row;
    },
    async commentDraftsBeyond(userId, keep) {
      const rows = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.userId, userId), eq(drafts.kind, 'comment')))
        .orderBy(desc(drafts.updatedAt), desc(drafts.id))
        .offset(keep);
      return rows.map((row) => row.id);
    },
  };
}
