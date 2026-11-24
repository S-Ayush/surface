// PLAN-014 S5, SPEC-014 §7, SPEC-005 §4.1: the attachment operations in the command menu. "Attach
// file…" and "Link any URL to issue…" are offered on an issue while the page registers their forms;
// "Rename attachment…" and "Remove attachment" on a focused attachment (the `attachment` target),
// to its creator, its team's members and Admins only (§5).
import { userActor } from '@surface/domain';
import { Attachment } from '@surface/domain/model';
import { registry as realRegistry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/command-menu/model.js';
import { rankCommands } from '../src/command-menu/ranking.js';
import { appSource } from '../src/command-menu/sources/app.js';
import { operationSource } from '../src/command-menu/sources/operations.js';
import type { CommandId } from '../src/commands/catalog.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { admin, context, noBoost } from './command-fixtures.js';

const TEAM = 'team-eng';
const ATTACHMENT = '0192f0c1-7e5a-7b3c-9d4e-000000000901';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';

const creator = userActor({ userId: 'u-iris', role: 'member', memberships: [] });
const teammate = userActor({
  userId: 'u-ada',
  role: 'member',
  memberships: [{ teamId: TEAM, private: false }],
});
const outsider = userActor({
  userId: 'u-bob',
  role: 'member',
  memberships: [{ teamId: 'team-des', private: false }],
});

// The replica as the command refs read it: the focused attachment's row.
const store = {
  pool: {
    get: (model: unknown, id: string) =>
      model === Attachment && id === ATTACHMENT
        ? { id: ATTACHMENT, teamId: TEAM, creatorId: 'u-iris' }
        : undefined,
  },
} as unknown as SyncStore;

function offered(ctx: CommandContext, registered: readonly CommandId[]): string[] {
  const commands = new CommandRegistry(() => undefined);
  for (const id of registered) commands.register(id, { run: vi.fn() });
  const source = operationSource(realRegistry, commands, OPERATION_COMMANDS);
  return rankCommands(source(ctx), '', ctx, noBoost)
    .flatMap((section) => section.items.map((item) => item.command.title))
    .filter((title) => /attach|link any url/i.test(title));
}

const onIssue = (actor = teammate) =>
  context({ actor, store, target: { kind: 'issue', ids: [ISSUE], label: 'ENG-42' } });
const onAttachment = (actor = teammate) =>
  context({
    actor,
    store,
    target: { kind: 'attachment', ids: [ATTACHMENT], label: 'Attachment: design.pdf' },
  });

describe('attachment commands (§7)', () => {
  it('offers "Attach file…" and "Link any URL to issue…" on an issue the page can change', () => {
    expect(offered(onIssue(), ['issue-page:attach-file', 'issue-page:link-url'])).toEqual(
      expect.arrayContaining(['Attach file…', 'Link any URL to issue…']),
    );
    // A read-only page registers neither, so neither is offered.
    expect(offered(onIssue(), [])).toEqual([]);
  });

  it('offers Rename and Remove on a focused attachment to its creator, its team and Admins', () => {
    const forms: CommandId[] = ['attachment:rename', 'attachment:remove'];
    for (const actor of [creator, teammate, admin]) {
      expect(offered(onAttachment(actor), forms)).toEqual(
        expect.arrayContaining(['Rename attachment…', 'Remove attachment']),
      );
    }
    expect(offered(onAttachment(outsider), forms)).toEqual([]);
  });

  it('does not offer attachment commands on an issue, nor issue ones on an attachment', () => {
    const all: CommandId[] = [
      'issue-page:attach-file',
      'issue-page:link-url',
      'attachment:rename',
      'attachment:remove',
    ];
    expect(offered(onIssue(), all)).not.toContain('Remove attachment');
    expect(offered(onAttachment(), all)).not.toContain('Attach file…');
  });
});

describe('acting on a focused attachment (§7)', () => {
  function appTitles(ctx: CommandContext): string[] {
    const commands = new CommandRegistry(() => undefined);
    const ids: CommandId[] = ['attachment:open', 'attachment:download', 'attachment:copy-link'];
    for (const id of ids) {
      commands.register(id, { run: vi.fn() });
    }
    return rankCommands(appSource(commands)(ctx), '', ctx, noBoost).flatMap((section) =>
      section.items.map((item) => item.command.title),
    );
  }

  it('offers Open, Download and Copy link for the attachment, and not for the issue', () => {
    expect(appTitles(onAttachment())).toEqual(
      expect.arrayContaining(['Open attachment', 'Download attachment', 'Copy link to attachment']),
    );
    expect(appTitles(onIssue())).not.toContain('Open attachment');
  });
});
