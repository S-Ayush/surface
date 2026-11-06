import { SYNC_PROTOCOL_VERSION } from '@surface/sync-protocol';
import { expect, it } from 'vitest';
import { CLIENT_PROTOCOL_VERSION } from '../src/index.js';

it('resolves workspace dependencies from source', () => {
  expect(CLIENT_PROTOCOL_VERSION).toBe(SYNC_PROTOCOL_VERSION);
});
