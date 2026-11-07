// /login (SPEC-001 §3.2, §7). Email and password; on success the router's guards send the user
// on to `?next=` or home (`followAuth` re-runs them when the session appears). A refusal shows the
// server's message as it is: the generic wrong-password one (AC-5), or how long a lockout lasts
// (E13). The "Email me a login link" button and "Forgot password?" come with their routes in
// PLAN-001 S4; without SMTP the page offers neither (AC-3).
import { Button, Input } from '@surface/ui';
import { useState, type FormEvent } from 'react';
import { LOGIN_FAILED, type LoginResult } from '../app/auth.js';
import { useApp } from '../app/context.js';
import { usePageTitle } from '../shell/usePageTitle.js';
import styles from './Pages.module.css';

/** What is missing, said before asking the server; null when the form can be sent. */
export function loginProblem(email: string, password: string): string | null {
  const noEmail = email.trim() === '';
  const noPassword = password === '';
  if (noEmail && noPassword) return 'Enter your email and password.';
  if (noEmail) return 'Enter your email.';
  if (noPassword) return 'Enter your password.';
  return null;
}

/** What the form shows: the error line, and whether the button is busy. */
export type LoginView = { readonly error: string | null; readonly pending: boolean };

/**
 * One sign-in at a time. The flag lives here, not in React state, so two submits in the same
 * frame (Enter twice) can't both start one: under SPEC-001 Q11 each would end the other's session.
 */
export class LoginSubmit {
  #pending = false;

  constructor(
    private readonly login: (email: string, password: string) => Promise<LoginResult>,
    private readonly show: (view: LoginView) => void,
  ) {}

  async submit(email: string, password: string): Promise<void> {
    if (this.#pending) return;
    const problem = loginProblem(email, password);
    if (problem !== null) {
      this.show({ error: problem, pending: false });
      return;
    }
    this.#pending = true;
    this.show({ error: null, pending: true });
    const result = await this.login(email.trim(), password).catch((): LoginResult => ({
      ok: false,
      message: LOGIN_FAILED,
    }));
    // Signed in: the guards are taking the user on, and this page goes away; stay busy.
    if (result.ok) return;
    this.#pending = false;
    this.show({ error: result.message, pending: false });
  }
}

export function LoginPage() {
  usePageTitle('Log in');
  const app = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [{ error, pending }, setView] = useState<LoginView>({ error: null, pending: false });
  const [form] = useState(
    () => new LoginSubmit((address, secret) => app.auth.login(address, secret), setView),
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.submit(email, password);
  };

  return (
    <main className={styles.public} tabIndex={-1}>
      <section className={styles.card} aria-labelledby="login-title">
        <h1 id="login-title" className={styles.title}>
          Log in to Surface
        </h1>
        <form className={styles.form} onSubmit={submit} noValidate aria-labelledby="login-title">
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {error !== null && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={pending}>
            Log in
          </Button>
        </form>
      </section>
    </main>
  );
}
