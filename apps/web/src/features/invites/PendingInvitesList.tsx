// The pending invites under Settings → Members (SPEC-001 §3.4; PLAN-001 S5), each with Revoke.
// The parent owns the PendingInvites flow, so a new invite reloads this list.
import { Team } from '@surface/domain/model';
import { LIST_LIMIT_MAX } from '@surface/operations';
import { Button, Spinner } from '@surface/ui';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { pendingInviteRow } from './invite-form.js';
import styles from './invites.module.css';
import type { PendingView } from './pending.js';

export function PendingInvitesList({
  view,
  onRevoke,
  now = new Date(),
}: {
  readonly view: PendingView;
  readonly onRevoke: (inviteId: string) => void;
  readonly now?: Date;
}) {
  const app = useApp();
  const teamKeys = useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return new Map<string, string>();
      return new Map(store.pool.all(Team).map((team) => [team.id, team.key]));
    }, [app]),
  );

  return (
    <section className={styles.section} aria-labelledby="pending-invites">
      <h2 id="pending-invites" className={styles.heading}>
        Pending invites
      </h2>
      {view.error !== null && (
        <p role="alert" className={styles.formError}>
          {view.error}
        </p>
      )}
      {view.loading && view.invites.length === 0 ? (
        <Spinner />
      ) : view.invites.length === 0 ? (
        <p className={styles.note}>No pending invites.</p>
      ) : (
        <ul className={styles.list} aria-label="Pending invites">
          {view.invites.map((invite) => {
            const row = pendingInviteRow(invite, teamKeys, now);
            return (
              <li key={invite.id} className={styles.row}>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{row.title}</span>
                  <span className={styles.rowMeta}>{row.meta}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Revoke the invite for ${row.title}`}
                  loading={view.revoking === invite.id}
                  disabled={view.revoking !== null && view.revoking !== invite.id}
                  onClick={() => onRevoke(invite.id)}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {view.more && <p className={styles.note}>Showing the newest {LIST_LIMIT_MAX}.</p>}
    </section>
  );
}
