import { userActor } from '@surface/domain';
import { createRegistry, defineOperation, type OperationUi } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Command, CommandTarget } from '../src/command-menu/model.js';
import { appSource } from '../src/command-menu/sources/app.js';
import { navigationSource, teamsPage } from '../src/command-menu/sources/navigation.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import { propertySource, type PropertyCommand } from '../src/command-menu/sources/properties.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { context, ENG, fixtureRegistry } from './command-fixtures.js';

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

describe('SPEC-012 §3.8: property commands', () => {
  const issueTarget = (ids: string[] = ['i1']): CommandTarget => ({
    kind: 'issue',
    ids,
    label: 'ENG-1',
  });
  const runAssign = vi.fn();
  const status: PropertyCommand = {
    id: 'prop:issue.status',
    title: 'Change status…',
    keywords: ['state'],
    section: 'settings',
    appliesTo: ['issue', 'issues'],
    operation: 'team.rename',
    refs: () => ({ team: { id: ENG.id } }),
    picker: () => ({ title: 'Change status', items: () => [] }),
  };
  const assignToMe: PropertyCommand = {
    id: 'prop:issue.assignToMe',
    title: 'Assign to me',
    section: 'settings',
    appliesTo: ['issue'],
    operation: 'team.rename',
    refs: () => ({ team: { id: ENG.id } }),
    run: runAssign,
  };
  const source = propertySource(fixtureRegistry, [status, assignToMe]);

  it('are offered for an issue and several issues, and hidden elsewhere', () => {
    expect(
      available(source(context({ target: issueTarget() })), context({ target: issueTarget() })),
    ).toEqual(['prop:issue.status', 'prop:issue.assignToMe']);
    const many: CommandTarget = { kind: 'issues', ids: ['i1', 'i2'], label: '2 selected issues' };
    expect(available(source(context({ target: many })), context({ target: many }))).toEqual([
      'prop:issue.status',
    ]);
    expect(available(source(context()), context())).toEqual([]);
    const team = { kind: 'team', ids: [ENG.id], label: 'ENG' } as const;
    expect(available(source(context({ target: team })), context({ target: team }))).toEqual([]);
  });

  it('use the permission pre-check of their operation and hide when it refuses', () => {
    const outsider = userActor({ userId: 'u-out', role: 'member', memberships: [] });
    const ctx = context({ target: issueTarget(), actor: outsider });
    expect(available(source(ctx), ctx)).toEqual([]);
    const noActor = context({ target: issueTarget(), actor: null });
    expect(available(source(noActor), noActor)).toEqual([]);
  });

  it('are hidden while their operation is not in the registry yet', () => {
    const missing = propertySource(fixtureRegistry, [{ ...status, operation: 'issue.update' }]);
    const ctx = context({ target: issueTarget() });
    expect(available(missing(ctx), ctx)).toEqual([]);
  });

  it('open a picker page or run at once', () => {
    const ctx = context({ target: issueTarget() });
    const [pickerCommand, runCommand] = source(ctx);
    expect(pickerCommand?.page?.(ctx).title).toBe('Change status');
    void runCommand?.run?.(ctx);
    expect(runAssign).toHaveBeenCalledWith(ctx);
  });

  it('carry destructive and keywords through to the command', () => {
    const ctx = context({ target: issueTarget() });
    const [command] = propertySource(fixtureRegistry, [{ ...status, destructive: true }])(ctx);
    expect(command).toMatchObject({ destructive: true, keywords: ['state'] });
  });
});

describe('SPEC-003 §3.1: ui.available(target, store)', () => {
  const op = (availableFn: OperationUi['available']) =>
    defineOperation({
      kind: 'mutation',
      destructive: false,
      description: 'A fixture.',
      keywords: ['fixture one', 'fixture two'],
      output: z.object({}),
      name: 'issue.fixtureEdit',
      domain: 'issue',
      summary: 'Edit an issue',
      input: z.object({ issue: z.string() }),
      permission: (p) => p.any(),
      examples: [{ issue: 'ENG-1' }],
      ui: {
        title: 'Edit issue…',
        icon: 'pencil',
        contexts: ['issue'],
        ...(availableFn === undefined ? {} : { available: availableFn }),
      },
    });
  const build = (availableFn: OperationUi['available']) => {
    const operation = op(availableFn);
    return operationSource(createRegistry([operation]), new CommandRegistry(() => undefined), {
      'issue.fixtureEdit': { run: () => undefined, refs: () => ({}) },
    });
  };
  const target: CommandTarget = { kind: 'issue', ids: ['i1'], label: 'ENG-1' };

  it('is called with the target and the store, and decides whether the command is offered', () => {
    const seen = vi.fn(() => false);
    const ctx = context({ target, store: null });
    const source = build(seen);
    expect(available(source(ctx), ctx)).toEqual([]);
    expect(seen).toHaveBeenCalledWith({ kind: 'issue', ids: ['i1'] }, null);
    const yes = build(() => true);
    expect(available(yes(ctx), ctx)).toEqual(['op:issue.fixtureEdit']);
  });

  it('means always available when absent, and hides the command when it throws', () => {
    const ctx = context({ target });
    expect(available(build(undefined)(ctx), ctx)).toEqual(['op:issue.fixtureEdit']);
    const broken = build(() => {
      throw new Error('store not ready');
    });
    expect(available(broken(ctx), ctx)).toEqual([]);
  });
});
