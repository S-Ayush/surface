// The login page's other ways in (SPEC-001 §3.2, §3.3; PLAN-001 S4): "Email me a login link",
// only when the server sends email (AC-3), and "Forgot password?", always: without email the
// forgot page says to ask an Admin.
import { Button } from '@surface/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApp } from '../../app/context.js';
import styles from './account.module.css';
import { useAccountApi } from './api.js';
import { AccountSubmit, emailMissing } from './submit.js';

export function LoginOptions({
  email,
  onError,
}: {
  /** What the login form's email field holds. */
  readonly email: string;
  /** Shows a message in the login form's error line. */
  readonly onError: (message: string) => void;
}) {
  const app = useApp();
  const api = useAccountApi();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [form] = useState(
    () =>
      new AccountSubmit((view) => {
        setSending(view.pending);
        if (view.error !== null) onError(view.error);
      }),
  );
  const snapshot = app.auth.snapshot;
  const smtp = snapshot.status === 'ready' && snapshot.capabilities.smtp;

  return (
    <>
      {smtp && (
        <Button
          loading={sending}
          onClick={() =>
            void form.submit(
              emailMissing(email),
              () => api.requestLink('magicLink', email),
              () => void navigate({ to: '/login/check-email' }),
            )
          }
        >
          Email me a login link
        </Button>
      )}
      <p className={styles.links}>
        <Link to="/forgot" className={styles.link}>
          Forgot password?
        </Link>
      </p>
    </>
  );
}
