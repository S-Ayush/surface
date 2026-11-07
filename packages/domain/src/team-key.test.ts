// SPEC-001 AC-11 (suggestions), §4 key algorithm, E11 (the next suggestion after a collision).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { suggestTeamKey, teamKeyCandidates } from './team-key.js';
import { RESERVED_TEAM_KEYS, teamKeyProblem } from './workspace.js';

const taken =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);

describe('suggestTeamKey (SPEC-001 §4)', () => {
  it('takes the first three letters of a one-word name', () => {
    expect(suggestTeamKey('Engineering')).toBe('ENG');
    expect(suggestTeamKey('design')).toBe('DES');
  });

  it('takes the initials of up to three words', () => {
    expect(suggestTeamKey('Mobile Platform')).toBe('MP');
    expect(suggestTeamKey('Customer Success Operations Team')).toBe('CSO');
    expect(suggestTeamKey('front-end web')).toBe('FEW');
  });

  it('grows the key a letter at a time when it is taken (E11)', () => {
    expect(suggestTeamKey('Engineering', taken('ENG'))).toBe('ENGI');
    expect(suggestTeamKey('Engineering', taken('ENG', 'ENGI'))).toBe('ENGIN');
    expect(suggestTeamKey('Mobile Platform', taken('MP'))).toBe('MPL');
    expect(suggestTeamKey('Mobile Platform', taken('MP', 'MPL', 'MPLA', 'MPLAT'))).toBe('MOB');
  });

  it('skips reserved keys', () => {
    expect(RESERVED_TEAM_KEYS).toEqual(expect.arrayContaining(['NEW', 'API', 'SYNC']));
    expect(suggestTeamKey('Newsroom')).toBe('NEWS');
    expect(suggestTeamKey('Synchronization', taken('SYN'))).toBe('SYNCH');
    expect(suggestTeamKey('Api')).toBeUndefined();
  });

  it('drops accents, digits and symbols', () => {
    expect(suggestTeamKey('Équipe')).toBe('EQU');
    expect(suggestTeamKey('Q3 Planning')).toBe('QP');
    expect(suggestTeamKey('R&D')).toBe('RD');
  });

  it('suggests nothing when the name has too few letters, or every candidate is taken', () => {
    expect(suggestTeamKey('X')).toBeUndefined();
    expect(suggestTeamKey('42')).toBeUndefined();
    expect(suggestTeamKey('   ')).toBeUndefined();
    expect(suggestTeamKey('Ops', taken('OPS'))).toBeUndefined();
  });

  it('accepts a two-letter name as its own key', () => {
    expect(suggestTeamKey('QA')).toBe('QA');
  });
});

describe('suggestTeamKey properties', () => {
  const names = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc
      .array(fc.stringMatching(/^[A-Za-zÀ-ÿ]{1,10}$/), { minLength: 1, maxLength: 5 })
      .map((w) => w.join(' ')),
  );
  const takenKeys = fc.uniqueArray(fc.stringMatching(/^[A-Z]{2,5}$/), { maxLength: 20 });

  it('only suggests free, valid, unreserved keys made of the name’s letters', () => {
    fc.assert(
      fc.property(names, takenKeys, (name, keys) => {
        const key = suggestTeamKey(name, (k) => keys.includes(k));
        if (key === undefined) return;
        expect(teamKeyProblem(key)).toBeUndefined();
        expect(keys).not.toContain(key);
        const letters = name
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toUpperCase()
          .replace(/[^A-Z]/g, '');
        for (const char of key) expect(letters).toContain(char);
      }),
    );
  });

  it('is the first candidate that is neither taken nor reserved', () => {
    fc.assert(
      fc.property(names, takenKeys, (name, keys) => {
        const free = teamKeyCandidates(name).filter(
          (k) => !keys.includes(k) && teamKeyProblem(k) === undefined,
        );
        expect(suggestTeamKey(name, (k) => keys.includes(k))).toBe(free[0]);
      }),
    );
  });
});
