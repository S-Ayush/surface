// The reset-link modal's steps (SPEC-001 §3.3, PLAN-001 S7), apart from React so they test
// without a browser: ask first (generating turns off the person's earlier links), then show the
// link once. One request at a time, and the modal stays open while it runs.
import { LINK_LIFETIME_TEXT } from '@surface/domain';
import type { MembersApi } from './api.js';

export type ResetLinkView =
  | { readonly phase: 'ask'; readonly busy: boolean; readonly error: string | null }
  | { readonly phase: 'shown'; readonly url: string; readonly expiresAt: Date };

export const ASK: ResetLinkView = { phase: 'ask', busy: false, error: null };

export class ResetLinkFlow {
  #view: ResetLinkView = ASK;

  constructor(
    private readonly api: MembersApi,
    private readonly onView: (view: ResetLinkView) => void,
  ) {}

  get view(): ResetLinkView {
    return this.#view;
  }

  async generate(userId: string): Promise<void> {
    if (this.#view.phase !== 'ask' || this.#view.busy) return;
    this.#show({ phase: 'ask', busy: true, error: null });
    const result = await this.api.createResetLink(userId);
    this.#show(
      result.ok
        ? { phase: 'shown', url: result.url, expiresAt: result.expiresAt }
        : { phase: 'ask', busy: false, error: result.message },
    );
  }

  #show(view: ResetLinkView): void {
    this.#view = view;
    this.onView(view);
  }
}

/**
 * Whether the modal may close. Not while a link is being generated: it would be made anyway,
 * turning off the person's earlier links, and nobody would ever see it.
 */
export function mayClose(view: ResetLinkView): boolean {
  return !(view.phase === 'ask' && view.busy);
}

/** The part of the Clipboard API used; `navigator.clipboard` is missing outside secure contexts. */
export type ClipboardLike = { writeText(text: string): Promise<void> };

/**
 * Copies `text`. False when the browser can't: no clipboard on a plain-http address
 * (`http://surface.lan`, a self-hosted install without TLS), or the write was refused.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardLike | undefined,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** What the modal says before generating, about `name`. */
export function resetLinkIntro(name: string, self: boolean): string {
  const who = self ? 'you' : name;
  const their = self ? 'Your' : 'Their';
  return `Generate a link for ${who} to choose a new password. It works once, for ${LINK_LIFETIME_TEXT.passwordReset}. ${their} earlier reset links stop working.`;
}

/** What the modal says beside the link. */
export function resetLinkShownNote(name: string, self: boolean): string {
  return self
    ? 'Shown only this once. Using it logs you out everywhere.'
    : `Shown only this once. Send it to ${name} directly. Using it logs them out everywhere.`;
}
