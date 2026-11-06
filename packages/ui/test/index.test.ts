import { expect, it } from 'vitest';
import { UI_PACKAGE } from '../src/index.js';

it('loads', () => {
  expect(UI_PACKAGE).toBe('@surface/ui');
});
