// The shell's read models: the user's teams in sidebar order, the actor the command menu checks
// permissions with (live from the store), /team/:key lookup, and SPEC-005 E5.
import { describe, expect, it } from 'vitest';
import {
  actorOf,
  myTeams,
  teamByKey,
  lostTeamMessage,
  observeTeam,
  type TeamView,
  type MembershipRow,
  type TeamRow,
} from '../src/app/workspace.js';

const teams: TeamRow[] = [
  { id: 't-eng', key: 'ENG', name: 'Engineering', private: false },
  { id: 't-des', key: 'DES', name: 'Design', private: false },
  { id: 't-sec', key: 'SEC', name: 'Security', private: true },
  { id: 't-old', key: 'OLD', name: 'Archive me', private: false, $archived: true },
];
const memberships: MembershipRow[] = [
  { teamId: 't-eng', userId: 'u1' },
  { teamId: 't-sec', userId: 'u1' },
  { teamId: 't-old', userId: 'u1' },
  { teamId: 't-des', userId: 'u2' },
  { teamId: 't-des', userId: 'u1', $archived: true },
];

describe('shell read models', () => {
  it('lists the user’s live teams by name', () => {
    expect(myTeams(teams, memberships, 'u1').map((t) => t.key)).toEqual(['ENG', 'SEC']);
    expect(myTeams(teams, memberships, 'u2').map((t) => t.key)).toEqual(['DES']);
    expect(myTeams(teams, memberships, 'nobody')).toEqual([]);
  });

  it('builds the actor from the user row and live memberships', () => {
    const actor = actorOf({ id: 'u1', role: 'member', active: true }, teams, memberships);
    expect(actor).toMatchObject({ userId: 'u1', role: 'member', memberOf: ['t-eng', 't-sec'] });
    // Every public team, joined or not, archived too, as the server's session says (SPEC-011 §5.6).
    expect(actor?.publicTeams).toEqual(['t-eng', 't-des', 't-old']);
    expect(actorOf({ id: 'u1', role: 'admin', active: true }, teams, memberships)?.role).toBe(
      'admin',
    );
    expect(actorOf({ id: 'u1', role: 'admin', active: false }, teams, memberships)).toBeNull();
    expect(actorOf(undefined, teams, memberships)).toBeNull();
  });

  it('finds a team by key in any case, never an archived one', () => {
    expect(teamByKey(teams, 'eng')?.id).toBe('t-eng');
    expect(teamByKey(teams, 'OLD')).toBeUndefined();
    expect(teamByKey(teams, 'NOPE')).toBeUndefined();
  });
});

describe('E5: losing a team while viewing it', () => {
  /** Runs the page's observations in order, as renders would, and returns each state. */
  const run = (steps: readonly (readonly [key: string, present: boolean])[]) => {
    let view: TeamView | null = null;
    return steps.map(([key, present]) => {
      const next = observeTeam(view, key, present);
      view = next.view;
      return next.state;
    });
  };

  it('goes "lost" when a team the page has shown disappears', () => {
    expect(
      run([
        ['ENG', true],
        ['ENG', true],
        ['ENG', false],
      ]),
    ).toEqual(['show', 'show', 'lost']);
  });

  it('shows not-found for a team that was never visible', () => {
    expect(
      run([
        ['SEC', false],
        ['SEC', false],
      ]),
    ).toEqual(['not-found', 'not-found']);
  });

  it('starts over when the page moves to another team', () => {
    expect(
      run([
        ['ENG', true],
        ['DES', true],
      ]),
    ).toEqual(['show', 'show']);
    expect(
      run([
        ['ENG', true],
        ['DES', false],
      ]),
    ).toEqual(['show', 'not-found']);
    expect(
      run([
        ['ENG', true],
        ['DES', true],
        ['DES', false],
      ]),
    ).toEqual(['show', 'show', 'lost']);
  });

  it('treats the URL key in any case as the same team', () => {
    expect(
      run([
        ['eng', true],
        ['ENG', false],
      ]),
    ).toEqual(['show', 'lost']);
  });

  it('names the team in the toast by its key', () => {
    expect(lostTeamMessage('eng')).toBe('You no longer have access to ENG');
  });
});
