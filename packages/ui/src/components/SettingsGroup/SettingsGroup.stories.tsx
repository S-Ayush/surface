import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button/Button.js';
import { Input } from '../Input/Input.js';
import { SettingsRow } from '../SettingsRow/SettingsRow.js';
import { SettingsGroup, SettingsPanel } from './SettingsGroup.js';

const meta = { title: 'Primitives/SettingsGroup' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const WithRows: Story = {
  render: () => (
    <SettingsGroup title="Account">
      <SettingsRow label="Display name" hint="How people @mention you." controlId="dn">
        <Input aria-label="Display name" id="dn" defaultValue="ada" />
      </SettingsRow>
      <SettingsRow label="Password" hint="Last changed 3 months ago.">
        <Button variant="secondary">Change</Button>
      </SettingsRow>
    </SettingsGroup>
  ),
};

export const ListWithActions: Story = {
  render: () => (
    <SettingsGroup
      title="Members"
      list
      listLabel="Members"
      actions={<Button variant="secondary">Invite</Button>}
    >
      <SettingsRow as="li" label="Ada Lovelace" hint="ada@example.com" />
      <SettingsRow as="li" label="Grace Hopper" hint="grace@example.com" />
    </SettingsGroup>
  ),
};

export const WithForm: Story = {
  render: () => (
    <SettingsGroup title="Workspace">
      <SettingsPanel>
        <Input label="Workspace name" defaultValue="Acme" />
        <Button>Save changes</Button>
      </SettingsPanel>
    </SettingsGroup>
  ),
};
