// The sign-in pages around the login page (SPEC-001 §3.2, §3.3, §7; PLAN-001 S4):
// - /login/check-email: after asking for a login link;
// - /forgot: asks for a reset link, or without SMTP says to ask an Admin (AC-3);
// - /reset?token=: chooses a new password, which logs out everywhere else (E10) and signs in;
// - /login/magic?token=: signs in with a login link (`POST /auth/magic`). It asks first: a mail scanner opening the
//   link uses nothing, and another site can't sign the browser into someone else's account.
// They render inside the public page (pages/PublicPage.tsx), as the login card does.
import { LINK_LIFETIME_TEXT } from '@surface/domain';
import { Button, Input } from '@surface/ui';
import { Link, useLocation } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import pages from '../../pages/Pages.module.css';
import styles from './account.module.css';
import { enterApp, useAccountApi } from './api.js';
import { AccountSubmit, emailMissing, IDLE, newPasswordProblem, type FormView } from './submit.js';

export const CHECK_EMAIL_TEXT = `If an account exists for that email, we sent it a login link. The link works once, for ${LINK_LIFETIME_TEXT.magicLink}.`;
export const RESET_SENT_TEXT = `If an account exists for that email, we sent it a reset link. The link works once, for ${LINK_LIFETIME_TEXT.passwordReset}.`;
export const ASK_ADMIN_TEXT =
  'This server doesn’t send email. Ask an Admin for a reset link: they can make one in Settings → Members.';
export const INCOMPLETE_LINK = 'This link is incomplete. Open it from the email again.';

function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className={pages.card} aria-labelledby="account-title">
      <h1 id="account-title" className={pages.title}>
        {title}
      </h1>
      {children}
    </section>
  );
}

function BackToLogin() {
  return (
    <p className={styles.links}>
      <Link to="/login" className={styles.link}>
        Back to log in
      </Link>
    </p>
  );
}

function FormError({ error }: { readonly error: string | null }) {
  return error === null ? null : (
    <p className={pages.formError} role="alert">
      {error}
    </p>
  );
}

/** The `token` of the page's address (`?token=…`), or null. */
function useToken(): string | null {
  const search = useLocation({ select: (location) => location.searchStr });
  const token = new URLSearchParams(search).get('token');
  return token === null || token === '' ? null : token;
}

function useAccountForm() {
  const [view, setView] = useState<FormView>(IDLE);
  const [form] = useState(() => new AccountSubmit(setView));
  return { view, form };
}

export function CheckEmailScreen(_props: ScreenProps) {
  return (
    <Card title="Check your email">
      <p className={styles.note}>{CHECK_EMAIL_TEXT}</p>
      <BackToLogin />
    </Card>
  );
}

export function ForgotScreen(_props: ScreenProps) {
  const app = useApp();
  const api = useAccountApi();
  const [email, setEmail] = useState('');
  const { view, form } = useAccountForm();
  const snapshot = app.auth.snapshot;
  const smtp = snapshot.status === 'ready' && snapshot.capabilities.smtp;

  if (!smtp) {
    return (
      <Card title="Reset your password">
        <p className={styles.note}>{ASK_ADMIN_TEXT}</p>
        <BackToLogin />
      </Card>
    );
  }
  if (view.done) {
    return (
      <Card title="Check your email">
        <p className={styles.note}>{RESET_SENT_TEXT}</p>
        <BackToLogin />
      </Card>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.submit(emailMissing(email), () => api.requestLink('passwordReset', email));
  };
  return (
    <Card title="Reset your password">
      <p className={styles.note}>Enter your email and we’ll send you a link to choose a new one.</p>
      <form className={pages.form} onSubmit={submit} noValidate aria-labelledby="account-title">
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
        <FormError error={view.error} />
        <Button type="submit" variant="primary" loading={view.pending}>
          Send reset link
        </Button>
      </form>
      <BackToLogin />
    </Card>
  );
}

export function ResetScreen(_props: ScreenProps) {
  const api = useAccountApi();
  const token = useToken();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { view, form } = useAccountForm();

  if (token === null) {
    return (
      <Card title="Choose a new password">
        <p className={pages.formError} role="alert">
          {INCOMPLETE_LINK}
        </p>
        <ForgotAgain />
      </Card>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.submit(
      newPasswordProblem(password, again),
      () => api.resetPassword(token, password),
      enterApp,
    );
  };
  return (
    <Card title="Choose a new password">
      <p className={styles.note}>Setting it logs you out everywhere else.</p>
      <form className={pages.form} onSubmit={submit} noValidate aria-labelledby="account-title">
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <Input
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
        <FormError error={view.error} />
        <Button type="submit" variant="primary" loading={view.pending}>
          Set password and log in
        </Button>
      </form>
      <ForgotAgain />
    </Card>
  );
}

function ForgotAgain() {
  return (
    <p className={styles.links}>
      <Link to="/forgot" className={styles.link}>
        Get a new reset link
      </Link>
      <Link to="/login" className={styles.link}>
        Back to log in
      </Link>
    </p>
  );
}

export function MagicLinkScreen(_props: ScreenProps) {
  const api = useAccountApi();
  const token = useToken();
  const { view, form } = useAccountForm();

  if (token === null) {
    return (
      <Card title="Log in to Surface">
        <p className={pages.formError} role="alert">
          {INCOMPLETE_LINK}
        </p>
        <BackToLogin />
      </Card>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.submit(null, () => api.signInWithLink(token), enterApp);
  };
  return (
    <Card title="Log in to Surface">
      <form className={pages.form} onSubmit={submit} noValidate aria-labelledby="account-title">
        <p className={styles.note}>Your login link is ready. It works once.</p>
        <FormError error={view.error} />
        {/* Focused, so Enter logs in. */}
        <Button type="submit" variant="primary" loading={view.pending} autoFocus>
          Log in
        </Button>
      </form>
      <BackToLogin />
    </Card>
  );
}
