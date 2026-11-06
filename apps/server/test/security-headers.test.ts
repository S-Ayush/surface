// SPEC-004 §15 (AC-14): every response the app routes carries a strict Content-Security-Policy.
// The only inline script, the theme bootstrap in index.html, is allowed by its sha256 hash, read
// from the served file at startup.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, inlineScriptHashes } from '../src/http/security-headers.js';
import { fakeWebDir, testApp, type TestApp } from './helpers.js';

// Computed with `printf '…' | openssl dgst -sha256 -binary | base64`, independently of the code.
const ALERT = { code: 'alert(1)', hash: "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='" };
const CAFE = {
  code: '\n  document.title = "café";\n',
  hash: "'sha256-S1YWprUc7I8SyLisAZqvS6PyWzGMTqw9SkSR/79K+JA='",
};
/** `a = 1;\nb = 2;\n`: what the browser hashes for the same script saved with CRLF or CR. */
const LINES = { hash: "'sha256-kAIU3sInQvEeCNBuJdVHmhjRUJwtmLykss1IgL06IwY='" };
/**
 * The theme bootstrap in `apps/web/index.html`, which Vite copies byte for byte into the build
 * (PLAN-005 S1). Extracted with Python and hashed with openssl; the same value Chromium accepted
 * on the built page. Update it when the bootstrap script changes.
 */
const THEME_BOOTSTRAP_HASH = "'sha256-w+nvaeLVNhclO6tqTz4g11FUiAKSTRLPdrVoK5TMAFU='";
const WEB_INDEX = path.resolve(import.meta.dirname, '../../web/index.html');

const page = (...scripts: string[]) =>
  `<!doctype html><html><head><title>Surface</title>${scripts.join('')}</head><body></body></html>`;

/** The policy as a map of directive → sources. */
function directives(policy: string | undefined): Map<string, string[]> {
  return new Map(
    (policy ?? '').split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('inline script hashes', () => {
  it('hashes the exact text of each inline script, whitespace and non-ASCII included', () => {
    expect(inlineScriptHashes(page(`<script>${ALERT.code}</script>`))).toEqual([ALERT.hash]);
    expect(inlineScriptHashes(page(`<script type="module">${CAFE.code}</script>`))).toEqual([
      CAFE.hash,
    ]);
  });

  it('skips scripts loaded from a file and lists a repeated script once', () => {
    const html = page(
      `<script type="module" crossorigin src="/assets/index-abc.js"></script>`,
      `<script>${ALERT.code}</script>`,
      `<SCRIPT>${ALERT.code}</SCRIPT >`,
    );
    expect(inlineScriptHashes(html)).toEqual([ALERT.hash]);
  });

  it('hashes CRLF and CR line endings as LF, like the HTML parser', () => {
    expect(inlineScriptHashes(page('<script>a = 1;\r\nb = 2;\r\n</script>'))).toEqual([LINES.hash]);
    expect(inlineScriptHashes(page('<script>a = 1;\rb = 2;\r</script>'))).toEqual([LINES.hash]);
  });

  it("finds exactly the web app's theme bootstrap in its real index.html", () => {
    expect(inlineScriptHashes(readFileSync(WEB_INDEX, 'utf8'))).toEqual([THEME_BOOTSTRAP_HASH]);
  });
});

describe('the policy', () => {
  // SPEC-004 §15, directive by directive.
  it('is exactly the §15 table', () => {
    expect(Object.fromEntries(directives(contentSecurityPolicy([ALERT.hash])))).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", ALERT.hash],
      'style-src': ["'self'"],
      'font-src': ["'self'", 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('names no other origin, scheme or keyword: no unsafe-inline, unsafe-eval or wildcard', () => {
    // Guards later edits as well as the table: anything else must change §15 first.
    for (const [directive, sources] of directives(contentSecurityPolicy([ALERT.hash]))) {
      for (const source of sources) {
        const allowed =
          source === "'self'" ||
          source === "'none'" ||
          /^'sha256-[A-Za-z0-9+/]{43}='$/.test(source) ||
          ((source === 'data:' || source === 'blob:') &&
            (directive === 'font-src' || directive === 'img-src'));
        expect(allowed, `${directive} ${source}`).toBe(true);
      }
    }
  });
});

describe('content security policy on responses', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.app.close();
  });

  it("allows the app page's inline script by its hash, and other scripts only from the server", async () => {
    t = await testApp({ webDir: fakeWebDir(page(`<script>${ALERT.code}</script>`)) });
    const res = await t.app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(
      directives(res.headers['content-security-policy']?.toString()).get('script-src'),
    ).toEqual(["'self'", ALERT.hash]);
  });

  it('sends the same policy on every response: page, asset, API error and health', async () => {
    t = await testApp({ webDir: fakeWebDir(page(`<script>${ALERT.code}</script>`)) });
    const policies = await Promise.all(
      [
        { url: '/team/ENG', headers: { accept: 'text/html' } },
        { url: '/assets/index-abc123.js' },
        { url: '/api/nope' },
        { url: '/healthz' },
      ].map(async (request) => (await t.app.inject(request)).headers['content-security-policy']),
    );
    expect(new Set(policies)).toEqual(new Set([contentSecurityPolicy([ALERT.hash])]));
  });

  it('allows no inline script when the web app is not built', async () => {
    t = await testApp({ webDir: '/definitely/not/here' });
    const res = await t.app.inject({ url: '/healthz' });
    expect(
      directives(res.headers['content-security-policy']?.toString()).get('script-src'),
    ).toEqual(["'self'"]);
  });
});
