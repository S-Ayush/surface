// The command menu's state and keyboard behaviour (command-menu.md §3–4), as a pure reducer so
// it is tested without a DOM. The view renders `rows` and forwards keys to `keyToAction`.
import type { Command, CommandContext, CommandPage, Section } from './model.js';
import { isOffered, type RankedItem, type RankedSection } from './ranking.js';

export type Frame = {
  readonly command: Command;
  readonly page: CommandPage;
  readonly query: string;
};

export type MenuState = {
  /** Nested pages, innermost last; each remembers the query of the level below it. */
  readonly pages: readonly Frame[];
  readonly query: string;
  /** Index into the options (not the header rows), used until the user points at a row. */
  readonly active: number;
  /**
   * The option the user pointed at (arrows, Tab, hover). It stays selected when rows above it come
   * or go (a permission change, command-menu.md §3.1.3); `null` means "the best match".
   */
  readonly activeId: string | null;
  /** The context chip is shown; Backspace on an empty root query removes it (§1). */
  readonly chip: boolean;
  /** An error from a command run with Mod+Enter, shown inline (the menu stayed open). */
  readonly error: string | null;
};

export const initialState = (options: { chip: boolean; page?: Frame }): MenuState => ({
  pages: options.page ? [options.page] : [],
  query: '',
  active: 0,
  activeId: null,
  chip: options.chip,
  error: null,
});

export type Row =
  | { readonly kind: 'header'; readonly id: string; readonly section: Section }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly entry: RankedSection['items'][number];
    }
  | { readonly kind: 'item'; readonly id: string; readonly entry: RankedItem };

/** Flattens sections (or a page's items) into rows; options are the non-header rows. */
export function toRows(content: RankedSection[] | RankedItem[]): Row[] {
  const rows: Row[] = [];
  for (const part of content) {
    if ('section' in part) {
      rows.push({ kind: 'header', id: `section:${part.section}`, section: part.section });
      for (const entry of part.items) rows.push({ kind: 'command', id: entry.command.id, entry });
    } else {
      rows.push({ kind: 'item', id: part.item.id, entry: part });
    }
  }
  return rows;
}

export const optionsOf = (rows: readonly Row[]) => rows.filter((row) => row.kind !== 'header');

/** The selected option's index: the row the user pointed at, while it is still listed. */
export function activeIndex(state: MenuState, options: readonly Row[]): number {
  if (state.activeId !== null) {
    const index = options.findIndex((row) => row.id === state.activeId);
    if (index >= 0) return index;
  }
  return Math.min(state.active, Math.max(0, options.length - 1));
}

const pointAt = (options: readonly Row[], index: number) => ({
  active: index,
  activeId: options[index]?.id ?? null,
});

export type MenuAction =
  | { type: 'query'; query: string }
  | { type: 'move'; by: number; rows: readonly Row[] }
  | { type: 'activate'; index: number; id: string }
  | { type: 'section'; direction: 1 | -1; rows: readonly Row[] }
  | { type: 'push'; frame: Omit<Frame, 'query'> }
  | { type: 'back' }
  | { type: 'remove-chip' }
  /** Pages from `depth` up belong to commands that are no longer offered (E4): close them. */
  | { type: 'revoke'; depth: number; message: string }
  | { type: 'error'; message: string | null };

export function reduce(state: MenuState, action: MenuAction): MenuState {
  switch (action.type) {
    case 'query':
      // Typing starts again from the best match.
      return { ...state, query: action.query, active: 0, activeId: null, error: null };
    case 'move': {
      const options = optionsOf(action.rows);
      if (options.length === 0) return state;
      const from = activeIndex(state, options);
      return {
        ...state,
        ...pointAt(options, (from + action.by + options.length) % options.length),
      };
    }
    case 'activate':
      return { ...state, active: action.index, activeId: action.id };
    case 'section': {
      const options = optionsOf(action.rows);
      const from = activeIndex(state, options);
      return { ...state, ...pointAt(options, sectionJump(action.rows, from, action.direction)) };
    }
    case 'push':
      return {
        ...state,
        pages: [...state.pages, { ...action.frame, query: state.query }],
        query: '',
        active: 0,
        activeId: null,
        error: null,
      };
    case 'back': {
      const last = state.pages.at(-1);
      if (last === undefined) return state;
      return {
        ...state,
        pages: state.pages.slice(0, -1),
        query: last.query,
        active: 0,
        activeId: null,
        error: null,
      };
    }
    case 'revoke': {
      const closed = state.pages[action.depth];
      if (closed === undefined) return state;
      return {
        ...state,
        pages: state.pages.slice(0, action.depth),
        query: closed.query,
        active: 0,
        activeId: null,
        error: action.message,
      };
    }
    case 'remove-chip':
      return { ...state, chip: false, active: 0, activeId: null };
    case 'error':
      return { ...state, error: action.message };
  }
}

