import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import panel from '../../stories/panel.module.css';
import { Row, Stack } from '../../stories/helpers.js';
import { SAMPLE_LABELS, STATUSES } from '../../stories/issue-data.js';
import { Avatar } from '../Avatar/Avatar.js';
import { PriorityIcon } from '../PriorityIcon/PriorityIcon.js';
import { StatusIcon } from '../StatusIcon/StatusIcon.js';
import { PropertyPicker, type PropertyPickerOption } from './PropertyPicker.js';

const meta = { title: 'Primitives/PropertyPicker' } satisfies Meta;
export default meta;
type Args = {
  onSelect: (id: string) => void;
  onClose: () => void;
  onApply: (ids: readonly string[]) => void;
};
type Story = StoryObj<Args>;

const PRIORITY_OPTIONS: PropertyPickerOption[] = [
  { id: '0', label: 'No priority', quickKey: '0' },
  { id: '1', label: 'Urgent', quickKey: '1' },
  { id: '2', label: 'High', quickKey: '2' },
  { id: '3', label: 'Medium', quickKey: '3' },
  { id: '4', label: 'Low', quickKey: '4' },
].map((option) => ({
  ...option,
  icon: <PriorityIcon priority={Number(option.id) as 0 | 1 | 2 | 3 | 4} />,
}));

const STATUS_OPTIONS: PropertyPickerOption[] = STATUSES.map((status, index) => ({
  id: status.id,
  label: status.name,
  quickKey: String(index + 1),
  icon: <StatusIcon category={status.category} color={status.color} />,
}));

const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds'];
const ASSIGNEE_OPTIONS: PropertyPickerOption[] = [
  { id: 'none', label: 'No assignee' },
  ...PEOPLE.map((name) => ({
    id: name,
    label: name,
    keywords: `${name.split(' ')[0]?.toLowerCase()}@example.com`,
    icon: <Avatar name={name} size={20} />,
  })),
];

const LABEL_OPTIONS: PropertyPickerOption[] = [
  { id: 'bug', label: 'Bug', group: 'Type', exclusiveGroup: 'type' },
  { id: 'feature', label: 'Feature', group: 'Type', exclusiveGroup: 'type' },
  ...SAMPLE_LABELS.filter((l) => l.id === 'design').map((l) => ({
    id: l.id,
    label: l.name,
    group: 'Workspace',
  })),
  { id: 'web', label: 'Web', group: 'Workspace' },
];

export const Single: Story = {
  render: () => (
    <Stack>
      <Row label="Priority (quick keys 0–4)">
        <div className={panel['panel']}>
          <PropertyPicker
            mode="single"
            label="Change priority"
            options={PRIORITY_OPTIONS}
            value="2"
            onSelect={() => {}}
          />
        </div>
      </Row>
      <Row label="Status (quick keys 1–6)">
        <div className={panel['panel']}>
          <PropertyPicker
            mode="single"
            label="Change status"
            options={STATUS_OPTIONS}
            value="s3"
            onSelect={() => {}}
          />
        </div>
      </Row>
      <Row label="Assignee (search matches name and email)">
        <div className={panel['panel']}>
          <PropertyPicker
            mode="single"
            label="Change assignee"
            options={ASSIGNEE_OPTIONS}
            value="Ada Lovelace"
            onSelect={() => {}}
          />
        </div>
      </Row>
    </Stack>
  ),
};

export const Labels: Story = {
  render: () => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="multi"
        label="Change labels"
        options={LABEL_OPTIONS}
        values={['bug', 'web']}
        onApply={() => {}}
      />
    </div>
  ),
};

export const NoMatches: Story = {
  render: () => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="single"
        label="Change status"
        options={[]}
        value={null}
        onSelect={() => {}}
        emptyText="No statuses"
      />
    </div>
  ),
};

