// PLAN-012 S6 (SPEC-012 §3.8, AC-8, AC-16, AC-25, E22): which issue commands a context offers
// through the real operation registry, in what order, and that Delete issue never ranks first on a
// keyword match. `#` (Restore issue) is only available on an archived or deleted issue.
import { userActor } from '@surface/domain';
import { registry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '../src/command-menu/model.js';
import { rankCommands } from '../src/command-menu/ranking.js';
import { appSource } from '../src/command-menu/sources/app.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';

const ME = 'u-me';
const noBoost = { boost: () => 1 };

/** A store whose pool answers the operations' `get('Issue', id)` for one issue. */
function storeWith(row: Record<string, unknown> | undefined): SyncStore {
  return {
    pool: {
      get: (model: string, id: string) => (model === 'Issue' && id === 'i1' ? row : undefined),
    },
  } as unknown as SyncStore;
}

const live = { id: 'i1', archivedAt: null, deletedAt: null };
const archived = { ...live, archivedAt: '2026-11-01T00:00:00.000Z' };
const deleted = { ...live, deletedAt: '2026-11-10T00:00:00.000Z' };

const actor = userActor({
  userId: ME,
  role: 'member',
  memberships: [{ teamId: 'eng', private: false }],
});

function ctx(kind: 'issue' | 'global', store: SyncStore | null): CommandContext {
  return {
    route: '/',
    target: kind === 'issue' ? { kind: 'issue', ids: ['i1'], label: 'ENG-42' } : { kind: 'global' },
    actor,
    store,
    teams: () => [],
  };
}

/** Handlers the list or page registers, so `commands.isAvailable` agrees (the menu's `appSource`). */
function registryWith(...ids: Parameters<CommandRegistry['register']>[0][]) {
  const commands = new CommandRegistry(() => undefined);
  for (const id of ids) commands.register(id, { run: () => undefined });
  return commands;
}

const titles = (commands: readonly Command[], c: CommandContext) =>
  commands.filter((command) => command.when?.(c) ?? true).map((command) => command.title);

describe('Delete issue and Restore issue in the menu (AC-16, AC-25, E22)', () => {
  const commands = registryWith('issue:delete', 'issue:restore');
  const ops = operationSource(registry, commands, OPERATION_COMMANDS);

  it('Delete issue is offered for a live or archived issue and hidden once deleted', () => {
    for (const row of [live, archived]) {
      const c = ctx('issue', storeWith(row));
      expect(titles(ops(c), c)).toContain('Delete issue');
    }
    const c = ctx('issue', storeWith(deleted));
    expect(titles(ops(c), c)).not.toContain('Delete issue');
  });

  it('Restore issue is available only on an archived or deleted issue (E22)', () => {
    for (const row of [archived, deleted]) {
      const c = ctx('issue', storeWith(row));
      expect(titles(ops(c), c)).toContain('Restore issue');
    }
    const c = ctx('issue', storeWith(live));
    expect(titles(ops(c), c)).not.toContain('Restore issue');
  });

  it('neither is offered without an issue as the target', () => {
    const c = ctx('global', storeWith(live));
    expect(titles(ops(c), c)).not.toContain('Delete issue');
    expect(titles(ops(c), c)).not.toContain('Restore issue');
  });

  it('Delete issue is a destructive command, so on a tie it never ranks first', () => {
    const c = ctx('issue', storeWith(archived));
    const all = ops(c);
    expect(all.find((command) => command.title === 'Delete issue')?.destructive).toBe(true);
    const ranked = rankCommands(all, 'issue', c, noBoost);
    expect(ranked[0]?.items[0]?.command.title).toBe('Restore issue');
  });
});

describe('the issue app commands (AC-16)', () => {
  const commands = registryWith('issue:rename', 'issue:copy-id', 'issue:copy-markdown');
  const source = appSource(commands);

  it('rename and the copy commands are offered for an issue, not elsewhere', () => {
    const forIssue = ctx('issue', null);
    expect(titles(source(forIssue), forIssue)).toEqual([
      'Rename issue',
      'Copy ID',
      'Copy issue as Markdown',
    ]);
    const nothing = ctx('global', null);
    expect(titles(source(nothing), nothing)).toEqual([]);
  });

  it('they suggest themselves for the focused issue', () => {
    const c = ctx('issue', null);
    const sections = rankCommands([...source(c)], '', c, noBoost);
    expect(sections[0]?.section).toBe('suggested');
    expect(sections[0]?.items.map((item) => item.command.title)).toEqual([
      'Rename issue',
      'Copy ID',
      'Copy issue as Markdown',
    ]);
  });

  it('a command with no handler yet (Restore issue is PLAN-015 S4’s) stays hidden', () => {
    const none = appSource(new CommandRegistry(() => undefined));
    const c = ctx('issue', null);
    expect(titles(none(c), c)).toEqual([]);
  });
});
