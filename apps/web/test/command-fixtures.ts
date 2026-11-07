// Fixture operations with `ui` metadata for command-menu tests. The real PLAN-001 operations
// (session E) take their place in the registry as they land.
import { userActor, type Actor } from '@surface/domain';
import { createRegistry, defineOperation } from '@surface/operations';
import { z } from 'zod';
import {
  GLOBAL_TARGET,
  type CommandContext,
  type CommandTarget,
} from '../src/command-menu/model.js';

const team = z.object({ team: z.string() });
const common = {
  kind: 'mutation',
  destructive: false,
  description: 'A command-menu test fixture.',
  keywords: ['fixture one', 'fixture two'],
  output: z.object({}),
} as const;

export const createTeam = defineOperation({
  ...common,
  name: 'team.create',
  domain: 'team',
  summary: 'Create a team',
  keywords: ['new team', 'add team'],
  input: z.object({ name: z.string() }),
  permission: (p) => p.admin(),
  examples: [{ name: 'Design' }],
  ui: { title: 'Create team…', icon: 'plus', contexts: ['global'] },
});

export const renameTeam = defineOperation({
  ...common,
  name: 'team.rename',
  domain: 'team',
  summary: 'Rename a team',
  keywords: ['rename team', 'change team name'],
  input: team,
  permission: (p, refs) => p.admin() || p.teamMember(refs['team']),
  examples: [{ team: 'ENG' }],
  ui: { title: 'Rename team…', icon: 'pencil', contexts: ['team'] },
});

export const colorTeam = defineOperation({
  ...common,
  name: 'team.updateColor',
  domain: 'team',
  summary: 'Change a team’s color',
  keywords: ['team colour', 'recolor team'],
  input: team,
  permission: (p, refs) => p.teamMember(refs['team']),
  examples: [{ team: 'ENG' }],
  ui: { title: 'Change team color…', icon: 'palette', contexts: ['team'], shortcut: null },
});

export const leaveWorkspace = defineOperation({
  ...common,
  name: 'user.exportData',
  domain: 'user',
  summary: 'Export your data',
  keywords: ['download my data', 'export account'],
  input: z.object({}),
  permission: (p) => p.any(),
  examples: [{}],
  ui: { title: 'Export my data', icon: 'download', contexts: ['global'], shortcut: 'Mod+Shift+E' },
});

export const hiddenInternal = defineOperation({
  ...common,
  name: 'debug.uiFixture',
  domain: 'debug',
  summary: 'Internal fixture',
  input: z.object({}),
  permission: (p) => p.any(),
  examples: [{}],
  internal: true,
  ui: { title: 'Internal thing', icon: 'bug', contexts: ['global'] },
});

export const oldRename = defineOperation({
  ...common,
  name: 'team.renameOld',
  domain: 'team',
  summary: 'Rename a team (old)',
  input: team,
  permission: (p) => p.any(),
  examples: [{ team: 'ENG' }],
  deprecated: { since: '0.1.0', replacedBy: 'team.rename' },
  ui: { title: 'Rename team (old)…', icon: 'pencil', contexts: ['team'] },
});

/** A permission that reads the operation's input, which the menu does not have yet. */
export const archiveTeams = defineOperation({
  ...common,
  name: 'team.archiveMany',
  domain: 'team',
  summary: 'Archive teams',
  input: z.object({ ids: z.array(z.string()) }),
  permission: (p, _refs, input) => input.ids.length > 0 && p.admin(),
  examples: [{ ids: ['team-eng'] }],
  ui: { title: 'Archive teams…', icon: 'archive', contexts: ['global'] },
});

export const fixtureRegistry = createRegistry([
  archiveTeams,
  createTeam,
  renameTeam,
  colorTeam,
  leaveWorkspace,
  hiddenInternal,
  oldRename,
]);

export const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
export const DES = { id: 'team-des', key: 'DES', name: 'Design' };

export const admin: Actor = userActor({ userId: 'u-admin', role: 'admin', memberships: [] });
export const member: Actor = userActor({
  userId: 'u-member',
  role: 'member',
  memberships: [{ teamId: ENG.id, private: false }],
});

export const teamTarget = (t = ENG): CommandTarget => ({ kind: 'team', ids: [t.id], label: t.key });

export function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    route: '/',
    target: GLOBAL_TARGET,
    actor: member,
    store: null,
    teams: () => [ENG, DES],
    ...overrides,
  };
}

export const noBoost = { boost: () => 1 };
