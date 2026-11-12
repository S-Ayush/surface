// SPEC-001 AC-16 (PLAN-001 S9): every operation of SPEC-001 §6.2 is registered, public, of the kind
// the spec gives, and passes the registry lint (summary, keywords, an example, a permission; the
// registry-wide run is `lint.test.ts`). Operations whose slice hasn't landed are listed as pending,
// and the test fails once one is registered, so the list can't go stale.
import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS, type AnyOperation } from '../src/index.js';
import { lintOperations } from '../src/lint.js';

type Kind = AnyOperation['kind'];

/** SPEC-001 §6.2, in its order. */
const SPEC_001_OPERATIONS: readonly (readonly [string, Kind])[] = [
  ['workspace.get', 'query'],
  ['workspace.update', 'mutation'],
  ['user.me', 'query'],
  ['user.list', 'query'],
  ['user.get', 'query'],
  ['user.updateProfile', 'mutation'],
  ['user.changePassword', 'mutation'],
  ['user.setRole', 'mutation'],
  ['user.createResetLink', 'mutation'],
  ['session.list', 'query'],
  ['session.revoke', 'mutation'],
  ['session.revokeOthers', 'mutation'],
  ['invite.create', 'mutation'],
  ['invite.list', 'query'],
  ['invite.revoke', 'mutation'],
  ['team.create', 'mutation'],
  ['team.update', 'mutation'],
  ['team.join', 'mutation'],
  ['team.leave', 'mutation'],
  ['team.addMember', 'mutation'],
  ['team.removeMember', 'mutation'],
  ['team.suggestKey', 'query'],
];

/**
 * Not built yet, with the PLAN-001 slice that adds each (session E). Remove an entry in the change
 * that registers the operation.
 */
const PENDING: Readonly<Record<string, string>> = {};

/**
 * Command-menu entries PLAN-001 S9 names (SPEC-005 §4.1). A title ends with "…" when the command
 * opens a form or picker. Pending ones are added by the slice that owns the operation.
 */
const COMMANDS: readonly (readonly [string, string])[] = [
  ['team.create', 'Create team…'],
  ['team.join', 'Join team'],
  ['team.update', 'Rename team…'],
  ['invite.create', 'Invite member…'],
];
const COMMANDS_PENDING: Readonly<Record<string, string>> = {};

const registered = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));
const built = SPEC_001_OPERATIONS.filter(([name]) => PENDING[name] === undefined);

describe('SPEC-001 operations (AC-16)', () => {
  it('lists only operations of SPEC-001 §6.2 as pending', () => {
    const names = new Set(SPEC_001_OPERATIONS.map(([name]) => name));
    expect(Object.keys(PENDING).filter((name) => !names.has(name))).toEqual([]);
  });

  it.each(built)('registers %s as a public %s that passes the registry lint', (name, kind) => {
    const op = registered.get(name);
    expect(op, `${name} is not registered`).toBeDefined();
    if (!op) return;
    expect([op.kind, op.internal ?? false]).toEqual([kind, false]);
    expect(lintOperations([op])).toEqual([]);
  });

  it('flags team.removeMember as destructive, for API keys (SPEC-001 §6.2)', () => {
    expect(registered.get('team.removeMember')?.destructive).toBe(true);
  });

  it('flags what can log a person out everywhere as destructive, for API keys (S6 review)', () => {
    expect(registered.get('session.revokeOthers')?.destructive).toBe(true);
    expect(registered.get('user.changePassword')?.destructive).toBe(true);
    // One session, named by id, is not "everywhere".
    expect(registered.get('session.revoke')?.destructive).toBe(false);
  });

  it.each(Object.entries(PENDING))(
    'has no %s yet (PLAN-001 %s): once it is registered, remove it from PENDING',
    (name) => {
      expect(registered.has(name)).toBe(false);
    },
  );

  it.each(COMMANDS.filter(([name]) => COMMANDS_PENDING[name] === undefined))(
    'offers %s in the command menu as "%s"',
    (name, title) => {
      expect(registered.get(name)?.ui?.title).toBe(title);
    },
  );

  it.each(Object.entries(COMMANDS_PENDING))(
    'has no command for %s yet (%s): once it has one, remove it from COMMANDS_PENDING',
    (name) => {
      expect(registered.get(name)?.ui).toBeUndefined();
    },
  );
});
