// The pending invites under Settings → Members (SPEC-001 §3.4; PLAN-001 S5), each with Revoke.
// The parent owns the PendingInvites flow, so a new invite reloads this list.
import { Team } from '@surface/domain/model';
import { LIST_LIMIT_MAX } from '@surface/operations';
import { Button, SettingsGroup, SettingsPanel, SettingsRow, Spinner } from '@surface/ui';
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

  const loading = view.loading && view.invites.length === 0;
  const empty = !loading && view.invites.length === 0;
  return (
    <div className={styles.stack}>
      {view.error !== null && (
        <p role="alert" className={styles.formError}>
          {view.error}
        </p>
      )}
      <SettingsGroup title="Pending invites" list={!loading && !empty} listLabel="Pending invites">
        {loading ? (
          <SettingsPanel>
            <Spinner />
          </SettingsPanel>
        ) : empty ? (
          <SettingsPanel>
            <p className={styles.note}>No pending invites.</p>
          </SettingsPanel>
        ) : (
          view.invites.map((invite) => {
            const row = pendingInviteRow(invite, teamKeys, now);
            return (
              <SettingsRow
                as="li"
                key={invite.id}
                id={`invite-${invite.id}`}
                label={row.title}
                hint={row.meta}
              >
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
              </SettingsRow>
            );
          })
        )}
      </SettingsGroup>
      {view.more && <p className={styles.note}>Showing the newest {LIST_LIMIT_MAX}.</p>}
    </div>
  );
}
