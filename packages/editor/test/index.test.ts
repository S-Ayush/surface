import { expect, it } from 'vitest';
import { EDITOR_PACKAGE } from '../src/index.js';

it('loads', () => {
  expect(EDITOR_PACKAGE).toBe('@surface/editor');
});
