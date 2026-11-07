import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { expect, it } from 'vitest';
import './zod-config.js';

it('turns off the Zod eval probe', () => {
  expect(z.config().jitless).toBe(true);
});

// Imports are evaluated in order: anything imported before the config could parse
// with Zod first and trigger the probe.
it('is the first import of main.tsx', () => {
  const main = readFileSync(new URL('main.tsx', import.meta.url), 'utf8');
  const first = /^import\s[^;]*;/m.exec(main)?.[0];
  expect(first).toBe("import './zod-config.js';");
});
