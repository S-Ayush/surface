import { expect, it } from 'vitest';
import { OPERATIONS_PACKAGE } from '../src/index.js';

it('loads', () => {
  expect(OPERATIONS_PACKAGE).toBe('@surface/operations');
});
