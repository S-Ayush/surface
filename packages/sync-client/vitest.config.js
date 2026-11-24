import { surfaceVitestShared } from '@surface/config/vitest';

// Files share workers and their module cache (`isolate: false`); those that `vi.mock` stay isolated.
// Tests name their own IndexedDB databases, so files share no stored state.
export default surfaceVitestShared(import.meta.dirname);
