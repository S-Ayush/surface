import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CycleRef,
  IssueRef,
  LabelRef,
  parseCycleRef,
  parseIssueRef,
  parseNamedRef,
  parseTeamRef,
  parseUserRef,
  scopedTo,
  StatusRef,
  SURFACE_REF_KEY,
  SURFACE_REF_SCOPE_KEY,
  TeamRef,
  UserRef,
  UserRefIncludingInactive,
} from './refs.js';

const ID = '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e';

describe('parsing reference formats (SPEC-003 §4)', () => {
  it('reads a team ref as an id or a key in any case', () => {
    expect(parseTeamRef(ID)).toEqual({ by: 'id', id: ID });
    expect(parseTeamRef(ID.toUpperCase())).toEqual({ by: 'id', id: ID });
    expect(parseTeamRef('eng')).toEqual({ by: 'key', key: 'ENG' });
    expect(parseTeamRef(' Ops ')).toEqual({ by: 'key', key: 'OPS' });
    expect(parseTeamRef('E')).toBeUndefined();
    expect(parseTeamRef('TOOLONG')).toBeUndefined();
    expect(parseTeamRef('EN1')).toBeUndefined();
  });

  it('reads a user ref as an id, me, an email or a display name, in that order', () => {
    expect(parseUserRef(ID)).toEqual({ by: 'id', id: ID });
    expect(parseUserRef('me')).toEqual({ by: 'me' });
    expect(parseUserRef('ME')).toEqual({ by: 'me' });
    expect(parseUserRef('Alex@Example.com')).toEqual({ by: 'email', email: 'alex@example.com' });
    expect(parseUserRef('alex.kim')).toEqual({ by: 'name', name: 'alex.kim' });
    expect(parseUserRef('   ')).toBeUndefined();
  });

  it('reads a named ref as an id or a trimmed name', () => {
    expect(parseNamedRef(ID)).toEqual({ by: 'id', id: ID });
    expect(parseNamedRef(' In Progress ')).toEqual({ by: 'name', name: 'In Progress' });
    expect(parseNamedRef('')).toBeUndefined();
  });

  it('reads an issue ref as an id or an identifier', () => {
    expect(parseIssueRef('eng-42')).toEqual({ by: 'identifier', key: 'ENG', number: 42 });
    expect(parseIssueRef(ID)).toEqual({ by: 'id', id: ID });
    expect(parseIssueRef('ENG-0')).toBeUndefined();
    expect(parseIssueRef('ENG')).toBeUndefined();
  });

  it('reads a cycle ref as an id, a number or a relative cycle', () => {
    expect(parseCycleRef(3)).toEqual({ by: 'number', number: 3 });
    expect(parseCycleRef('12')).toEqual({ by: 'number', number: 12 });
    expect(parseCycleRef('Current')).toEqual({ by: 'relative', which: 'current' });
    expect(parseCycleRef(0)).toBeUndefined();
    expect(parseCycleRef('last')).toBeUndefined();
  });
});

describe('reference schemas', () => {
  it('accept every documented format and keep the value as written', () => {
    expect(TeamRef.parse('eng')).toBe('eng');
    expect(UserRef.parse('me')).toBe('me');
    expect(StatusRef.parse('In Progress')).toBe('In Progress');
    expect(IssueRef.parse('ENG-123')).toBe('ENG-123');
    expect(CycleRef.parse('next')).toBe('next');
    expect(CycleRef.parse(4)).toBe(4);
  });

  it('reject malformed values with a message that says what to use', () => {
    const result = TeamRef.safeParse('engineering');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Use a team key like ENG, or a team id');
    expect(IssueRef.safeParse('ENG123').error?.issues[0]?.message).toBe(
      'Use an issue identifier like ENG-123, or an issue id',
    );
  });

  it('carry their type, formats and scope in the JSON Schema', () => {
    const json = z.toJSONSchema(
      z.object({
        team: TeamRef,
        status: StatusRef,
        label: LabelRef,
        user: UserRefIncludingInactive,
      }),
    );
    expect(json.properties?.team).toMatchObject({
      [SURFACE_REF_KEY]: 'TeamRef',
      description: 'Team key like ENG (any case), or a team id',
    });
    expect(json.properties?.status).toMatchObject({
      [SURFACE_REF_KEY]: 'StatusRef',
      [SURFACE_REF_SCOPE_KEY]: 'team',
    });
    expect(json.properties?.user).toMatchObject({
      [SURFACE_REF_KEY]: 'UserRef',
      'x-surface-ref-allow-inactive': true,
    });
  });

  it('scopedTo points a scoped ref at another field and keeps the rest', () => {
    const json = z.toJSONSchema(z.object({ status: scopedTo(StatusRef, 'toTeam') }));
    expect(json.properties?.status).toMatchObject({
      [SURFACE_REF_KEY]: 'StatusRef',
      [SURFACE_REF_SCOPE_KEY]: 'toTeam',
    });
    // The original is unchanged.
    expect(z.toJSONSchema(StatusRef)).toMatchObject({ [SURFACE_REF_SCOPE_KEY]: 'team' });
  });
});
