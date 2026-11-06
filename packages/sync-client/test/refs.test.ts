/**
 * Client reference resolvers (SPEC-003 §4, PLAN-002 S8), against fixture
 * models until PLAN-001 lands. Each case mirrors a rule of the server
 * resolvers, so a reference means the same row on both sides.
 */
import { describe, expect, it } from 'vitest';
import { ObjectPool } from '../src/pool.js';
import { createClientRefResolver, poolRefSource } from '../src/refs.js';
import { id } from './support/models.js';
import { REF_FIXTURE_MODELS } from './support/ref-models.js';

const ENG = id(1);
const DES = id(2);

function fixture() {
  const pool = new ObjectPool(REF_FIXTURE_MODELS);
  const load = (model: string, rows: Record<string, unknown>[]) =>
    pool.loadBase(
      model,
      rows.map((row, i) => ({
        row: { id: id(100 * (model.length + 1) + i), ...row },
        archived: false,
      })),
    );
  pool.loadBase('Team', [
    { row: { id: ENG, key: 'ENG', name: 'Engineering', private: false }, archived: false },
    { row: { id: DES, key: 'DES', name: 'Design', private: false }, archived: false },
  ]);
  load('User', [
    { email: 'ada@surface.test', name: 'Ada', displayName: 'Ada', role: 'member', active: true },
    { email: 'sam@surface.test', name: 'Sam A', displayName: 'Sam', role: 'member', active: true },
    { email: 'sam2@surface.test', name: 'Sam B', displayName: 'sam', role: 'member', active: true },
    { email: 'kim@surface.test', name: 'Kim', displayName: 'Kim', role: 'member', active: false },
    { email: 'lee@surface.test', name: 'Lee', displayName: 'Lee', role: 'member', active: true },
    { email: 'lee2@surface.test', name: 'Lee 2', displayName: 'LEE', role: 'member', active: true },
  ]);
  load('WorkflowStatus', [
    { teamId: ENG, name: 'In Progress', category: 'started' },
    { teamId: DES, name: 'In Progress', category: 'started' },
    { teamId: ENG, name: 'Done', category: 'completed' },
  ]);
  load('Label', [
    { teamId: null, parentId: null, name: 'Bug', isGroup: false },
    { teamId: ENG, parentId: null, name: 'Bug', isGroup: false },
    { teamId: null, parentId: null, name: 'Feature', isGroup: false },
    { teamId: DES, parentId: null, name: 'Polish', isGroup: false },
  ]);
  const me = id(500); // Ada: users get ids from 500
  const resolver = createClientRefResolver(poolRefSource(pool), () => me);
  const name = (
    type: Parameters<typeof resolver.resolve>[0],
    value: string,
    scopeTeamId?: string,
  ) => {
    const result = resolver.resolve(type, value, scopeTeamId ? { scopeTeamId } : {});
    if (result.status === 'found') return String(result.entity.key ?? result.entity.name);
    if (result.status === 'ambiguous')
      return result.candidates.map((c) => String(c.email ?? c.name));
    return result.status;
  };
  return { pool, resolver, name, me };
}

describe('client reference resolvers', () => {
  it('resolves teams by key in any case, or by id', () => {
    const { name } = fixture();
    expect(name('TeamRef', 'eng')).toBe('ENG');
    expect(name('TeamRef', DES)).toBe('DES');
    expect(name('TeamRef', 'OPS')).toBe('notFound');
    expect(name('TeamRef', 'not a key')).toBe('notFound');
  });

  it('resolves users by id, me, email or display name, active ones only', () => {
    const { name, resolver } = fixture();
    expect(name('UserRef', 'me')).toBe('Ada');
    expect(name('UserRef', 'ADA@surface.test')).toBe('Ada');
    expect(name('UserRef', 'ada')).toBe('Ada');
    expect(name('UserRef', 'Kim')).toBe('notFound');
    expect(resolver.resolve('UserRef', 'Kim', { allowInactive: true }).status).toBe('found');
  });

  it('prefers the one exact-case name, and lists candidates when that does not settle it', () => {
    const { name } = fixture();
    expect(name('UserRef', 'sam')).toBe('Sam B');
    expect(name('UserRef', 'Sam')).toBe('Sam A');
    expect(name('UserRef', 'lEE')).toEqual(['lee2@surface.test', 'lee@surface.test']);
  });

  it('resolves statuses only within the scope team', () => {
    const { name, resolver } = fixture();
    const inEng = resolver.resolve('StatusRef', 'in progress', { scopeTeamId: ENG });
    expect(inEng.status === 'found' && inEng.entity.teamId).toBe(ENG);
    expect(name('StatusRef', 'Done', DES)).toBe('notFound');
    expect(name('StatusRef', 'Done')).toBe('notFound'); // no team: like the server's "needs a team"
    if (inEng.status !== 'found') throw new Error('expected a status');
    expect(name('StatusRef', inEng.entity.id, DES)).toBe('notFound');
  });

  it("prefers the team's label, and without a team sees only workspace labels", () => {
    const { resolver, name } = fixture();
    const bug = resolver.resolve('LabelRef', 'bug', { scopeTeamId: ENG });
    expect(bug.status === 'found' && bug.entity.teamId).toBe(ENG);
    const workspaceBug = resolver.resolve('LabelRef', 'Bug');
    expect(workspaceBug.status === 'found' && workspaceBug.entity.teamId).toBe(null);
    expect(name('LabelRef', 'Feature', DES)).toBe('Feature');
    expect(name('LabelRef', 'Polish', ENG)).toBe('notFound');
    expect(name('LabelRef', 'Polish')).toBe('notFound');
  });

  it('finds nothing for reference types whose models do not exist yet', () => {
    const { resolver } = fixture();
    expect(resolver.resolve('IssueRef', 'ENG-1').status).toBe('notFound');
    const bare = createClientRefResolver(poolRefSource(new ObjectPool([])), () => undefined);
    expect(bare.resolve('TeamRef', 'ENG').status).toBe('notFound');
    expect(bare.resolve('UserRef', 'me').status).toBe('notFound');
  });

  it('follows the replica as it changes', () => {
    const { pool, name } = fixture();
    pool.applyBase([{ kind: 'delete', model: 'Team', id: DES }]);
    expect(name('TeamRef', 'DES')).toBe('notFound');
  });
});