/** `1`–`4` pick while the query is empty; once a letter is typed, digits go into the query (E17). */
export const QuickKeys: Story = {
  args: { onSelect: fn(), onClose: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="single"
        label="Change priority"
        options={PRIORITY_OPTIONS}
        value="0"
        onSelect={args.onSelect}
        onClose={args.onClose}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('combobox', { name: 'Change priority' });
    await expect(field).toHaveFocus();
    await expect(canvasElement.querySelectorAll('kbd').length).toBeGreaterThan(0);
    // E17: a digit after a letter is typed, not a quick pick.
    await userEvent.keyboard('v2');
    await expect(field).toHaveValue('v2');
    await expect(args.onSelect).not.toHaveBeenCalled();
    await expect(canvas.getByRole('status')).toHaveTextContent('No matches');
    await expect(canvasElement.querySelectorAll('kbd')).toHaveLength(0);
    await userEvent.clear(field);
    await userEvent.keyboard('2');
    await expect(args.onSelect).toHaveBeenCalledWith('2');
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const SingleKeyboard: Story = {
  args: { onSelect: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="single"
        label="Change status"
        options={STATUS_OPTIONS}
        value="s2"
        onSelect={args.onSelect}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('combobox', { name: 'Change status' });
    await expect(canvas.getByRole('option', { name: /Todo/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.keyboard('{ArrowDown}');
    await expect(field).toHaveAttribute(
      'aria-activedescendant',
      canvas.getByRole('option', { name: /In Progress/ }).id,
    );
    await userEvent.keyboard('{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('s3');
  },
};

/** `Space` toggles and keeps it open; `Enter` applies what was toggled and never toggles it back (E21). */
export const LabelsKeyboard: Story = {
  args: { onApply: fn(), onClose: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="multi"
        label="Change labels"
        options={LABEL_OPTIONS}
        values={['web']}
        onApply={args.onApply}
        onClose={args.onClose}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard(' ');
    await expect(canvas.getByRole('option', { name: /Bug/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(args.onApply).not.toHaveBeenCalled();
    // Inside the Type group, choosing Feature unchecks Bug.
    await userEvent.keyboard('{ArrowDown} ');
    await expect(canvas.getByRole('option', { name: /Feature/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.getByRole('option', { name: /Bug/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledOnce();
    await expect(args.onApply).toHaveBeenCalledWith(['web', 'feature']);
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Typed spaces stay text: "Needs d" filters, and does not toggle anything. */
export const LabelsSearch: Story = {
  args: { onApply: fn() },
  render: (args) => (
    <div className={panel['panel']}>
      <PropertyPicker
        mode="multi"
        label="Change labels"
        options={LABEL_OPTIONS}
        values={[]}
        onApply={args.onApply}
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard('Needs d');
    await expect(canvas.getByRole('combobox')).toHaveValue('Needs d');
    await expect(canvas.getAllByRole('option')).toHaveLength(1);
    await expect(canvas.getByRole('option')).toHaveAttribute('aria-selected', 'false');
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};

/** Closing in any way applies the toggles in one call: here the picker is unmounted (outside click). */
export const LabelsApplyOnClose: Story = {
  args: { onApply: fn() },
  render: (args) => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            Click outside
          </button>
          {open && (
            <div className={panel['panel']}>
              <PropertyPicker
                mode="multi"
                label="Change labels"
                options={LABEL_OPTIONS}
                values={[]}
                onApply={args.onApply}
              />
            </div>
          )}
        </div>
      );
    }
    return <Host />;
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('option', { name: /Bug/ }));
    await userEvent.click(canvas.getByRole('option', { name: /Web/ }));
    await expect(args.onApply).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Click outside' }));
    await expect(args.onApply).toHaveBeenCalledOnce();
    await expect(args.onApply).toHaveBeenCalledWith(['bug', 'web']);
  },
};

/** A picker that stays mounted after `Enter` still applies on unmount once more is toggled. */
export const LabelsApplyAgainAfterEnter: Story = {
  args: { onApply: fn() },
  render: (args) => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            Click outside
          </button>
          {open && (
            <div className={panel['panel']}>
              <PropertyPicker
                mode="multi"
                label="Change labels"
                options={LABEL_OPTIONS}
                values={[]}
                onApply={args.onApply}
              />
            </div>
          )}
        </div>
      );
    }
    return <Host />;
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.keyboard(' {Enter}');
    await expect(args.onApply).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('option', { name: /Web/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Click outside' }));
    await expect(args.onApply).toHaveBeenCalledTimes(2);
    await expect(args.onApply).toHaveBeenLastCalledWith(['bug', 'web']);
  },
};
