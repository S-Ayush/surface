import type { Meta, StoryObj } from '@storybook/react-vite';
import { parseDueDate } from '@surface/domain';
import { expect, fn, userEvent, within } from 'storybook/test';
import panel from '../../stories/panel.module.css';
import { DatePicker } from './DatePicker.js';

const meta = { title: 'Primitives/DatePicker' } satisfies Meta;
export default meta;
type Args = { onChange: (date: string | null) => void; onClose: () => void };
type Story = StoryObj<Args>;

// 2026-11-12 is a Thursday. A fixed "today" and locale keep the snapshots stable.
const TODAY = '2026-11-12';
const parse = (text: string) => parseDueDate(text, TODAY);

export const Default: Story = {
  render: () => (
    <div className={panel['panel']}>
      <DatePicker
        value="2026-12-03"
        today={TODAY}
        locale="en-US"
        parse={parse}
        onChange={() => {}}
      />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className={panel['panel']}>
      <DatePicker value={null} today={TODAY} locale="en-US" parse={parse} onChange={() => {}} />
    </div>
  ),
};

/** A typed date is read by `parse`; the result shows under the field before Enter. */
export const TypedDate: Story = {
  args: { onChange: fn(), onClose: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <DatePicker
        value={null}
        today={TODAY}
        locale="en-US"
        parse={parse}
        onChange={args.onChange}
        onClose={args.onClose}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('textbox', { name: 'Due date' });
    await expect(field).toHaveFocus();
    await userEvent.type(field, 'next friday');
    await expect(canvas.getByRole('status')).toHaveTextContent('Friday, November 20, 2026');
    await userEvent.keyboard('{Enter}');
    await expect(args.onChange).toHaveBeenCalledWith('2026-11-20');
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const TypedGarbage: Story = {
  args: { onChange: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <DatePicker
        value={null}
        today={TODAY}
        locale="en-US"
        parse={parse}
        onChange={args.onChange}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('textbox', { name: 'Due date' });
    await userEvent.type(field, 'whenever{Enter}');
    await expect(args.onChange).not.toHaveBeenCalled();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(canvas.getByRole('status')).toHaveTextContent('Not a date');
  },
};

/** Arrow keys move by day and week, Page Up and Down by month; Enter picks. */
export const CalendarKeyboard: Story = {
  args: { onChange: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <DatePicker
        value={null}
        today={TODAY}
        locale="en-US"
        parse={parse}
        onChange={args.onChange}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('button', { name: 'Thursday, November 12, 2026' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    await expect(canvas.getByRole('button', { name: 'Friday, November 20, 2026' })).toHaveFocus();
    await userEvent.keyboard('{PageDown}');
    await expect(canvas.getByRole('grid', { name: 'December 2026' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Sunday, December 20, 2026' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onChange).toHaveBeenCalledWith('2026-12-20');
  },
};

export const NoDueDate: Story = {
  args: { onChange: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <DatePicker
        value="2026-12-03"
        today={TODAY}
        locale="en-US"
        parse={parse}
        onChange={args.onChange}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'No due date' }));
    await expect(args.onChange).toHaveBeenCalledWith(null);
  },
};
