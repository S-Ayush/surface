/**
 * Member operations (SPEC-001 §3.6, §6.2; PLAN-001 S7). Anyone reads the people in the workspace
 * (their rows sync to everyone, email included: SPEC-001 §5); only Admins change roles
 * (permissions.md §3.1). A role change that would leave no active Admin is refused (INV-01, E6).
 */
import { USER_ROLES, UserRef } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { Timestamp } from './shared.js';
import { connectionOf, listInput } from '../list.js';

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  displayName: z.string(),
  avatarFileId: z.uuid().nullable(),
  timezone: z.string(),
  role: z.enum(USER_ROLES),
  /** False once deactivated (M7). */
  active: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const userList = defineOperation({
  name: 'user.list',
  kind: 'query',
  domain: 'user',
  summary: 'List the people in the workspace',
  description:
    'Lists users with their email, display name, role and join date. Filter by role (admin, member), active, name, displayName, email or createdAt; sort by name, displayName, email or createdAt (default name).',
  keywords: ['list users', 'list members', 'who is in the workspace', 'find admins'],
  input: z.object({ ...listInput }),
  output: connectionOf(UserSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ filter: { field: 'role', op: 'eq', value: 'admin' } }],
});

export const userGet = defineOperation({
  name: 'user.get',
  kind: 'query',
  domain: 'user',
  summary: 'Get a user',
  description:
    'Returns one user: email, name, display name, role, time zone and join date. Accepts an email, a display name, "me" or a user id.',
  keywords: ['get user', 'look up a person', 'user details', 'who is'],
  input: z.object({ user: UserRef }),
  output: UserSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ user: 'me' }],
});

export const userSetRole = defineOperation({
  name: 'user.setRole',
  kind: 'mutation',
  domain: 'user',
  summary: 'Change a user’s role',
  description:
    'Makes a user an Admin or a Member. Admins manage members, invites and workspace settings. The last active Admin cannot become a Member. Setting the role a user already has changes nothing. Admins only. Accepts an email, a display name or a user id.',
  keywords: ['make admin', 'change role', 'promote to admin', 'demote admin'],
  input: z.object({ user: UserRef, role: z.enum(USER_ROLES) }),
  output: UserSchema,
  permission: (p) => p.admin(),
  destructive: false,
  // Back to Member after: the registry contract test runs examples in order on one seed.
  examples: [
    { user: 'iris@example.com', role: 'admin' },
    { user: 'iris@example.com', role: 'member' },
  ],
  // The last-Admin guard is the server's (it sees every Admin); the UI disables that change.
  optimistic: (store, input) => {
    store.patch('User', input.user, { role: input.role, updatedAt: store.now.toISOString() });
  },
});
