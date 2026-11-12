// `session.list` (SPEC-001 §3.5; PLAN-001 S6): the actor's live sessions, with "this device"
// marked. Sessions are server-side only and few, so they are read whole and paged in memory.
import { defineFilterFields } from '@surface/domain';
import { sessionList, type SessionSchema } from '@surface/operations';
import { and, eq, gt } from 'drizzle-orm';
import type { z } from 'zod';
import { sessions } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { memoryPage, type MemoryListModel } from '../memory-list.js';
import { actorUserId } from '../users/self.js';

type Session = z.input<typeof SessionSchema>;

const SESSION_LIST: MemoryListModel = {
  noun: 'sessions',
  filterFields: defineFilterFields({
    current: { type: 'boolean' },
    ip: { type: 'text' },
    userAgent: { type: 'text' },
    createdAt: { type: 'instant' },
    lastUsedAt: { type: 'instant' },
  }),
  orderFields: { lastUsedAt: 'instant', createdAt: 'instant' },
  defaultOrder: { field: 'lastUsedAt', direction: 'desc' },
};

export default handler(sessionList, async (ctx, input) => {
  const userId = actorUserId(ctx);
  const now = ctx.now();
  const rows = await ctx.tx
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)));
  const all = rows.map((row): Session => ({
    id: row.id,
    userAgent: row.userAgent,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    current: row.id === ctx.actor.sessionId,
  }));
  return memoryPage(SESSION_LIST, all, input, { now, me: userId });
});
