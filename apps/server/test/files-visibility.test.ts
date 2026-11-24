// PLAN-014 S1, SPEC-014 §4.2 (AC-5 builder side, E16): the one statement every read of a file goes
// through, compiled as Postgres would receive it. The same cells run against real Postgres in
// `files-leak.int.test.ts`. S1 has the branches that need no `issues` table; S4a adds the issue
// branch (an owned file is its issue's) and the detached-file lookup of an undo (D28).
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  fileReaderOf,
  fileVisibilityBranches,
  reattachableFileQuery,
  visibleFileQuery,
  type FileReader,
} from '../src/files/store.js';

const FILE = '01930000-0000-7000-8000-0000000000f1';
const ADA = '01930000-0000-7000-8000-00000000ada1';

const session: FileReader = { userId: ADA, groups: ['workspace', `user:${ADA}`], keyTeamIds: null };
const TEAM = '01930000-0000-7000-8000-0000000000e1';
const narrowedKey: FileReader = { ...session, keyTeamIds: [TEAM] };

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
    expect(text).not.toContain(TEAM);
    expect(text).not.toContain(`user:${ADA}`);
    // The file, the M0 uploader, then the issue branch's groups and key teams.
    expect(params).toEqual([FILE, ADA, session.groups, [TEAM]]);
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

    /** The branch that admits a file an issue owns. */
    const issueBranch = (reader: FileReader) => {
      const found = branches(reader).filter((branch) => branch.text.includes('FROM issues i'));
      expect(found).toHaveLength(1);
      const [branch] = found;
      if (branch === undefined) throw new Error('no issue branch');
      return branch;
    };

    it('owned file: whoever sees its issue, by the issue’s sync groups, in every lifecycle state', () => {
      for (const reader of [session, narrowedKey]) {
        const branch = issueBranch(reader);
        expect(branch.text).toContain("s.purpose IN ('attachment', 'inline')");
        expect(branch.text).toContain('s.issue_id IS NOT NULL');
        expect(branch.text).toContain('i.id = s.issue_id');
        expect(branch.text).toContain('i.sync_groups && $1::text[]');
        expect(branch.params[0]).toEqual(reader.groups);
        // Archived and deleted issues stay readable (§4.2): the branch never reads their state.
        expect(branch.text).not.toMatch(/archived_at|deleted_at/);
      }
    });

    it('owned file: a key limited to some teams sees only those teams’ issues', () => {
      expect(issueBranch(session).text).not.toContain('i.team_id');
      const keyed = issueBranch(narrowedKey);
      expect(keyed.text).toContain('i.team_id = ANY($2::uuid[])');
      expect(keyed.params).toEqual([narrowedKey.groups, [TEAM]]);
    });

    it('owned file: no uploader exception (E16)', () => {
      // The only branch that names the uploader for an attachment or inline file needs it
      // unclaimed, so once an issue owns it, being its uploader gives nothing.
      for (const branch of branches(session)) {
        if (branch.text.includes("'attachment'") && branch.text.includes('uploader_id')) {
          expect(branch.text).toContain('s.issue_id IS NULL');
        }
      }
      expect(issueBranch(session).text).not.toContain('uploader_id');
    });

    it('detached file: nobody, its uploader and the issue’s readers included (E8)', () => {
      expect(issueBranch(session).text).toContain('s.detached_at IS NULL');
      for (const branch of branches(session)) {
        if (branch.text.includes("'attachment'") && !branch.text.includes('s.issue_id IS NULL')) {
          expect(branch.text).toContain('s.detached_at IS NULL');
        }
      }
    });

    it('preview: follows its source through the issue branch, so an invisible source hides it', () => {
      // `s` is the preview's source; the issue branch tests only `s`.
      expect(issueBranch(session).text).not.toContain('f.');
    });

    it('a preview never passes the unclaimed branch, and no branch admits one by its own purpose', () => {
      for (const branch of unclaimedBranches(session)) {
        expect(branch.text).toContain('f.preview_of IS NULL');
      }
      for (const branch of branches(session)) expect(branch.text).not.toContain("'preview'");
    });
  });
});

describe('the detached-file lookup of an undo (SPEC-014 §3.5, D28)', () => {
  function compileReattach(reader: FileReader) {
    const { sql, params } = new PgDialect().sqlToQuery(reattachableFileQuery(FILE, reader));
    return { text: sql.replace(/\s+/g, ' '), params };
  }

  it('finds only a detached attachment file of an issue the reader sees', () => {
    const { text, params } = compileReattach(session);
    expect(text).toContain("f.purpose = 'attachment'");
    expect(text).toContain('f.detached_at IS NOT NULL');
    expect(text).toContain('i.id = f.issue_id AND i.sync_groups && $2::text[]');
    expect(params).toEqual([FILE, session.groups]);
  });

  it('narrows by a key’s teams like the issue branch', () => {
    const { text, params } = compileReattach(narrowedKey);
    expect(text).toContain('i.team_id = ANY($3::uuid[])');
    expect(params).toEqual([FILE, narrowedKey.groups, [TEAM]]);
  });

  it('is never part of the download rule', () => {
    expect(compile(session).text).not.toContain('detached_at IS NOT NULL');
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
