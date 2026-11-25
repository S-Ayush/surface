// Team settings → Members (SPEC-001 §3.7): the members, "Add member" and "Remove", for members of
// the team and Admins (`team.addMember`, `team.removeMember`). Adding and removing show at once
// (optimistic); a refusal rolls back. The last member of a private team can't be removed
// or leave (E12, D3). Leaving yourself works as everywhere else (useLeaveTeam).
import { teamAddMember, teamRemoveMember } from '@surface/operations';
import { Avatar, Button, Dialog, DialogClose, Menu, SettingsGroup, SettingsRow } from '@surface/ui';
import { useId, useState } from 'react';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { LAST_PRIVATE_MEMBER, memberCountText, type MemberItem } from './model.js';
import { submitMutation, toastIfFailed } from './submit.js';
import { TeamSettingsLayout } from './TeamSettingsLayout.js';
import styles from './teams.module.css';
import { useLeaveTeam } from './useLeaveTeam.js';
import type { TeamDetails } from './useTeams.js';

export function TeamMembersScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {(details) => <Members details={details} />}
    </TeamSettingsLayout>
  );
}

function Members({ details }: { readonly details: TeamDetails }) {
  const app = useApp();
  const { team, members, addable, access, canEnd } = details;
  const me = app.session?.userId;
  const leaving = useLeaveTeam(team);
  // Who the Remove dialog is about. Kept after it closes, so its text doesn't change while the
  // close animation runs.
  const [removing, setRemoving] = useState<MemberItem>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();

  const add = async (user: MemberItem) => {
    const store = app.store;
    if (store === null) return;
    // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
    toastIfFailed(await submitMutation(store, teamAddMember, { team: team.key, user: user.id }));
  };

  const remove = async (user: MemberItem) => {
    const store = app.store;
    if (store === null || busy) return;
    setBusy(true);
    toastIfFailed(await submitMutation(store, teamRemoveMember, { team: team.key, user: user.id }));
    setBusy(false);
    setAsking(false);
  };

  return (
    <>
      <p className={styles.note}>{memberCountText(members.length)}</p>
      {!access.manageMembers && (
        <p className={styles.note}>
          Only members of {team.key} and Admins can add or remove members.
        </p>
      )}
      {!canEnd && (
        // Visible, not only a tooltip: disabled buttons take no focus (E12).
        <p id={reasonId} className={styles.reason}>
          {LAST_PRIVATE_MEMBER}
        </p>
      )}
      <SettingsGroup
        title="Members"
        list
        listLabel={`Members of ${team.name}`}
        actions={
          access.manageMembers && (
            <Menu
              align="end"
              trigger={<Button disabled={addable.length === 0}>Add member</Button>}
              items={addable.map((user) => ({
                type: 'item' as const,
                label: `${user.name} (${user.email})`,
                onSelect: () => void add(user),
              }))}
            />
          )
        }
      >
        {members.map((user) => {
          const self = user.id === me;
          const allowed = self || access.manageMembers;
          return (
            <SettingsRow
              as="li"
              key={user.id}
              id={`member-${user.id}`}
              leading={<Avatar name={user.name} />}
              label={
                <>
                  {user.name}
                  {self ? ' (you)' : ''}
                </>
              }
              hint={`@${user.displayName} · ${user.email}`}
            >
              {allowed && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEnd}
                  loading={self && leaving.busy}
                  aria-describedby={canEnd ? undefined : reasonId}
                  onClick={() => {
                    if (self) {
                      leaving.leave();
                    } else {
                      setRemoving(user);
                      setAsking(true);
                    }
                  }}
                >
                  {self ? 'Leave' : 'Remove'}
                </Button>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {leaving.dialog}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing?.name ?? ''}?`}
        description={`${removing?.name ?? ''} is removed from ${team.key}.`}
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                if (removing !== undefined) void remove(removing);
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}
