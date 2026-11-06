// SPEC-004 §15 (AC-14): every response carries a strict Content-Security-Policy. The only inline
// script, the theme bootstrap in index.html, is allowed by its sha256 hash, read from the served
// file at startup.
import { afterEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, inlineScriptHashes } from '../src/http/security-headers.js';
import { fakeWebDir, testApp, type TestApp } from './helpers.js';

// Computed with `printf '…' | openssl dgst -sha256 -binary | base64`, independently of the code.
const ALERT = { code: 'alert(1)', hash: "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='" };
const CAFE = {
  code: '\n  document.title = "café";\n',
  hash: "'sha256-S1YWprUc7I8SyLisAZqvS6PyWzGMTqw9SkSR/79K+JA='",
};

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
});

describe('content security policy', () => {
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

  it('never allows inline code by keyword, plugins, framing or a moved base URL', () => {
    const policy = directives(contentSecurityPolicy([ALERT.hash]));
    const all = [...policy.values()].flat();
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
    expect(all).not.toContain('*');
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('style-src')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
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
