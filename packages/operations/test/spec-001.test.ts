// SPEC-001 AC-16 (PLAN-001 S9): every operation of SPEC-001 §6.2 is registered, public, of the kind
// the spec gives, and passes the registry lint (summary, keywords, an example, a permission; the
// registry-wide run is `lint.test.ts`). Every one is built (PLAN-001 S9 part 2): the pending lists
// the earlier slices kept are gone.
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
 * Command-menu entries PLAN-001 S9 names (SPEC-005 §4.1), and the two the S8 follow-up added once
 * leave and remove could predict (2026-11-12). A title ends with "…" when the command opens a
 * form or picker.
 */
const COMMANDS: readonly (readonly [string, string])[] = [
  ['team.create', 'Create team…'],
  ['team.join', 'Join team'],
  ['team.update', 'Rename team…'],
  ['team.leave', 'Leave team…'],
  ['team.removeMember', 'Remove member…'],
  ['invite.create', 'Invite member…'],
];

const registered = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));

describe('SPEC-001 operations (AC-16)', () => {
  it.each(SPEC_001_OPERATIONS)(
    'registers %s as a public %s that passes the registry lint',
    (name, kind) => {
      const op = registered.get(name);
      expect(op, `${name} is not registered`).toBeDefined();
      if (!op) return;
      expect([op.kind, op.internal ?? false]).toEqual([kind, false]);
      expect(lintOperations([op])).toEqual([]);
    },
  );

  it('flags team.removeMember as destructive, for API keys (SPEC-001 §6.2)', () => {
    expect(registered.get('team.removeMember')?.destructive).toBe(true);
  });

  it('flags what can log a person out everywhere as destructive, for API keys (S6 review)', () => {
    expect(registered.get('session.revokeOthers')?.destructive).toBe(true);
    expect(registered.get('user.changePassword')?.destructive).toBe(true);
    // One session, named by id, is not "everywhere".
    expect(registered.get('session.revoke')?.destructive).toBe(false);
  });

  it.each(COMMANDS)('offers %s in the command menu as "%s"', (name, title) => {
    expect(registered.get(name)?.ui?.title).toBe(title);
  });
});
