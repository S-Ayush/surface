// PLAN-015 S4 (SPEC-015 §7, AC-15): the command menu's lifecycle commands. "Restore issue" is
// offered only where the page or the archive row says the issue can be restored (its handler's
// `when`), "Permanently delete…" only to Admins on a deleted issue, and every team has "Go to
// archived issues in ENG" and "Go to recently deleted issues in ENG".
import { userActor } from '@surface/domain';
import { registry as realRegistry } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import type { Command, CommandContext } from '../src/command-menu/model.js';
import { rankCommands } from '../src/command-menu/ranking.js';
import { navigationSource } from '../src/command-menu/sources/navigation.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { context, ENG, noBoost } from './command-fixtures.js';

const issueTarget = { kind: 'issue', ids: ['issue-42'], label: 'ENG-42' } as const;
const memberOfEng = userActor({
  userId: 'u-member',
  role: 'member',
  memberships: [{ teamId: ENG.id, private: false }],
});
const adminOfEng = userActor({
  userId: 'u-admin',
  role: 'admin',
  memberships: [{ teamId: ENG.id, private: false }],
});

function offered(commands: readonly Command[], ctx: CommandContext): string[] {
  return rankCommands(commands, '', ctx, noBoost).flatMap((s) => s.items.map((i) => i.command.id));
}

/** The menu over the real registry, with the page's handlers answering `restorable`/`purgeable`. */
function menu(state: { restorable: boolean; purgeable: boolean }) {
  const commands = new CommandRegistry(() => undefined);
  commands.register('issue:restore', { run: vi.fn(), when: () => state.restorable }, 'page');
  commands.register('issue:purge', { run: vi.fn(), when: () => state.purgeable }, 'page');
  return operationSource(realRegistry, commands, OPERATION_COMMANDS);
}

describe('Restore issue and Permanently delete… (AC-15)', () => {
  it('offers Restore issue only while the issue can be restored', () => {
    const state = { restorable: false, purgeable: false };
    const source = menu(state);
    const ctx = context({ actor: memberOfEng, target: issueTarget });
    expect(offered(source(ctx), ctx)).not.toContain('op:issue.restore');
    state.restorable = true;
    expect(offered(source(ctx), ctx)).toContain('op:issue.restore');
  });

  it('offers Permanently delete… to an Admin on a deleted issue, never to a Member', () => {
    const state = { restorable: true, purgeable: true };
    const source = menu(state);
    const asAdmin = context({ actor: adminOfEng, target: issueTarget });
    expect(offered(source(asAdmin), asAdmin)).toContain('op:issue.purge');
    const asMember = context({ actor: memberOfEng, target: issueTarget });
    expect(offered(source(asMember), asMember)).not.toContain('op:issue.purge');
    state.purgeable = false;
    expect(offered(source(asAdmin), asAdmin)).not.toContain('op:issue.purge');
  });
});

describe('Go to the archive (§7)', () => {
  it('has "Go to archived issues in ENG" and "Go to recently deleted issues in ENG"', () => {
    const navigate = vi.fn();
    const ctx = context({ navigate });
    const commands = navigationSource(ctx);
    const archived = commands.find((c) => c.title === 'Go to archived issues in ENG');
    const deleted = commands.find((c) => c.title === 'Go to recently deleted issues in ENG');
    void archived?.run?.(ctx);
    void deleted?.run?.(ctx);
    expect(navigate.mock.calls).toEqual([
      ['/team/ENG/archive'],
      ['/team/ENG/archive/recently-deleted'],
    ]);
  });
});
