// SPEC-005 §4.2 ranking and AC-3 (context): with a team page open, team-context commands rank in
// Suggested; without a context they do not appear there.
import { describe, expect, it } from 'vitest';
import { fuzzyMatch, matchCommand } from '../src/command-menu/fuzzy.js';
import type { Command } from '../src/command-menu/model.js';
import { collect, rankCommands, rankPageItems } from '../src/command-menu/ranking.js';
import { operationSource, type OperationCommand } from '../src/command-menu/sources/operations.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { context, fixtureRegistry, noBoost, teamTarget } from './command-fixtures.js';

const implementations: Record<string, OperationCommand> = {
  'team.create': { run: () => undefined },
  'team.rename': {
    run: () => undefined,
    refs: (ctx) => ({ team: { id: ctx.target.kind === 'team' ? (ctx.target.ids[0] ?? '') : '' } }),
  },
  'team.updateColor': { run: () => undefined },
  'user.exportData': { run: () => undefined },
};
const source = operationSource(
  fixtureRegistry,
  new CommandRegistry(() => undefined),
  implementations,
);

const ids = (sections: ReturnType<typeof rankCommands>, section: string) =>
  sections.find((entry) => entry.section === section)?.items.map((item) => item.command.id) ?? [];

describe('AC-3: context ranking', () => {
  it('ranks team-context commands in Suggested on a team page', () => {
    const ctx = context({ target: teamTarget() });
    const sections = rankCommands(source(ctx), '', ctx, noBoost);
    expect(sections[0]?.section).toBe('suggested');
    expect(ids(sections, 'suggested')).toContain('op:team.rename');
    // Global commands still offered, in their own section.
    expect(ids(sections, 'settings')).toContain('op:user.exportData');
  });

  it('leaves team-context commands out of Suggested (and out of the menu) without a context', () => {
    const ctx = context();
    const sections = rankCommands(source(ctx), '', ctx, noBoost);
    const all = sections.flatMap((section) => section.items.map((item) => item.command.id));
    expect(all).not.toContain('op:team.rename');
    expect(ids(sections, 'suggested')).toEqual(['op:user.exportData']);
  });

  it('doubles the score of commands that apply to the context', () => {
    const plain: Command = { id: 'a', title: 'Rename thing', section: 'settings' };
    const boosted: Command = { ...plain, id: 'b', appliesTo: () => true };
    const ctx = context();
    const [suggested, settings] = rankCommands([plain, boosted], 'rename', ctx, noBoost);
    expect(suggested?.items[0]?.score).toBeCloseTo((settings?.items[0]?.score ?? 0) * 2);
  });
});

describe('ranking', () => {
  const commands: Command[] = [
    { id: 'reset', title: 'Reset everything', section: 'settings' },
    { id: 'settings', title: 'Go to settings', section: 'navigation' },
    {
      id: 'theme',
      title: 'Toggle light and dark theme',
      section: 'settings',
      keywords: ['dark mode'],
    },
    { id: 'help', title: 'Keyboard shortcuts', section: 'help' },
  ];

  it('keeps sections in order and drops empty ones', () => {
    const sections = rankCommands(commands, '', context(), noBoost);
    expect(sections.map((section) => section.section)).toEqual(['navigation', 'settings', 'help']);
  });

  it('lists only matches, best first within a section', () => {
    const sections = rankCommands(commands, 'set', context(), noBoost);
    expect(sections.flatMap((s) => s.items.map((i) => i.command.id))).toEqual([
      'settings',
      'reset',
    ]);
  });

  it('matches keywords', () => {
    const sections = rankCommands(commands, 'dark mode', context(), noBoost);
    expect(sections.flatMap((s) => s.items.map((i) => i.command.id))).toEqual(['theme']);
  });

  it('boosts frequently used commands', () => {
    const two: Command[] = [
      { id: 'one', title: 'Archive team', section: 'settings' },
      { id: 'two', title: 'Archive project', section: 'settings' },
    ];
    const sections = rankCommands(two, 'archive', context(), {
      boost: (id) => (id === 'two' ? 1.5 : 1),
    });
    expect(sections[0]?.items.map((i) => i.command.id)).toEqual(['two', 'one']);
  });

  it('hides unavailable commands, duplicates and a command whose `when` throws', () => {
    const list: Command[] = [
      { id: 'x', title: 'Shown', section: 'help' },
      { id: 'x', title: 'Duplicate', section: 'help' },
      { id: 'y', title: 'Not here', section: 'help', when: () => false },
      {
        id: 'z',
        title: 'Broken',
        section: 'help',
        when: () => {
          throw new Error('bad');
        },
      },
    ];
    const sections = rankCommands(list, '', context(), noBoost);
    expect(sections.flatMap((s) => s.items.map((i) => i.command.title))).toEqual(['Shown']);
  });
});

describe('a broken command never breaks the menu', () => {
  const boom = () => {
    throw new Error('boom');
  };

  it('lists a command whose appliesTo throws in its own section', () => {
    const list: Command[] = [{ id: 'a', title: 'Shown', section: 'help', appliesTo: boom }];
    expect(rankCommands(list, '', context(), noBoost).map((s) => s.section)).toEqual(['help']);
  });

  it('skips a source that throws, keeping the others', () => {
    const ok = () => [{ id: 'a', title: 'Shown', section: 'help' } satisfies Command];
    expect(collect([boom, ok], context()).map((c) => c.id)).toEqual(['a']);
  });

  it('shows an empty page when its items throw', () => {
    expect(rankPageItems({ title: 'Broken', items: boom }, '')).toEqual([]);
  });
});

