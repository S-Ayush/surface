/**
 * Fixture mutations on `DebugItem`, with `optimistic()` (PLAN-002 header:
 * `debug.create`, `debug.rename`, `debug.touch`, `debug.delete`). The real
 * ones belong in `packages/operations` (session A); until then the engine is
 * tested against these. The fake hub runs the server side (`hub.ts`).
 */
import { createRegistry, defineOperation } from '@surface/operations';
import { z } from 'zod';

const item = z.object({ id: z.uuid(), title: z.string(), counter: z.number().int() });
const fixture = {
  domain: 'debug' as const,
  permission: () => true,
  destructive: false,
  internal: true,
  output: item,
};

export const debugCreate = defineOperation({
  ...fixture,
  name: 'debug.create',
  kind: 'mutation',
  summary: 'Create a debug item',
  description: 'Creates a debug item with a client-generated id. For sync tests.',
  keywords: ['create debug item', 'new debug item'],
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', title: 'New' }],
  optimistic(store, input) {
    store.insert('DebugItem', {
      id: input.id,
      title: input.title,
      counter: 0,
      groups: ['workspace'],
      archivedAt: null,
    });
  },
});

export const debugRename = defineOperation({
  ...fixture,
  name: 'debug.rename',
  kind: 'mutation',
  summary: 'Rename a debug item',
  description: 'Sets the title of a debug item. For sync tests.',
  keywords: ['rename debug item', 'change title'],
  input: z.object({ id: z.uuid(), title: z.string().min(1).max(200) }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', title: 'Renamed' }],
  optimistic(store, input) {
    store.patch('DebugItem', input.id, { title: input.title });
  },
});

export const debugTouch = defineOperation({
  ...fixture,
  name: 'debug.touch',
  kind: 'mutation',
  summary: 'Increment a debug item’s counter',
  description: 'Adds one to the counter of a debug item. For sync tests.',
  keywords: ['touch debug item', 'increment counter'],
  input: z.object({ id: z.uuid() }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
  optimistic(store, input) {
    const row = store.get('DebugItem', input.id);
    if (typeof row?.counter === 'number') {
      store.patch('DebugItem', input.id, { counter: row.counter + 1 });
    }
  },
});

export const debugDelete = defineOperation({
  ...fixture,
  name: 'debug.delete',
  kind: 'mutation',
  summary: 'Delete a debug item',
  description: 'Deletes a debug item. For sync tests.',
  keywords: ['delete debug item', 'remove debug item'],
  input: z.object({ id: z.uuid() }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
  optimistic(store, input) {
    store.remove('DebugItem', input.id);
  },
});

/** Changes only rows this client cannot see: confirmed by an `ack` alone. */
export const debugHide = defineOperation({
  ...fixture,
  name: 'debug.hide',
  kind: 'mutation',
  summary: 'Change a hidden debug row',
  description: 'Writes a row in a group the caller cannot see. For ack-only tests.',
  keywords: ['hidden change', 'invisible write'],
  input: z.object({ note: z.string() }),
  examples: [{ note: 'x' }],
});

/** An `optimistic()` with a bug: it throws. */
export const debugBroken = defineOperation({
  ...fixture,
  name: 'debug.broken',
  kind: 'mutation',
  summary: 'Rename with a broken prediction',
  description: 'Renames on the server, but its optimistic() throws. For overlay tests.',
  keywords: ['broken optimistic', 'throwing prediction'],
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e', title: 'x' }],
  optimistic() {
    throw new Error('bug in optimistic');
  },
});

export const FIXTURE_OPS = createRegistry([
  debugCreate,
  debugRename,
  debugTouch,
  debugDelete,
  debugHide,
  debugBroken,
]);
