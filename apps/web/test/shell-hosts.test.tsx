// Feature hooks in the shell (features/hosts.ts, SPEC-001 §3.7): the teams feature mounts its
// Create team dialog and team ⋯ menu without changing the shell.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TeamRef } from '../src/features/hosts.js';
import { TeamMenuSlot } from '../src/pages/TeamHomePage.js';
import { FeatureHosts } from '../src/shell/Shell.js';
import { CreateTeamButton } from '../src/shell/Sidebar.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';

/** Registers `form:create-team` during render: SSR runs no effects, and it renders first. */
function CreateTeamHandler() {
  useCommandRegistry().register('form:create-team', { run: () => undefined });
  return null;
}

describe('the sidebar "+" next to Your teams', () => {
  it('shows only while a feature implements Create team', () => {
    const without = renderToString(
      <ShortcutProvider>
        <CreateTeamButton />
      </ShortcutProvider>,
    );
    expect(without).not.toContain('Create team');

    const withHandler = renderToString(
      <ShortcutProvider>
        <CreateTeamHandler />
        <CreateTeamButton />
      </ShortcutProvider>,
    );
    expect(withHandler).toContain('aria-label="Create team"');
  });
});

describe('feature hosts', () => {
  it('mounts every registered host once', () => {
    const First = () => <p>first host</p>;
    const Second = () => <p>second host</p>;
    const html = renderToString(<FeatureHosts hosts={[First, Second]} />);
    expect(html).toContain('first host');
    expect(html).toContain('second host');
  });

  it('puts the team ⋯ menu in the team header when a feature provides one', () => {
    const team: TeamRef = { id: 't1', key: 'ENG', name: 'Engineering' };
    const Menu = ({ team: shown }: { team: TeamRef }) => <button>{`${shown.key} actions`}</button>;
    expect(renderToString(<TeamMenuSlot team={team} menu={Menu} />)).toContain('ENG actions');
    expect(renderToString(<TeamMenuSlot team={team} menu={null} />)).toBe('');
  });
});
