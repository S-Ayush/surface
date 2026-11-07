import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../src/command-menu/model.js';
import { appSource } from '../src/command-menu/sources/app.js';
import { navigationSource, teamsPage } from '../src/command-menu/sources/navigation.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { context, ENG } from './command-fixtures.js';

const available = (commands: readonly Command[], ctx = context()) =>
  commands.filter((command) => command.when?.(ctx) ?? true).map((command) => command.id);

describe('navigation commands', () => {
  it('are hidden until the shell provides navigation (S4)', () => {
    expect(available(navigationSource(context()))).toEqual([]);
  });

  it('cover the M0 pages, "Open team…" and one "Go to" per live team, with their shortcuts', () => {
    const navigate = vi.fn();
    const ctx = context({ navigate });
    const commands = navigationSource(ctx);
    expect(commands.map((command) => command.title)).toEqual([
      'Go to My issues',
      'Go to settings',
      'Open team…',
      'Go to Engineering',
      'Go to Design',
    ]);
    expect(commands.find((c) => c.id === 'nav:settings')?.shortcuts).toEqual(['Mod+,', ['G', 'S']]);
    expect(commands.find((c) => c.id === 'nav:open-team')?.shortcuts).toEqual([['O', 'T']]);
    void commands.find((c) => c.title === 'Go to Engineering')?.run?.(ctx);
    expect(navigate).toHaveBeenCalledWith('/team/ENG');
  });

  it('"Open team…" is a page of teams that navigates to the chosen one', () => {
    const navigate = vi.fn();
    const page = teamsPage(context({ navigate }));
    const items = page.items();
    expect(items.map((item) => item.title)).toEqual(['Engineering', 'Design']);
    expect(items[0]?.keywords).toEqual([ENG.key]);
    void items[1]?.run();
    expect(navigate).toHaveBeenCalledWith('/team/DES');
    expect(teamsPage(context({ teams: () => [] })).empty).toBe('No teams yet');
  });
});

describe('app commands', () => {
  it('are offered while their handler is registered, and run it', () => {
    const registry = new CommandRegistry(() => undefined);
    const commands = appSource(registry)(context());
    expect(available(commands)).toEqual([]);
    const toggle = vi.fn();
    registry.register('toggle:theme', { run: toggle });
    expect(available(commands)).toEqual(['toggle:theme']);
    void commands.find((c) => c.id === 'toggle:theme')?.run?.(context());
    expect(toggle).toHaveBeenCalledOnce();
    expect(commands.find((c) => c.id === 'toggle:theme')?.shortcuts).toEqual(['Alt+Shift+T']);
  });
});
