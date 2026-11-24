// The page around the Attachments section in the key, paste and viewer tests (PLAN-014 S5): a
// plain text field (the title, say) and a comment box, plus a counter for the browser's file
// picker. A test file using `around` mocks `editor-host.js` with `comment-editor-fake.js`.
import { EMPTY_DOC } from '@surface/domain';
import { act } from 'react';
import { vi } from 'vitest';
import { ComposerBox } from '../src/features/comments/ComposerBox.js';

export const linkDialog = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes('Link any URL to issue'),
  );
export const uploadRows = () => document.querySelectorAll('[data-testid="upload-row"]');

/** Around the section: a plain text field (the title, say) and a comment box. */
export const around = (
  <>
    <input aria-label="Title" />
    {/* A rich-text editor's surface, as TipTap renders it (the comment fake is a textarea). */}
    <div contentEditable suppressContentEditableWarning aria-label="Rich text" />
    <ComposerBox
      value={EMPTY_DOC}
      onChange={() => undefined}
      onSubmit={() => undefined}
      placeholder="Leave a comment…"
      ariaLabel="Comment"
      submitLabel="Comment"
      canSubmit={false}
    />
  </>
);

export function field(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`no ${label}`);
  return element;
}

export async function focus(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.focus();
    await Promise.resolve();
  });
}

export const modShiftU = (platform: 'mac' | 'other') => ({
  code: 'KeyU',
  shiftKey: true,
  ...(platform === 'mac' ? { metaKey: true } : { ctrlKey: true }),
});

/** Counts the times the hidden file input is clicked (the browser would open its picker). */
export function countFilePicker(): { readonly opened: () => number } {
  let opened = 0;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement,
  ) {
    if (this.type === 'file') opened += 1;
  });
  return { opened: () => opened };
}
