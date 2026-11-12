// Settings → Members → Invite member (SPEC-001 §3.4; PLAN-001 S5): an optional email, a role and
// teams, then the link, shown once with a Copy button, emailed or not (E7, D7). Closing the modal
// forgets the link. While the invite is being made the modal stays open.
import { Team } from '@surface/domain/model';
import { Button, Checkbox, Dialog, DialogClose, Input, SegmentedControl } from '@surface/ui';
import { useCallback, useId, useState, type FormEvent } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { copyText } from '../members/reset-link.js';
import { COPIED, COPY_FAILED } from '../members/ResetLinkDialog.js';
import { useInvitesApi } from './api.js';
import {
  EMPTY_INVITE_FORM,
  INVITE_FORM,
  InviteFlow,
  inviteShownNote,
  inviteTeamChoices,
  mayCloseInvite,
  withTeam,
  type InviteForm,
  type InviteView,
} from './invite-form.js';
import styles from './invites.module.css';

const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
] as const;

export function InviteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => void;
}) {
  const [closable, setClosable] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || closable) onOpenChange(next);
      }}
      title="Invite member"
      size="md"
    >
      {/* A new form per opening: a link is never shown twice. */}
      {open && (
        <InviteBody onView={(view) => setClosable(mayCloseInvite(view))} onCreated={onCreated} />
      )}
    </Dialog>
  );
}

function InviteBody({
  onView,
  onCreated,
}: {
  readonly onView: (view: InviteView) => void;
  readonly onCreated: () => void;
}) {
  const app = useApp();
  const api = useInvitesApi();
  const [view, setView] = useState<InviteView>(INVITE_FORM);
  const [form, setForm] = useState<InviteForm>(EMPTY_INVITE_FORM);
  const [flow] = useState(
    () =>
      new InviteFlow(
        api,
        (next) => {
          setView(next);
          onView(next);
        },
        onCreated,
      ),
  );
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const formId = useId();
  const teamsId = useId();
  const teams = useObserved(
    useCallback(() => {
      const store = app.store;
      return store === null || store.status !== 'ready'
        ? []
        : inviteTeamChoices(store.pool.all(Team));
    }, [app]),
  );

  if (view.phase === 'shown') {
    const copy = () => {
      void copyText(view.url, navigator.clipboard).then((ok) => setCopied(ok ? 'yes' : 'failed'));
    };
    return (
      <div className={styles.dialogBody}>
        <Input
          label="Invite link"
          value={view.url}
          readOnly
          autoFocus
          onFocus={(event) => event.target.select()}
          hint={inviteShownNote(view.invite.email, view.emailed)}
        />
        <p role="status" className={copied === 'failed' ? styles.formError : styles.note}>
          {copied === 'yes' ? COPIED : copied === 'failed' ? COPY_FAILED : ''}
        </p>
        <div className={styles.dialogActions}>
          <DialogClose>
            <Button variant="ghost">Done</Button>
          </DialogClose>
          <Button variant="primary" onClick={copy}>
            {copied === 'yes' ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void flow.create(form);
  };
  return (
    <form id={formId} className={styles.dialogBody} onSubmit={submit} noValidate>
      <Input
        label="Email (optional)"
        type="email"
        autoComplete="off"
        autoFocus
        value={form.email}
        error={view.emailError ?? undefined}
        hint="Without an email, anyone with the link can join once."
        onChange={(event) => {
          setForm({ ...form, email: event.target.value });
        }}
      />
      <div className={styles.field}>
        <span className={styles.label}>Role</span>
        <SegmentedControl
          aria-label="Role"
          size="sm"
          options={ROLES}
          value={form.role}
          onValueChange={(role) => {
            setForm({ ...form, role });
          }}
        />
      </div>
      <fieldset className={styles.teams} aria-describedby={teamsId}>
        <legend className={styles.label}>Teams</legend>
        <p id={teamsId} className={styles.note}>
          {teams.length === 0
            ? 'No teams to add them to yet.'
            : 'They join these teams when they accept.'}
        </p>
        {teams.map((team) => (
          <Checkbox
            key={team.id}
            label={`${team.key} · ${team.name}`}
            checked={form.teams.includes(team.id)}
            onCheckedChange={(checked) => {
              setForm(withTeam(form, team.id, checked === true));
            }}
          />
        ))}
      </fieldset>
      {view.error !== null && (
        <p role="alert" className={styles.formError}>
          {view.error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <DialogClose>
          <Button variant="ghost" disabled={view.busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={view.busy}>
          Create invite
        </Button>
      </div>
    </form>
  );
}
