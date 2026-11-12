// Settings → Account → Profile (SPEC-001 §3.5, §7; PLAN-001 S6): your avatar, name, display name
// and time zone. Read from the replica, so a change from another tab shows as its delta lands;
// saved with `user.updateProfile` (save.ts), live for everyone (AC-15).
import { User } from '@surface/domain/model';
import { Button, Input, Spinner } from '@surface/ui';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { useSettingsApi } from '../files/api.js';
import { ImagePicker } from '../files/ImagePicker.js';
import { fileUrl } from '../files/url.js';
import styles from './profile.module.css';
import {
  changeAvatar,
  profileChanges,
  profileProblems,
  removeAvatar,
  saveProfile,
  type ProfileField,
  type ProfileValues,
} from './save.js';

type Me = ProfileValues & { readonly avatarFileId: string | null };

/** The browser's time zones, for the field's suggestions; empty where the browser has none. */
function timeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export function ProfileScreen(_props: ScreenProps) {
  const app = useApp();
  const me = useObserved(
    useCallback((): Me | undefined => {
      const store = app.store;
      const session = app.session;
      if (store === null || store.status !== 'ready' || session === null) return undefined;
      const user = store.pool.get(User, session.userId);
      return user === undefined
        ? undefined
        : {
            name: user.name,
            displayName: user.displayName,
            timezone: user.timezone,
            avatarFileId: user.avatarFileId,
          };
    }, [app]),
  );
  if (me === undefined) {
    return (
      <div className={styles.screen}>
        <Spinner />
      </div>
    );
  }
  return (
    <div className={styles.screen}>
      <AvatarSection me={me} />
      <ProfileForm saved={me} />
    </div>
  );
}

function AvatarSection({ me }: { readonly me: Me }) {
  const app = useApp();
  const api = useSettingsApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (
    change: (store: NonNullable<typeof app.store>) => Promise<{ ok: boolean; message?: string }>,
  ) => {
    const store = app.store;
    if (store === null || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await change(store);
    setBusy(false);
    if (!result.ok) setError(result.message);
  };

  return (
    <section className={styles.section} aria-labelledby="avatar">
      <h2 id="avatar" className={styles.heading}>
        Avatar
      </h2>
      <ImagePicker
        label="avatar"
        alt="Your avatar"
        name={me.name}
        src={fileUrl(me.avatarFileId)}
        busy={busy}
        error={error}
        onPick={(file) => void run((store) => changeAvatar(api, store, file))}
        onRemove={() => void run((store) => removeAvatar(store))}
      />
    </section>
  );
}

function ProfileForm({ saved }: { readonly saved: ProfileValues }) {
  const app = useApp();
  // Only the user's edits: until there is one, a field follows the saved value as deltas land.
  const [edits, setEdits] = useState<Partial<ProfileValues>>({});
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<{ message: string; field?: ProfileField }>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const values: ProfileValues = { ...saved, ...edits };
  const problems = touched ? profileProblems(values) : {};
  const changed = Object.keys(profileChanges(saved, values)).length > 0;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const reset = () => {
    setEdits({});
    setTouched(false);
    setError(undefined);
    setNote(undefined);
  };

  const edit = (field: ProfileField, value: string) => {
    setError(undefined);
    setEdits((previous) => ({ ...previous, [field]: value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const store = app.store;
    if (store === null || busy) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    const result = await saveProfile(store, saved, values);
    setBusy(false);
    if (result.kind === 'saved') reset();
    else if (result.kind === 'queued') setNote(result.note);
    else if (result.kind === 'error') setError(result);
  };

  const fieldError = (field: ProfileField) =>
    problems[field] ?? (error?.field === field ? error.message : undefined);

  return (
    <section className={styles.section} aria-labelledby="profile">
      <h2 id="profile" className={styles.heading}>
        Profile
      </h2>
      <form className={styles.form} onSubmit={(event) => void save(event)} noValidate>
        {error !== undefined && error.field === undefined && (
          <p role="alert" className={styles.formError}>
            {error.message}
          </p>
        )}
        <Input
          label="Name"
          autoComplete="name"
          value={values.name}
          error={fieldError('name')}
          onChange={(event) => edit('name', event.target.value)}
        />
        <Input
          label="Display name"
          autoComplete="username"
          value={values.displayName}
          error={fieldError('displayName')}
          hint="How people @mention you. Letters, digits, dots, dashes and underscores."
          onChange={(event) => edit('displayName', event.target.value)}
        />
        <Input
          label="Time zone"
          list="profile-time-zones"
          value={values.timezone}
          error={fieldError('timezone')}
          hint={`An IANA name, like Europe/Berlin. This browser is in ${browserZone}.`}
          onChange={(event) => edit('timezone', event.target.value)}
        />
        <datalist id="profile-time-zones">
          {timeZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {note !== undefined && <p className={styles.note}>{note}</p>}
        <div className={styles.actions}>
          {values.timezone !== browserZone && (
            <Button variant="ghost" type="button" onClick={() => edit('timezone', browserZone)}>
              Use this browser’s time zone
            </Button>
          )}
          <Button variant="ghost" type="button" disabled={!changed} onClick={reset}>
            Discard
          </Button>
          <Button type="submit" loading={busy} disabled={!changed}>
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}
