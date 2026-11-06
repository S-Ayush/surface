import { expect, it } from 'vitest';
import { serverInfo } from '../src/info.js';

it('reports info built from workspace packages', () => {
  expect(serverInfo()).toEqual({ name: 'surface', protocolVersion: 1, statusCategories: 7 });
});
