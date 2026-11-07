// Mod+Enter in a dialog submits like the form's default button would (shortcuts.md §3.8).
import { describe, expect, it } from 'vitest';
import {
  canSubmitWith,
  defaultSubmitter,
  type ControlLike,
} from '../src/shortcuts/dialogSubmit.js';

const control = (
  tagName: string,
  type: string,
  attrs: Record<string, string> = {},
  disabled = false,
) =>
  ({
    tagName,
    type,
    disabled,
    getAttribute: (name: string) => attrs[name] ?? null,
  }) satisfies ControlLike;

describe('dialog submit', () => {
  it('uses the first submit button, as implicit submission does', () => {
    const cancel = control('BUTTON', 'button');
    const create = control('BUTTON', 'submit');
    const other = control('INPUT', 'submit');
    expect(defaultSubmitter([control('INPUT', 'text'), cancel, create, other])).toBe(create);
    expect(defaultSubmitter([control('INPUT', 'text')])).toBeNull();
  });

  it('does not submit while the default button is disabled or busy', () => {
    expect(canSubmitWith(control('BUTTON', 'submit', {}, true))).toBe(false);
    expect(canSubmitWith(control('BUTTON', 'submit', { 'aria-busy': 'true' }))).toBe(false);
    expect(canSubmitWith(control('BUTTON', 'submit'))).toBe(true);
    expect(canSubmitWith(null)).toBe(true);
  });
});
