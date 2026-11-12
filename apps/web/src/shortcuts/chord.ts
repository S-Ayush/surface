// Chords and key matching (SPEC-005 §5, E2, E3). The notation is shared with the design system
// (`parseChord` in @surface/ui, shortcuts.md §1): "Mod+Shift+K", "?", "Esc", and a sequence is a
// list of chords (["G", "S"]).
import { parseChord, type Platform } from '@surface/ui';

export type Chord = {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** An upper-case letter ("K"), another printable character ("?", ",", "1") or a named key. */
  readonly key: string;
  /**
   * The physical key (`event.code`) this chord matches, when the chord is position-based
   * (SPEC-012 §4.2): digits, every chord with Alt, Shift with a non-letter, and letters with
   * Mod or Ctrl. Absent for chords that match what the key types (`event.key`).
   */
  readonly code?: string;
};

/** The parts of a KeyboardEvent the engine reads, so it can be tested without a DOM. */
export type KeyInput = {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly keyCode?: number;
  readonly getModifierState?: (key: string) => boolean;
};

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const NAMED_KEYS = new Set([
  'Escape',
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const KEY_ALIASES: Readonly<Record<string, string>> = { Esc: 'Escape' };

/** Keys that only modify another key; pressing one alone never matches or breaks a sequence. */
export const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'CapsLock',
  'Fn',
  'FnLock',
]);

const isModifier = (part: string): part is Modifier =>
  MODIFIER_ORDER.some((modifier) => modifier === part);
const isAsciiLetter = (key: string) => /^[A-Za-z]$/.test(key);

/** `event.code` of the printable characters a position-based chord may name (US physical keys). */
const SYMBOL_CODES: Readonly<Record<string, string>> = {
  '.': 'Period',
  ',': 'Comma',
  "'": 'Quote',
  '\\': 'Backslash',
  ';': 'Semicolon',
  '/': 'Slash',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '`': 'Backquote',
};

type Flags = Pick<Chord, 'mod' | 'ctrl' | 'alt' | 'shift'>;

/**
 * The physical key a chord matches, `undefined` when it matches what the key types, and `null`
 * for a position-based chord on a character with no known key (SPEC-012 §4.2, SPEC-005 E3).
 */
function codeFor(key: string, flags: Flags): string | null | undefined {
  if (NAMED_KEYS.has(key)) return undefined;
  if (isAsciiLetter(key)) {
    // Mod, Ctrl and Alt change `event.key` (Option+T types "†"), so the position is what counts.
    return flags.mod || flags.ctrl || flags.alt ? `Key${key}` : undefined;
  }
  // Digits match the top row only (SPEC-012 §4.2): Numpad1 has its own code and is not bound.
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (flags.alt || flags.shift) return SYMBOL_CODES[key] ?? null;
  return undefined;
}

/** Parses one chord. Throws on notation the matcher cannot honour, so the registry fails at load. */
export function toChord(text: string): Chord {
  const parts = parseChord(text);
  const last = parts.at(-1);
  if (last === undefined) throw new Error(`Empty shortcut chord: "${text}"`);
  const modifiers = parts.slice(0, -1);
  for (const part of modifiers) {
    if (!isModifier(part)) throw new Error(`Unknown modifier "${part}" in "${text}"`);
  }
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error(`Repeated modifier in "${text}"`);
  }
  const named = KEY_ALIASES[last] ?? last;
  let key: string;
  if (isAsciiLetter(named)) key = named.toUpperCase();
  else if (NAMED_KEYS.has(named)) key = named;
  else if ([...named].length === 1 && !isModifier(named)) key = named;
  else throw new Error(`Unknown key "${last}" in "${text}"`);
  const has = (modifier: Modifier) => modifiers.includes(modifier);
  const code = codeFor(key, {
    mod: has('Mod'),
    ctrl: has('Ctrl'),
    alt: has('Alt'),
    shift: has('Shift'),
  });
  if (code === null) throw new Error(`No physical key is known for "${last}" in "${text}"`);
  const flags = { mod: has('Mod'), ctrl: has('Ctrl'), alt: has('Alt'), shift: has('Shift') };
  return code === undefined ? { ...flags, key } : { ...flags, key, code };
}

