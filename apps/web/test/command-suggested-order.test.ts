// SPEC-005 §4.2 / AC-3 (changed 2026-11-26, PLAN-016 visual pass): Suggested copies Linear. On a
// team page with nothing focused it leads with "Create issue", then the team's views; team
// administration and destructive commands are reached by typing, never pre-suggested.
import { registry as realRegistry } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import { collect, rankCommands } from '../src/command-menu/ranking.js';
import type { CommandTarget } from '../src/command-menu/model.js';
import { navigationSource } from '../src/command-menu/sources/navigation.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { admin, context, noBoost, teamTarget } from './command-fixtures.js';

const commands = new CommandRegistry(() => undefined);
for (const impl of Object.values(OPERATION_COMMANDS)) {
  if ('opens' in impl) commands.register(impl.opens, { run: vi.fn() });
}
const sources = [operationSource(realRegistry, commands, OPERATION_COMMANDS), navigationSource];

const rank = (query: string, target: CommandTarget) => {
  const ctx = context({ actor: admin, target, navigate: vi.fn() });
  return rankCommands(collect(sources, ctx), query, ctx, noBoost);
};
const suggestedItems = (query: string, target: CommandTarget) =>
  rank(query, target).find((s) => s.section === 'suggested')?.items ?? [];

describe('Suggested on a team page with no focused issue', () => {
  it('starts with Create issue, then the team views', () => {
    const titles = suggestedItems('', teamTarget()).map((i) => i.command.title);
    expect(titles[0]).toBe('Create issue…');
    expect(titles).toContain('Go to ENG issues');
  });

  it('holds no team-admin or destructive command with an empty query', () => {
    const items = suggestedItems('', teamTarget());
    const titles = items.map((i) => i.command.title);
    for (const banned of ['Rename team…', 'Leave team…', 'Remove member…', 'Set default status…']) {
      expect(titles).not.toContain(banned);
    }
    expect(items.some((i) => i.command.destructive === true)).toBe(false);
  });

  it('still finds "Rename team…" first when typing "rename"', () => {
    const first = rank('rename', teamTarget()).flatMap((s) => s.items)[0];
    expect(first?.command.title).toBe('Rename team…');
  });
});

describe('Suggested with a focused issue', () => {
  it('still leads with that issue’s actions, not the team’s', () => {
    const issue: CommandTarget = { kind: 'issue', ids: ['i1'], label: 'ENG-1' };
    const ids = suggestedItems('', issue).map((i) => i.command.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain('op:team.update');
    expect(ids).not.toContain('op:issue.create');
  });
});
