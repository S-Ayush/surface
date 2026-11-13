// PLAN-013 S3, SPEC-013 §4.1, §4.2, §5.1, D12: the Comment and Reaction models as both sides
// register them (one schema hash, content models of parent Issue), their tables (no undeclared
// column, no cascade from a synced table), and their groups: `team:<teamId>` only, taken from the
// issue row, never the issue's `user:` groups. The per-model column checks of
// workspace-models.test.ts run on these two models too.
import { teamGroup, userGroup } from '@surface/domain';
import { Comment, PRODUCTION_MODELS, Reaction } from '@surface/domain/model';
import { computeSchemaHash } from '@surface/sync-protocol';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { comments, commentSearchText, reactions } from '../src/db/schema/index.js';
import { SYNCED_MODELS } from '../src/sync/models.js';
import { syncRegistry } from '../src/sync/registry.js';
import { scriptedDb, type Row } from './support/scripted-db.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const AT = '2026-11-01T09:00:00.000Z';
const ENG = '0190f0c0-0000-7000-8000-00000000e000';
const OTHER = '0190f0c0-0000-7000-8000-00000000f000';
const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const IRIS = '0190f0c0-0000-7000-8000-0000000000a2';
const COMMENT = '0190f0c0-0000-7000-8000-000000000701';
const REACTION = '0190f0c0-0000-7000-8000-000000000801';

describe('the comment models', () => {
  const production = syncRegistry({ includeFixtures: false });

  it('are registered on both sides, so the client and the server compute one schema hash', () => {
    for (const def of [Comment, Reaction]) {
      expect(PRODUCTION_MODELS).toContain(def);
      expect(Object.values(SYNCED_MODELS).some((entry) => entry.def === def)).toBe(true);
    }
    expect(production.schemaHash).toBe(computeSchemaHash(PRODUCTION_MODELS));
  });

  it('load per issue as content of their Issue, never in the bootstrap', () => {
    for (const def of [Comment, Reaction]) {
      expect(def.load).toBe('content');
      expect(def.parent).toEqual({ model: 'Issue', field: 'issueId' });
      expect(production.content.map((m) => m.name)).toContain(def.name);
      expect(production.eager.map((m) => m.name)).not.toContain(def.name);
    }
  });

  it('keep the plain search text in a server-only table, never in a model field (D2)', () => {
    expect(Object.keys(Comment.fields)).not.toContain('bodyText');
    const synced = Object.values(SYNCED_MODELS).map((entry) => getTableName(entry.table));
    expect(synced).not.toContain(getTableName(commentSearchText));
  });
});

describe('the comment tables (§4.6)', () => {
  it('restrict every delete from a synced table: no cascade skips sync_log', () => {
    for (const table of [comments, reactions]) {
      const keys = getTableConfig(table).foreignKeys;
      expect(keys.length).toBeGreaterThan(0);
      for (const fk of keys) expect(fk.onDelete, fk.getName()).toBe('restrict');
    }
    // The one cascade: the server-only search text follows its comment.
    expect(getTableConfig(commentSearchText).foreignKeys.map((fk) => fk.onDelete)).toEqual([
      'cascade',
    ]);
  });

  it('check the actor kind, the version and the resolved fields in the database', () => {
    expect(getTableConfig(comments).checks.map((c) => c.name)).toEqual([
      'comments_actor_kind_check',
      'comments_version_check',
      'comments_resolved_check',
      'comments_reply_resolved_check',
    ]);
  });
});

describe('comment and reaction groups (SPEC-013 D12)', () => {
  // A public team's issue as PLAN-011 S4b stores it: its team, its creator's and assignee's groups.
  const issueRow: Row = {
    id: ISSUE,
    team_id: ENG,
    number: 1,
    title: 'Fix login',
    assignee_id: IRIS,
    creator_id: ADA,
    archived_at: null,
    deleted_at: null,
    sync_groups: [teamGroup(ENG), userGroup(ADA), userGroup(IRIS)],
    created_at: AT,
    updated_at: AT,
  };

  const groupsLogged = async (
    insert: (repo: ReturnType<typeof scriptedDb>['repo']) => Promise<unknown>,
  ) => {
    const { repo } = scriptedDb({ issues: [issueRow] }, { now: NOW });
    await insert(repo);
    return repo.changes().map((c) => ({ model: c.model, groups: [...c.groups] }));
  };

  it('a comment on an assigned public-team issue is in team:<teamId> only, with the issue team', async () => {
    const { repo, rowsOf } = scriptedDb({ issues: [issueRow] }, { now: NOW });
    const row = await repo.insert('Comment', {
      id: COMMENT,
      issueId: ISSUE,
      // A handler's teamId is never trusted: the repo takes the issue row's (SPEC-011 §5.1).
      teamId: OTHER,
      parentCommentId: null,
      userId: ADA,
      actorKind: 'user',
      body: { type: 'doc', content: [{ type: 'paragraph' }] },
      version: 1,
    });
    expect(row.teamId).toBe(ENG);
    // Drizzle sends the array as a Postgres array literal.
    expect(rowsOf('comments').get(COMMENT)?.['sync_groups']).toBe(`{"${teamGroup(ENG)}"}`);
    expect(repo.changes().map((c) => [c.model, [...c.groups]])).toEqual([
      ['Comment', [teamGroup(ENG)]],
    ]);
  });

  it('a reaction is in team:<teamId> only, too', async () => {
    expect(
      await groupsLogged((repo) =>
        repo.insert('Reaction', {
          id: REACTION,
          issueId: ISSUE,
          teamId: OTHER,
          commentId: null,
          userId: IRIS,
          emoji: '👍',
        }),
      ),
    ).toEqual([{ model: 'Reaction', groups: [teamGroup(ENG)] }]);
  });
});