describe('fuzzy matching', () => {
  it('matches characters in order, ignoring case and spaces', () => {
    expect(fuzzyMatch('gts', 'Go to settings')).not.toBeNull();
    expect(fuzzyMatch('G S', 'Go to settings')?.indices).toEqual([0, 6]);
    expect(fuzzyMatch('xyz', 'Go to settings')).toBeNull();
    expect(fuzzyMatch('', 'anything')?.score).toBe(1);
  });

  it('prefers word starts, consecutive runs and exact matches', () => {
    const score = (q: string, t: string) => fuzzyMatch(q, t)?.score ?? 0;
    expect(score('set', 'Settings')).toBeGreaterThan(score('set', 'Reset'));
    expect(score('team', 'Create team')).toBeGreaterThan(score('team', 'Toggle each amber mode'));
    expect(score('settings', 'settings')).toBe(1);
  });

  it('counts highlight positions in characters, as the view does, past emoji', () => {
    const title = '🚀 Launch';
    const indices = fuzzyMatch('la', title)?.indices ?? [];
    expect(indices).toEqual([2, 3]);
    expect(indices.map((i) => [...title][i]).join('')).toBe('La');
  });

  it('scores keyword matches below title matches', () => {
    const title = matchCommand('theme', 'Theme', []);
    const keyword = matchCommand('theme', 'Appearance', ['theme']);
    expect(title?.score ?? 0).toBeGreaterThan(keyword?.score ?? 0);
  });
});

describe('SPEC-012 AC-16: a destructive command never ranks first on a keyword match', () => {
  const ctx = context();
  const command = (overrides: Partial<Command> & Pick<Command, 'id' | 'title'>): Command => ({
    section: 'settings',
    ...overrides,
  });
  const deleteIssue = command({
    id: 'issue:delete',
    title: 'Delete issue',
    keywords: ['remove', 'deleted', 'trash'],
    destructive: true,
    appliesTo: () => true,
  });
  const restore = command({
    id: 'issue:restore',
    title: 'Restore issue',
    keywords: ['deleted', 'undelete'],
    appliesTo: () => true,
  });
  const firstId = (sections: ReturnType<typeof rankCommands>) => sections[0]?.items[0]?.command.id;

  it('puts Restore issue ahead of Delete issue for the keyword "deleted"', () => {
    expect(firstId(rankCommands([deleteIssue, restore], 'deleted', ctx, noBoost))).toBe(
      'issue:restore',
    );
    expect(firstId(rankCommands([restore, deleteIssue], 'deleted', ctx, noBoost))).toBe(
      'issue:restore',
    );
  });

  it('still finds a destructive command that is the only match, with a score above 0', () => {
    const rename = command({ id: 'issue:rename', title: 'Rename issue', appliesTo: () => true });
    const sections = rankCommands([deleteIssue, rename], 'trash', ctx, noBoost);
    expect(firstId(sections)).toBe('issue:delete');
    expect(sections[0]?.items[0]?.score).toBeGreaterThan(0);
  });

  it('puts a command in an earlier section ahead of a destructive keyword match', () => {
    const both = rankCommands(
      [deleteIssue, command({ id: 'nav:trash', title: 'Go to trash', section: 'navigation' })],
      'trash',
      ctx,
      noBoost,
    );
    expect(both.flatMap((section) => section.items).map((item) => item.command.id)).toEqual([
      'nav:trash',
      'issue:delete',
    ]);
  });

  it('clamps a keyword-only destructive command under a better-scoring command of its own section', () => {
    // Delete is in Suggested through `appliesTo` and its keyword "trash" is an exact match, so it
    // would outscore this weak title match; the clamp keeps it below. (Tested on the same section,
    // where the order is by score.)
    const weak = command({
      id: 'app:weak',
      title: 'Manage the integrations of all teams in the workspace',
    });
    const delete2 = { ...deleteIssue, section: 'settings' as const, keywords: ['trash'] };
    const unclamped = Math.max(0, fuzzyMatch('trash', 'trash')?.score ?? 0) * 0.8;
    const weakScore = fuzzyMatch('trash', weak.title)?.score ?? 0;
    expect(unclamped).toBeGreaterThan(weakScore);
    const sections = rankCommands([delete2, weak], 'trash', ctx, noBoost);
    expect(sections.map((section) => section.section)).toEqual(['settings']);
    expect(sections[0]?.items.map((item) => item.command.id)).toEqual(['app:weak', 'issue:delete']);
  });

  it('ranks it first when its title matches better than any other command', () => {
    const sections = rankCommands([restore, deleteIssue], 'delete issue', ctx, noBoost);
    expect(firstId(sections)).toBe('issue:delete');
  });

  it('never ranks it first for an empty query', () => {
    expect(firstId(rankCommands([deleteIssue, restore], '', ctx, noBoost))).toBe('issue:restore');
  });

  it('leaves non-destructive commands as they were', () => {
    const plain = { ...deleteIssue, destructive: false };
    expect(firstId(rankCommands([restore, plain], 'delete issue', ctx, noBoost))).toBe(
      'issue:delete',
    );
  });
});
