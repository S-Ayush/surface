// PLAN-014 S1, SPEC-014 §4.2 (AC-5 builder side, E16): the one statement every read of a file goes
// through, compiled as Postgres would receive it. The same cells run against real Postgres in
// `files-leak.int.test.ts`. S1 has the branches that need no `issues` table; S4a adds the issue
// branch here, one case per remaining matrix row.
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  fileReaderOf,
  fileVisibilityBranches,
  visibleFileQuery,
  type FileReader,
} from '../src/files/store.js';

const FILE = '01930000-0000-7000-8000-0000000000f1';
const ADA = '01930000-0000-7000-8000-00000000ada1';

const session: FileReader = { userId: ADA, groups: ['workspace', `user:${ADA}`], keyTeamIds: null };
const narrowedKey: FileReader = {
  ...session,
  keyTeamIds: ['01930000-0000-7000-8000-0000000000e1'],
};

function compile(reader: FileReader) {
  const { sql, params } = new PgDialect().sqlToQuery(visibleFileQuery(FILE, reader));
  return { text: sql.replace(/\s+/g, ' '), params };
}

/** Each OR-ed branch, compiled on its own (parameters numbered from $1). */
function branches(reader: FileReader): { text: string; params: unknown[] }[] {
  const dialect = new PgDialect();
  return fileVisibilityBranches(reader).map((branch) => {
    const { sql, params } = dialect.sqlToQuery(branch);
    return { text: sql.replace(/\s+/g, ' '), params };
  });
}

describe('the file visibility statement (SPEC-014 §4.2)', () => {
  it('decides by the source of a preview and the file itself otherwise', () => {
    const { text, params } = compile(session);
    expect(text).toContain('FROM files f JOIN files s ON s.id = coalesce(f.preview_of, f.id)');
    expect(text).toContain('WHERE f.id = $1 AND (');
    expect(params[0]).toBe(FILE);
  });

  it('passes every value as a parameter, never in the SQL text', () => {
    const { text, params } = compile(narrowedKey);
    expect(text).not.toContain(ADA);
    expect(text).not.toContain(FILE);
    expect(params).toEqual([FILE, ADA]);
  });

  describe('one case per matrix row', () => {
    /** The branches that admit an unclaimed upload: they test `s.issue_id IS NULL`. */
    const unclaimedBranches = (reader: FileReader) =>
      branches(reader).filter((branch) => branch.text.includes('s.issue_id IS NULL'));

    it('avatar, logo: the M0 rule, for every reader, a narrowed key included', () => {
      for (const reader of [session, narrowedKey]) {
        const m0 = branches(reader).filter((branch) => branch.text.includes("'avatar', 'logo'"));
        expect(m0).toHaveLength(1);
        const [rule] = m0;
        // Its uploader, any user naming it as their avatar, or the workspace naming it as the logo.
        expect(rule?.params).toEqual([reader.userId]);
        expect(rule?.text).toContain('u.avatar_file_id = s.id');
        expect(rule?.text).toContain('w.logo_file_id = s.id');
      }
    });

    it('unclaimed attachment or inline file: its uploader only', () => {
      const unclaimed = unclaimedBranches(session);
      expect(unclaimed).toHaveLength(1);
      expect(unclaimed[0]?.text).toContain("s.purpose IN ('attachment', 'inline')");
      expect(unclaimed[0]?.params).toEqual([session.userId]);
    });

    it('a key limited to some teams never gets the unclaimed branch', () => {
      // The matrix's key column: an unclaimed upload belongs to no team.
      expect(unclaimedBranches(narrowedKey)).toEqual([]);
    });

    it('owned file (attached, detached, archived or deleted issue): no uploader exception (E16)', () => {
      // Every branch that admits an `attachment` or `inline` file needs it unclaimed, so once an
      // issue owns it, being its uploader gives nothing. S4a adds the issue branch.
      for (const branch of branches(session)) {
        if (branch.text.includes("'attachment'")) {
          expect(branch.text).toContain('s.issue_id IS NULL');
        }
      }
      expect(compile(session).text).not.toContain('issues');
    });

    it('a preview never passes the unclaimed branch, and no branch admits one by its own purpose', () => {
      for (const branch of unclaimedBranches(session)) {
        expect(branch.text).toContain('f.preview_of IS NULL');
      }
      for (const branch of branches(session)) expect(branch.text).not.toContain("'preview'");
    });
  });
});

describe('fileReaderOf', () => {
  it('reads as the actor’s user with all its groups, narrowed only by a key with teams', () => {
    const groups = ['workspace', `user:${ADA}`];
    const publicTeams: string[] = [];
    expect(fileReaderOf({ userId: ADA, groups, publicTeams })).toEqual({
      userId: ADA,
      groups,
      keyTeamIds: null,
    });
    const key = { id: 'k', scope: 'read' as const, allowDestructive: false };
    expect(
      fileReaderOf({ userId: ADA, groups, publicTeams, apiKey: { ...key, teamIds: [] } }),
    ).toEqual({
      userId: ADA,
      groups,
      keyTeamIds: null,
    });
    expect(
      fileReaderOf({ userId: ADA, groups, publicTeams, apiKey: { ...key, teamIds: ['t'] } }),
    ).toEqual({
      userId: ADA,
      groups,
      keyTeamIds: ['t'],
    });
  });

  it('is undefined for an actor without a user, which reads no file', () => {
    expect(fileReaderOf({ groups: [], publicTeams: [] })).toBeUndefined();
  });

  it('reads with every public team’s group, which no socket needs to follow (SPEC-011 §5.6)', () => {
    const groups = ['workspace', `user:${ADA}`];
    expect(fileReaderOf({ userId: ADA, groups, publicTeams: ['t-eng'] })?.groups).toEqual([
      ...groups,
      'team:t-eng',
    ]);
  });
});
