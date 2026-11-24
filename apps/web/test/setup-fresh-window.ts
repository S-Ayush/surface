// Test files share a worker, its module cache and its jsdom window (`isolate: false`,
// vitest.config.js). Isolation gave each file fresh ones; this setup file, which Vitest runs
// before each file, puts back what a file can leave behind and a later file would read.
//
// Module singletons with state of their own (a search of `apps/web/src` and `packages/ui/src` for
// module-level `let`, `new …`, `Set` and `Map`):
// - `overlayManager`: toasts and banners (a toast one file raised would satisfy a later file's
//   "shows a toast" assertion). Its layers belong to mounted overlays: a file that leaves one open
//   fails below;
// - `focusMemory`: the focused row each list restores (a group header's id is the same in every
//   file, so a later list opened with focus on it);
// - `announcer` (the live region's text), `lastDelete`, `deleteRequests`, `purgeRequests`,
//   `pickerRequests`, `INVITE_REQUESTS`, the label and status add-intents, the composer request
//   and the remembered My issues tab.
// Their listener sets hold mounted components only: `setup-react-roots.ts` fails a file that
// leaves a React root mounted, so they are empty when a file starts. Not reset, as they hold no
// state a test can see: the lazily built HTTP clients (`cached`, `browser`; they read `window` at
// call time), `WeakMap`s keyed by a store (each test builds its own), the focus records in
// `layer.tsx` (one per open layer: checked with the layers) and `usePlatform`'s detection (jsdom's
// navigator never changes platform).
//
// Window state:
// - `localStorage` and `sessionStorage` (a list's collapsed groups, the theme);
// - the document: nodes, and so focus, a file didn't remove;
// - the navigator's own properties: jsdom defines none, so each is a file's stub
//   (`clipboard`, `sendBeacon`);
// - fake timers, if a file left them on.
// The browser APIs that jsdom lacks (`matchMedia`, `ResizeObserver`, `scrollTo`…) stay as the
// harnesses stub them: those stubs run once, when a harness module is first imported in the
// worker, and every file of the worker relies on them. A file that changes one in a way other
// files must not see puts it back itself (`issue-page-layout.test.tsx` restores `matchMedia`).
import { overlayManager } from '@surface/ui';
import { afterAll, vi } from 'vitest';
import { purgeRequests } from '../src/features/archive/purge-flow.js';
import { INVITE_REQUESTS } from '../src/features/invites/requests.js';
import { announcer } from '../src/features/issues/announcer.js';
import { takeComposerRequest } from '../src/features/issues/composer-request.js';
import { deleteRequests, lastDelete } from '../src/features/issues/delete-flow.js';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { rememberMyIssuesTab } from '../src/features/issues/my-issues-tab.js';
import { pickerRequests } from '../src/features/issues/pickers/picker-request.js';
import { clearCreateLabel } from '../src/features/labels/add-intent.js';
import { clearAddStatus } from '../src/features/statuses/add-intent.js';
import { takeLeakedRoots } from './react-roots.js';

vi.useRealTimers();

overlayManager.clear();
focusMemory.clear();
// An empty announcement is what the live region starts with.
if (announcer.snapshot().text !== '') announcer.announce('');
lastDelete.take();
deleteRequests.close();
purgeRequests.close();
pickerRequests.close();
INVITE_REQUESTS.take();
clearCreateLabel();
clearAddStatus();
takeComposerRequest();
// The in-memory fallback only: storage is cleared below.
rememberMyIssuesTab('assigned', { setItem: () => undefined });

if (typeof window !== 'undefined') {
  localStorage.clear();
  sessionStorage.clear();
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const name of document.documentElement.getAttributeNames()) {
    document.documentElement.removeAttribute(name);
  }
  for (const name of Reflect.ownKeys(navigator)) {
    Reflect.deleteProperty(navigator, name);
  }
}

// Runs before `setup-react-roots.ts`'s hook (later hooks first), so it reports leaked roots too:
// Vitest skips the remaining `afterAll` hooks once one throws.
afterAll(() => {
  const problems: string[] = [];
  const roots = takeLeakedRoots();
  if (roots !== undefined) problems.push(roots);
  const layers = overlayManager.getSnapshot().layers;
  // Removed once reported, so the next file fails only for its own.
  for (const layer of layers) overlayManager.removeLayer(layer.id);
  if (layers.length > 0) {
    const kinds = layers.map((layer) => layer.kind).join(', ');
    problems.push(
      `This file left ${layers.length} overlay layer(s) open (${kinds}). Unmount what opened ` +
        'them: later files in the worker would see them.',
    );
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
});
