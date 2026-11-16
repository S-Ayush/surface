import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Row, Stack } from '../../stories/helpers.js';
import type { PickerEmoji } from '../EmojiPicker/model.js';
import { ReactionChips, ReactionBar, type ReactionChipData } from './ReactionChips.js';

const meta = { title: 'Domain/ReactionChips' } satisfies Meta;
export default meta;
type Story = StoryObj;

const CHIPS: ReactionChipData[] = [
  { emoji: '👍', count: 3, mine: true, label: 'thumbs up', people: ['You', 'Ada', 'Iris'] },
  { emoji: '🎉', count: 1, mine: false, label: 'party popper', people: ['Iris'] },
  { emoji: '👀', count: 12, mine: false, label: 'eyes', people: ['Ada', 'Iris', 'Sam'] },
];

const SAMPLE: readonly PickerEmoji[] = [
  { unicode: '👍', label: 'thumbs up', shortcodes: ['thumbsup'], group: 1 },
  { unicode: '🎉', label: 'party popper', shortcodes: ['tada'], group: 6 },
  { unicode: '🚀', label: 'rocket', shortcodes: ['rocket'], group: 5 },
];
const loadSample = () => Promise.resolve(SAMPLE);

export const Chips: Story = {
  render: () => (
    <Stack>
      <Row label="Pressed when it includes you">
        <ReactionChips reactions={CHIPS} onReact={() => {}} />
      </Row>
      <Row label="Read-only (archived issue)">
        <ReactionChips reactions={CHIPS} onReact={() => {}} readOnly />
      </Row>
      <Row label="With Add reaction">
        <ReactionBar reactions={CHIPS} onReact={() => {}} loadEmoji={loadSample} />
      </Row>
    </Stack>
  ),
};

/** A row that applies its own toggles, as the store does once `reaction.set` dispatches. */
function LiveRow() {
  const [chips, setChips] = useState<ReactionChipData[]>(CHIPS.slice(0, 1));
  const onReact = (emoji: string, reacted: boolean) =>
    setChips((list) => {
      const found = list.find((c) => c.emoji === emoji);
      if (found === undefined) {
        return reacted ? [...list, { emoji, count: 1, mine: true }] : list;
      }
      if (found.mine === reacted) return list;
      const count = found.count + (reacted ? 1 : -1);
      return count === 0
        ? list.filter((c) => c !== found)
        : list.map((c) => (c === found ? { ...c, count, mine: reacted } : c));
    });
  return <ReactionBar reactions={chips} onReact={onReact} loadEmoji={loadSample} />;
}

/** Toggling a chip from the keyboard, then adding one through the picker. */
export const Keyboard: Story = {
  render: () => <LiveRow />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole('button', { name: 'Thumbs up, 3 reactions, including you' });
    chip.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: 'Thumbs up, 2 reactions' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Add reaction' }));
    const body = within(canvasElement.ownerDocument.body);
    // Frequently used and its category both list it.
    await body.findAllByRole('option', { name: 'rocket' });
    await userEvent.keyboard('rock{Enter}');
    await expect(
      canvas.getByRole('button', { name: '🚀, 1 reaction, including you' }),
    ).toBeVisible();
  },
};
