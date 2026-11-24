// PLAN-014 S2 (SPEC-014 §4.8, review m3): cleaning a name is linear in its length. A wall-clock
// budget, so it runs in `pnpm test:deep` (plans README §6); `files-names.test.ts` checks the
// results in the gate.
import { expect, it } from 'vitest';
import { cleanFileName } from '../src/files/names.js';

const header = (name: string) => encodeURIComponent(name);

it('trims a long run of spaces in time linear in its length (review m3)', () => {
  // 100,000 spaces then a letter: a backtracking trim tries every start, 5·10⁹ steps.
  const spaces = ' '.repeat(100_000);
  const started = performance.now();
  expect(cleanFileName(header(`${spaces}a${spaces}`))).toBe('a');
  expect(cleanFileName(header(`${spaces}a`))).toBe('a');
  expect(cleanFileName(header(`a${spaces}.b`))).toBe('a.b');
  expect(performance.now() - started).toBeLessThan(1_000);
});
