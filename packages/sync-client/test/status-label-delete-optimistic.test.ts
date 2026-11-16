/**
 * PLAN-010 S5, SPEC-010 AC-17, E1, E8: the issue halves of `status.delete` and `label.delete` on
 * the client.
 * - `status.delete` with an issue in the store throws the server's refusal (`OptimisticRefusal`),
 *   and `dispatch` queues nothing and sends nothing. With none in the store it removes the status;
 *   the server's `CONFLICT` (issues this client doesn't hold) rolls it back.
 * - `label.delete` removes the Label row only; issues keep the id until the server's deltas arrive,
 *   and `labelsOf` skips it.
 * - E1: `statusGoneMessage` words a refusal naming a status the replica saw deleted.
 * The overlay runs the production operations against the production models; the dispatch half
 * runs a whole store against the fake hub, with a fixture op whose prediction refuses.
 */
import { NEW_TEAM_SETTINGS, labelsOf } from '@surface/domain';
import { Issue, Label, PRODUCTION_MODELS, WorkflowStatus } from '@surface/domain/model';
import {
  OptimisticRefusal,
  createRegistry,
  defineOperation,
  labelDelete,
  statusDelete,
} from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
import { STATUS_GONE_MESSAGE, statusGoneMessage } from '../src/status-gone.js';
import { FakeHub } from './support/hub.js';
import { liveStore, until } from './support/live.js';
import { DebugItem, id } from './support/models.js';
import {
  debugBroken,
  debugCreate,
  debugDelete,
  debugHide,
  debugRename,
  debugTouch,
} from './support/ops.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const PROGRESS = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
const REVIEW = '0192f0c1-7e5a-7b3c-9d4e-0000000000b4';
const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b5';
const BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
const UI = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const USER = '0192f0c1-7e5a-7b3c-9d4e-0000000000d1';
const now = new Date('2026-11-16T10:00:00.000Z');
const AT = now.toISOString();

const base = (row: Record<string, unknown> & { id: string }) => ({ row, archived: false });

function status(id: string, name: string, category: string, position: string) {
  return base({
    id,
    teamId: ENG,
    name,
    category,
    color: 'gray',
    description: null,
    position,
    groups: ['workspace'],
    createdAt: AT,
    updatedAt: AT,
  });
}

function label(id: string, name: string) {
  return base({
    id,
    teamId: ENG,
    name,
    color: 'gray',
    description: null,
    parentId: null,
    isGroup: false,
    exclusive: true,
    groups: ['workspace'],
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
  });
}

function issue(id: string, statusId: string, labelIds: string[]) {
  return base({
    id,
    teamId: ENG,
    number: 1,
    title: 'Fix login',
    statusId,
    priority: 0,
    assigneeId: null,
    labelIds,
    estimate: null,
    dueDate: null,
    sortOrder: 'a0',
    creatorId: USER,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedById: null,
    groups: [`team:${ENG}`],
    createdAt: AT,
    updatedAt: AT,
  });
}

function setup(issues: ReturnType<typeof issue>[] = []) {
  const pool = new ObjectPool(PRODUCTION_MODELS);
  pool.loadBase('Team', [
    base({
      ...NEW_TEAM_SETTINGS,
      id: ENG,
      key: 'ENG',
      name: 'Engineering',
      icon: null,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
      defaultStatusId: BACKLOG,
    }),
  ]);
  pool.loadBase('WorkflowStatus', [
    status(BACKLOG, 'Backlog', 'backlog', 'a0'),
    status(PROGRESS, 'In Progress', 'started', 'a0'),
    status(REVIEW, 'In Review', 'started', 'a1'),
    status(DONE, 'Done', 'completed', 'a0'),
  ]);
  pool.loadBase('Label', [label(BUG, 'Bug'), label(UI, 'UI')]);
  pool.loadBase('Issue', issues);
  return { pool, engine: new OverlayEngine(pool, () => undefined) };
}

