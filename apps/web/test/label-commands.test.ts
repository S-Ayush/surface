// PLAN-010 S3, SPEC-010 §7.3: the "Create label…" entry passes `checkOperationCommands` against the
// real registry; its sub-page lists the focused team and the workspace (only the workspace without
// a team); choosing one goes to that labels page and leaves the request the page takes; and the
// entry is hidden from someone who may not create labels in the focused team.
import { labelCreate, registry } from '@surface/operations';
import { userActor } from '@surface/domain';
import { Team } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import { checkOperationCommands, permits } from '../src/command-menu/sources/operations.js';
import type { CommandContext } from '../src/command-menu/model.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { takeCreateLabel } from '../src/features/labels/add-intent.js';
import { LABEL_COMMANDS, labelsPath } from '../src/features/labels/commands.js';

function context(navigated: string[], global = false): CommandContext {
  const pool = {
    get: (model: unknown, id: string) =>
      model === Team && id === 't-eng'
        ? { id: 't-eng', key: 'ENG', name: 'Engineering' }
        : undefined,
  };
  return {
    route: '/team/ENG',
    target: global ? { kind: 'global' } : { kind: 'team', ids: ['t-eng'], label: 'ENG' },
    actor: null,
    store: { pool } as unknown as SyncStore,
    navigate: (path) => void navigated.push(path),
    teams: () => [],
  };
}

function pageOf(ctx: CommandContext) {
  const entry = LABEL_COMMANDS['label.create'];
  if (entry === undefined || !('page' in entry)) throw new Error('label.create has no page');
  return entry.page(ctx, labelCreate);
}

describe('Create label… (command menu)', () => {
  it('passes the command checks with the other operation commands', () => {
    expect(checkOperationCommands(registry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('lists the focused team and the workspace', () => {
    expect(
      pageOf(context([]))
        .items()
        .map((item) => item.title),
    ).toEqual(['ENG', 'Workspace']);
  });

  it('lists only the workspace without a team in focus', () => {
    expect(
      pageOf(context([], true))
        .items()
        .map((item) => item.title),
    ).toEqual(['Workspace']);
  });

  it("goes to the team's labels page and leaves the request for its form", () => {
    const navigated: string[] = [];
    void pageOf(context(navigated))
      .items()
      .find((item) => item.id === 'ENG')
      ?.run();
    expect(navigated).toEqual(['/settings/teams/ENG/labels']);
    expect(takeCreateLabel('DES')).toBe(false);
    expect(takeCreateLabel('eng')).toBe(true);
    expect(takeCreateLabel('ENG')).toBe(false);
  });

  it('goes to the workspace labels page for the workspace', () => {
    const navigated: string[] = [];
    void pageOf(context(navigated))
      .items()
      .find((item) => item.id === 'workspace')
      ?.run();
    expect(navigated).toEqual(['/settings/labels']);
    expect(takeCreateLabel('ENG')).toBe(false);
    expect(takeCreateLabel('workspace')).toBe(true);
  });

  it('is hidden from a non-member of the focused team, shown to members and Admins', () => {
    const entry = LABEL_COMMANDS['label.create'];
    if (entry === undefined || entry.refs === undefined)
      throw new Error('label.create has no refs');
    const as = (role: 'admin' | 'member', member: boolean): CommandContext => ({
      ...context([]),
      actor: userActor({
        userId: 'u1',
        role,
        memberships: member ? [{ teamId: 't-eng', private: false }] : [],
      }),
    });
    const allowed = (ctx: CommandContext) => permits(labelCreate, ctx, entry.refs?.(ctx) ?? {});
    expect(allowed(as('member', false))).toBe(false);
    expect(allowed(as('member', true))).toBe(true);
    expect(allowed(as('admin', false))).toBe(true);
  });

  it('builds the labels paths', () => {
    expect(labelsPath()).toBe('/settings/labels');
    expect(labelsPath('ENG')).toBe('/settings/teams/ENG/labels');
  });
});
