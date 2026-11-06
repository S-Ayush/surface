import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs.js';

const meta = { title: 'Primitives/Tabs' } satisfies Meta;
export default meta;
type Story = StoryObj;

const ViewTabs = () => (
  <Tabs defaultValue="all">
    <TabsList aria-label="Issue views">
      <TabsTrigger value="all" count={128}>
        All issues
      </TabsTrigger>
      <TabsTrigger value="active" count={12}>
        Active
      </TabsTrigger>
      <TabsTrigger value="backlog">Backlog</TabsTrigger>
      <TabsTrigger value="archived" disabled>
        Archived
      </TabsTrigger>
    </TabsList>
    <TabsContent value="all">All issues of the team.</TabsContent>
    <TabsContent value="active">Issues in started states.</TabsContent>
    <TabsContent value="backlog">Issues not yet planned.</TabsContent>
    <TabsContent value="archived">Archived issues.</TabsContent>
  </Tabs>
);

export const Default: Story = { render: () => <ViewTabs /> };

/** Arrow keys move between tabs (skipping disabled ones) and show their panel. */
export const Keyboard: Story = {
  render: () => <ViewTabs />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('tab', { name: /All issues/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    const active = canvas.getByRole('tab', { name: /Active/ });
    await expect(active).toHaveFocus();
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent('Issues in started states.');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await expect(canvas.getByRole('tab', { name: /All issues/ })).toHaveFocus();
  },
};
