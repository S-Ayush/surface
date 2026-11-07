// Settings → Members, Admins only (SPEC-001 §3.6, §7; PLAN-001 S7): everyone in the workspace
// with role, teams and join date, filtered by role. Each row's ⋯ menu changes the role
// (`user.setRole`, shown at once) and generates a reset link. The last Admin can't become a Member
// (INV-01, E6): the menu disables it and says why. The settings page shows Members not-found
// (SettingsPage, AC-14), so this screen assumes an Admin. Invites come with PLAN-001 S5.
import { LAST_ADMIN_MESSAGE, type UserRole } from '@surface/domain';
import { Team, TeamMembership, User } from '@surface/domain/model';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogClose,
  IconButton,
  Menu,
  SegmentedControl,
  Spinner,
  type MenuEntry,
} from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { Ellipsis } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { toastIfFailed } from '../teams/submit.js';
import { changeRole, demoteSelf, roleChoice } from './actions.js';
import styles from './members.module.css';
import {
  joinedText,
  memberCountText,
  memberList,
  ROLE_LABEL,
  type MemberListItem,
  type RoleFilter,
} from './model.js';
import { ResetLinkDialog, type ResetLinkTarget } from './ResetLinkDialog.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'admin', label: 'Admins' },
  { value: 'member', label: 'Members' },
] as const;

/** Where an Admin who makes themselves a Member goes: Members is no longer theirs to see. */
const AFTER_SELF_DEMOTION = '/settings/account/profile';

/** The menu of one row: its role, and a reset link. */
export function memberMenuItems(
  member: MemberListItem,
  actions: {
    readonly setRole: (role: UserRole) => void;
    readonly resetLink: () => void;
  },
): MenuEntry[] {
  return [
    {
      type: 'radio',
      label: 'Role',
      value: member.role,
      options: [
        { value: 'admin', label: ROLE_LABEL.admin },
        { value: 'member', label: ROLE_LABEL.member, disabled: member.lastAdmin },
      ],
      onValueChange: (value) => {
        if (value === 'admin' || value === 'member') actions.setRole(value);
      },
    },
    { type: 'item', label: 'Generate reset link…', onSelect: actions.resetLink },
  ];
}

export function MembersScreen(_props: ScreenProps) {
  const app = useApp();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [resetTarget, setResetTarget] = useState<ResetLinkTarget>();
  const [resetOpen, setResetOpen] = useState(false);
  const [confirmSelf, setConfirmSelf] = useState(false);
  const reasonId = useId();

  const members = useObserved(
    useCallback(() => {
      const store = app.store;
      const session = app.session;
      if (store === null || store.status !== 'ready' || session === null) return null;
      return memberList(
        store.pool.all(User),
        store.pool.all(Team),
        store.pool.all(TeamMembership),
        session.userId,
        filter,
      );
    }, [app, filter]),
  );

  if (members === null) {
    return (
      <div className={styles.screen}>
        <Spinner />
      </div>
    );
  }

  const setRole = async (member: MemberListItem, role: UserRole) => {
    const store = app.store;
    const choice = roleChoice(member, role);
    if (choice === 'confirm') setConfirmSelf(true);
    if (store === null || choice !== 'change') return;
    // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
    toastIfFailed(await changeRole(store, member.id, role));
  };

  const confirmDemoteSelf = () => {
    const store = app.store;
    const me = members.find((member) => member.self);
    setConfirmSelf(false);
    if (store === null || me === undefined) return;
    void demoteSelf(store, me.id, () => void navigate({ to: AFTER_SELF_DEMOTION })).then(
      toastIfFailed,
    );
  };

  const onlyAdmin = members.some((member) => member.lastAdmin);

  return (
    <div className={styles.screen}>
      <div className={styles.toolbar}>
        <SegmentedControl
          aria-label="Show"
          size="sm"
          options={FILTERS}
          value={filter}
          onValueChange={setFilter}
        />
        <p className={styles.note}>{memberCountText(members.length, filter)}</p>
      </div>
      {onlyAdmin && (
        // Visible, not only a disabled menu option: why the last Admin can't become a Member.
        <p id={reasonId} className={styles.note}>
          {LAST_ADMIN_MESSAGE}
        </p>
      )}
      <ul className={styles.list} aria-label="Members">
        {members.map((member) => (
          <li key={member.id} className={styles.row}>
            <Avatar name={member.name} />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                {member.name}
                {member.self ? ' (you)' : ''}
              </span>
              <span className={styles.rowMeta}>
                @{member.displayName} · {member.email}
              </span>
              <span className={styles.rowMeta}>
                {member.teams.length === 0 ? 'No teams' : member.teams.join(', ')} ·{' '}
                {joinedText(member.joined)}
              </span>
            </span>
            <Badge variant={member.role === 'admin' ? 'accent' : 'neutral'}>
              {ROLE_LABEL[member.role]}
            </Badge>
            <Menu
              align="end"
              trigger={
                <IconButton
                  aria-label={`More actions for ${member.name}`}
                  aria-describedby={member.lastAdmin ? reasonId : undefined}
                  icon={<Ellipsis size={16} />}
                  size="sm"
                />
              }
              items={memberMenuItems(member, {
                setRole: (role) => void setRole(member, role),
                resetLink: () => {
                  setResetTarget({ id: member.id, name: member.name, self: member.self });
                  setResetOpen(true);
                },
              })}
            />
          </li>
        ))}
      </ul>
      {members.length === 0 && <p className={styles.note}>Nobody has this role.</p>}
      <ResetLinkDialog target={resetTarget} open={resetOpen} onOpenChange={setResetOpen} />
      <Dialog
        open={confirmSelf}
        onOpenChange={setConfirmSelf}
        title="Make yourself a Member?"
        description="You lose access to Members and Workspace settings. Another Admin can make you an Admin again."
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmDemoteSelf}>
              Make me a Member
            </Button>
          </>
        }
      />
    </div>
  );
}