const mutation = (
  key: string,
  op: OverlayMutation['op'],
  input: OverlayMutation['input'],
): OverlayMutation => ({ key, op, input, now });

describe('status.delete on a status the replica shows an issue on (AC-17, E8)', () => {
  it('refuses with the server’s message and leaves the status', () => {
    const { pool, engine } = setup([issue(ISSUE, REVIEW, [])]);
    const refusal = engine.push(
      mutation('c:1', statusDelete, { team: 'ENG', status: 'In Review' }),
    );
    expect(refusal).toBeInstanceOf(OptimisticRefusal);
    expect(refusal?.message).toBe(
      'Can\'t delete the "In Review" status. It has 1 issue. Move it to another status first.',
    );
    expect(pool.get(WorkflowStatus, REVIEW)).toMatchObject({ name: 'In Review' });
  });

  it('with none in the store, removes it; the server’s CONFLICT brings it back', () => {
    const { pool, engine } = setup([issue(ISSUE, PROGRESS, [])]);
    const refusal = engine.push(
      mutation('c:1', statusDelete, { team: 'ENG', status: 'In Review' }),
    );
    expect(refusal).toBeUndefined();
    expect(pool.get(WorkflowStatus, REVIEW)).toBeUndefined();
    // The server refused: the issues are ones this client doesn't hold (SPEC-011 §5.7).
    engine.rebuild([]);
    expect(pool.get(WorkflowStatus, REVIEW)).toMatchObject({ name: 'In Review' });
  });

  it('shows the status again when an issue on it arrives before the answer; the delete stays queued', () => {
    const { pool, engine } = setup();
    const pending = mutation('c:1', statusDelete, { team: 'ENG', status: 'In Review' });
    expect(engine.push(pending)).toBeUndefined();
    expect(pool.get(WorkflowStatus, REVIEW)).toBeUndefined();
    pool.applyBase([{ kind: 'upsert', model: 'Issue', row: issue(ISSUE, REVIEW, []).row }]);
    // A replay only drops the effect; the server, which got the mutation, decides.
    expect(() => engine.rebuild([pending])).not.toThrow();
    expect(pool.get(WorkflowStatus, REVIEW)).toMatchObject({ name: 'In Review' });
  });
});

describe('label.delete in the overlay (AC-17)', () => {
  it('removes the Label row only; the issue keeps the id, and no renderer shows it', () => {
    const { pool, engine } = setup([issue(ISSUE, BACKLOG, [BUG, UI])]);
    engine.push(mutation('c:1', labelDelete, { label: 'Bug', team: 'ENG' }));
    expect(pool.get(Label, BUG)).toBeUndefined();
    const row = pool.get(Issue, ISSUE);
    expect(row?.labelIds).toEqual([BUG, UI]);
    const shown = labelsOf({ labelIds: row?.labelIds ?? [] }, (labelId) =>
      pool.get(Label, labelId),
    );
    expect(shown.map((l) => l.name)).toEqual(['UI']);

    // Refused: the label and every issue show their server state again.
    engine.rebuild([]);
    expect(pool.get(Label, BUG)).toMatchObject({ name: 'Bug' });
    expect(pool.get(Issue, ISSUE)?.labelIds).toEqual([BUG, UI]);
  });
});

// ---------------------------------------------------------------------------------------------
// dispatch: a refusal from the store queues nothing.

/** A rename whose prediction refuses an item titled "Locked", as `status.delete` refuses. */
const debugGuarded = defineOperation({
  domain: 'debug',
  permission: () => true,
  destructive: false,
  internal: true,
  output: z.object({ id: z.uuid() }),
  name: 'debug.guarded',
  kind: 'mutation',
  summary: 'Rename unless locked',
  description: 'Renames a debug item; its prediction refuses a locked one. For sync tests.',
  keywords: ['guarded rename', 'refused prediction'],
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', title: 'x' }],
  optimistic(store, input) {
    if (store.get('DebugItem', input.id)?.['title'] === 'Locked') {
      throw new OptimisticRefusal('That item is locked. Unlock it first.');
    }
    store.patch('DebugItem', input.id, { title: input.title });
  },
});

