// @vitest-environment jsdom
// PLAN-013 S4, SPEC-013 §3.4, design-system §5.3: the EmojiPicker's search, its "Frequently used"
// list kept on this device (and a picker that still works when storage throws), and its grid keys,
// over a fake `loadEmoji`. The key and list rules are pure (`model.ts`) and tested first; then
// the component in jsdom. Axe and a real browser are the stories' (held, `pnpm test:storybook`).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker.js';
import {
  DEFAULT_FREQUENT,
  EMOJI_COLUMNS,
  emojiSections,
  FREQUENT_STORAGE_KEY,
  frequentEmoji,
  moveCell,
  parseFrequentUse,
  recordUse,
  searchEmoji,
  type EmojiSection,
  type PickerEmoji,
} from './model.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const e = (
  unicode: string,
  label: string,
  shortcodes: string[],
  group: number,
  tags: string[] = [],
) => ({ unicode, label, shortcodes, group, tags }) satisfies PickerEmoji;

const DATA: readonly PickerEmoji[] = [
  e('😄', 'grinning face with smiling eyes', ['smile'], 0, ['happy', 'joy']),
  e('🤔', 'thinking face', ['thinking'], 0, ['hmm']),
  e('😕', 'confused face', ['confused'], 0),
  e('👍', 'thumbs up', ['thumbsup', '+1'], 1, ['yes']),
  e('👎', 'thumbs down', ['thumbsdown', '-1'], 1),
  e('🏽', 'medium skin tone', ['tone3'], 2),
  e('🐶', 'dog face', ['dog'], 3),
  e('🎉', 'party popper', ['tada'], 6, ['celebrate']),
  e('🚀', 'rocket', ['rocket'], 5, ['ship']),
  e('❤️', 'red heart', ['heart'], 8, ['love']),
  e('👀', 'eyes', ['eyes'], 1, ['look']),
];

const section = (id: string, n: number): EmojiSection => ({
  id,
  name: id,
  emoji: Array.from({ length: n }, (_, i) => e(String.fromCodePoint(0x1f600 + i), `e${i}`, [], 0)),
});

describe('search', () => {
  it('matches the start of a word of the name, a shortcode or a tag, shortcode prefixes first', () => {
    expect(searchEmoji(DATA, 'thu').map((x) => x.unicode)).toEqual(['👍', '👎']);
    expect(searchEmoji(DATA, 'think').map((x) => x.unicode)).toEqual(['🤔']);
    expect(searchEmoji(DATA, 'celebrate').map((x) => x.unicode)).toEqual(['🎉']);
    expect(searchEmoji(DATA, ':tada:').map((x) => x.unicode)).toEqual(['🎉']);
    expect(searchEmoji(DATA, 'face dog').map((x) => x.unicode)).toEqual(['🐶']);
    expect(searchEmoji(DATA, 'xyz')).toEqual([]);
  });

  it('never offers a skin tone component on its own', () => {
    expect(searchEmoji(DATA, 'tone')).toEqual([]);
    expect(
      emojiSections(DATA, '', {})
        .flatMap((s) => s.emoji)
        .map((x) => x.unicode),
    ).not.toContain('🏽');
  });

  it('shows one results section for a query, and none when nothing matches', () => {
    expect(emojiSections(DATA, 'rock', {}).map((s) => s.name)).toEqual(['Search results']);
    expect(emojiSections(DATA, 'nothing here', {})).toEqual([]);
  });
});

describe('Frequently used (kept on this device)', () => {
  it('starts with Linear’s defaults, then shows the most used first, then the latest', () => {
    expect(frequentEmoji(DATA, {}).map((x) => x.unicode)).toEqual(
      DEFAULT_FREQUENT.filter((u) => DATA.some((x) => x.unicode === u)),
    );
    let use = recordUse({}, '🚀', 1);
    use = recordUse(use, '🐶', 2);
    use = recordUse(use, '🚀', 3);
    use = recordUse(use, '🎉', 4);
    expect(frequentEmoji(DATA, use).map((x) => x.unicode)).toEqual(['🚀', '🎉', '🐶']);
  });

  it('comes first when there is no query, then the categories in emojibase order', () => {
    const names = emojiSections(DATA, '', recordUse({}, '👀', 1)).map((s) => s.name);
    expect(names).toEqual([
      'Frequently used',
      'Smileys & emotion',
      'People & body',
      'Animals & nature',
      'Travel & places',
      'Activities',
      'Symbols',
    ]);
  });

  it('ignores stored use that is unreadable, or names emoji the data lacks', () => {
    expect(parseFrequentUse(null)).toEqual({});
    expect(parseFrequentUse('not json')).toEqual({});
    expect(parseFrequentUse('[1,2]')).toEqual({});
    expect(parseFrequentUse('{"👍":{"count":"2","at":1},"🎉":{"count":2,"at":1}}')).toEqual({
      '🎉': { count: 2, at: 1 },
    });
    // Only unknown emoji stored: as if none were, the defaults show.
    expect(frequentEmoji(DATA, { '🦄': { count: 9, at: 1 } })).toEqual(frequentEmoji(DATA, {}));
  });
});

