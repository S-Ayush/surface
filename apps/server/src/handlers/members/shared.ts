/** Output shape and list model of the member handlers (PLAN-001 S7). */
import { defineFilterFields, USER_ROLES } from '@surface/domain';
import type { UserSchema } from '@surface/operations';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { users } from '../../db/schema/index.js';
import { defineFilterModel } from '../../executor/filter-sql.js';
import { defineListModel } from '../../executor/list.js';

type UserOutput = z.input<typeof UserSchema>;

export function userOutput(row: {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly displayName: string;
  readonly avatarFileId: string | null;
  readonly timezone: string;
  readonly role: UserOutput['role'];
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): UserOutput {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    displayName: row.displayName,
    avatarFileId: row.avatarFileId,
    timezone: row.timezone,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `user.list`: every user row the actor can see (all of them: users sync to the workspace
 * group). Deactivated users (M7) are listed too; filter on `active` to leave them out.
 */
export const userListModel = defineListModel({
  table: users,
  filter: defineFilterModel({
    fields: defineFilterFields({
      role: { type: 'enum', values: USER_ROLES },
      active: { type: 'boolean' },
      name: { type: 'text' },
      displayName: { type: 'text' },
      email: { type: 'text' },
      createdAt: { type: 'instant' },
    }),
    columns: () => ({
      role: sql`${users.role}`,
      active: sql`${users.active}`,
      name: sql`${users.name}`,
      displayName: sql`${users.displayName}`,
      email: sql`${users.email}`,
      createdAt: sql`${users.createdAt}`,
    }),
  }),
  order: { name: 'text', displayName: 'text', email: 'text', createdAt: 'instant' },
  defaultOrder: { field: 'name', direction: 'asc' },
  teamColumn: null,
});
