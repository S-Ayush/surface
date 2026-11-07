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
  // Shift changes the character a symbol key types ("Shift+/" is "?" on US layouts, not on others),
  // so a symbol is written as the character itself: "?", not "Shift+/".
  // Shift and Option/AltGr change the character a symbol key types ("Shift+/" is "?" on US layouts,
  // not on others), and the matcher ignores them for symbols. So a symbol is written as the character
  // itself ("?", not "Shift+/"), and Alt+<symbol> cannot be told apart from the plain symbol.
  if ((has('Shift') || has('Alt')) && key.length === 1 && !isAsciiLetter(key)) {
    const modifier = has('Shift') ? 'Shift' : 'Alt';
    throw new Error(`Write the character instead of ${modifier}+${key} in "${text}" (E3)`);
  }
  return { mod: has('Mod'), ctrl: has('Ctrl'), alt: has('Alt'), shift: has('Shift'), key };
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

/**
 * Whether a keydown is this chord (SPEC-005 E3, as built in PLAN-005 S5):
 * - letters with Mod, Ctrl or Alt match the key's position (`event.code`), because those modifiers
 *   change `event.key` (Option+Shift+T types "ˇ" on macOS) and non-Latin layouts type other letters;
 * - other letters and printable characters match what the key types (`event.key`), so `?` works on
 *   any layout; for characters, Shift, Option and AltGr are part of typing them and are not compared;
 * - named keys (Esc, Enter, arrows, F-keys) match `event.key` with exact modifiers.
 */
export function matchesChord(event: KeyInput, chord: Chord, platform: Platform): boolean {
  const wantMeta = platform === 'mac' && chord.mod;
  const wantCtrl = chord.ctrl || (platform !== 'mac' && chord.mod);
  if (event.metaKey !== wantMeta) return false;

  if (isAsciiLetter(chord.key)) {
    if (event.ctrlKey !== wantCtrl || event.altKey !== chord.alt) return false;
    if (event.shiftKey !== chord.shift) return false;
    if (chord.mod || chord.ctrl || chord.alt) return event.code === `Key${chord.key}`;
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
