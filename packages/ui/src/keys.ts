// Shortcut notation shared with the shortcut registry (shortcuts.md §1): a chord is "Mod+Shift+K"
// (modifiers first, joined by "+"); a sequence is an array of chords, e.g. ["G", "I"].
import type { Platform } from './platform.js';

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
};

const OTHER_LABELS: Readonly<Record<string, string>> = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
};

const NAMED_KEYS: Readonly<Record<string, { label: string; spoken: string }>> = {
  Enter: { label: '↵', spoken: 'Enter' },
  Escape: { label: 'Esc', spoken: 'Escape' },
  Esc: { label: 'Esc', spoken: 'Escape' },
  Backspace: { label: '⌫', spoken: 'Backspace' },
  Tab: { label: 'Tab', spoken: 'Tab' },
  Space: { label: 'Space', spoken: 'Space' },
  ArrowUp: { label: '↑', spoken: 'Up arrow' },
  ArrowDown: { label: '↓', spoken: 'Down arrow' },
  ArrowLeft: { label: '←', spoken: 'Left arrow' },
  ArrowRight: { label: '→', spoken: 'Right arrow' },
};

const SPOKEN_MODIFIERS: Readonly<Record<Platform, Readonly<Record<string, string>>>> = {
  mac: { Mod: 'Command', Ctrl: 'Control', Alt: 'Option', Shift: 'Shift' },
  other: { Mod: 'Control', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift' },
};

/** Splits "Mod+Shift+K" into ["Mod", "Shift", "K"]. A trailing "+" is the plus key: "Mod++". */
export function parseChord(chord: string): string[] {
  const split = (text: string) =>
    text
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  if (!chord.endsWith('+')) return split(chord);
  // "+" → [+]; "Mod++" → [Mod, +]: drop the plus key, then the separator before it, if any.
  return [...split(chord.slice(0, -1).replace(/\+$/, '')), '+'];
}

const ARIA_MODIFIERS: Readonly<Record<Platform, Readonly<Record<string, string>>>> = {
  mac: { Mod: 'Meta', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift' },
  other: { Mod: 'Control', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift' },
};

const ARIA_KEYS: Readonly<Record<string, string>> = { Esc: 'Escape' };

/**
 * The `aria-keyshortcuts` value for a chord ("Meta+K" on macOS, "Control+K" elsewhere). A sequence
 * ("G then I") cannot be expressed in that attribute, so it returns undefined.
 */
export function ariaKeyShortcuts(
  keys: string | readonly string[],
  platform: Platform,
): string | undefined {
  const chord = typeof keys === 'string' ? keys : keys.length === 1 ? keys[0] : undefined;
  if (chord === undefined) return undefined;
  return parseChord(chord)
    .map(
      (key) =>
        ARIA_MODIFIERS[platform][key] ??
        ARIA_KEYS[key] ??
        (key.length === 1 ? key.toUpperCase() : key),
    )
    .join('+');
}

/** The visible label of each key in a chord: ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function keyLabels(chord: string, platform: Platform): string[] {
  const modifiers = platform === 'mac' ? MAC_SYMBOLS : OTHER_LABELS;
  return parseChord(chord).map(
    (key) =>
      modifiers[key] ?? NAMED_KEYS[key]?.label ?? (key.length === 1 ? key.toUpperCase() : key),
  );
}

/** How a screen reader should say a chord or sequence: "Command K", "G then I". */
export function spokenShortcut(keys: string | readonly string[], platform: Platform): string {
  const chords = typeof keys === 'string' ? [keys] : keys;
  return chords
    .map((chord) =>
      parseChord(chord)
        .map(
          (key) =>
            SPOKEN_MODIFIERS[platform][key] ??
            NAMED_KEYS[key]?.spoken ??
            (key.length === 1 ? key.toUpperCase() : key),
        )
        .join(' '),
    )
    .join(' then ');
}
