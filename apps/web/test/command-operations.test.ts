// SPEC-005 AC-2 (unit part; the e2e is held): operation commands appear for permitted users only,
// and E4: a permission change re-evaluates `when` while the menu is open.
import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@surface/domain';
import { registry as realRegistry } from '@surface/operations';
import type { Command } from '../src/command-menu/model.js';
import { rankCommands } from '../src/command-menu/ranking.js';
import { track, watch } from '../src/command-menu/reactive.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import {
  checkOperationCommands,
  menuOperations,
  operationSource,
  type OperationCommand,
} from '../src/command-menu/sources/operations.js';
import { CommandRegistry } from '../src/commands/registry.js';
import {
  admin,
  context,
  fixtureRegistry,
  member,
  noBoost,
  teamTarget,
  ENG,
  DES,
} from './command-fixtures.js';

const teamRefs: OperationCommand['refs'] = (ctx) =>
  ctx.target.kind === 'team'
    ? { team: { id: ctx.target.ids[0] ?? '', name: ctx.target.label } }
    : {};
const implementations: Record<string, OperationCommand> = {
  'team.create': { opens: 'help:shortcuts' },
  'team.rename': { run: vi.fn(), refs: teamRefs },
  'team.updateColor': { run: vi.fn(), refs: teamRefs },
  'user.exportData': { run: vi.fn() },
  'debug.uiFixture': { run: vi.fn() },
  'team.renameOld': { run: vi.fn() },
};

function offered(commands: readonly Command[], ctx = context()) {
  return rankCommands(commands, '', ctx, noBoost).flatMap((s) => s.items.map((i) => i.command.id));
}

function setup() {
  const registry = new CommandRegistry(() => undefined);
  registry.register('help:shortcuts', { run: vi.fn() });
  const source = operationSource(fixtureRegistry, registry, implementations);
  return { registry, source };
}

describe('AC-2: permission filtering', () => {
  it('shows admin-only commands to Admins and never to Members', () => {
    const { source } = setup();
    expect(offered(source(context({ actor: admin })), context({ actor: admin }))).toContain(
      'op:team.create',
    );
    expect(offered(source(context({ actor: member })), context({ actor: member }))).not.toContain(
      'op:team.create',
    );
  });

  it('uses the context’s references: members see team commands for their own team only', () => {
    const { source } = setup();
    const own = context({ actor: member, target: teamTarget(ENG) });
    const other = context({ actor: member, target: teamTarget(DES) });
    expect(offered(source(own), own)).toEqual(
      expect.arrayContaining(['op:team.rename', 'op:team.updateColor']),
    );
    expect(offered(source(other), other)).not.toContain('op:team.rename');
    expect(offered(source(other), other)).not.toContain('op:team.updateColor');
    // Admins pass team.rename's `p.admin()` branch for any team.
    const adminOther = context({ actor: admin, target: teamTarget(DES) });
    expect(offered(source(adminOther), adminOther)).toContain('op:team.rename');
  });

  it('offers no operation before sign-in', () => {
    const { source } = setup();
    const ctx = context({ actor: null });
    expect(offered(source(ctx), ctx).filter((id) => id.startsWith('op:'))).toEqual([]);
  });

  it('leaves a check that needs the operation’s input to the server: the command stays offered', () => {
    const registry = new CommandRegistry(() => undefined);
    const source = operationSource(fixtureRegistry, registry, {
      'team.archiveMany': { run: vi.fn() },
    });
    // `input.ids.length > 0 && p.admin()` throws on the empty input before reaching p.admin(), so
    // even a Member is offered it; the server refuses (SPEC-005 AC-2 note). Role checks go first.
    const ctx = context({ actor: member });
    expect(offered(source(ctx), ctx)).toContain('op:team.archiveMany');
  });

  it('skips internal and deprecated operations', () => {
    const names = menuOperations(fixtureRegistry).map((op) => op.name);
    expect(names).not.toContain('debug.uiFixture');
    expect(names).not.toContain('team.renameOld');
  });

  it('hides a command that opens a form until its feature registers the form', () => {
    const registry = new CommandRegistry(() => undefined);
    const source = operationSource(fixtureRegistry, registry, implementations);
    const ctx = context({ actor: admin });
    expect(offered(source(ctx), ctx)).not.toContain('op:team.create');
    registry.register('help:shortcuts', { run: vi.fn() });
    expect(offered(source(ctx), ctx)).toContain('op:team.create');
  });

  it('carries the title, keywords, section and shortcut from the registry', () => {
    const { source } = setup();
    const commands = source(context({ actor: admin }));
    expect(commands.find((c) => c.id === 'op:team.create')).toMatchObject({
      title: 'Create team…',
      section: 'create',
      keywords: ['new team', 'add team'],
    });
    // `Mod+Shift+E` is declared but not bound in this build: no hint for a key that does nothing.
    expect(commands.find((c) => c.id === 'op:user.exportData')?.shortcuts).toBeUndefined();
  });

  it('every real operation with ui metadata has a working command entry, and no entry is stale', () => {
    expect(checkOperationCommands(realRegistry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('the entry check catches missing, stale, unscoped, unbound and unreachable entries', () => {
    expect(
      checkOperationCommands(fixtureRegistry, {
        'team.create': { opens: 'help:shortcuts' },
        'team.rename': { run: vi.fn() }, // no refs: Members would never see it
        'team.updateColor': { run: vi.fn(), refs: () => ({}) }, // refs that never name the team
        'team.archiveMany': { run: vi.fn() },
        'team.gone': { run: vi.fn() },
      }),
    ).toEqual([
      'team.gone has a command entry but no operation with ui',
      'team.rename acts on team but gives no refs',
      'team.updateColor is not offered in its team context',
      'user.exportData has ui metadata but no command entry',
    ]);
    expect(
      checkOperationCommands(fixtureRegistry, {
        ...implementations,
        'team.archiveMany': { run: vi.fn() },
        'user.exportData': { run: vi.fn() },
      }).filter((problem) => problem.startsWith('user.exportData')),
    ).toEqual(['user.exportData shows Mod+Shift+E, which no shortcut binding uses']);
  });
});

describe('E4: a permission change while the menu is open', () => {
  it('re-evaluates `when` reactively, and the command disappears', () => {
    const { source } = setup();
    const actor = observable.box<Actor>(admin, { deep: false });
    const compute = () => {
      const ctx = context({ actor: actor.get() });
      return offered(source(ctx), ctx);
    };
    const changed = vi.fn();
    const stop = watch(compute, changed);
    expect(compute()).toContain('op:team.create');
    runInAction(() => actor.set(member)); // the role change arrives as a delta
    expect(changed).toHaveBeenCalledOnce();
    expect(compute()).not.toContain('op:team.create');
    stop();
  });
});

describe('E4: a change between showing the menu and subscribing to the store', () => {
  it('is not missed: the subscribing run sees it and refreshes the menu', () => {
    const { source } = setup();
    const actor = observable.box<Actor>(admin, { deep: false });
    const compute = () => {
      const ctx = context({ actor: actor.get() });
      return offered(source(ctx), ctx);
    };
    const same = (a: string[], b: string[]) => a.join() === b.join();
    const shown = compute(); // rendered as Admin
    runInAction(() => actor.set(member)); // the delta lands before the effect subscribes
    const changed = vi.fn();
    const stop = track(compute, shown, same, changed);
    expect(changed).toHaveBeenCalledOnce();
    stop();

    const unchanged = vi.fn();
    track(compute, compute(), same, unchanged)();
    expect(unchanged).not.toHaveBeenCalled();
  });
});
