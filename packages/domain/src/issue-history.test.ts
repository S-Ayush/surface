// PLAN-011 S6, SPEC-011 §4.4: history entries and their folds (AC-5, E4, E16, E21).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createdChanges,
  CREATOR_FOLD_MS,
  DESCRIPTION_FOLD_MS,
  historyEntryFor,
  historyWrite,
  parseHistoryChanges,
  updatedChanges,
  type CreatedValues,
  type HistoryActorFacts,
  type HistoryDiff,
  type HistoryEntryFacts,
  type HistoryWriteInput,
} from './issue-history.js';

const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const BOB = '0192f0c1-7e5a-7b3c-9d4e-0000000000b0';
const KEY = '0192f0c1-7e5a-7b3c-9d4e-00000000c0de';
const ada: HistoryActorFacts = { actorKind: 'user', actorId: ADA, apiKeyId: null };
const bob: HistoryActorFacts = { actorKind: 'user', actorId: BOB, apiKeyId: null };
const adaViaKey: HistoryActorFacts = { actorKind: 'api', actorId: ADA, apiKeyId: KEY };

const backlog = { id: 's-backlog', name: 'Backlog', category: 'backlog' } as const;
const todo = { id: 's-todo', name: 'Todo', category: 'unstarted' } as const;
const done = { id: 's-done', name: 'Done', category: 'completed' } as const;
const bug = { id: 'l-bug', name: 'Bug', color: 'red' };
const ui = { id: 'l-ui', name: 'UI', color: 'blue' };
const defaults = { statusId: backlog.id };

const CREATED_AT = new Date('2026-11-16T10:00:00.000Z');
const at = (ms: number) => new Date(CREATED_AT.getTime() + ms);

const bare: CreatedValues = {
  title: 'Fix the login loop',
  status: backlog,
  priority: 0,
  assignee: null,
  labels: [],
  estimate: null,
  dueDate: null,
  descriptionEmpty: true,
};

function entry(
  fields: Partial<HistoryEntryFacts> & Pick<HistoryEntryFacts, 'kind' | 'changes'>,
): HistoryEntryFacts {
  return { id: 'h-1', ...ada, updatedAt: CREATED_AT, ...fields };
}

function input(fields: Partial<HistoryWriteInput> & Pick<HistoryWriteInput, 'diff'>) {
  return {
    latest: entry({ kind: 'created', changes: createdChanges(bare, defaults) }),
    issue: { creatorId: ADA, createdAt: CREATED_AT },
    actor: ada,
    now: at(60_000),
    defaults,
    ...fields,
  };
}

describe('created entries (§4.4)', () => {
  it('hold only { to } of the fields that differ from their defaults', () => {
    expect(createdChanges(bare, defaults)).toEqual({ title: { to: 'Fix the login loop' } });
    expect(
      createdChanges(
        {
          ...bare,
          status: todo,
          priority: 2,
          assignee: { id: BOB, name: 'Bob' },
          labels: [bug],
          estimate: 3,
          dueDate: '2026-12-01',
          descriptionEmpty: false,
        },
        defaults,
      ),
    ).toEqual({
      title: { to: 'Fix the login loop' },
      status: { to: todo },
      priority: { to: 2 },
      assignee: { to: { id: BOB, name: 'Bob' } },
      labels: { to: [bug] },
      estimate: { to: 3 },
      dueDate: { to: '2026-12-01' },
      description: true,
    });
  });

  it('keep a status when the team default is unknown', () => {
    expect(createdChanges(bare, {})).toHaveProperty('status', { to: backlog });
  });
});

describe('updated entries (§4.4)', () => {
  it('name every changed field, with references snapshotted by name (E16)', () => {
    const diff: HistoryDiff = {
      title: { from: 'A', to: 'B' },
      status: { from: todo, to: done },
      assignee: { from: null, to: { id: BOB, name: 'Bob' } },
      labels: { from: [bug], to: [ui] },
      description: { empty: false },
    };
    expect(updatedChanges(diff)).toEqual({
      title: { from: 'A', to: 'B' },
      status: { from: todo, to: done },
      assignee: { from: null, to: { id: BOB, name: 'Bob' } },
      labels: { added: [ui], removed: [bug] },
      description: true,
    });
  });

  it('carry no text of the description', () => {
    expect(updatedChanges({ description: { empty: false } })).toEqual({ description: true });
  });

  it('are empty for a label diff that adds and removes nothing', () => {
    expect(updatedChanges({ labels: { from: [bug], to: [bug] } })).toEqual({});
  });

  it('deleted, restored and archived entries have empty changes', () => {
    for (const kind of ['deleted', 'restored', 'archived'] as const) {
      expect(historyEntryFor({ kind })).toEqual({ kind, changes: {} });
    }
    expect(historyEntryFor({ kind: 'created', values: bare, defaults })).toEqual({
      kind: 'created',
      changes: { title: { to: 'Fix the login loop' } },
    });
    expect(historyEntryFor({ kind: 'updated', diff: { priority: { from: 0, to: 1 } } })).toEqual({
      kind: 'updated',
      changes: { priority: { from: 0, to: 1 } },
    });
  });
});

