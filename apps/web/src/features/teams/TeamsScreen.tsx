// Settings → Teams (SPEC-001 §3.7, §7): every team the user can see, with its member count and a
// Join or Leave button, and "Create team". Joins and leaves show at once (optimistic); a refusal
// rolls back.
import { canEndMembership } from '@surface/domain';
import { teamJoin } from '@surface/operations';
import {
  Badge,
  Button,
  EmptyState,
  SettingsGroup,
  SettingsPanel,
  SettingsRow,
  Skeleton,
} from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { useCommandRegistry } from '../../shortcuts/ShortcutProvider.js';
import { LAST_PRIVATE_MEMBER, memberCountText, type TeamListItem } from './model.js';
import { submitMutation, toastIfFailed } from './submit.js';
import styles from './teams.module.css';
import { useLeaveTeam } from './useLeaveTeam.js';
import { useBrowseTeams } from './useTeams.js';

export function TeamsScreen(_props: ScreenProps) {
  const teams = useBrowseTeams();
  // The shell's Create team (TeamsHost), so it is offered only once the replica is ready.
  const commands = useCommandRegistry();
  const canCreate = useObserved(
    useCallback(() => commands.isAvailable('form:create-team'), [commands]),
  );

  return (
    <>
      <p className={styles.note}>Join a team to see it in your sidebar.</p>
      <SettingsGroup
        title="Teams"
        list={teams !== null && teams.length > 0}
        listLabel="Teams"
        actions={
          <Button disabled={!canCreate} onClick={() => commands.run('form:create-team')}>
            Create team
          </Button>
        }
      >
        {teams === null ? (
          <SettingsPanel>
            <Skeleton shape="row" aria-label="Loading teams" />
          </SettingsPanel>
        ) : teams.length === 0 ? (
          <EmptyState icon={<Users />} title="No teams yet" description="Create the first one." />
        ) : (
          teams.map((team) => <TeamRow key={team.id} team={team} />)
        )}
      </SettingsGroup>
    </>
  );
}

function TeamRow({ team }: { readonly team: TeamListItem }) {
  const app = useApp();
  const leaving = useLeaveTeam(team);
  const [joining, setJoining] = useState(false);
  const reasonId = useId();
  // E12, D3: the last member of a private team can't leave.
  const blocked = team.member && !canEndMembership(team, team.memberCount);

  const join = async () => {
    const store = app.store;
    if (store === null || joining) return;
    setJoining(true);
    // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
    toastIfFailed(await submitMutation(store, teamJoin, { team: team.key }));
    setJoining(false);
  };

  return (
    <SettingsRow
      as="li"
      id={`setting-team-${team.key}`}
      leading={<span className={styles.key}>{team.key}</span>}
      label={
        <Link to="/settings/teams/$key/general" params={{ key: team.key }} className={styles.link}>
          {team.icon === null ? team.name : `${team.icon} ${team.name}`}
        </Link>
      }
      hint={
        <>
          {memberCountText(team.memberCount)}
          {team.private ? ' · Private' : ''}
          {blocked && (
            // Visible, not only a tooltip: a disabled button takes no focus (E12).
            <span id={reasonId} className={styles.reason}>
              {LAST_PRIVATE_MEMBER}
            </span>
          )}
        </>
      }
    >
      {team.member && <Badge>Member</Badge>}
      <Button
        variant={team.member ? 'ghost' : 'secondary'}
        size="sm"
        loading={team.member ? leaving.busy : joining}
        disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        aria-label={`${team.member ? 'Leave' : 'Join'} ${team.name}`}
        onClick={team.member ? leaving.leave : () => void join()}
      >
        {team.member ? 'Leave' : 'Join'}
      </Button>
      {leaving.dialog}
    </SettingsRow>
  );
}
