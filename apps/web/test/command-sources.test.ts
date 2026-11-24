import { userActor } from '@surface/domain';
import { createRegistry, defineOperation, type OperationUi } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Command, CommandTarget } from '../src/command-menu/model.js';
import { appSource } from '../src/command-menu/sources/app.js';
import {
  issueFastPath,
  navigationSource,
  teamsPage,
  withIssueFastPath,
} from '../src/command-menu/sources/navigation.js';
import { collect, rankCommands } from '../src/command-menu/ranking.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import { propertySource, type PropertyCommand } from '../src/command-menu/sources/properties.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { context, ENG, fixtureRegistry, noBoost } from './command-fixtures.js';

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
      'Go to Drafts',
      'Go to settings',
      'Open team…',
      'Go to Engineering',
      'Go to Design',
      'Go to ENG issues',
      'Go to DES issues',
      // SPEC-015 §7 (PLAN-015 S4): the archive page's two tabs, per team.
      'Go to archived issues in ENG',
      'Go to recently deleted issues in ENG',
      'Go to archived issues in DES',
      'Go to recently deleted issues in DES',
    ]);
    expect(commands.find((c) => c.id === 'nav:settings')?.shortcuts).toEqual(['Mod+,', ['G', 'S']]);
    expect(commands.find((c) => c.id === 'nav:open-team')?.shortcuts).toEqual([['O', 'T']]);
    void commands.find((c) => c.title === 'Go to Engineering')?.run?.(ctx);
    expect(navigate).toHaveBeenCalledWith('/team/ENG');
    // SPEC-012 §3.3 item 1: "Go to ENG issues" opens the team's list.
    void commands.find((c) => c.title === 'Go to ENG issues')?.run?.(ctx);
    expect(navigate).toHaveBeenCalledWith('/team/ENG/issues');
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

describe('identifier fast path (command-menu §3.1, SPEC-011 §7)', () => {
  const ranked = (query: string, ctx = context({ navigate: vi.fn() })) =>
    withIssueFastPath(
      rankCommands(collect([navigationSource], ctx), query, ctx, noBoost),
      query,
      ctx,
    );

  it('puts "Open ENG-87" first for eng-87, and opens the issue address', () => {
    const navigate = vi.fn();
    const ctx = context({ navigate });
    const sections = ranked('eng-87', ctx);
    expect(sections[0]?.section).toBe('suggested');
    const first = sections[0]?.items[0]?.command;
    expect(first?.title).toBe('Open ENG-87');
    void first?.run?.(ctx);
    expect(navigate).toHaveBeenCalledWith('/issue/ENG-87');
  });

  it('offers Open for an identifier the replica does not hold, whatever the team (E29)', () => {
    // No team has the key ZZZ and no issue is in the context: the route resolves it (issue.get).
    const navigate = vi.fn();
    const ctx = context({ navigate });
    const first = ranked('zzz-9', ctx)[0]?.items[0]?.command;
    expect(first?.title).toBe('Open ZZZ-9');
    void first?.run?.(ctx);
    expect(navigate).toHaveBeenCalledWith('/issue/ZZZ-9');
  });

  it('stays first even when another command matches the query', () => {
    // "Go to Engineering" has ENG as a keyword.
    const sections = ranked('ENG-1');
    expect(sections.flatMap((s) => s.items).map((i) => i.command.title)[0]).toBe('Open ENG-1');
  });

  it('offers nothing for other queries, or before the shell provides navigation', () => {
    expect(issueFastPath('eng')).toBeUndefined();
    expect(issueFastPath('settings')).toBeUndefined();
    const titles = (sections: ReturnType<typeof ranked>) =>
      sections.flatMap((s) => s.items).map((i) => i.command.title);
    expect(titles(ranked('eng'))).not.toContain('Open ENG');
    expect(titles(ranked('eng-87', context()))).not.toContain('Open ENG-87');
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
