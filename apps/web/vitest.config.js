import { surfaceVitestShared } from '@surface/config/vitest';

// Files share workers and their module cache (`isolate: false`); those that `vi.mock` stay
// isolated. Every file fails if it leaves a React root mounted (`setup-react-roots.ts`); shared
// files start from a reset window and module singletons (`setup-fresh-window.ts`).
export default surfaceVitestShared(
  import.meta.dirname,
  { test: { setupFiles: ['./test/setup-react-roots.ts'] } },
  { sharedSetupFiles: ['./test/setup-fresh-window.ts'] },
);
