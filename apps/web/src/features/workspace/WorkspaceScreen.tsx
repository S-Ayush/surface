// Settings → Workspace, Admins only (SPEC-001 §3.6, §7; PLAN-001 S7): the workspace's name, which
// the sidebar and the browser tab show. Saving waits for the server (save.ts); the logo comes
// with file uploads (PLAN-001 S6).
import { Workspace } from '@surface/domain/model';
import { Button, Input, Spinner } from '@surface/ui';
import { useCallback, useState, type FormEvent } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { saveWorkspaceName, workspaceNameProblem } from './save.js';
import styles from './workspace.module.css';

export { QUEUED_NOTE, workspaceNameProblem } from './save.js';

/** Setup creates the workspace, so this means the replica is incomplete. */
export const NO_WORKSPACE = 'The workspace hasn’t loaded. Reload the page.';

export function WorkspaceScreen(_props: ScreenProps) {
  const app = useApp();
  // undefined while the store loads; null when it is ready without a workspace row.
  const saved = useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return undefined;
      return store.pool.all(Workspace)[0]?.name ?? null;
    }, [app]),
  );
  if (saved === undefined) {
    return (
      <div className={styles.screen}>
        <Spinner />
      </div>
    );
  }
  if (saved === null) {
    return (
      <div className={styles.screen}>
        <p role="alert" className={styles.formError}>
          {NO_WORKSPACE}
        </p>
      </div>
    );
  }
  return <WorkspaceForm saved={saved} />;
}

function WorkspaceForm({ saved }: { readonly saved: string }) {
  const app = useApp();
  // Only the user's edit: until there is one, the field follows the saved name as deltas land.
  const [edit, setEdit] = useState<string>();
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const name = edit ?? saved;
  const problem = touched ? workspaceNameProblem(name) : undefined;
  const changed = edit !== undefined && edit.trim() !== saved;

  const reset = () => {
    setEdit(undefined);
    setTouched(false);
    setError(undefined);
    setNote(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const store = app.store;
    if (store === null || busy) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    const result = await saveWorkspaceName(store, name, saved);
    setBusy(false);
    if (result.kind === 'saved') reset();
    else if (result.kind === 'queued') setNote(result.note);
    else if (result.kind === 'error') setError(result.message);
  };

  return (
    <form className={styles.form} onSubmit={(event) => void save(event)} noValidate>
      {error !== undefined && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
      <Input
        label="Workspace name"
        value={name}
        error={problem}
        hint="Shown in the sidebar, the browser tab and emails."
        onChange={(event) => {
          setError(undefined);
          setEdit(event.target.value);
        }}
      />
      {note !== undefined && <p className={styles.note}>{note}</p>}
      <div className={styles.actions}>
        <Button variant="ghost" type="button" disabled={edit === undefined} onClick={reset}>
          Discard
        </Button>
        <Button type="submit" loading={busy} disabled={!changed}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
