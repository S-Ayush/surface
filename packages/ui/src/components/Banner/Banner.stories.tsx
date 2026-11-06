import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor } from 'storybook/test';
import { banner, BANNER_PRIORITY } from '../../overlays/manager.js';
import { Stack } from '../../stories/helpers.js';
import { Banner, BannerRegion } from './Banner.js';

const meta = { title: 'Overlays/Banner', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;

const noop = () => {};

/** The system banners of SPEC-005 §8. */
export const Tones: Story = {
  render: () => (
    <Stack>
      <Banner tone="info" action={{ label: 'Reload', onAction: noop }}>
        Surface was updated.
      </Banner>
      <Banner tone="warning">Offline: changes will sync when you reconnect · 3 pending</Banner>
      <Banner tone="warning" onDismiss={noop}>
        Offline mode unavailable in this browser session
      </Banner>
      <Banner tone="danger" action={{ label: 'Learn more', onAction: noop }}>
        Live updates unavailable: check your proxy&apos;s WebSocket settings.
      </Banner>
    </Stack>
  ),
};

/**
 * The region shows one banner: the most severe, then the oldest. Danger is an alert, the rest a
 * polite status; a dismissible banner hides on Dismiss and the next one takes its place.
 */
export const Region: Story = {
  render: () => (
    <main tabIndex={-1} aria-label="Content">
      <BannerRegion />
    </main>
  ),
  play: async () => {
    // Live regions must exist before their text arrives, or screen readers stay silent.
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    banner.show('outdated', {
      tone: 'info',
      message: 'Surface was updated.',
      action: { label: 'Reload', onAction: noop },
    });
    await waitFor(() => expect(status).toHaveTextContent('Surface was updated.'));
    await expect(screen.getByRole('status')).toBe(status);

    banner.show('ws', { tone: 'danger', message: 'Live updates unavailable.' });
    await waitFor(() => expect(alert).toHaveTextContent('Live updates unavailable.'));
    await expect(screen.queryByText('Surface was updated.')).not.toBeInTheDocument();
    banner.hide('ws');

    banner.show('idb', {
      tone: 'warning',
      message: 'Offline mode unavailable in this browser session',
      dismissible: true,
    });
    await screen.findByText('Offline mode unavailable in this browser session');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // The button is gone; focus goes to the main region rather than <body>.
    await expect(screen.getByRole('main')).toHaveFocus();
    await waitFor(() => expect(status).toHaveTextContent('Surface was updated.'));
    // Persistent banners have no dismiss button.
    await expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  },
};

/** A banner that blocks syncing outranks a dismissible warning (explicit priority). */
export const Priority: Story = {
  render: () => <BannerRegion />,
  play: async () => {
    banner.show('idb', { tone: 'warning', message: 'Offline mode unavailable', dismissible: true });
    banner.show('outdated', {
      tone: 'info',
      message: 'Surface was updated.',
      priority: BANNER_PRIORITY.blocking,
    });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Surface was updated.'),
    );
  },
};
