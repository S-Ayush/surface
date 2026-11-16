// PLAN-011 S6, SPEC-011 §4.4 and D9: the activity line of each history entry (AC-25).
import { describe, expect, it } from 'vitest';
import { activityLines, type ActivityEntry } from './activity-line.js';

const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const BOB = '0192f0c1-7e5a-7b3c-9d4e-0000000000b0';
const todo = { id: 's-todo', name: 'Todo', category: 'unstarted' };
const progress = { id: 's-prog', name: 'In Progress', category: 'started' };
const canceled = { id: 's-canc', name: 'Canceled', category: 'canceled' };

const byAda = (fields: Partial<ActivityEntry> & Pick<ActivityEntry, 'kind'>): ActivityEntry => ({
  actorKind: 'user',
  actorId: ADA,
  changes: {},
  ...fields,
});

describe('activity lines (§4.4 table)', () => {
  it('created, deleted and restored', () => {
    expect(
      activityLines(byAda({ kind: 'created', changes: { title: { to: 'X' } } }), 'Ada'),
    ).toEqual(['Ada created the issue']);
    expect(activityLines(byAda({ kind: 'deleted' }), 'Ada')).toEqual(['Ada deleted the issue']);
    expect(activityLines(byAda({ kind: 'restored' }), 'Ada')).toEqual(['Ada restored the issue']);
  });

  it('a status change: moved from A to B', () => {
    const entry = byAda({ kind: 'updated', changes: { status: { from: todo, to: progress } } });
    expect(activityLines(entry, 'Ada')).toEqual(['Ada moved from Todo to In Progress']);
  });

  it('assignee set to the actor, to someone else, and cleared', () => {
    const to = (assignee: unknown) =>
      activityLines(byAda({ kind: 'updated', changes: { assignee } }), 'Ada');
    expect(to({ from: null, to: { id: ADA, name: 'Ada' } })).toEqual([
      'Ada self-assigned the issue',
    ]);
    expect(to({ from: null, to: { id: BOB, name: 'Bob' } })).toEqual([
      'Ada assigned the issue to Bob',
    ]);
    expect(to({ from: { id: BOB, name: 'Bob' }, to: null })).toEqual(['Ada removed assignee']);
  });

  it('the auto-archive and auto-close jobs (actor system)', () => {
    const system = { actorKind: 'system', actorId: null } as const;
    expect(activityLines({ ...system, kind: 'archived', changes: {} }, 'Surface')).toEqual([
      'Issue was automatically archived',
    ]);
    expect(
      activityLines(
        { ...system, kind: 'updated', changes: { status: { from: todo, to: canceled } } },
        'Surface',
      ),
    ).toEqual(['Issue was automatically closed']);
  });

  it('"via API" and "via MCP" after the name', () => {
    const viaApi = byAda({ kind: 'created', actorKind: 'api' });
    const viaMcp = byAda({
      kind: 'updated',
      actorKind: 'mcp',
      changes: { status: { from: todo, to: progress } },
    });
    expect(activityLines(viaApi, 'Ada')).toEqual(['Ada via API created the issue']);
    expect(activityLines(viaMcp, 'Ada')).toEqual(['Ada via MCP moved from Todo to In Progress']);
  });

  it('the description: "updated the description" (Q18), never its text', () => {
    const entry = byAda({ kind: 'updated', changes: { description: true } });
    expect(activityLines(entry, 'Ada')).toEqual(['Ada updated the description']);
  });

  it('one line per changed field, in field order', () => {
    const entry = byAda({
      kind: 'updated',
      changes: {
        description: true,
        status: { from: todo, to: progress },
        priority: { from: 0, to: 2 },
        labels: { added: [{ id: 'l1', name: 'Bug', color: 'red' }], removed: [] },
      },
    });
    expect(activityLines(entry, 'Ada')).toEqual([
      'Ada moved from Todo to In Progress',
      'Ada set priority to High',
      'Ada added label Bug',
      'Ada updated the description',
    ]);
  });

  it('shows the stored names even after a rename (E16), and reads unknown shapes safely', () => {
    const entry = byAda({
      kind: 'updated',
      changes: { status: { from: { ...todo, name: 'To do (old name)' }, to: progress } },
    });
    expect(activityLines(entry, 'Ada')).toEqual(['Ada moved from To do (old name) to In Progress']);
    expect(activityLines(byAda({ kind: 'updated', changes: { status: 'x' } }), 'Ada')).toEqual([
      'Ada updated the issue',
    ]);
  });
});