/** Tab: the first option of the next (or previous) section, wrapping (§4). */
function sectionJump(rows: readonly Row[], active: number, direction: 1 | -1): number {
  const starts: number[] = [];
  let option = 0;
  let headerSeen = false;
  for (const row of rows) {
    if (row.kind === 'header') {
      headerSeen = true;
      continue;
    }
    if (headerSeen || starts.length === 0) starts.push(option);
    headerSeen = false;
    option += 1;
  }
  if (starts.length === 0) return active;
  if (direction === 1) return starts.find((start) => start > active) ?? starts[0] ?? 0;
  const current = [...starts].reverse().find((start) => start <= active) ?? 0;
  const before = [...starts].reverse().find((start) => start < current);
  return before ?? starts.at(-1) ?? 0;
}

export type KeyLike = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** An IME is composing: its keys (Enter confirms, arrows pick a candidate) are not ours (E2). */
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  /** Held down. */
  readonly repeat?: boolean;
};

export type KeyResult =
  | { readonly kind: 'action'; readonly action: MenuAction }
  | { readonly kind: 'run'; readonly keepOpen: boolean }
  | { readonly kind: 'none' };

/** The keyboard table of command-menu.md §4 (Esc is the dialog's; Mod+K is the shortcut's). */
export function keyToAction(
  event: KeyLike,
  state: MenuState,
  rows: readonly Row[],
  mod: 'meta' | 'ctrl',
): KeyResult {
  // Safari sends the Enter that ends a composition with isComposing false but keyCode 229.
  if (event.isComposing === true || event.keyCode === 229) return { kind: 'none' };
  const modHeld = mod === 'meta' ? event.metaKey : event.ctrlKey;
  // Ctrl+N / Ctrl+P are the macOS text-navigation keys; elsewhere the browser keeps Ctrl+N (new
  // window) and Ctrl+P (print) before the page sees them (command-menu.md §4).
  const emacs =
    mod === 'meta' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (event.key === 'ArrowDown' || (emacs && event.key.toLowerCase() === 'n')) {
    return { kind: 'action', action: { type: 'move', by: 1, rows } };
  }
  if (event.key === 'ArrowUp' || (emacs && event.key.toLowerCase() === 'p')) {
    return { kind: 'action', action: { type: 'move', by: -1, rows } };
  }
  if (event.key === 'Tab') {
    return {
      kind: 'action',
      action: { type: 'section', direction: event.shiftKey ? -1 : 1, rows },
    };
  }
  if (event.key === 'Enter') return { kind: 'run', keepOpen: modHeld };
  // A held Backspace clears the query; it must not go on to close pages or drop the chip.
  if (event.key === 'Backspace' && state.query === '' && !modHeld && event.repeat !== true) {
    if (state.pages.length > 0) return { kind: 'action', action: { type: 'back' } };
    if (state.chip) return { kind: 'action', action: { type: 'remove-chip' } };
  }
  return { kind: 'none' };
}

export type Effect = () => void | Promise<void>;

/** What running an option does (command-menu.md §3.4), decided without touching the view. */
export type Execution =
  | { readonly kind: 'none' }
  /** Open the command's page; `record` is the command id, for frecency. */
  | { readonly kind: 'push'; readonly frame: Omit<Frame, 'query'>; readonly record: string }
  /** Run `effect`: after the menu has closed, or in place with Mod+Enter (`keepOpen`). */
  | {
      readonly kind: 'run';
      readonly effect: Effect;
      readonly keepOpen: boolean;
      readonly record: string | null;
    }
  /** The command's page could not be built: say so in the menu. */
  | { readonly kind: 'failed' };

/** Runs `row`: the clicked option, or the selected one for a key. */
export function execute(row: Row | undefined, keepOpen: boolean, ctx: CommandContext): Execution {
  if (row === undefined || row.kind === 'header') return { kind: 'none' };
  if (row.kind === 'item') {
    const item = row.entry.item;
    return { kind: 'run', effect: () => item.run(), keepOpen, record: null };
  }
  const command = row.entry.command;
  if (command.page) {
    try {
      return { kind: 'push', frame: { command, page: command.page(ctx) }, record: command.id };
    } catch {
      return { kind: 'failed' };
    }
  }
  const run = command.run;
  if (run === undefined) return { kind: 'none' };
  return { kind: 'run', effect: () => run(ctx), keepOpen, record: command.id };
}

/**
 * The first open page whose command is no longer offered (E4: a role change arrived while it was
 * open), or -1. Its page and any above it close.
 */
export function revokedDepth(pages: readonly Frame[], ctx: CommandContext): number {
  return pages.findIndex((frame) => !isOffered(frame.command, ctx));
}

/** An option row's pointer handlers: hovering selects it, and a click runs that row itself. */
export function optionHandlers(
  row: Row,
  index: number,
  selected: boolean,
  act: {
    dispatch: (action: MenuAction) => void;
    perform: (row: Row, keepOpen: boolean) => void;
  },
): { onMouseMove: () => void; onClick: () => void } {
  return {
    onMouseMove: () => {
      if (!selected) act.dispatch({ type: 'activate', index, id: row.id });
    },
    onClick: () => {
      act.dispatch({ type: 'activate', index, id: row.id });
      act.perform(row, false);
    },
  };
}
