import { expect, it } from 'vitest';
import { SYNC_PROTOCOL_VERSION } from '../src/index.js';

it('exposes a protocol version', () => {
  expect(SYNC_PROTOCOL_VERSION).toBeGreaterThan(0);
});
