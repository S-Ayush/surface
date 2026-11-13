// The Copy › actions (SPEC-012 §3.7): what each one copies and what its toast says. Pure, so the
// list's row menu, PLAN-012 S4's page header and S6's keys share the wording. "Copy issue as
// Markdown" needs the description, which a list row doesn't have, so it joins with S4.
import { gitBranchName, issueSlug, issueUrl } from '@surface/domain';
import { toast } from '@surface/ui';
import { copyText, type ClipboardLike } from '../members/reset-link.js';
import { announce } from './announcer.js';

export type CopyKind = 'id' | 'url' | 'title' | 'title-link' | 'branch';

/** What a copy reads of an issue. `identifier` is `ENG-42`, or null while the number is pending. */
export interface CopyTarget {
  readonly identifier: string | null;
  readonly title: string;
}

export type CopyPlan =
  | { readonly ok: true; readonly text: string; readonly message: string }
  | { readonly ok: false; readonly message: string };

export const COPY_ITEMS: readonly { readonly kind: CopyKind; readonly label: string }[] = [
  { kind: 'id', label: 'Copy ID' },
  { kind: 'url', label: 'Copy URL' },
  { kind: 'title', label: 'Copy title' },
  { kind: 'title-link', label: 'Copy title as link' },
  { kind: 'branch', label: 'Copy git branch name' },
];

/** What `kind` copies for `target`, with the page's own origin (the client never reads config). */
export function planCopy(
  kind: CopyKind,
  target: CopyTarget,
  origin: string,
  displayName: string,
): CopyPlan {
  const { identifier, title } = target;
  if (identifier === null) {
    return { ok: false, message: 'Wait a moment: ENG-… has no number yet.' };
  }
  switch (kind) {
    case 'id':
      return { ok: true, text: identifier, message: `Copied ${identifier}` };
    case 'url':
      return {
        ok: true,
        text: issueUrl(origin, identifier, title),
        message: `Copied link to ${identifier}`,
      };
    case 'title':
      return { ok: true, text: title, message: 'Copied title' };
    case 'title-link':
      return {
        ok: true,
        text: `[${title}](${issueUrl(origin, identifier, title)})`,
        message: 'Copied title as link',
      };
    case 'branch':
      return {
        ok: true,
        text: gitBranchName(displayName, identifier, issueSlug(title)),
        message: 'Copied branch name',
      };
  }
}

/** Copies per `plan` and says so in a toast and the live region. */
export async function runCopy(plan: CopyPlan, clipboard: ClipboardLike | undefined): Promise<void> {
  if (!plan.ok) {
    toast({ tone: 'danger', message: plan.message });
    return;
  }
  const copied = await copyText(plan.text, clipboard);
  const message = copied ? plan.message : "Couldn't copy. Allow clipboard access and try again.";
  toast({ tone: copied ? 'neutral' : 'danger', message });
  announce(message);
}
