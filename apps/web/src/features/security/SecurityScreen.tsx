// Settings → Account → Security (SPEC-001 §3.5, §7; PLAN-001 S6): change your password, and the
// sessions signed in to your account, with Revoke and Revoke all others. Neither is in the
// replica: both ask the server (files/api.ts), and the flows live outside React to test.
import { Badge, Button, Input, Spinner } from '@surface/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ScreenProps } from '../../app/screens.js';
import { SESSIONS_PAGE, useSettingsApi } from '../files/api.js';
import { deviceName, lastActiveText } from './device.js';
import { changedText, changePassword, PASSWORD_EDITING, type PasswordView } from './password.js';
import styles from './security.module.css';
import { SESSIONS_LOADING, SessionsFlow, type SessionsView } from './sessions.js';

export function SecurityScreen(_props: ScreenProps) {
  const api = useSettingsApi();
  const [view, setView] = useState<SessionsView>(SESSIONS_LOADING);
  const flow = useMemo(() => new SessionsFlow(api, setView), [api]);
  useEffect(() => {
    void flow.load();
  }, [flow]);

  return (
    <div className={styles.screen}>
      <PasswordSection onChanged={() => void flow.load()} />
      <SessionsSection view={view} flow={flow} />
    </div>
  );
}

function PasswordSection({ onChanged }: { readonly onChanged: () => void }) {
  const api = useSettingsApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [view, setView] = useState<PasswordView>(PASSWORD_EDITING);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (view.phase === 'editing' && view.busy) return;
    setView({ phase: 'editing', busy: true });
    const result = await changePassword(api, { current, next, again });
    setView(result);
    if (result.phase === 'changed') {
      setCurrent('');
      setNext('');
      setAgain('');
      onChanged();
    }
  };

  const problem = view.phase === 'editing' ? view.problem : undefined;
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    if (view.phase === 'changed' || problem !== undefined) setView(PASSWORD_EDITING);
  };

  return (
    <section className={styles.section} aria-labelledby="change-password">
      <h2 id="change-password" className={styles.heading}>
        Change password
      </h2>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {view.phase === 'changed' && (
          <p role="status" className={styles.success}>
            {changedText(view.endedSessions)}
          </p>
        )}
        {problem !== undefined && problem.field === null && (
          <p role="alert" className={styles.formError}>
            {problem.message}
          </p>
        )}
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          error={problem?.field === 'currentPassword' ? problem.message : undefined}
          onChange={(event) => edit(setCurrent)(event.target.value)}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          hint="At least 10 characters. Your other sessions are logged out."
          error={problem?.field === 'newPassword' ? problem.message : undefined}
          onChange={(event) => edit(setNext)(event.target.value)}
        />
        <Input
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(event) => edit(setAgain)(event.target.value)}
        />
        <div className={styles.actions}>
          <Button type="submit" loading={view.phase === 'editing' && view.busy}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}

export function SessionsSection({
  view,
  flow,
  now = new Date(),
}: {
  readonly view: SessionsView;
  readonly flow: Pick<SessionsFlow, 'revoke' | 'revokeOthers'>;
  readonly now?: Date;
}) {
  const others = view.sessions.filter((session) => !session.current).length;
  return (
    <section className={styles.section} aria-labelledby="sessions">
      <h2 id="sessions" className={styles.heading}>
        Sessions
      </h2>
      <p className={styles.note}>
        Browsers signed in to your account. Revoke one you don’t recognise; it is logged out at
        once.
      </p>
      {view.error !== null && (
        <p role="alert" className={styles.formError}>
          {view.error}
        </p>
      )}
      {view.loading && view.sessions.length === 0 ? (
        <Spinner />
      ) : (
        <ul className={styles.list} aria-label="Sessions">
          {view.sessions.map((session) => {
            const device = deviceName(session.userAgent);
            const meta = [session.ip ?? 'Unknown address', lastActiveText(session.lastUsedAt, now)];
            return (
              <li key={session.id} className={styles.row}>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>
                    {device}
                    {session.current && <Badge variant="accent">This device</Badge>}
                  </span>
                  <span className={styles.rowMeta}>{meta.join(' · ')}</span>
                </span>
                {!session.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Revoke the session on ${device}`}
                    loading={view.revoking === session.id}
                    disabled={view.revoking !== null && view.revoking !== session.id}
                    onClick={() => void flow.revoke(session.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {view.more && <p className={styles.note}>Showing the {SESSIONS_PAGE} most recent.</p>}
      {others > 0 && (
        <div className={styles.toolbar}>
          <Button
            variant="ghost"
            loading={view.revoking === 'others'}
            disabled={view.revoking !== null && view.revoking !== 'others'}
            onClick={() => void flow.revokeOthers()}
          >
            Revoke all others
          </Button>
        </div>
      )}
    </section>
  );
}
