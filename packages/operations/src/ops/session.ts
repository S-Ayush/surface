/**
 * Your sessions (SPEC-001 §3.5, §6.2; PLAN-001 S6): the browsers signed in to your account, and
 * logging them out. Sessions are server-side only (never synced); each operation sees the
 * actor's own sessions, and another user's session is NOT_FOUND. An ended session's sockets
 * close with `4001` (AC-8).
 */
import { SessionRef } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import { Timestamp } from './shared.js';

/** The seed fixture's second session of its actor (server `test/seed.ts`). */
const EXAMPLE_SESSION_ID = '01930000-0000-7000-8000-000000000601';

export const SessionSchema = z.object({
  id: z.uuid(),
  /** The browser's User-Agent at sign-in, if it sent one; the client words it as a device. */
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
  /** The session making this request ("this device"). */
  current: z.boolean(),
});

export const sessionList = defineOperation({
  name: 'session.list',
  kind: 'query',
  domain: 'user',
  summary: 'List your sessions',
  description:
    'Lists the browsers signed in to your account: device, IP address, sign-in and last-active times, and which one is this session (current). Filter by current, ip, userAgent, createdAt or lastUsedAt; sort by lastUsedAt (default, most recent first) or createdAt.',
  keywords: ['active sessions', 'where am i logged in', 'signed in devices'],
  input: z.object({ ...listInput }),
  output: connectionOf(SessionSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}, { filter: { field: 'current', op: 'eq', value: false } }],
});

export const sessionRevoke = defineOperation({
  name: 'session.revoke',
  kind: 'mutation',
  domain: 'user',
  summary: 'Log out one of your sessions',
  description:
    'Ends one of your sessions, by id from session.list: that browser is logged out at once. Revoking this session logs you out.',
  keywords: ['revoke session', 'log out device', 'sign out browser'],
  input: z.object({ session: SessionRef }),
  output: z.object({ revoked: z.boolean() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ session: EXAMPLE_SESSION_ID }],
});

export const sessionRevokeOthers = defineOperation({
  name: 'session.revokeOthers',
  kind: 'mutation',
  domain: 'user',
  summary: 'Log out all your other sessions',
  description:
    'Ends every session of yours except this one: every other browser is logged out at once.',
  keywords: ['log out everywhere', 'revoke all sessions', 'sign out other devices'],
  input: z.object({}),
  output: z.object({ revoked: z.number().int().nonnegative() }),
  permission: (p) => p.any(),
  // Run with an API key (M6), which has no session to keep, it logs the person out everywhere:
  // only a key allowed destructive operations may (SPEC-001 §6.2, S6 review).
  destructive: true,
  examples: [{}],
});