describe('grid keys', () => {
  const sections = [section('a', 10), section('b', 3), section('c', 20)];

  it('steps left and right in reading order, across sections, and stops at the ends', () => {
    expect(moveCell(sections, { section: 0, index: 9 }, 'ArrowRight')).toEqual({
      section: 1,
      index: 0,
    });
    expect(moveCell(sections, { section: 1, index: 0 }, 'ArrowLeft')).toEqual({
      section: 0,
      index: 9,
    });
    expect(moveCell(sections, { section: 0, index: 0 }, 'ArrowLeft')).toEqual({
      section: 0,
      index: 0,
    });
    expect(moveCell(sections, { section: 2, index: 19 }, 'ArrowRight')).toEqual({
      section: 2,
      index: 19,
    });
  });

  it('moves down and up by a row, keeping the column where the next row has it', () => {
    expect(EMOJI_COLUMNS).toBe(8);
    expect(moveCell(sections, { section: 0, index: 1 }, 'ArrowDown')).toEqual({
      section: 0,
      index: 9,
    });
    // Row two of `a` has two cells: from column 5, down lands on its last.
    expect(moveCell(sections, { section: 0, index: 5 }, 'ArrowDown')).toEqual({
      section: 0,
      index: 9,
    });
    expect(moveCell(sections, { section: 0, index: 9 }, 'ArrowDown')).toEqual({
      section: 1,
      index: 1,
    });
    expect(moveCell(sections, { section: 1, index: 2 }, 'ArrowDown')).toEqual({
      section: 2,
      index: 2,
    });
    expect(moveCell(sections, { section: 2, index: 2 }, 'ArrowUp')).toEqual({
      section: 1,
      index: 2,
    });
    expect(moveCell(sections, { section: 1, index: 2 }, 'ArrowUp')).toEqual({
      section: 0,
      index: 9,
    });
    expect(moveCell(sections, { section: 1, index: 0 }, 'ArrowUp')).toEqual({
      section: 0,
      index: 8,
    });
  });

  it('jumps to the first and last cell with Home and End', () => {
    expect(moveCell(sections, { section: 1, index: 1 }, 'Home')).toEqual({ section: 0, index: 0 });
    expect(moveCell(sections, { section: 1, index: 1 }, 'End')).toEqual({ section: 2, index: 19 });
  });
});

// ---------------------------------------------------------------------------------------------
// The component

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

async function mount(props: Partial<Parameters<typeof EmojiPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const loadEmoji = vi.fn(() => Promise.resolve(DATA));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <EmojiPicker
        loadEmoji={loadEmoji}
        onSelect={onSelect}
        onClose={onClose}
        label="Add reaction"
        {...props}
      />,
    );
    await Promise.resolve();
  });
  const input = container.querySelector('input');
  if (input === null) throw new Error('no search field');
  return { container, input, onSelect, onClose, loadEmoji };
}

function key(input: HTMLInputElement, name: string) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
}

function type(input: HTMLInputElement, text: string) {
  act(() => {
    // The prototype's setter, so React's value tracker sees a change and fires onChange.
    Reflect.set(HTMLInputElement.prototype, 'value', text, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const highlighted = (c: HTMLElement) =>
  c.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('aria-label');

describe('EmojiPicker', () => {
  it('loads the emoji once, focuses the search, and names the grid', async () => {
    const { container, input, loadEmoji } = await mount();
    expect(loadEmoji).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Add reaction');
    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe(
      'Add reaction',
    );
    const headings = [...container.querySelectorAll('[role="group"]')].map(
      (g) => g.firstElementChild?.textContent,
    );
    expect(headings[0]).toBe('Frequently used');
    expect(highlighted(container)).toBe('thumbs up');
  });

  it('filters as you type and picks the highlighted emoji with Enter, then closes', async () => {
    const { container, input, onSelect, onClose } = await mount();
    type(input, 'rock');
    expect([...container.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      '🚀',
    ]);
    key(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('🚀');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing matches', async () => {
    const { container, input } = await mount();
    type(input, 'zzz');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No emoji match “zzz”');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('moves through the grid with the arrow keys and points the field at the highlight', async () => {
    const { container, input, onSelect } = await mount();
    key(input, 'ArrowRight');
    expect(highlighted(container)).toBe('thumbs down');
    key(input, 'ArrowDown');
    // "Frequently used" holds eight defaults (one row): down goes to Smileys & emotion, column 1.
    expect(highlighted(container)).toBe('thinking face');
    const active = input.getAttribute('aria-activedescendant');
    expect(active).not.toBeNull();
    expect(document.getElementById(active ?? '')?.getAttribute('aria-label')).toBe('thinking face');
    key(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('🤔');
  });

  it('remembers picks on this device, so they lead "Frequently used" next time', async () => {
    const first = await mount();
    type(first.input, 'dog');
    key(first.input, 'Enter');
    act(() => root?.unmount());
    root = null;
    expect(JSON.parse(localStorage.getItem(FREQUENT_STORAGE_KEY) ?? '{}')).toHaveProperty('🐶');
    const second = await mount();
    const frequent = second.container.querySelector('[role="group"]');
    expect(frequent?.firstElementChild?.textContent).toBe('Frequently used');
    expect(
      [...(frequent?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.textContent),
    ).toEqual(['🐶']);
  });

  it('still works when storage throws (private mode, blocked site data)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { input, onSelect } = await mount();
    type(input, 'eyes');
    key(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('👀');
  });

  it('closes on Esc without picking, and keeps the key from reaching the page', async () => {
    const { input, onSelect, onClose } = await mount();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    key(input, 'Escape');
    document.removeEventListener('keydown', outside);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
  });

  it('picks with a click, and says when the data can’t load', async () => {
    const { container, onSelect } = await mount();
    const party = container.querySelector('[aria-label="party popper"]');
    act(() => {
      party?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('🎉');
    act(() => root?.unmount());
    root = null;
    const failed = await mount({ loadEmoji: () => Promise.reject(new Error('chunk failed')) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Emoji couldn’t load. Close the picker and open it again.',
    );
  });
});
