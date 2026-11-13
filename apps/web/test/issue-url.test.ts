// SPEC-011 §4.1, AC-24 (the address part), E27, Q14 (PLAN-011 S4): any slug, or none, resolves to
// the issue and the page belongs at the canonical address; a pending issue is `/issue/<id>` until
// its number arrives; a wrong identifier is not found (E13). And the command-menu identifier fast
// path's parsing (command-menu §3.1).
import { describe, expect, it } from 'vitest';
import {
  canonicalIssuePath,
  resolveIssueAddress,
  typedIdentifier,
  type IssueAddressLookup,
  type IssueAddressRow,
} from '../src/features/issues/issue-url.js';

const ENG = { id: '0192f0c1-7e5a-7b3c-9d4e-0000000000e1', key: 'ENG' };
const ARCHIVED_TEAM = { id: '0192f0c1-7e5a-7b3c-9d4e-0000000000e9', key: 'OLD' };
const ISSUE: IssueAddressRow = {
  id: '0192f0c1-7e5a-7b3c-9d4e-0000000000b1',
  teamId: ENG.id,
  number: 42,
  title: 'Login page flickers on Safari!',
};
const PENDING: IssueAddressRow = {
  id: '0192f0c1-7e5a-7b3c-9d4e-0000000000b2',
  teamId: ENG.id,
  number: null,
  title: 'Draft',
};
const OF_ARCHIVED_TEAM: IssueAddressRow = { ...ISSUE, id: ISSUE.id.replace('b1', 'b3') };

/** The replica: ENG is live, OLD is archived, so its issues don't resolve. */
const lookup: IssueAddressLookup = {
  teamByKey: (key) => (key.toUpperCase() === 'ENG' ? ENG : undefined),
  teamById: (id) => (id === ENG.id ? ENG : undefined),
  issueById: (id) =>
    [ISSUE, PENDING, { ...OF_ARCHIVED_TEAM, teamId: ARCHIVED_TEAM.id }].find((i) => i.id === id),
  issueByNumber: (teamId, number) =>
    teamId === ISSUE.teamId && number === ISSUE.number ? ISSUE : undefined,
};

const SLUGGED = '/issue/ENG-42/login-page-flickers-on-safari';

describe('resolveIssueAddress (E27)', () => {
  it('resolves an identifier in any case, and gives the slugged address', () => {
    for (const ref of ['ENG-42', 'eng-42', 'Eng-42']) {
      expect(resolveIssueAddress(ref, lookup)).toEqual({
        kind: 'found',
        issue: ISSUE,
        identifier: 'ENG-42',
        canonical: SLUGGED,
      });
    }
  });

  it('resolves an id to the identifier address', () => {
    expect(resolveIssueAddress(ISSUE.id, lookup)).toMatchObject({ canonical: SLUGGED });
  });

  it('keeps a pending issue at /issue/<id> until its number arrives (Q14)', () => {
    expect(resolveIssueAddress(PENDING.id, lookup)).toMatchObject({
      identifier: null,
      canonical: `/issue/${PENDING.id}`,
    });
    expect(canonicalIssuePath({ ...PENDING, number: 7 }, 'ENG')).toBe('/issue/ENG-7/draft');
  });

  it('drops the slug for a title with no letters or digits', () => {
    expect(canonicalIssuePath({ ...ISSUE, title: '!!!' }, 'ENG')).toBe('/issue/ENG-42');
  });

  it('is not found for a wrong identifier, an unknown key or id, or an archived team (E13)', () => {
    for (const ref of [
      'ENG-43',
      'NOPE-42',
      'ENG',
      'ENG-0',
      ISSUE.id.replace('b1', 'ff'),
      OF_ARCHIVED_TEAM.id,
      '%E0',
    ]) {
      expect(resolveIssueAddress(ref, lookup), ref).toEqual({ kind: 'not-found' });
    }
  });
});

describe('typedIdentifier (command-menu §3.1)', () => {
  it('reads 2–5 letters, a hyphen and a number, in any case', () => {
    expect(typedIdentifier('eng-87')).toBe('ENG-87');
    expect(typedIdentifier(' Des-3 ')).toBe('DES-3');
    expect(typedIdentifier('ABCDE-1')).toBe('ABCDE-1');
  });

  it('ignores anything else', () => {
    for (const query of ['', 'eng', 'e-1', 'abcdef-1', 'eng-', 'eng-87a', 'eng 87', 'eng-0']) {
      expect(typedIdentifier(query), query).toBeUndefined();
    }
  });
});
