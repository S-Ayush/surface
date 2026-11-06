import { describe, expect, it } from 'vitest';
import { ariaKeyShortcuts, keyLabels, parseChord, spokenShortcut } from '../src/keys.js';

describe('parseChord', () => {
  it('splits modifiers and key, keeping a literal plus', () => {
    expect(parseChord('Mod+Shift+K')).toEqual(['Mod', 'Shift', 'K']);
    expect(parseChord('?')).toEqual(['?']);
    expect(parseChord('+')).toEqual(['+']);
  });

  it('reads a trailing plus as the plus key, after modifiers too', () => {
    expect(parseChord('Mod++')).toEqual(['Mod', '+']);
    expect(parseChord('Shift++')).toEqual(['Shift', '+']);
    expect(parseChord('Mod+Shift++')).toEqual(['Mod', 'Shift', '+']);
  });
});

describe('keyLabels', () => {
  it('renders Mod as ⌘ on macOS and Ctrl elsewhere, never hard-coding either (shortcuts.md rule 1)', () => {
    expect(keyLabels('Mod+K', 'mac')).toEqual(['⌘', 'K']);
    expect(keyLabels('Mod+K', 'other')).toEqual(['Ctrl', 'K']);
  });

  it('uses symbols for Alt and Shift on macOS and words elsewhere', () => {
    expect(keyLabels('Alt+Shift+T', 'mac')).toEqual(['⌥', '⇧', 'T']);
    expect(keyLabels('Alt+Shift+T', 'other')).toEqual(['Alt', 'Shift', 'T']);
  });

  it('upper-cases letters and names special keys', () => {
    expect(keyLabels('g', 'mac')).toEqual(['G']);
    expect(keyLabels('Escape', 'other')).toEqual(['Esc']);
    expect(keyLabels('Mod+Enter', 'mac')).toEqual(['⌘', '↵']);
  });
});

describe('spokenShortcut', () => {
  it('says chords with platform modifier names', () => {
    expect(spokenShortcut('Mod+K', 'mac')).toBe('Command K');
    expect(spokenShortcut('Mod+K', 'other')).toBe('Control K');
    expect(spokenShortcut('Alt+Shift+T', 'mac')).toBe('Option Shift T');
  });

  it('joins sequences with "then"', () => {
    expect(spokenShortcut(['G', 'S'], 'other')).toBe('G then S');
  });
});

describe('ariaKeyShortcuts', () => {
  it('maps Mod to Meta on macOS and Control elsewhere, in aria-keyshortcuts syntax', () => {
    expect(ariaKeyShortcuts('Mod+Enter', 'mac')).toBe('Meta+Enter');
    expect(ariaKeyShortcuts('Mod+Shift+k', 'other')).toBe('Control+Shift+K');
    expect(ariaKeyShortcuts('Esc', 'other')).toBe('Escape');
    expect(ariaKeyShortcuts(['C'], 'mac')).toBe('C');
  });

  it('omits sequences, which the attribute cannot express', () => {
    expect(ariaKeyShortcuts(['G', 'S'], 'mac')).toBeUndefined();
  });
});
