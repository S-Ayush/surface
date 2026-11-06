import { clientIdSchema } from '@surface/sync-protocol';
import { expect, it } from 'vitest';
import { randomUuid } from '../src/uuid.js';

it('makes distinct version-4 UUIDs the protocol accepts as client ids', () => {
  const ids = Array.from({ length: 1000 }, randomUuid);
  for (const value of ids) {
    expect(clientIdSchema.safeParse(value).success, value).toBe(true);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  expect(new Set(ids).size).toBe(ids.length);
});
