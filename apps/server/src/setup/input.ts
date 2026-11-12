/**
 * `POST /setup`'s body (SPEC-001 §3.1): the three wizard steps. Messages say how to fix the
 * field, and never echo a password or the token.
 */
import {
  canonicalTimeZone,
  displayNameFrom,
  displayNameProblem,
  emailProblem,
  NAME_MAX_LENGTH,
  nameProblem,
  normaliseEmail,
  passwordProblem,
  teamKeyProblem,
  timeZoneProblem,
} from '@surface/domain';
import { z } from 'zod';

/** A string checked by one of the shared rules, so the wizard and the server agree. */
const checked = (required: string, problem: (value: string) => string | undefined) =>
  z.string({ error: required }).superRefine((value, ctx) => {
    const message = problem(value);
    if (message) ctx.addIssue({ code: 'custom', message });
  });

const name = (field: string, max: number) =>
  checked(`${field} is required`, (value) => nameProblem(field, value, max)).transform((value) =>
    value.trim(),
  );

/** An IANA zone, stored canonically (`europe/berlin` → `Europe/Berlin`); offsets are refused. */
const timezone = checked('Time zone is required, like Europe/Berlin', timeZoneProblem).transform(
  canonicalTimeZone,
);

export const setupInputSchema = z.object({
  token: z.string({ error: 'The setup link is incomplete' }).min(1).max(128),
  workspace: z.object({ name: name('Workspace name', NAME_MAX_LENGTH.workspace) }),
  admin: z.object({
    name: name('Your name', NAME_MAX_LENGTH.person),
    email: checked('Email is required', emailProblem).transform(normaliseEmail),
    password: checked('Password is required', passwordProblem),
    timezone: timezone.optional(),
  }),
  team: z.object({
    name: name('Team name', NAME_MAX_LENGTH.team),
    key: z
      .string({ error: 'Team key is required' })
      .trim()
      .toUpperCase()
      .superRefine((key, ctx) => {
        const problem = teamKeyProblem(key);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
  }),
});

export type SetupInput = z.infer<typeof setupInputSchema>;

/**
 * The Admin's @mention handle, from their name or email (`Ada Lovelace` → `ada`), by the shared
 * rule the invite page uses (SPEC-001 D9). The first user can't collide with anyone; they can
 * change it in their profile.
 */
export function displayNameFor(name: string, email: string): string {
  const handle = displayNameFrom(name, email, 'admin');
  // The rule only ever gives a valid handle; checked so a change to it can't break setup.
  return displayNameProblem(handle) === undefined ? handle : 'admin';
}
