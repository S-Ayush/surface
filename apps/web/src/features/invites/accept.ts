// The invite page's form (SPEC-001 §3.4, §7; PLAN-001 S5), apart from React so it tests without a
// browser. The display name follows the name (or the email) until the invitee edits it (D9). The
// checks are the server's, in form order, so a mistake shows on its field before anything is sent;
// the server's refusals (E3, E5) land on their field the same way. One request at a time: a second
// Enter must not try a single-use invite twice.
import {
  displayNameFrom,
  displayNameProblem,
  emailProblem,
  NAME_MAX_LENGTH,
  nameProblem,
  passwordProblem,
} from '@surface/domain';
import type { AcceptBody, AcceptField, AcceptResult, InvitesApi } from './api.js';

export type AcceptForm = {
  readonly name: string;
  readonly displayName: string;
  /** Typed by the invitee: no longer follows the name. */
  readonly displayNameEdited: boolean;
  readonly password: string;
  /** Only used when the invite has no email. */
  readonly email: string;
};

export const EMPTY_ACCEPT_FORM: AcceptForm = {
  name: '',
  displayName: '',
  displayNameEdited: false,
  password: '',
  email: '',
};

/** The handle the form suggests: empty until there is a name or email to start from. */
function suggested(name: string, email: string): string {
  return name.trim() === '' && email.trim() === '' ? '' : displayNameFrom(name, email);
}

/** `inviteEmail` is the invite's own email, or null when the invitee types one. */
export function withName(form: AcceptForm, name: string, inviteEmail: string | null): AcceptForm {
  return {
    ...form,
    name,
    displayName: form.displayNameEdited
      ? form.displayName
      : suggested(name, inviteEmail ?? form.email),
  };
}

export function withEmail(form: AcceptForm, email: string): AcceptForm {
  return {
    ...form,
    email,
    displayName: form.displayNameEdited ? form.displayName : suggested(form.name, email),
  };
}

export function withDisplayName(form: AcceptForm, displayName: string): AcceptForm {
  return { ...form, displayName, displayNameEdited: true };
}

export type AcceptProblems = Readonly<Partial<Record<AcceptField, string>>>;

/** What is wrong, by field; empty when the form can be sent. */
export function acceptProblems(form: AcceptForm, needsEmail: boolean): AcceptProblems {
  const found: [AcceptField, string | undefined][] = [
    ['email', needsEmail ? emailProblem(form.email) : undefined],
    ['name', nameProblem('Name', form.name, NAME_MAX_LENGTH.person)],
    ['displayName', displayNameProblem(form.displayName)],
    ['password', passwordProblem(form.password)],
  ];
  // Worded as the server words them, which ends each with a full stop.
  return Object.fromEntries(
    found.flatMap(([field, problem]) => (problem === undefined ? [] : [[field, `${problem}.`]])),
  );
}

export function acceptBody(form: AcceptForm, needsEmail: boolean, timezone?: string): AcceptBody {
  return {
    name: form.name.trim(),
    displayName: form.displayName.trim(),
    password: form.password,
    ...(needsEmail ? { email: form.email.trim() } : {}),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

export type AcceptView = {
  readonly pending: boolean;
  readonly problems: AcceptProblems;
  /** A refusal that isn't about one field (offline, a server failure). */
  readonly error: string | null;
  /** The invite stopped being valid while the page was open (E4). */
  readonly invalid: string | null;
};

export const ACCEPT_IDLE: AcceptView = { pending: false, problems: {}, error: null, invalid: null };

export class AcceptFlow {
  #pending = false;

  constructor(
    private readonly api: Pick<InvitesApi, 'accept'>,
    private readonly show: (view: AcceptView) => void,
  ) {}

  /** Checks, then accepts; after a success `then` runs and the form stays busy. */
  async submit(
    token: string,
    form: AcceptForm,
    needsEmail: boolean,
    then: () => void,
    timezone?: string,
  ): Promise<void> {
    if (this.#pending) return;
    const problems = acceptProblems(form, needsEmail);
    if (Object.keys(problems).length > 0) {
      this.show({ ...ACCEPT_IDLE, problems });
      return;
    }
    this.#pending = true;
    this.show({ ...ACCEPT_IDLE, pending: true });
    const result = await this.api.accept(token, acceptBody(form, needsEmail, timezone));
    if (result.ok) {
      then();
      return;
    }
    this.#pending = false;
    this.show(refused(result));
  }
}

function refused(result: Exclude<AcceptResult, { ok: true }>): AcceptView {
  if (result.invalid === true) return { ...ACCEPT_IDLE, invalid: result.message };
  if (result.field !== undefined) {
    return { ...ACCEPT_IDLE, problems: { [result.field]: result.message } };
  }
  return { ...ACCEPT_IDLE, error: result.message };
}

/** The page's heading line: who invited whom where. */
export function invitedText(inviterName: string, workspaceName: string): string {
  return `${inviterName} invited you to join ${workspaceName} on Surface.`;
}
