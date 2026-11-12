// PLAN-010 S2, SPEC-010 AC-23 (for "Add status…"): the entry passes `checkOperationCommands`
// against the real registry; its sub-page lists the five editable categories; choosing one goes to
// the team's workflow page and leaves the add request the page takes (opening the form in that
// category with the name field focused).
import { registry, statusCreate } from '@surface/operations';
import { userActor } from '@surface/domain';
import { Team } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import { checkOperationCommands, permits } from '../src/command-menu/sources/operations.js';
import type { CommandContext } from '../src/command-menu/model.js';
import { takeAddStatus } from '../src/features/statuses/add-intent.js';
import { STATUS_COMMANDS, workflowPath } from '../src/features/statuses/commands.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';

function context(navigated: string[]): CommandContext {
  const pool = {
    get: (model: unknown, id: string) =>
      model === Team && id === 't-eng' ? { id: 't-eng', key: 'ENG' } : undefined,
  };
  return {
    route: '/team/ENG',
    target: { kind: 'team', ids: ['t-eng'], label: 'ENG' },
    actor: null,
    store: { pool } as unknown as SyncStore,
    navigate: (path) => void navigated.push(path),
    teams: () => [],
  };
}

describe('Add status… (command menu)', () => {
  it('passes the command checks with the other operation commands (AC-23)', () => {
    expect(checkOperationCommands(registry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('is a page that lists the five editable categories', () => {
    const entry = STATUS_COMMANDS['status.create'];
    if (entry === undefined || !('page' in entry)) throw new Error('status.create has no page');
    const page = entry.page(context([]), statusCreate);
    expect(page.items().map((item) => item.title)).toEqual([
      'Backlog',
      'Unstarted',
      'Started',
      'Completed',
      'Canceled',
    ]);
  });

  it('goes to the workflow page and leaves the category for its add form', () => {
    const entry = STATUS_COMMANDS['status.create'];
    if (entry === undefined || !('page' in entry)) throw new Error('status.create has no page');
    const navigated: string[] = [];
    const page = entry.page(context(navigated), statusCreate);
    const started = page.items().find((item) => item.id === 'started');
    void started?.run();
    expect(navigated).toEqual(['/settings/teams/ENG/workflow']);
    expect(takeAddStatus('DES')).toBeUndefined();
    expect(takeAddStatus('eng')).toEqual({ teamKey: 'ENG', category: 'started' });
    expect(takeAddStatus('ENG')).toBeUndefined();
  });

  it('offers nothing without a team in focus', () => {
    const entry = STATUS_COMMANDS['status.create'];
    if (entry === undefined || !('page' in entry)) throw new Error('status.create has no page');
    const ctx: CommandContext = { ...context([]), target: { kind: 'global' } };
    expect(entry.page(ctx, statusCreate).items()).toEqual([]);
  });

  it('is hidden from a non-member Member of the team and shown to members and Admins (E11)', () => {
    const entry = STATUS_COMMANDS['status.create'];
    if (entry === undefined || entry.refs === undefined)
      throw new Error('status.create has no refs');
    const as = (role: 'admin' | 'member', member: boolean): CommandContext => ({
      ...context([]),
      actor: userActor({
        userId: 'u1',
        role,
        memberships: member ? [{ teamId: 't-eng', private: false }] : [],
      }),
    });
    const allowed = (ctx: CommandContext) => permits(statusCreate, ctx, entry.refs?.(ctx) ?? {});
    expect(allowed(as('member', false))).toBe(false);
    expect(allowed(as('member', true))).toBe(true);
    expect(allowed(as('admin', false))).toBe(true);
  });

  it('builds the workflow path from the team key', () => {
    expect(workflowPath('ENG')).toBe('/settings/teams/ENG/workflow');
  });
});
