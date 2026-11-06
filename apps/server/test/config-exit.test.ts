// SPEC-004 AC-6: invalid or missing config exits within 1 s, naming the variable and the fix.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

it('exits 1 within a second with an actionable message', () => {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ['--conditions=@surface/source', '--import', 'tsx', 'src/main.ts'],
    {
      cwd: serverRoot,
      // Only what Node needs; none of the developer's own settings.
      env: { PATH: process.env.PATH, SESSION_SECRET: 'too-short' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  const elapsedMs = performance.now() - started;

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('SURFACE_URL is missing');
  expect(result.stderr).toContain('SESSION_SECRET must be at least 32 bytes');
  expect(result.stderr).not.toContain('too-short');
  expect(result.stdout).toBe('');
  expect(elapsedMs).toBeLessThan(1_000);
});
