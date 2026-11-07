// Create team (SPEC-001 §3.7): name, key (suggested as the name is typed), icon, color and time
// zone (the creator's by default). The creator becomes a member; the team shows in the sidebar at
// once (optimistic) and in other clients as its delta lands (AC-12).
import { uuidv7 } from '@surface/domain';
import { Team, User } from '@surface/domain/model';
import { teamCreate } from '@surface/operations';
import { Button, ColorPicker, Dialog, DialogClose, Input } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useApp, useObserved } from '../../app/context.js';
import {
  createTeamContext,
  createTeamInput,
  createTeamProblems,
  emptyCreateTeamForm,
  hasProblems,
  hasUnsavedChanges,
  placeServerError,
  withKey,
  withRefusedKey,
  withName,
  type CreateTeamForm,
} from './create-team.js';
import { submitMutation } from './submit.js';
import styles from './teams.module.css';

export type CreateTeamDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export function CreateTeamDialog({ open, onOpenChange }: CreateTeamDialogProps) {
  const app = useApp();
  // The id of the team being created while the server answers: its optimistic row is in the store
  // and must not count its own key as taken.
  const [creatingId, setCreatingId] = useState<string>();
  const { keys, myTimezone } = useObserved(
    useCallback(() => {
      const store = app.store;
      const session = app.session;
      if (store === null || store.status !== 'ready') return { keys: [], myTimezone: undefined };
      const me = session === null ? undefined : store.pool.get(User, session.userId);
      return createTeamContext(store.pool.all(Team), me, creatingId);
    }, [app, creatingId]),
  );
  // Keys the server refused this opening (a private team's, D2) count as taken too.
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const taken = new Set([...keys, ...refused]);
  const [form, setForm] = useState<CreateTeamForm>(() => emptyCreateTeamForm(myTimezone));
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<{ field: 'key' | 'form'; message: string }>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const formId = useId();
  // Whether the dialog is still open when an answer arrives: closed meanwhile, the change still
  // goes through (it was queued), but the dialog no longer acts on it (no jump to the team).
  const openNow = useRef(open);
  useEffect(() => {
    openNow.current = open;
  }, [open]);

  const problems = createTeamProblems(form, taken);
  const shown = touched ? problems : {};
  const keyError = shown.key ?? (serverError?.field === 'key' ? serverError.message : undefined);
  const dirty = hasUnsavedChanges(form, busy);

  const reset = () => {
    setForm(emptyCreateTeamForm(myTimezone));
    setTouched(false);
    setServerError(undefined);
    setBusy(false);
    setCreatingId(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setServerError(undefined);
    const store = app.store;
    if (hasProblems(problems) || busy || store === null) return;
    setBusy(true);
    const id = uuidv7();
    setCreatingId(id);
    const input = createTeamInput(form, id);
    const result = await submitMutation(store, teamCreate, input);
    if (!openNow.current) return;
    setBusy(false);
    setCreatingId(undefined);
    if (result.kind === 'rejected') {
      setServerError(placeServerError(result));
      setRefused(withRefusedKey(refused, result, input.key));
      return;
    }
    if (result.kind === 'failed') {
      setServerError({ field: 'form', message: result.message });
      return;
    }
    onOpenChange(false);
    reset();
    void navigate({ to: '/team/$key', params: { key: input.key ?? '' } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Create team"
      size="sm"
      dirty={dirty}
      footer={
        <>
          <DialogClose>
            <Button variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} loading={busy}>
            Create team
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {serverError?.field === 'form' && (
          <p role="alert" className={styles.formError}>
            {serverError.message}
          </p>
        )}
        <Input
          label="Name"
          value={form.name}
          placeholder="Engineering"
          autoFocus
          error={shown.name}
          onChange={(event) => {
            setServerError(undefined);
            setForm(withName(form, event.target.value, taken));
          }}
        />
        <Input
          label="Key"
          value={form.key}
          placeholder="ENG"
          hint="Prefixes issue ids, like ENG-123. It can't be changed later."
          error={keyError}
          maxLength={5}
          onChange={(event) => {
            setServerError(undefined);
            setForm(withKey(form, event.target.value, taken));
          }}
        />
        <Input
          label="Icon"
          value={form.icon}
          placeholder="An emoji, optional"
          error={shown.icon}
          onChange={(event) => setForm({ ...form, icon: event.target.value })}
        />
        <div className={styles.field}>
          <span className={styles.fieldLabel} aria-hidden="true">
            Color
          </span>
          <ColorPicker
            aria-label="Team color"
            value={form.color}
            onValueChange={(color) => setForm({ ...form, color })}
          />
        </div>
        <Input
          label="Time zone"
          value={form.timezone}
          placeholder="Europe/Berlin"
          error={shown.timezone}
          onChange={(event) => setForm({ ...form, timezone: event.target.value })}
        />
      </form>
    </Dialog>
  );
}

/**
 * The create-team dialog and a function that opens it. Each opening mounts a fresh form, so its
 * defaults (the creator's time zone, the taken keys) come from the replica as it is then: hosts
 * mount before the replica is ready, and a form made at mount would default to UTC.
 */
export function useCreateTeamDialog(): { readonly open: () => void; readonly dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(0);
  return {
    open: () => {
      setOpening((n) => n + 1);
      setOpen(true);
    },
    dialog: <CreateTeamDialog key={opening} open={open} onOpenChange={setOpen} />,
  };
}
