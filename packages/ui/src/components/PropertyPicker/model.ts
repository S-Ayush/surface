/**
 * The behaviour of the property picker (SPEC-012 §3.5) as pure functions, so the key rules are
 * unit tested without a DOM: quick keys only on an empty query, `Space` and `Enter` in the labels
 * picker, one label per exclusive group, and closing applies every toggle once.
 */

export interface PickerOption {
  id: string;
  /** The text shown and searched. */
  label: string;
  /** Extra words that match the query (an email, a display name). */
  keywords?: string;
  disabled?: boolean;
  /** A heading the option sits under; options of one group are listed together by the caller. */
  group?: string;
  /** Choosing this option unchecks the others of the same exclusive group (INV-07). */
  exclusiveGroup?: string;
  /** One character that picks the option while the query is empty (single mode). */
  quickKey?: string;
}

export type PickerMode = 'single' | 'multi';

export interface PickerState {
  query: string;
  /** The highlighted option's id (the `aria-activedescendant`), or null when nothing matches. */
  highlightId: string | null;
  /** Multi mode: the ids currently checked. Single mode: unused. */
  selected: readonly string[];
  /** The ids checked when the picker opened: `apply` is skipped when nothing changed. */
  initial: readonly string[];
  /** A toggle happened since the picker opened (`Enter` then applies instead of toggling). */
  touched: boolean;
}

export type PickerEffect =
  { type: 'select'; id: string } | { type: 'apply'; ids: readonly string[] } | { type: 'close' };

export interface KeyResult {
  state: PickerState;
  effects: readonly PickerEffect[];
  /** The key was used here: the caller must `preventDefault`. Otherwise the field handles it. */
  handled: boolean;
}

export function initialState(
  options: readonly PickerOption[],
  selected: readonly string[],
  /** Single mode: the current value, highlighted first. */
  current?: string | null,
): PickerState {
  const highlighted =
    current !== undefined &&
    current !== null &&
    options.some((o) => o.id === current && !o.disabled)
      ? current
      : (firstEnabled(options)?.id ?? null);
  return { query: '', highlightId: highlighted, selected, initial: selected, touched: false };
}

function firstEnabled(options: readonly PickerOption[]): PickerOption | undefined {
  return options.find((option) => !option.disabled);
}

/** Case-insensitive substring match on the label and keywords; all words of the query must match. */
export function filterOptions<T extends PickerOption>(options: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = `${option.label} ${option.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Typing changes the matches: the highlight goes to the first match. */
export function setQuery(
  state: PickerState,
  query: string,
  options: readonly PickerOption[],
): PickerState {
  const visible = filterOptions(options, query);
  const keep = visible.find((o) => o.id === state.highlightId && !o.disabled);
  return { ...state, query, highlightId: (keep ?? firstEnabled(visible))?.id ?? null };
}

function move(
  state: PickerState,
  visible: readonly PickerOption[],
  to: 'next' | 'previous' | 'first' | 'last',
): PickerState {
  const enabled = visible.filter((o) => !o.disabled);
  if (enabled.length === 0) return state;
  const at = enabled.findIndex((o) => o.id === state.highlightId);
  const index =
    to === 'first'
      ? 0
      : to === 'last'
        ? enabled.length - 1
        : to === 'next'
          ? Math.min(at + 1, enabled.length - 1)
          : Math.max(at - 1, 0);
  return { ...state, highlightId: enabled[index]?.id ?? state.highlightId };
}

/** Checks or unchecks `id`; checking a label of an exclusive group unchecks the group's other one. */
export function toggle(
  state: PickerState,
  options: readonly PickerOption[],
  id: string,
): PickerState {
  const option = options.find((o) => o.id === id);
  if (!option || option.disabled) return state;
  let selected: string[];
  if (state.selected.includes(id)) {
    selected = state.selected.filter((s) => s !== id);
  } else {
    const group = option.exclusiveGroup;
    selected = [
      ...state.selected.filter(
        (s) => group === undefined || options.find((o) => o.id === s)?.exclusiveGroup !== group,
      ),
      id,
    ];
  }
  return { ...state, selected, touched: true };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The effects of closing a multi picker: one apply with every toggle, or nothing when unchanged. */
export function closeEffects(state: PickerState): PickerEffect[] {
  return sameIds(state.selected, state.initial)
    ? [{ type: 'close' }]
    : [{ type: 'apply', ids: state.selected }, { type: 'close' }];
}

/**
 * One key press in the search field. `key` is `KeyboardEvent.key`. Keys that aren't handled
 * (`handled: false`) go into the field as typing, so digits after a letter ("v2") and spaces in
 * a query stay text (E17).
 */
export function onKey(
  state: PickerState,
  key: string,
  options: readonly PickerOption[],
  mode: PickerMode,
): KeyResult {
  const visible = filterOptions(options, state.query);
  const result = (next: PickerState, effects: readonly PickerEffect[] = []): KeyResult => ({
    state: next,
    effects,
    handled: true,
  });

  switch (key) {
    case 'ArrowDown':
      return result(move(state, visible, 'next'));
    case 'ArrowUp':
      return result(move(state, visible, 'previous'));
    case 'Home':
      return state.query === '' ? result(move(state, visible, 'first')) : unhandled(state);
    case 'End':
      return state.query === '' ? result(move(state, visible, 'last')) : unhandled(state);
    case 'Escape':
      return result(state, mode === 'multi' ? closeEffects(state) : [{ type: 'close' }]);
    case 'Enter': {
      if (state.highlightId === null && !(mode === 'multi' && state.touched)) {
        // Multi mode, nothing toggled, nothing highlighted: close without applying.
        return result(state, mode === 'multi' ? [{ type: 'close' }] : []);
      }
      if (mode === 'single') {
        return result(state, [{ type: 'select', id: state.highlightId ?? '' }, { type: 'close' }]);
      }
      // `Space` then `Enter` applies what was toggled; it never toggles the last label back (E21).
      const next =
        state.touched || state.highlightId === null
          ? state
          : toggle(state, options, state.highlightId);
      return result(next, closeEffects(next));
    }
    case ' ':
      if (mode === 'multi' && state.query === '' && state.highlightId !== null) {
        return result(toggle(state, options, state.highlightId));
      }
      return unhandled(state);
    default: {
      if (mode === 'single' && state.query === '' && key.length === 1) {
        const match = visible.find((o) => o.quickKey === key && !o.disabled);
        if (match) return result(state, [{ type: 'select', id: match.id }, { type: 'close' }]);
      }
      return unhandled(state);
    }
  }
}

function unhandled(state: PickerState): KeyResult {
  return { state, effects: [], handled: false };
}

/** Quick-key hints show only while they work: an empty query in single mode. */
export function showsQuickKeys(state: PickerState, mode: PickerMode): boolean {
  return mode === 'single' && state.query === '';
}
