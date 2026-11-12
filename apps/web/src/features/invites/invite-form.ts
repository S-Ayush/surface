// Settings → Members → Invite (SPEC-001 §3.4; PLAN-001 S5), apart from React so it tests without
// a browser. The Admin picks an optional email, a role and teams; the link comes back once and is
// always shown for copying, emailed or not (E7, D7: `emailed` means the email was queued). One
// request at a time, and the modal stays open while it runs.
import { emailProblem, LINK_LIFETIME_TEXT, type UserRole } from '@surface/domain';
import type { CreateInviteResult, Invite, InvitesApi } from './api.js';

export type InviteForm = {
  readonly email: string;
  readonly role: UserRole;
  /** Team ids, in the order picked. */
  readonly teams: readonly string[];
};

export const EMPTY_INVITE_FORM: InviteForm = { email: '', role: 'member', teams: [] };

export function withTeam(form: InviteForm, teamId: string, on: boolean): InviteForm {
  const rest = form.teams.filter((id) => id !== teamId);
  return { ...form, teams: on ? [...rest, teamId] : rest };
}

/** The email is optional; one that is typed must be an email. */
export function inviteEmailProblem(email: string): string | undefined {
  const problem = email.trim() === '' ? undefined : emailProblem(email);
  return problem === undefined ? undefined : `${problem}.`;
}

export type InviteView =
  | {
      readonly phase: 'form';
      readonly busy: boolean;
      /** Under the email field. */
      readonly emailError: string | null;
      readonly error: string | null;
    }
  | {
      readonly phase: 'shown';
      readonly invite: Invite;
      readonly url: string;
      readonly emailed: boolean;
    };

export const INVITE_FORM: Extract<InviteView, { phase: 'form' }> = {
  phase: 'form',
  busy: false,
  emailError: null,
  error: null,
};

export class InviteFlow {
  #view: InviteView = INVITE_FORM;

  constructor(
    private readonly api: Pick<InvitesApi, 'create'>,
    private readonly onView: (view: InviteView) => void,
    /** After an invite is made: the pending list reloads. */
    private readonly onCreated: () => void = () => undefined,
  ) {}

  get view(): InviteView {
    return this.#view;
  }

  async create(form: InviteForm): Promise<void> {
    if (this.#view.phase !== 'form' || this.#view.busy) return;
    const emailError = inviteEmailProblem(form.email) ?? null;
    if (emailError !== null) {
      this.#show({ ...INVITE_FORM, emailError });
      return;
    }
    this.#show({ ...INVITE_FORM, busy: true });
    const email = form.email.trim();
    const result: CreateInviteResult = await this.api.create({
      ...(email === '' ? {} : { email }),
      role: form.role,
      teams: form.teams,
    });
    if (!result.ok) {
      // E3 names the email field; anything else is the form's.
      const aboutEmail = result.field === 'email';
      this.#show({
        ...INVITE_FORM,
        emailError: aboutEmail ? result.message : null,
        error: aboutEmail ? null : result.message,
      });
      return;
    }
    this.#show({ phase: 'shown', invite: result.invite, url: result.url, emailed: result.emailed });
    this.onCreated();
  }

  #show(view: InviteView): void {
    this.#view = view;
    this.onView(view);
  }
}

/** Whether the modal may close: not while the invite is being made, or its link would be lost. */
export function mayCloseInvite(view: InviteView): boolean {
  return !(view.phase === 'form' && view.busy);
}

/** What the modal says beside the link (E7, D7). */
export function inviteShownNote(email: string | null, emailed: boolean): string {
  const lifetime = `It works once, for ${LINK_LIFETIME_TEXT.invite}. Shown only this once.`;
  if (email !== null && emailed) {
    return `We’re emailing the invite to ${email}. You can also send them this link. ${lifetime}`;
  }
  if (email !== null) {
    return `This server doesn’t send email. Send this link to ${email} yourself. ${lifetime}`;
  }
  return `Send this link to the person you’re inviting. ${lifetime}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Expires in 6 days", "Expires today". */
export function expiresText(expiresAt: Date, now: Date): string {
  // Rounded: an invite made a moment ago still reads 7 days, one with an hour left reads today.
  const days = Math.round((expiresAt.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return 'Expires today';
  return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
}

/** One pending invite's row: who, and what they get. */
export function pendingInviteRow(
  invite: Invite,
  teamKeys: ReadonlyMap<string, string>,
  now: Date,
): { readonly title: string; readonly meta: string } {
  const teams = invite.teamIds.flatMap((id) => {
    const key = teamKeys.get(id);
    return key === undefined ? [] : [key];
  });
  const role = invite.role === 'admin' ? 'Admin' : 'Member';
  return {
    title: invite.email ?? 'Link without an email',
    meta: [
      role,
      teams.length === 0 ? 'No teams' : teams.sort().join(', '),
      expiresText(new Date(invite.expiresAt), now),
    ].join(' · '),
  };
}

export type InviteTeamRow = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly $archived?: boolean;
};

/** The teams an invite can name: those the Admin sees that aren't archived, by key. */
export function inviteTeamChoices(teams: readonly InviteTeamRow[]): InviteTeamRow[] {
  return teams
    .filter((team) => team.$archived !== true)
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
