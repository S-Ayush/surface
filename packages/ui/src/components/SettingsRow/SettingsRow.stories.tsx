import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Switch } from '../Switch/Switch.js';
import { SettingsGroup } from '../SettingsGroup/SettingsGroup.js';
import { SettingsRow } from './SettingsRow.js';

const meta = { title: 'Primitives/SettingsRow' } satisfies Meta;
export default meta;
type Story = StoryObj;

/** Static rows for the visual snapshot (design-system §5.4): with and without a hint. */
export const Rows: Story = {
  render: () => (
    <SettingsGroup title="Preferences">
      <SettingsRow label="Email digest" hint="A daily summary of what changed.">
        <Switch aria-label="Email digest" defaultChecked />
      </SettingsRow>
      <SettingsRow label="Desktop alerts">
        <Switch aria-label="Desktop alerts" />
      </SettingsRow>
    </SettingsGroup>
  ),
};

/** The row is a named group whose description is its hint. */
export const LabelAndControl: Story = {
  render: () => (
    <SettingsGroup title="Notifications">
      <SettingsRow label="Email digest" hint="A daily summary of what changed.">
        <Switch aria-label="Email digest" defaultChecked />
      </SettingsRow>
      <SettingsRow label="Desktop alerts" hint="Only while Surface is open.">
        <Switch aria-label="Desktop alerts" />
      </SettingsRow>
    </SettingsGroup>
  ),
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Email digest' });
    await expect(group).toHaveAccessibleDescription('A daily summary of what changed.');
  },
};
