// `user.updateProfile` (SPEC-001 §3.5, §6.2; PLAN-001 S6): the actor's own name, display name,
// avatar and time zone. The user row is synced, so the change is live in every client (AC-15).
import {
  canonicalTimeZone,
  displayNameSuggestionPrefix,
  displayNameTakenMessage,
  suggestDisplayName,
} from '@surface/domain';
import { userUpdateProfile } from '@surface/operations';
import { eq, sql } from 'drizzle-orm';
import { users } from '../../db/schema/index.js';
import { handler, type HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { isUniqueViolation, resolved } from '../teams/shared.js';
import { userOutput } from '../members/shared.js';
import { actorUserId } from './self.js';

const fieldError = (code: 'CONFLICT' | 'INVALID_INPUT', field: string, message: string) =>
  new SurfaceError(code, message, { issues: [{ path: [field], message }] });

export default handler(userUpdateProfile, async (ctx, input) => {
  const userId = actorUserId(ctx);
  // Two saves at once (two tabs) run one after the other, each on the other's result.
  await ctx.tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  const current = await ctx.query.get('User', userId);
  if (!current) throw new SurfaceError('NOT_FOUND', 'Your account was not found. Log in again.');

  const changes: {
    name?: string;
    displayName?: string;
    avatarFileId?: string | null;
    timezone?: string;
  } = {};
  if (input.name !== undefined && input.name.trim() !== current.name) {
    changes.name = input.name.trim();
  }
  if (input.displayName !== undefined && input.displayName.trim() !== current.displayName) {
    const displayName = input.displayName.trim();
    // A new case of your own name ("ada" → "Ada") is yours; anyone else's is E5.
    if (displayName.toLowerCase() !== current.displayName.toLowerCase()) {
      const similar = await displayNamesLike(ctx, displayNameSuggestionPrefix(displayName), userId);
      if (similar.some((taken) => taken.toLowerCase() === displayName.toLowerCase())) {
        const suggestion = suggestDisplayName(displayName, [...similar, current.displayName]);
        throw fieldError('CONFLICT', 'displayName', `${displayNameTakenMessage(suggestion)}.`);
      }
    }
    changes.displayName = displayName;
  }
  if (input.avatar === null && current.avatarFileId !== null) changes.avatarFileId = null;
  if (input.avatar !== undefined && input.avatar !== null) {
    // Resolved by the executor: any file the actor can see (SPEC-014 §4.2). Only your own upload
    // or your current avatar is yours to set; taking another user's would pin their file with
    // the RESTRICT key. Anything else answers like an unknown id (SPEC-003 §4).
    const file = resolved(ctx.refs['avatar'], 'avatar');
    if (file.id !== current.avatarFileId) {
      if (file['uploaderId'] !== userId) {
        throw refNotFound('FileRef', input.avatar, ['avatar']);
      }
      if (file['purpose'] !== 'avatar') {
        throw fieldError(
          'INVALID_INPUT',
          'avatar',
          'That file isn’t an avatar. Upload it again as your avatar.',
        );
      }
      changes.avatarFileId = file.id;
    }
  }
  if (input.timezone !== undefined) {
    const timezone = canonicalTimeZone(input.timezone);
    if (timezone !== current.timezone) changes.timezone = timezone;
  }
  if (Object.keys(changes).length === 0) return userOutput(current);

  try {
    return userOutput(await ctx.repo.update('User', userId, changes));
  } catch (error) {
    // Someone took the display name between the check and the write.
    if (isUniqueViolation(error, 'users_display_name_idx')) {
      throw fieldError(
        'CONFLICT',
        'displayName',
        'That display name was just taken. Try another one.',
      );
    }
    throw error;
  }
});

/** Other users' display names starting with `prefix`, without case (D9: unique without case). */
async function displayNamesLike(
  ctx: HandlerContext,
  prefix: string,
  userId: string,
): Promise<string[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await ctx.tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(
      sql`lower(${users.displayName}) LIKE lower(${pattern}) ESCAPE '\\' AND ${users.id} <> ${userId}`,
    );
  return rows.map((row) => row.displayName);
}
