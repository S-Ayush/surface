// Builds the offline app cache's worker (ADR-0019): after the app's build, bundles
// `src/offline/sw.ts` on its own into `dist/sw.js`, with the build's id and files written in.
// Vite builds it, so no plugin or worker library is added.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Plugin } from 'vite';
import type { AppBuild } from './src/offline/app-cache.js';

/**
 * The page first, then every file under `assets/` (hashed by Vite), without source maps. Files
 * outside `assets/` (Vite's `public/`, none today) aren't cached: a page that needs one offline
 * must import it, so it gets a hashed name under `assets/`. The id
 * changes whenever a file or the page does, so the worker's bytes change and browsers install it.
 */
export function appBuild(fileNames: readonly string[], indexHtml: string): AppBuild {
  const assets = fileNames
    .filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
    .sort()
    .map((name) => `/${name}`);
  const id = createHash('sha256')
    .update(JSON.stringify([assets, indexHtml]))
    .digest('hex')
    .slice(0, 16);
  return { id, files: ['/index.html', ...assets] };
}

/** Production builds only (`vite build`); `vite` in dev registers no worker. */
export function appCache(): Plugin {
  let root = '';
  let outDir = '';
  let conditions: string[] = [];
  return {
    name: 'surface-app-cache',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
      // The app's conditions (`@surface/source`), so the worker bundles the same package source.
      conditions = [...config.resolve.conditions];
    },
    async closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
        );
      const app = appBuild(files, readFileSync(path.join(outDir, 'index.html'), 'utf8'));
      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        define: { __SURFACE_APP_BUILD__: JSON.stringify(app) },
        resolve: { conditions },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: {
            entry: path.join(root, 'src/offline/sw.ts'),
            formats: ['es'],
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}
