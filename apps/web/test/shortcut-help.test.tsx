// SPEC-005 AC-8: the `?` overlay lists exactly the registered bindings available in the build,
// grouped and searchable.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlatformProvider } from '@surface/ui';
import { commandTitle } from '../src/commands/catalog.js';
import { helpGroups } from '../src/shortcuts/help.js';
import { SHORTCUTS, inBuild, shortcut } from '../src/shortcuts/registry.js';
import { ShortcutHelpContent } from '../src/shortcuts/ShortcutHelp.js';

const later = shortcut({
  id: 'test.later',
  keys: 'C',
  scope: 'global',
  command: 'help:shortcuts',
  group: 'Later',
  milestone: 'M1',
});

const ids = (groups: ReturnType<typeof helpGroups>) =>
  groups.flatMap((group) => group.rows.map((row) => row.id));

describe('AC-8: the help overlay', () => {
  it('lists exactly the bindings available in this build, grouped in registry order', () => {
    const groups = helpGroups([...SHORTCUTS, later], { platform: 'mac' });
    expect(ids(groups).sort()).toEqual(
      SHORTCUTS.filter((entry) => entry.milestone === 'M0')
        .map((entry) => entry.id)
        .sort(),
    );
    expect(groups.map((group) => group.group)).toEqual([
      'General',
      'Navigation',
      'Dialogs and pickers',
    ]);
  });

  it('includes later bindings once the build reaches their milestone', () => {
    const groups = helpGroups([...SHORTCUTS, later], { platform: 'mac', milestone: 'M1' });
    expect(ids(groups)).toContain('test.later');
  });

  it.each([
    ['theme', ['global.theme']],
    ['g s', ['nav.settings']],
    ['SETTINGS', ['global.settings', 'nav.settings']],
    ['⌘ k', ['global.commandMenu']],
    ['command k', ['global.commandMenu']],
    ['navigation team', ['nav.openTeam']],
    ['open t', ['nav.openTeam']],
    ['go to s', ['global.settings', 'nav.settings']],
    ['toggle th', ['global.theme']],
  ])('searches titles, groups and keys: "%s"', (query, expected) => {
    expect(ids(helpGroups(SHORTCUTS, { platform: 'mac', query }))).toEqual(expected);
  });

  it('shows the platform’s key names', () => {
    expect(ids(helpGroups(SHORTCUTS, { platform: 'other', query: 'ctrl k' }))).toEqual([
      'global.commandMenu',
    ]);
    expect(ids(helpGroups(SHORTCUTS, { platform: 'other', query: '⌘' }))).toEqual([]);
  });

  it('renders every group and title, with a search field', () => {
    const html = renderToString(
      <PlatformProvider platform="mac">
        <ShortcutHelpContent bindings={SHORTCUTS} />
      </PlatformProvider>,
    );
    expect(html).toContain('aria-label="Search shortcuts"');
    for (const entry of SHORTCUTS) expect(html).toContain(commandTitle(entry.command));
    expect(html).toMatch(/<h3[^>]*>General<\/h3>/);
    expect(html).toContain('Command K');
  });

  it('says when nothing matches, in a live region', () => {
    const html = renderToString(
      <PlatformProvider platform="mac">
        <ShortcutHelpContent bindings={SHORTCUTS} initialQuery="zzz" />
      </PlatformProvider>,
    );
    expect(html).toMatch(/<p role="status"[^>]*>No shortcuts match &quot;zzz&quot;<\/p>/);
    expect(html).not.toContain('<h3');
  });
});

describe('inBuild', () => {
  it('is what the engine is given: bindings up to the build milestone', () => {
    expect(inBuild([...SHORTCUTS, later]).map((entry) => entry.id)).not.toContain('test.later');
    expect(inBuild([...SHORTCUTS, later], 'M1').map((entry) => entry.id)).toContain('test.later');
  });
});
