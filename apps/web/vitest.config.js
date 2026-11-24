import { surfaceVitestShared } from '@surface/config/vitest';

// Files share workers and their module cache (`isolate: false`); those that `vi.mock` stay
// isolated. Files share the jsdom window too: `setup-fresh-window.ts` resets it before each file.
export default surfaceVitestShared(import.meta.dirname, {
  test: { setupFiles: ['./test/setup-fresh-window.ts'] },
});