describe('the history write of a change', () => {
  it('writes nothing for a change of nothing (E12)', () => {
    expect(historyWrite(input({ diff: {} }))).toEqual({ action: 'none' });
  });

  describe('creator fold (rule 1)', () => {
    it("merges the creator's change within 3 minutes into the created entry", () => {
      const write = historyWrite(
        input({
          now: at(CREATOR_FOLD_MS),
          diff: { status: { from: backlog, to: todo }, priority: { from: 0, to: 3 } },
        }),
      );
      expect(write).toEqual({
        action: 'fold',
        id: 'h-1',
        changes: { title: { to: 'Fix the login loop' }, status: { to: todo }, priority: { to: 3 } },
      });
    });

    it('drops a field the change sets back to its default', () => {
      const latest = entry({
        kind: 'created',
        changes: { title: { to: 'T' }, priority: { to: 2 }, labels: { to: [bug] } },
      });
      const write = historyWrite(
        input({
          latest,
          diff: { priority: { from: 2, to: 0 }, labels: { from: [bug], to: [] } },
        }),
      );
      expect(write).toEqual({ action: 'fold', id: 'h-1', changes: { title: { to: 'T' } } });
    });

    it('takes the description as true, and drops it when emptied', () => {
      const added = historyWrite(input({ diff: { description: { empty: false } } }));
      expect(added).toMatchObject({ action: 'fold', changes: { description: true } });
      const latest = entry({ kind: 'created', changes: { title: { to: 'T' }, description: true } });
      const emptied = historyWrite(input({ latest, diff: { description: { empty: true } } }));
      expect(emptied).toEqual({ action: 'fold', id: 'h-1', changes: { title: { to: 'T' } } });
    });

    it('does not fold after 3 minutes', () => {
      const write = historyWrite(
        input({ now: at(CREATOR_FOLD_MS + 1), diff: { priority: { from: 0, to: 1 } } }),
      );
      expect(write).toEqual({ action: 'insert', changes: { priority: { from: 0, to: 1 } } });
    });

    it("does not fold anyone else's change (E4)", () => {
      const write = historyWrite(input({ actor: bob, diff: { priority: { from: 0, to: 1 } } }));
      expect(write.action).toBe('insert');
    });

    it('does not fold the creator acting through an API key into a signed-in create', () => {
      const write = historyWrite(
        input({ actor: adaViaKey, diff: { priority: { from: 0, to: 1 } } }),
      );
      expect(write.action).toBe('insert');
    });

    it('does not fold once another entry follows the created one (D15)', () => {
      const latest = entry({
        id: 'h-2',
        kind: 'updated',
        changes: { priority: { from: 0, to: 1 } },
        ...bob,
      });
      const write = historyWrite(input({ latest, diff: { priority: { from: 1, to: 2 } } }));
      expect(write).toEqual({ action: 'insert', changes: { priority: { from: 1, to: 2 } } });
    });
  });

  describe('attachments (SPEC-014 §6.3, AC-11)', () => {
    const shot = { id: 'a-1', kind: 'file' as const, title: 'login.png' };
    const doc = { id: 'a-2', kind: 'link' as const, title: 'Login flow' };

    it('writes an added or removed attachment as its own updated entry after the window', () => {
      const write = historyWrite(
        input({
          now: at(CREATOR_FOLD_MS + 1),
          diff: { attachments: { added: [shot], removed: [] } },
        }),
      );
      expect(write).toEqual({
        action: 'insert',
        changes: { attachments: { added: [shot], removed: [] } },
      });
    });

    it('folds the creator’s attachments into created, netting one added then removed', () => {
      const created = entry({
        kind: 'created',
        changes: {
          ...createdChanges(bare, defaults),
          attachments: { added: [shot, doc], removed: [] },
        },
      });
      const write = historyWrite(
        input({ latest: created, diff: { attachments: { added: [], removed: [shot] } } }),
      );
      expect(write).toEqual({
        action: 'fold',
        id: 'h-1',
        changes: {
          title: { to: 'Fix the login loop' },
          attachments: { added: [doc], removed: [] },
        },
      });
    });

    it('drops the field when nothing is left, and never folds an attachment into a description entry', () => {
      const created = entry({
        kind: 'created',
        changes: { ...createdChanges(bare, defaults), attachments: { added: [shot], removed: [] } },
      });
      const write = historyWrite(
        input({ latest: created, diff: { attachments: { added: [], removed: [shot] } } }),
      );
      expect(write).toEqual({
        action: 'fold',
        id: 'h-1',
        changes: { title: { to: 'Fix the login loop' } },
      });
      const described = entry({ kind: 'updated', changes: { description: true } });
      const next = historyWrite(
        input({
          latest: described,
          now: at(CREATOR_FOLD_MS + 1),
          diff: { attachments: { added: [doc], removed: [] } },
        }),
      );
      expect(next.action).toBe('insert');
    });

    it('reads stored attachment changes back', () => {
      expect(
        parseHistoryChanges({ attachments: { added: [shot], removed: [] } }).attachments,
      ).toEqual({ added: [shot], removed: [] });
    });
  });

  describe('description fold (rule 2, E21)', () => {
    const descriptionEntry = (fields: Partial<HistoryEntryFacts> = {}) =>
      entry({
        id: 'h-2',
        kind: 'updated',
        changes: { description: true },
        updatedAt: at(CREATOR_FOLD_MS + 60_000),
        ...fields,
      });
    const later = (ms: number) => at(CREATOR_FOLD_MS + 60_000 + ms);

    it('merges a description-only change into the same actor’s entry at most 10 minutes old', () => {
      const write = historyWrite(
        input({
          latest: descriptionEntry(),
          now: later(DESCRIPTION_FOLD_MS),
          diff: { description: { empty: false } },
        }),
      );
      expect(write).toEqual({ action: 'fold', id: 'h-2', changes: { description: true } });
    });

    it('applies to every actor, keys and the system included', () => {
      for (const actor of [adaViaKey, bob]) {
        const write = historyWrite(
          input({
            latest: descriptionEntry(actor),
            actor,
            now: later(1_000),
            diff: { description: { empty: true } },
          }),
        );
        expect(write.action).toBe('fold');
      }
    });

    it('counts the 10 minutes from the entry’s updatedAt, so autosave keeps one entry', () => {
      // Five saves a minute apart: each folds, because each fold moves updatedAt.
      let latest = descriptionEntry();
      for (let i = 1; i <= 5; i++) {
        const now = later(i * 9 * 60_000);
        const write = historyWrite(input({ latest, now, diff: { description: { empty: false } } }));
        expect(write.action).toBe('fold');
        latest = { ...latest, updatedAt: now };
      }
    });

    it('starts a new entry after 10 minutes, for another actor, or after another change', () => {
      const diff = { description: { empty: false } };
      const old = historyWrite(
        input({ latest: descriptionEntry(), now: later(DESCRIPTION_FOLD_MS + 1), diff }),
      );
      const other = historyWrite(
        input({ latest: descriptionEntry(), actor: bob, now: later(1_000), diff }),
      );
      const mixed = historyWrite(
        input({
          latest: descriptionEntry({
            changes: { description: true, priority: { from: 0, to: 1 } },
          }),
          now: later(1_000),
          diff,
        }),
      );
      for (const write of [old, other, mixed]) {
        expect(write).toEqual({ action: 'insert', changes: { description: true } });
      }
    });

    it('never folds a change that is not description-only', () => {
      const write = historyWrite(
        input({
          latest: descriptionEntry(),
          now: later(1_000),
          diff: { description: { empty: false }, priority: { from: 0, to: 1 } },
        }),
      );
      expect(write.action).toBe('insert');
    });

    it('never folds into a deleted, restored or archived entry', () => {
      for (const kind of ['deleted', 'restored', 'archived'] as const) {
        const write = historyWrite(
          input({
            latest: entry({ kind, changes: {}, updatedAt: later(0) }),
            now: later(1_000),
            diff: { description: { empty: false } },
          }),
        );
        expect(write.action).toBe('insert');
      }
    });
  });

  it('one entry per changing operation: any sequence of changes ends with folds or inserts only', () => {
    // Property: a write is never a fold into anything but the latest entry, and a change of
    // something always writes (no lost change).
    const field = fc.constantFrom<HistoryDiff>(
      { priority: { from: 0, to: 1 } },
      { description: { empty: false } },
      { status: { from: backlog, to: todo } },
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(field, fc.constantFrom(ada, bob), fc.nat(15 * 60_000)), {
          maxLength: 20,
        }),
        (steps) => {
          let latest: HistoryEntryFacts = entry({
            kind: 'created',
            changes: createdChanges(bare, defaults),
          });
          let now = CREATED_AT.getTime();
          let ids = 1;
          for (const [diff, actor, gap] of steps) {
            now += gap;
            const write = historyWrite(input({ latest, actor, now: new Date(now), diff }));
            expect(write.action).not.toBe('none');
            if (write.action === 'fold') {
              expect(write.id).toBe(latest.id);
              latest = { ...latest, changes: write.changes, updatedAt: new Date(now) };
            } else if (write.action === 'insert') {
              ids += 1;
              latest = entry({
                id: `h-${ids}`,
                kind: 'updated',
                changes: write.changes,
                updatedAt: new Date(now),
                ...actor,
              });
            }
          }
        },
      ),
      { seed: 42 },
    );
  });
});

describe('parseHistoryChanges', () => {
  it('reads stored changes leniently: unknown and malformed fields are left out', () => {
    expect(
      parseHistoryChanges({
        status: { from: todo, to: done },
        priority: { to: 'high' },
        moved_team: { to: 'X' },
      }),
    ).toMatchObject({ status: { from: todo, to: done }, priority: undefined });
    expect(parseHistoryChanges(null)).toEqual({});
  });
});
