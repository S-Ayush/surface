// One request at a time for the account forms (PLAN-001 S4), like the login page's `LoginSubmit`:
// the flag lives outside React state, so two Enters in one frame can't send twice (a second use
// of a single-use link would fail and show an error over the first one's success).
import { passwordProblem } from '@surface/domain';
import type { AccountResult } from './api.js';

export type FormView = {
  readonly error: string | null;
  readonly pending: boolean;
  /** Sent, and the screen shows what happens next. */
  readonly done: boolean;
};

export const IDLE: FormView = { error: null, pending: false, done: false };

export class AccountSubmit {
  #pending = false;

  constructor(private readonly show: (view: FormView) => void) {}

  /**
   * `problem` is checked first (null: fine). After a success `then` runs, if given, and the form
   * stays busy while the page moves on; otherwise the screen shows it is done.
   */
  async submit(
    problem: string | null,
    send: () => Promise<AccountResult>,
    then?: () => void,
  ): Promise<void> {
    if (this.#pending) return;
    if (problem !== null) {
      this.show({ error: problem, pending: false, done: false });
      return;
    }
    this.#pending = true;
    this.show({ error: null, pending: true, done: false });
    const result = await send();
    if (result.ok && then !== undefined) {
      then();
      return;
    }
    this.#pending = false;
    this.show(
      result.ok
        ? { error: null, pending: false, done: true }
        : { error: result.message, pending: false, done: false },
    );
  }
}

/** The new-password form's check, before asking the server. */
export function newPasswordProblem(password: string, again: string): string | null {
  if (password === '') return 'Enter a new password.';
  const problem = passwordProblem(password);
  if (problem !== undefined) return `${problem}.`;
  if (password !== again) return "The passwords don't match. Type the same one twice.";
  return null;
}

export function emailMissing(email: string): string | null {
  return email.trim() === '' ? 'Enter your email.' : null;
}