/** "Mod+Shift+K": modifiers in a fixed order, so equal chords have equal text. */
export function chordText(chord: Chord): string {
  const flags: Record<Modifier, boolean> = {
    Mod: chord.mod,
    Ctrl: chord.ctrl,
    Alt: chord.alt,
    Shift: chord.shift,
  };
  return [...MODIFIER_ORDER.filter((modifier) => flags[modifier]), chord.key].join('+');
}

/**
 * The same chord as the physical keys pressed on a platform: `Mod` is ⌘ on macOS and Ctrl elsewhere,
 * so "Mod+K" and "Ctrl+K" are one chord on Windows and Linux (shortcuts.md rule 1).
 */
export function platformChordText(chord: Chord, platform: Platform): string {
  if (platform === 'mac') return chordText(chord);
  return chordText({ ...chord, mod: false, ctrl: chord.mod || chord.ctrl });
}

/** Mod (or Ctrl) chords are the only ones that fire while typing or over an overlay (§5). */
export function isCommandChord(chord: Chord): boolean {
  return chord.mod || chord.ctrl;
}

/** The letter key pressed: the typed letter, or the key's position on non-Latin layouts. */
function letterOf(event: KeyInput): string | undefined {
  if (isAsciiLetter(event.key)) return event.key.toUpperCase();
  // A letter outside A–Z (Cyrillic "п", or "é" on a dead key): use the key's QWERTY position.
  if (/^\p{L}$/u.test(event.key)) return /^Key([A-Z])$/.exec(event.code)?.[1];
  return undefined;
}

/** Whether the chord matches by position (`event.code`) rather than by typed character. */
export const matchesByCode = (chord: Chord): boolean => chord.code !== undefined;

/**
 * Whether a keydown is this chord (SPEC-005 E3, as built in PLAN-005 S5 and changed by SPEC-012 §4.2):
 * - position-based chords (`chord.code`: digits, anything with Alt, Shift with a non-letter,
 *   letters with Mod or Ctrl) match `event.code` with exact modifiers, because those modifiers
 *   change `event.key` and layouts move punctuation around;
 * - other letters and printable characters match what the key types (`event.key`), so `?` and `#`
 *   work on any layout; for characters, Shift, Option and AltGr are part of typing them and are
 *   not compared;
 * - named keys (Esc, Enter, arrows, F-keys) match `event.key` with exact modifiers.
 * The engine tries chords that match by `event.key` first (see `matchesByCode`).
 */
export function matchesChord(event: KeyInput, chord: Chord, platform: Platform): boolean {
  const wantMeta = platform === 'mac' && chord.mod;
  const wantCtrl = chord.ctrl || (platform !== 'mac' && chord.mod);
  if (event.metaKey !== wantMeta) return false;

  if (chord.code !== undefined) {
    return (
      event.ctrlKey === wantCtrl &&
      event.altKey === chord.alt &&
      event.shiftKey === chord.shift &&
      event.code === chord.code
    );
  }

  if (isAsciiLetter(chord.key)) {
    if (event.ctrlKey !== wantCtrl || event.altKey !== chord.alt) return false;
    if (event.shiftKey !== chord.shift) return false;
    return letterOf(event) === chord.key;
  }

  if (NAMED_KEYS.has(chord.key)) {
    if (event.ctrlKey !== wantCtrl || event.altKey !== chord.alt) return false;
    if (event.shiftKey !== chord.shift) return false;
    return event.key === (chord.key === 'Space' ? ' ' : chord.key);
  }

  if (event.key !== chord.key) return false;
  // Mod+, : the modifiers asked for, and no Option or AltGr on top (Cmd+Option+, is another chord).
  if (chord.mod || chord.ctrl) return event.ctrlKey === wantCtrl && !event.altKey;
  // A plain character. Windows reports AltGr as Ctrl+Alt; Ctrl alone means a Ctrl chord.
  const altGraph = event.getModifierState?.('AltGraph') === true || event.altKey;
  return !event.ctrlKey || altGraph;
}
