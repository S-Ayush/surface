import { Button, Input, ProgressBar, SurfaceLockup } from '@surface/ui';
import type { FormEvent } from 'react';
import styles from './SetupView.module.css';
import type { SetupScreen } from './state.js';
import { STEPS, type FieldErrors, type SetupValues, type Step } from './wizard.js';

export type { SetupScreen } from './state.js';

export interface SetupViewProps {
  readonly screen: SetupScreen;
  readonly values: SetupValues;
  readonly errors: FieldErrors;
  /** A problem with the whole form (from the server, or the network). */
  readonly formError: string | undefined;
  readonly submitting: boolean;
  /** Shown on the last step once the server refused the link's token: the newest link. */
  readonly newLink: string | undefined;
  readonly onChange: (field: keyof SetupValues, value: string) => void;
  readonly onNewLinkChange: (text: string) => void;
  /** Check the link again now, on the "can't reach" screen. */
  readonly onRetry: () => void;
  /** Enter or the button: next step, or finish on the last one (SPEC-001 §3.1 keyboard). */
  readonly onSubmit: () => void;
  readonly onBack: () => void;
}

const TITLES: Record<Step, string> = {
  workspace: 'Name your workspace',
  admin: 'Create your Admin account',
  team: 'Create your first team',
};

/** The setup wizard (SPEC-001 §3.1, §7): three steps with a progress indicator. */
export function SetupView(props: SetupViewProps) {
  const { screen } = props;
  if (screen.t === 'checking') {
    return (
      <Shell title="Set up Surface">
        <p className={styles.text}>Checking the setup link…</p>
      </Shell>
    );
  }
  if (screen.t === 'invalid-link') {
    return (
      <Shell title="Find the setup link in the server logs">
        <p className={styles.text}>
          This page needs the link Surface printed when it started. It looks like{' '}
          <code>/setup?token=…</code>. For a new link, run <code>surface setup-token</code> on the
          server.
        </p>
      </Shell>
    );
  }
  if (screen.t === 'unavailable') {
    return (
      <Shell title="Can’t reach Surface yet">
        <p className={styles.text}>
          The server may still be starting. This page tries again every few seconds.
        </p>
        <div className={styles.actions}>
          <Button variant="primary" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }
  if (screen.t === 'complete') {
    return (
      <Shell title="Surface is already set up">
        <p className={styles.text}>
          <a href="/">Sign in to your workspace</a>
        </p>
      </Shell>
    );
  }
  const index = STEPS.indexOf(screen.step);
  const last = index === STEPS.length - 1;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };
  return (
    <Shell title={TITLES[screen.step]}>
      <p className={styles.progressLabel}>
        Step {index + 1} of {STEPS.length}
      </p>
      <ProgressBar aria-label="Setup progress" value={index + 1} max={STEPS.length} />
      <form className={styles.form} onSubmit={submit} noValidate aria-label={TITLES[screen.step]}>
        <StepFields {...props} step={screen.step} />
        {last && props.newLink !== undefined && (
          <Input
            label="Newest setup link"
            hint="From the server logs, or from surface setup-token"
            name="newLink"
            autoFocus
            spellCheck={false}
            value={props.newLink}
            onChange={(event) => props.onNewLinkChange(event.currentTarget.value)}
          />
        )}
        {props.formError !== undefined && (
          <p className={styles.formError} role="alert">
            {props.formError}
          </p>
        )}
        <div className={styles.actions}>
          {index > 0 && (
            <Button variant="ghost" onClick={props.onBack} disabled={props.submitting}>
              Back
            </Button>
          )}
          <Button type="submit" variant="primary" loading={props.submitting}>
            {last ? 'Finish setup' : 'Continue'}
          </Button>
        </div>
      </form>
    </Shell>
  );
}

function StepFields({ step, values, errors, onChange }: SetupViewProps & { step: Step }) {
  const field = (name: keyof SetupValues) => ({
    name,
    value: String(values[name]),
    error: errors[name],
    onChange: (event: { currentTarget: HTMLInputElement }) =>
      onChange(name, event.currentTarget.value),
  });
  if (step === 'workspace') {
    return (
      <Input
        label="Workspace name"
        hint="Usually your company or group, like Acme"
        autoFocus
        autoComplete="organization"
        {...field('workspaceName')}
      />
    );
  }
  if (step === 'admin') {
    return (
      <>
        <Input label="Your name" autoFocus autoComplete="name" {...field('name')} />
        <Input label="Email" type="email" autoComplete="email" {...field('email')} />
        <Input
          label="Password"
          type="password"
          hint="At least 10 characters"
          autoComplete="new-password"
          {...field('password')}
        />
        <Input
          label="Password again"
          type="password"
          autoComplete="new-password"
          {...field('confirmPassword')}
        />
      </>
    );
  }
  return (
    <>
      <Input label="Team name" hint="Like Engineering" autoFocus {...field('teamName')} />
      <Input
        label="Team key"
        hint="2–5 capital letters. Issue IDs start with it, like ENG-1"
        autoCapitalize="characters"
        spellCheck={false}
        {...field('teamKey')}
      />
    </>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={styles.page} tabIndex={-1}>
      {/* Brand.md §7: the lockup above the screen, 24 px tall. */}
      <SurfaceLockup height={24} title="Surface" />
      <section className={styles.card} aria-labelledby="setup-title">
        <h1 id="setup-title" className={styles.title}>
          {title}
        </h1>
        {children}
      </section>
    </main>
  );
}
