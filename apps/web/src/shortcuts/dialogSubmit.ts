// Mod+Enter in a dialog (shortcuts.md §3.8): submits the form that has focus, as its default submit
// button would. If that button is disabled or busy, nothing happens, like a plain Enter: otherwise
// Mod+Enter would bypass the guard and could submit twice while a request is in flight.

/** The parts of a form control this reads, so it can be tested without a DOM. */
export type ControlLike = {
  readonly tagName: string;
  readonly type?: string;
  readonly disabled?: boolean;
  getAttribute(name: string): string | null;
};

const isSubmitButton = (control: ControlLike) => {
  const tag = control.tagName.toUpperCase();
  const type = (control.type ?? '').toLowerCase();
  return (
    (tag === 'BUTTON' && type === 'submit') ||
    (tag === 'INPUT' && (type === 'submit' || type === 'image'))
  );
};

/** The form's default button: its first submit button in tree order (HTML "implicit submission"). */
export function defaultSubmitter<T extends ControlLike>(controls: Iterable<T>): T | null {
  for (const control of controls) if (isSubmitButton(control)) return control;
  return null;
}

/** Whether the form may be submitted now: no default button, or one that is enabled and idle. */
export function canSubmitWith(submitter: ControlLike | null): boolean {
  if (submitter === null) return true;
  return submitter.disabled !== true && submitter.getAttribute('aria-busy') !== 'true';
}

/** The form of the focused control, when focus is inside a dialog. */
export function focusedDialogForm(doc: Document = document): HTMLFormElement | null {
  const active = doc.activeElement;
  if (active?.closest('[role="dialog"], [role="alertdialog"]') == null) return null;
  // A control can belong to a form it is not inside (`form="id"`, e.g. a footer button).
  if ('form' in active && active.form instanceof HTMLFormElement) return active.form;
  return active.closest('form');
}

export function submitFocusedDialog(doc: Document = document): void {
  const form = focusedDialogForm(doc);
  if (form === null) return;
  const submitter = defaultSubmitter(Array.from(form.elements));
  if (!canSubmitWith(submitter)) return;
  // Pass the button so the submit event names it, as a click or Enter would.
  form.requestSubmit(
    submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
      ? submitter
      : null,
  );
}

export function canSubmitFocusedDialog(doc: Document = document): boolean {
  const form = focusedDialogForm(doc);
  return form !== null && canSubmitWith(defaultSubmitter(Array.from(form.elements)));
}
