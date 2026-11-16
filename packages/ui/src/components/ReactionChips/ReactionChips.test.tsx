// @vitest-environment jsdom
// PLAN-013 S4, SPEC-013 §3.4: reaction chips are buttons with `aria-pressed` and a name like
// "Thumbs up, 3 reactions, including you", a tooltip naming who reacted, a click that sets or
// clears the viewer's reaction, and a row whose **Add reaction** opens the EmojiPicker, where
// choosing an emoji sets it. Read-only rows (archived or deleted issues, D10) toggle nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../Tooltip/Tooltip.js';
import {
  ReactionChips,
  ReactionBar,
  reactionChipLabel,
  reactionTooltip,
  type ReactionChipData,
} from './ReactionChips.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CHIPS: ReactionChipData[] = [
  { emoji: '👍', count: 3, mine: true, label: 'thumbs up', people: ['You', 'Ada', 'Iris'] },
  { emoji: '🎉', count: 1, mine: false, label: 'party popper', people: ['Iris'] },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

async function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TooltipProvider>{element}</TooltipProvider>);
    await Promise.resolve();
  });
  return container;
}

function click(element: Element | null | undefined) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('chip names and tooltips', () => {
  it('reads "Thumbs up, 3 reactions, including you"', () => {
    expect(reactionChipLabel({ emoji: '👍', count: 3, mine: true, label: 'thumbs up' })).toBe(
      'Thumbs up, 3 reactions, including you',
    );
    expect(reactionChipLabel({ emoji: '🎉', count: 1, mine: false, label: 'party popper' })).toBe(
      'Party popper, 1 reaction',
    );
    // Before the emoji data loads, the emoji itself names the chip.
    expect(reactionChipLabel({ emoji: '🚀', count: 2, mine: false })).toBe('🚀, 2 reactions');
  });

  it('names who reacted', () => {
    expect(
      reactionTooltip({ emoji: '👍', label: 'thumbs up', people: ['You', 'Ada', 'Iris'] }),
    ).toBe('You, Ada and Iris reacted with thumbs up');
    expect(reactionTooltip({ emoji: '🎉', people: ['Iris'] })).toBe('Iris reacted with 🎉');
    expect(reactionTooltip({ emoji: '🎉', people: [] })).toBeUndefined();
  });
});

describe('ReactionChips', () => {
  it('renders pressed and unpressed buttons, and a click sets or clears the viewer’s reaction', async () => {
    const onReact = vi.fn();
    const c = await mount(<ReactionChips reactions={CHIPS} onReact={onReact} />);
    const buttons = [...c.querySelectorAll('button')];
    expect(
      buttons.map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Thumbs up, 3 reactions, including you', 'true'],
      ['Party popper, 1 reaction', 'false'],
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual(['👍3', '🎉1']);
    click(buttons[0]);
    click(buttons[1]);
    expect(onReact.mock.calls).toEqual([
      ['👍', false],
      ['🎉', true],
    ]);
  });

  it('renders nothing without reactions', async () => {
    const empty = await mount(<ReactionChips reactions={[]} onReact={vi.fn()} />);
    expect(empty.innerHTML).toBe('');
  });

  it('keeps read-only chips focusable, with their tooltip, but toggles nothing (D10)', async () => {
    const onReact = vi.fn();
    const c = await mount(<ReactionChips reactions={CHIPS} onReact={onReact} readOnly />);
    const first = c.querySelector('button');
    if (first === null) throw new Error('no chip');
    expect(first.disabled).toBe(false);
    expect(first.getAttribute('aria-disabled')).toBe('true');
    act(() => first.focus());
    expect(document.activeElement).toBe(first);
    // The keyboard reaches who reacted: focus opens the tooltip.
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('You, Ada and Iris reacted with thumbs up');
    click(first);
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onReact).not.toHaveBeenCalled();
  });
});

describe('ReactionBar', () => {
  const loadEmoji = () =>
    Promise.resolve([{ unicode: '🚀', label: 'rocket', shortcodes: ['rocket'], group: 5 }]);

  it('opens the EmojiPicker from Add reaction; choosing an emoji sets it and closes', async () => {
    const onReact = vi.fn();
    const c = await mount(
      <ReactionBar reactions={CHIPS} onReact={onReact} loadEmoji={loadEmoji} />,
    );
    const add = c.querySelector('button[aria-label="Add reaction"]');
    expect(add).not.toBeNull();
    await act(async () => {
      add?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Add reaction"]');
    expect(dialog).not.toBeNull();
    click(dialog?.querySelector('[aria-label="rocket"]'));
    expect(onReact).toHaveBeenCalledWith('🚀', true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens when the host asks (the Add reaction… command), and has no button when read-only', async () => {
    const onOpenChange = vi.fn();
    await mount(
      <ReactionBar
        reactions={CHIPS}
        onReact={vi.fn()}
        loadEmoji={loadEmoji}
        pickerOpen
        onPickerOpenChange={onOpenChange}
      />,
    );
    expect(document.querySelector('[role="dialog"][aria-label="Add reaction"]')).not.toBeNull();
    act(() => root?.unmount());
    const c = await mount(
      <ReactionBar reactions={CHIPS} onReact={vi.fn()} loadEmoji={loadEmoji} readOnly />,
    );
    expect(c.querySelector('button[aria-label="Add reaction"]')).toBeNull();
    expect(c.querySelectorAll('button')).toHaveLength(2);
  });
});
