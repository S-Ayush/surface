// PLAN-017 S1: the web manifest's icons. Vite hashes `index.html`'s own links into `assets/`
// (where the offline cache keeps them, ADR-0019) and copies the manifest file there too, but it
// doesn't read the icon URLs inside it. After the bundle, this plugin emits those icons as hashed
// assets and points the manifest at them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const SOURCE_PREFIX = '/src/brand/';

type Manifest = { readonly icons: readonly { readonly src: string }[] };

/** The manifest with each icon's `src` replaced by `urlFor(file name)`. */
export function withIconUrls(source: string, urlFor: (file: string) => string): string {
  const manifest = JSON.parse(source) as Manifest;
  const icons = manifest.icons.map((icon) => {
    if (!icon.src.startsWith(SOURCE_PREFIX)) throw new Error(`Unexpected icon path ${icon.src}`);
    return { ...icon, src: urlFor(icon.src.slice(SOURCE_PREFIX.length)) };
  });
  return `${JSON.stringify({ ...manifest, icons }, null, 2)}\n`;
}

/** Production builds only: in dev the manifest's `/src/brand/...` paths are served as they are. */
export function brandManifest(): Plugin {
  let root = '';
  return {
    name: 'surface-brand-manifest',
    apply: 'build',
    // After Vite's own asset handling, so the manifest is already in the bundle.
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const manifest = Object.values(bundle).find(
        (chunk) => chunk.type === 'asset' && /\.webmanifest$/.test(chunk.fileName),
      );
      if (manifest?.type !== 'asset') throw new Error('The web manifest is not in the build');
      const source =
        typeof manifest.source === 'string'
          ? manifest.source
          : Buffer.from(manifest.source).toString('utf8');
      manifest.source = withIconUrls(source, (file) => {
        const ref = this.emitFile({
          type: 'asset',
          name: file,
          source: readFileSync(path.join(root, 'src/brand', file)),
        });
        return `/${this.getFileName(ref)}`;
      });
    },
  };
}
