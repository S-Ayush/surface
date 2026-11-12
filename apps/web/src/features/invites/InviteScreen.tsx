// /invite/:token (SPEC-001 §3.4, §7; PLAN-001 S5): "X invited you to join Acme", then name,
// display name (suggested from the name until edited, D9), password, and the email when the
// invite has none (locked when it has one). Accepting creates the account, joins the invite's
// teams and signs in (AC-2). A used, revoked or expired invite says so (E4); an email that has an
// account says to log in (E3); a taken display name suggests another (E5). Renders inside the
// public page (pages/PublicPage.tsx), as the account pages do.
import { PASSWORD_MIN_LENGTH } from '@surface/domain';
import { Button, Input, Spinner } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ScreenProps } from '../../app/screens.js';
import pages from '../../pages/Pages.module.css';
import { enterApp } from '../account/api.js';
import {
  ACCEPT_IDLE,
  AcceptFlow,
  EMPTY_ACCEPT_FORM,
  invitedText,
  withDisplayName,
  withEmail,
  withName,
  type AcceptForm,
  type AcceptView,
} from './accept.js';
import { useInvitesApi, type InviteDetailsResult } from './api.js';
import styles from './invites.module.css';

export const INVITE_TITLE = 'Join the workspace';

function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className={pages.card} aria-labelledby="invite-title">
      <h1 id="invite-title" className={pages.title}>
        {title}
      </h1>
      {children}
    </section>
  );
}

function Invalid({ message }: { readonly message: string }) {
  return (
    <Card title={INVITE_TITLE}>
      <p className={pages.formError} role="alert">
        {message}
      </p>
      <p className={styles.note}>
        <Link to="/login">Log in</Link> if you already have an account.
      </p>
    </Card>
  );
}

/** The browser's time zone, for the new account (the server falls back to UTC). */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function InviteScreen({ params }: ScreenProps) {
  const api = useInvitesApi();
  const token = params['token'] ?? '';
  const [details, setDetails] = useState<InviteDetailsResult>();

  useEffect(() => {
    let current = true;
    void api.details(token).then((result) => {
      if (current) setDetails(result);
    });
    return () => {
      current = false;
    };
  }, [api, token]);

  if (details === undefined) {
    return (
      <Card title={INVITE_TITLE}>
        <Spinner />
      </Card>
    );
  }
  if (!details.ok) {
    return details.invalid ? (
      <Invalid message={details.message} />
    ) : (
      <Card title={INVITE_TITLE}>
        <p className={pages.formError} role="alert">
          {details.message}
        </p>
      </Card>
    );
  }
  return <AcceptInvite token={token} invite={details.invite} />;
}

export function AcceptInvite({
  token,
  invite,
  initialView = ACCEPT_IDLE,
}: {
  readonly token: string;
  readonly invite: Extract<InviteDetailsResult, { ok: true }>['invite'];
  readonly initialView?: AcceptView;
}) {
  const api = useInvitesApi();
  const [form, setForm] = useState<AcceptForm>(EMPTY_ACCEPT_FORM);
  const [view, setView] = useState<AcceptView>(initialView);
  const [flow] = useState(() => new AcceptFlow(api, setView));
  const needsEmail = invite.email === null;

  if (view.invalid !== null) return <Invalid message={view.invalid} />;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void flow.submit(token, form, needsEmail, enterApp, browserTimeZone());
  };
  return (
    <Card title={INVITE_TITLE}>
      <p className={styles.note}>{invitedText(invite.inviterName, invite.workspaceName)}</p>
      <form className={pages.form} onSubmit={submit} noValidate aria-labelledby="invite-title">
        <Input
          label="Email"
          type="email"
          autoComplete="username"
          value={invite.email ?? form.email}
          readOnly={!needsEmail}
          autoFocus={needsEmail}
          hint={needsEmail ? undefined : 'This invite is for this email.'}
          error={view.problems.email}
          onChange={(event) => {
            if (needsEmail) setForm(withEmail(form, event.target.value));
          }}
        />
        <Input
          label="Name"
          autoComplete="name"
          autoFocus={!needsEmail}
          value={form.name}
          error={view.problems.name}
          onChange={(event) => {
            setForm(withName(form, event.target.value, invite.email));
          }}
        />
        <Input
          label="Display name"
          autoComplete="nickname"
          value={form.displayName}
          hint="How people @mention you, like ada.l"
          error={view.problems.displayName}
          onChange={(event) => {
            setForm(withDisplayName(form, event.target.value));
          }}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={view.problems.password}
          onChange={(event) => {
            setForm({ ...form, password: event.target.value });
          }}
        />
        {view.error !== null && (
          <p className={pages.formError} role="alert">
            {view.error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={view.pending}>
          Join {invite.workspaceName}
        </Button>
      </form>
    </Card>
  );
}
