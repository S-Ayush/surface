// Test files share a worker, its module cache and its jsdom window (`isolate: false`,
// vitest.config.js). Isolation gave each file fresh ones; this setup file, which Vitest runs
// before each file, clears what files leave behind and later files would read:
// - `focusMemory`, the focused row each list restores (a group header's id is the same in every
//   file, so a later list opened with focus on it);
// - `localStorage` and `sessionStorage` (a list's collapsed groups, the theme);
// - the document: nodes, and so focus, a file didn't unmount.
//
// The browser APIs that jsdom lacks (`matchMedia`, `ResizeObserver`, `scrollTo`…) stay as the
// harnesses stub them: those stubs run once, when a harness module is first imported in the
// worker, and every file of the worker relies on them. A file that changes one in a way other
// files must not see puts it back itself (`issue-page-layout.test.tsx` restores `matchMedia`).
import { focusMemory } from '../src/features/issues/focus-model.js';

focusMemory.clear();

if (typeof window !== 'undefined') {
  localStorage.clear();
  sessionStorage.clear();
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const name of document.documentElement.getAttributeNames()) {
    document.documentElement.removeAttribute(name);
  }
}
