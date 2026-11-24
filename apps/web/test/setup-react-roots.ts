// Test files share a worker and its jsdom window (`isolate: false`, vitest.config.js). A React
// root a file leaves mounted keeps rendering into the next file: its components stay subscribed
// to the module singletons (overlays, pickers, delete requests, add-intents, lifecycle events…)
// and answer what the next file asks of them. Clearing the document doesn't unmount a root, so
// this setup file, which runs before each file, fails a file that leaves one mounted.
//
// It is the first setup file and imports nothing that loads `react-dom`, so the tracker is in
// place when React looks for the DevTools hook. `setup-fresh-window.ts` reports leaked roots
// together with open layers (Vitest skips the remaining `afterAll` hooks after one throws).
import { afterAll } from 'vitest';
import { takeLeakedRoots, trackReactRoots } from './react-roots.js';

trackReactRoots();

afterAll(() => {
  const leaked = takeLeakedRoots();
  if (leaked !== undefined) throw new Error(leaked);
});
