// SPEC-015 E1, E2 (PLAN-015 S4): an edit refused because its issue was deleted or archived
// meanwhile ("ENG-42 was deleted. Restore it to edit it.") rolls back, so the typing would be lost.
// For a description, the refusal's toast offers **Copy text**; comments already do (SPEC-013 §3.1,
// `comments/actions.ts`).
import { isDocJson, isLockedRefusal, type DocNodeJSON } from '@surface/domain';
import type { ToastOptions } from '@surface/ui';

export interface CopyTextDeps {
  /** The document as Markdown. */
  readonly markdownOf: (doc: DocNodeJSON) => string;
  readonly copy: (text: string) => Promise<boolean>;
}

/** The danger toast for a refused description save, with **Copy text** when the issue is locked. */
export function refusedTextToast(
  message: string,
  doc: DocNodeJSON | undefined,
  deps: CopyTextDeps,
): ToastOptions {
  if (doc === undefined || !isLockedRefusal(message)) return { tone: 'danger', message };
  return {
    tone: 'danger',
    message,
    // Until the user acts: the text is only here.
    duration: Infinity,
    action: {
      label: 'Copy text',
      onAction: () => {
        void deps.copy(deps.markdownOf(doc));
      },
    },
  };
}

/** The description of a queued `issue.updateDescription` the shell reports after a reload. */
export function refusedDescription(op: string, input: unknown): DocNodeJSON | undefined {
  if (op !== 'issue.updateDescription' || typeof input !== 'object' || input === null) {
    return undefined;
  }
  const description: unknown = Reflect.get(input, 'description');
  return isDocJson(description) ? description : undefined;
}