const OPS = createRegistry([
  debugCreate,
  debugRename,
  debugTouch,
  debugDelete,
  debugHide,
  debugBroken,
  debugGuarded,
]);

describe('dispatch of a mutation the store refuses (AC-17, E8)', () => {
  it('throws the refusal, queues nothing and sends nothing; the next dispatch is seq 1', async () => {
    const hub = new FakeHub();
    hub.upsert(1);
    const { store } = liveStore(hub, { operations: OPS });
    await store.start();
    await until(() => store.connection === 'online');
    const rename = store.dispatch(debugRename, { id: id(1), title: 'Locked' });
    expect(await rename).toEqual({ status: 'confirmed' });
    const sent = hub.mutateRequests.length;

    expect(() => store.dispatch(debugGuarded, { id: id(1), title: 'Open' })).toThrow(
      new OptimisticRefusal('That item is locked. Unlock it first.'),
    );
    expect(store.pending).toEqual([]);
    expect(store.pool.get(DebugItem, id(1))?.title).toBe('Locked');
    expect(hub.mutateRequests.length).toBe(sent);

    // The refused dispatch took no seq: the next one follows the confirmed rename.
    expect(await store.dispatch(debugTouch, { id: id(1) })).toEqual({ status: 'confirmed' });
    const seqs = hub.mutateRequests.flatMap((request) => request.mutations.map((m) => m.seq));
    expect(seqs).toEqual([1, 2]);
    await store.close();
  });
});

describe('the E1 message (statusGoneMessage)', () => {
  const seen = (deleted: { id: string; name: string }[]) => ({
    seenDeleted: (_model: string, rowId: string) => deleted.find((d) => d.id === rowId),
    seenDeletedRows: () => deleted,
  });
  const rejection = (code: string, input: unknown) => ({
    code,
    message: 'No status matches "x" in ENG. Use a status name or id.',
    input,
  });

  it('says the status was deleted when the replica saw its delete, by id or by name', () => {
    const store = seen([{ id: REVIEW, name: 'In Review' }]);
    expect(
      statusGoneMessage(rejection('NOT_FOUND', { issue: 'ENG-1', status: REVIEW }), store),
    ).toBe(STATUS_GONE_MESSAGE);
    expect(statusGoneMessage(rejection('CONFLICT', { status: 'in review' }), store)).toBe(
      'That status was deleted. Choose another.',
    );
  });

  it('keeps the server’s message otherwise', () => {
    const store = seen([{ id: REVIEW, name: 'In Review' }]);
    const server = rejection('NOT_FOUND', { status: DONE });
    expect(statusGoneMessage(server, store)).toBe(server.message);
    expect(statusGoneMessage(rejection('INVALID_INPUT', { status: REVIEW }), store)).toBe(
      server.message,
    );
    expect(statusGoneMessage(rejection('NOT_FOUND', { title: 'x' }), store)).toBe(server.message);
  });

  it('is fed by the store: a D delta of a remembered model is remembered with its fields', async () => {
    const hub = new FakeHub();
    hub.upsert(1);
    hub.upsert(2);
    const { store } = liveStore(hub, { rememberDeletes: ['DebugItem'] });
    await store.start();
    await until(() => store.connection === 'online');
    hub.remove(1);
    await until(() => store.pool.get(DebugItem, id(1)) === undefined);
    expect(store.seenDeleted('DebugItem', id(1))).toEqual({ id: id(1) });
    expect(store.seenDeleted('DebugItem', id(2))).toBeUndefined();
    await store.close();

    // By default only settings rows are remembered.
    const other = new FakeHub();
    other.upsert(1);
    const { store: plain } = liveStore(other);
    await plain.start();
    await until(() => plain.connection === 'online');
    other.remove(1);
    await until(() => plain.pool.get(DebugItem, id(1)) === undefined);
    expect(plain.seenDeleted('DebugItem', id(1))).toBeUndefined();
    await plain.close();
  });
});
