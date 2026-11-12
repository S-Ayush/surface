// ADR-0019: what the build writes into the worker: the page and the build's own files (no source
// maps), and a build id that changes whenever they do, so browsers install the new worker.
import { describe, expect, it } from 'vitest';
import { appBuild } from '../vite-app-cache.js';

const INDEX = '<script type="module" src="/assets/index-abc.js"></script>';

describe('the build the worker caches', () => {
  it('lists the page first, then every file under assets/, without source maps', () => {
    const build = appBuild(
      ['assets/index-abc.js', 'assets/index-abc.js.map', 'assets/index-def.css', 'favicon.svg'],
      INDEX,
    );
    expect(build.files).toEqual(['/index.html', '/assets/index-abc.js', '/assets/index-def.css']);
  });

  it('has an id that is the same for the same build and changes with its files or page', () => {
    const files = ['assets/index-abc.js', 'assets/index-def.css'];
    const id = appBuild(files, INDEX).id;
    expect(appBuild([...files].reverse(), INDEX).id).toBe(id);
    expect(appBuild(['assets/index-abd.js', 'assets/index-def.css'], INDEX).id).not.toBe(id);
    expect(appBuild(files, `${INDEX}<!-- changed -->`).id).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
