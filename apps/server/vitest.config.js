import { surfaceVitestShared } from '@surface/config/vitest';

// Files share workers and their module cache (`isolate: false`); those that `vi.mock` stay isolated.
export default surfaceVitestShared(import.meta.dirname, { test: { environment: 'node' } });
