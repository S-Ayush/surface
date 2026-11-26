// @vitest-environment jsdom
// PLAN-018 S1: the landing page's search, sharing and self-containment rules, checked on the files
// as they are published (apps/site/public is served as is).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SITE = 'https://surface.pages.dev/';
const PUBLIC = join(import.meta.dirname, '..', 'public');
const BRAND = join(import.meta.dirname, '..', '..', '..', 'docs', '05-design', 'brand', 'assets');

const read = (file: string): string => readFileSync(join(PUBLIC, file), 'utf8');
const parse = (file: string): Document => new DOMParser().parseFromString(read(file), 'text/html');
const index = parse('index.html');

const meta = (doc: Document, selector: string): string => {
  const el = doc.querySelector(selector);
  expect(el, selector).not.toBeNull();
  return el?.getAttribute('content') ?? '';
};

function jsonLd(): Record<string, unknown>[] {
  const script = index.querySelector('script[type="application/ld+json"]');
  const data: unknown = JSON.parse(script?.textContent ?? '');
  if (
    typeof data !== 'object' ||
    data === null ||
    !('@graph' in data) ||
    !Array.isArray(data['@graph'])
  ) {
    throw new Error('JSON-LD needs an @graph array');
  }
  return data['@graph'].filter(
    (node: unknown): node is Record<string, unknown> => typeof node === 'object' && node !== null,
  );
}

const isExternal = (url: string): boolean => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url);

describe('the landing page for search engines', () => {
  it('has a title and description of a length search results show in full', () => {
    expect(index.title.length).toBeGreaterThanOrEqual(30);
    expect(index.title.length).toBeLessThanOrEqual(65);
    const description = meta(index, 'meta[name="description"]');
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(index.documentElement.lang).toBe('en');
  });

  it('names one canonical address, used by every sharing tag', () => {
    expect(index.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE);
    expect(meta(index, 'meta[property="og:url"]')).toBe(SITE);
    expect(meta(index, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
      const image = meta(index, selector);
      expect(image.startsWith(SITE), selector).toBe(true);
      expect(existsSync(join(PUBLIC, image.slice(SITE.length))), image).toBe(true);
    }
    expect(meta(index, 'meta[property="og:image:width"]')).toBe('1200');
    expect(meta(index, 'meta[property="og:image:height"]')).toBe('630');
  });

  it('describes the software in structured data without invented ratings', () => {
    const graph = jsonLd();
    const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
    expect(app).toBeDefined();
    expect(app?.name).toBe('Surface');
    expect(app?.url).toBe(SITE);
    expect(app?.license).toBe('https://opensource.org/license/mit');
    expect(app?.offers).toMatchObject({ '@type': 'Offer', price: '0' });
    // PLAN-018 W-2, W-4: Surface has no ratings or reviews, so the markup claims none.
    expect(app).not.toHaveProperty('aggregateRating');
    expect(app).not.toHaveProperty('review');
    expect(graph.find((node) => node['@type'] === 'WebSite')?.url).toBe(SITE);
  });

  it('has exactly one h1 and never skips a heading level', () => {
    expect(index.querySelectorAll('h1')).toHaveLength(1);
    let previous = 0;
    for (const heading of index.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const level = Number(heading.tagName.slice(1));
      expect(level, heading.textContent ?? '').toBeLessThanOrEqual(previous + 1);
      previous = level;
    }
  });

  it('lists the canonical address in the sitemap and robots.txt', () => {
    expect(read('sitemap.xml')).toContain(`<loc>${SITE}</loc>`);
    expect(read('robots.txt')).toContain(`Sitemap: ${SITE}sitemap.xml`);
  });

  it('keeps the not-found page out of the index', () => {
    expect(meta(parse('404.html'), 'meta[name="robots"]')).toBe('noindex');
  });
});

describe('the landing page as a self-contained site', () => {
  it.each(['index.html', '404.html'])('%s loads nothing from another origin', (file) => {
    const doc = parse(file);
    for (const el of doc.querySelectorAll('script[src], img[src], iframe, link[rel]')) {
      const rel = el.getAttribute('rel') ?? '';
      const url = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
      if (rel === 'canonical') continue; // an address, not a resource
      expect(isExternal(url), `${el.tagName} ${url}`).toBe(false);
    }
    for (const match of read(file).matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      expect(isExternal(match[1] ?? ''), match[0]).toBe(false);
    }
  });

  it.each(['index.html', '404.html'])(
    '%s sets a content security policy with no outbound connections',
    (file) => {
      const policy = meta(parse(file), 'meta[http-equiv="Content-Security-Policy"]');
      expect(policy).toMatch(/default-src '(self|none)'/);
      if (policy.includes('connect-src')) expect(policy).toContain("connect-src 'none'");
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    },
  );

  it('sends the same policy as a header, plus the anti-framing rule a meta tag cannot set', () => {
    // Cloudflare Pages reads public/_headers (PLAN-018 S2).
    const headers = read('_headers');
    const header =
      /^\/\*\n(?:[ \t]+.*\n)*?[ \t]+Content-Security-Policy: (.+)$/m.exec(headers)?.[1] ?? '';
    const directives = (policy: string): string[] =>
      policy
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);
    const page = directives(meta(index, 'meta[http-equiv="Content-Security-Policy"]'));
    expect(directives(header).filter((d) => !d.startsWith('frame-ancestors'))).toEqual(page);
    expect(directives(header)).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/^[ \t]+Strict-Transport-Security: max-age=\d+/m);
    expect(headers).toMatch(/^[ \t]+X-Content-Type-Options: nosniff$/m);
  });

  it('resolves every local link, file and in-page anchor', () => {
    for (const el of index.querySelectorAll('[href], [src]')) {
      const url = el.getAttribute('href') ?? el.getAttribute('src') ?? '';
      if (isExternal(url) || url === './') continue;
      if (url.startsWith('#')) {
        expect(index.getElementById(url.slice(1)), url).not.toBeNull();
      } else {
        expect(existsSync(join(PUBLIC, url)), url).toBe(true);
      }
    }
    for (const match of read('index.html').matchAll(/url\('([^']+)'\)/g)) {
      expect(existsSync(join(PUBLIC, match[1] ?? '')), match[1]).toBe(true);
    }
  });

  it('labels every meaningful image and hides decorative ones', () => {
    for (const img of index.querySelectorAll('img')) expect(img.hasAttribute('alt')).toBe(true);
    for (const svg of index.querySelectorAll('svg[role="img"]')) {
      expect(svg.getAttribute('aria-label'), svg.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });

  it('draws the logo from the brand assets', () => {
    const lockup = readFileSync(join(BRAND, 'surface-lockup.svg'), 'utf8');
    const html = read('index.html');
    for (const [, d] of lockup.matchAll(/ d="([^"]+)"/g)) expect(html).toContain(d);
    for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
      expect(readFileSync(join(PUBLIC, 'assets', file)), file).toEqual(
        readFileSync(join(BRAND, file)),
      );
    }
  });
});
