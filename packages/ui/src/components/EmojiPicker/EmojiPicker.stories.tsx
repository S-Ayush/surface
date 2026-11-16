import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import panel from '../../stories/panel.module.css';
import { EmojiPicker } from './EmojiPicker.js';
import type { PickerEmoji } from './model.js';

const meta = { title: 'Domain/EmojiPicker' } satisfies Meta;
export default meta;
type Args = { onSelect: (emoji: string) => void; onClose: () => void };
type Story = StoryObj<Args>;

/**
 * A sample of the bundled data. The app passes the editor's lazy `emojibase-data` loader; the
 * picker itself never fetches (SPEC-013 AC-16), so the stories need no network either.
 */
const SAMPLE: readonly PickerEmoji[] = [
  ['😄', 'grinning face with smiling eyes', 'smile', 0],
  ['😂', 'face with tears of joy', 'joy', 0],
  ['🤔', 'thinking face', 'thinking', 0],
  ['😕', 'confused face', 'confused', 0],
  ['👍', 'thumbs up', 'thumbsup', 1],
  ['👎', 'thumbs down', 'thumbsdown', 1],
  ['👀', 'eyes', 'eyes', 1],
  ['🙏', 'folded hands', 'pray', 1],
  ['🐶', 'dog face', 'dog', 3],
  ['🌱', 'seedling', 'seedling', 3],
  ['☕', 'hot beverage', 'coffee', 4],
  ['🚀', 'rocket', 'rocket', 5],
  ['🎉', 'party popper', 'tada', 6],
  ['💡', 'light bulb', 'bulb', 7],
  ['❤️', 'red heart', 'heart', 8],
  ['✅', 'check mark button', 'white_check_mark', 8],
  ['🏁', 'chequered flag', 'checkered_flag', 9],
].map(([unicode, label, code, group]) => ({
  unicode: String(unicode),
  label: String(label),
  shortcodes: [String(code)],
  group: Number(group),
}));

const loadSample = () => Promise.resolve(SAMPLE);

export const Default: Story = {
  render: () => (
    <div className={panel['panel']}>
      <EmojiPicker label="Add reaction" loadEmoji={loadSample} onSelect={() => {}} />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className={panel['panel']}>
      <EmojiPicker
        label="Add reaction"
        loadEmoji={() => new Promise<readonly PickerEmoji[]>(() => {})}
        onSelect={() => {}}
      />
    </div>
  ),
};

/** The arrow keys move through the grid while the search keeps focus; `Enter` picks. */
export const Keyboard: Story = {
  args: { onSelect: fn(), onClose: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <EmojiPicker
        label="Add reaction"
        loadEmoji={loadSample}
        onSelect={args.onSelect}
        onClose={args.onClose}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('combobox', { name: 'Add reaction' });
    await expect(field).toHaveFocus();
    await canvas.findByRole('option', { name: 'thumbs up' });
    await userEvent.keyboard('{ArrowRight}');
    await expect(field).toHaveAttribute(
      'aria-activedescendant',
      canvas.getAllByRole('option', { name: 'thumbs down' })[0]?.id,
    );
    await userEvent.keyboard('rock{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('🚀');
    await expect(args.onClose).toHaveBeenCalled();
  },
};
