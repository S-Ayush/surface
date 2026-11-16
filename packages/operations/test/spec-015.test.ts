// SPEC-015 AC-18 (PLAN-015 S3): every operation of §6.1 is registered, of the kind the spec gives,
// passes the registry lint (the registry-wide run is `lint.test.ts`; the seed examples run in
// server/test/registry-contract.int.test.ts, where `systemOnly` ones are exempt, SPEC-003 §11),
// and the system-only ones are hidden from every surface. AC-16's operation half: the prediction
// of `team.updateAutomations` equals what the server writes.
import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS, isPublicOperation, type AnyOperation } from '../src/index.js';
import { lintOperations } from '../src/lint.js';
import type { OptimisticStore, StoreRow } from '../src/optimistic.js';

type Kind = AnyOperation['kind'];

/** SPEC-015 §6.1, in its order. `issue.listDeleted` is PLAN-015 S4's. */
const SPEC_015_OPERATIONS: readonly (readonly [string, Kind, boolean])[] = [
  ['issue.delete', 'mutation', false],
  ['issue.restore', 'mutation', false],
  ['issue.purge', 'mutation', false],
  ['team.updateAutomations', 'mutation', false],
  ['issue.autoArchive', 'mutation', true],
  ['issue.autoClose', 'mutation', true],
];

const registered = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));

describe('SPEC-015 operations (AC-18)', () => {
  it.each(SPEC_015_OPERATIONS)(
    'registers %s as a %s (systemOnly: %s) that passes the registry lint',
    (name, kind, systemOnly) => {
      const op = registered.get(name);
      expect(op, `${name} is not registered`).toBeDefined();
      if (!op) return;
      expect(op.kind).toBe(kind);
      expect(op.systemOnly === true).toBe(systemOnly);
      expect(lintOperations([op])).toEqual([]);
      expect(op.examples.length).toBeGreaterThan(0);
      // A system-only operation is hidden from the catalog and the command menu (§6.1).
      expect(isPublicOperation(op)).toBe(!systemOnly);
      if (systemOnly) {
        expect(op.ui).toBeUndefined();
        expect(typeof op.optimistic).toBe('undefined');
      }
    },
  );

  it('gives team.updateAutomations a prediction and no command', () => {
    const op = registered.get('team.updateAutomations');
    expect(typeof op?.optimistic).toBe('function');
    expect(op?.ui).toBeUndefined();
  });

  it('keeps the system-only operations out of the public catalog snapshot', () => {
    const names = ALL_OPERATIONS.filter((op) => isPublicOperation(op)).map((op) => op.name);
    expect(names).not.toContain('issue.autoArchive');
    expect(names).not.toContain('issue.autoClose');
    expect(names).toContain('team.updateAutomations');
  });
});

// ---------------------------------------------------------------------------------------------

const TEAM = 't-eng';
const NOW = new Date('2026-11-16T00:00:00.000Z');

/** A store of one team and its statuses; `patch` records what the prediction wrote. */
function store(team: Record<string, unknown>) {
  const rows: Record<string, StoreRow[]> = {
    Team: [
      {
        id: TEAM,
        key: 'ENG',
        autoArchiveMonths: 6,
        autoCloseMonths: null,
        autoCloseStatusId: null,
        ...team,
      },
    ],
    WorkflowStatus: [
      { id: 's-b', teamId: TEAM, name: 'Backlog', category: 'backlog', position: 'a0' },
      { id: 's-w', teamId: TEAM, name: 'Won’t do', category: 'canceled', position: 'a1' },
      { id: 's-c', teamId: TEAM, name: 'Canceled', category: 'canceled', position: 'a0' },
      { id: 's-d', teamId: TEAM, name: 'Done', category: 'completed', position: 'a0' },
    ],
  };
  const patches: StoreRow[] = [];
  const fake: OptimisticStore = {
    now: NOW,
    get: (model, ref) =>
      rows[model]?.find((r) => r['id'] === ref || r['key'] === ref || r['name'] === ref),
    find: (model, fields) =>
      (rows[model] ?? []).filter((r) => Object.entries(fields).every(([k, v]) => r[k] === v)),
    patch: (_model, _ref, changes) => void patches.push(changes),
    insert: () => undefined,
    archive: () => undefined,
    unarchive: () => undefined,
    remove: () => undefined,
  };
  return { fake, patches };
}

function predict(input: Record<string, unknown>, team: Record<string, unknown> = {}) {
  const op = registered.get('team.updateAutomations');
  const parsed = op?.input.parse({ team: 'ENG', ...input });
  const { fake, patches } = store(team);
  op?.optimistic?.(fake, parsed);
  return patches;
}

describe('team.updateAutomations prediction (AC-16)', () => {
  const at = { updatedAt: NOW.toISOString() };

  it('predicts the months, and turning auto-close on with 6 months and the first Canceled status', () => {
    expect(predict({ autoArchiveMonths: 3 })).toEqual([{ autoArchiveMonths: 3, ...at }]);
    expect(predict({ autoCloseMonths: 6 })).toEqual([
      { autoCloseMonths: 6, autoCloseStatusId: 's-c', ...at },
    ]);
  });

  it('predicts the chosen Canceled status by name or id, and nothing for another category', () => {
    expect(predict({ autoCloseMonths: 3, autoCloseStatus: 'Won’t do' })).toEqual([
      { autoCloseMonths: 3, autoCloseStatusId: 's-w', ...at },
    ]);
    expect(predict({ autoCloseMonths: 3, autoCloseStatus: 'Done' })).toEqual([]);
  });

  it('predicts off as null months and no status, and nothing when nothing changes', () => {
    const on = { autoCloseMonths: 6, autoCloseStatusId: 's-c' };
    expect(predict({ autoCloseMonths: null }, on)).toEqual([
      { autoCloseMonths: null, autoCloseStatusId: null, ...at },
    ]);
    expect(predict({ autoCloseMonths: 6 }, on)).toEqual([]);
    expect(predict({ autoArchiveMonths: 6 })).toEqual([]);
    expect(predict({ autoCloseMonths: null })).toEqual([]);
  });
});
