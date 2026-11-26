# PLAN-018: The Surface website (landing page)

Implements: [brand v0.1](../05-design/brand.md) (descriptor, line, palette, type, voice) · [ADR-0026](../04-architecture/adr/0026-open-source-mit.md) · the user's request of 2026-11-25: a landing page that is fully SEO-optimised, with best-in-class animation · Status: **Done** (S1 2026-11-25, S2 2026-11-26; deploys once the user connects Cloudflare) · Date: 2026-11-25

---

## 1. Problem & goal

Surface is about to be published as open source ([publishing.md](../publishing.md)), and it has no public page. People who search for a self-hosted or open-source issue tracker should find it, understand it in one screen, and try it.

The goal is one fast, static landing page that:
- shows the product working, with a keyboard-driven demo rather than a screenshot;
- tells the truth about its state (Alpha, with M0 and M1 shipped);
- ranks for what people search for;
- follows the brand book.

## 2. Decisions

| # | Decision |
| --- | --- |
| W-1 | **Static, zero dependencies.** One `index.html` with inline CSS, one `site.js`, self-hosted fonts, and no framework, CDN or analytics (CLAUDE.md rule 5 in spirit, and the best Core Web Vitals). The script is a file, not inline, so ESLint covers it and the CSP can say `script-src 'self'` with no hashes to maintain. It lives in `apps/site/public/`, so the workspace's tooling and gate cover it. |
| W-2 | **Honest claims only.** Features are split into "In Surface today" (M0 and M1) and the roadmap (M2 to M7). Performance numbers are labelled as budgets (PRD NFR-01 to NFR-03, NFR-12). No ratings, reviews, user counts or logos. Simulations are labelled as simulations. |
| W-3 | **SEO targets** (from research on 2026-11-25). Primary: "open-source issue tracker", "self-hosted issue tracker". Secondary: "local-first issue tracker" (no open-source tracker owns it), "open-source Linear alternative", "self-hosted Jira alternative", "keyboard-first", "issue tracker for small teams". Directories (alternativeto.net, openalternative.co) dominate "Linear alternative", so a listing there is an off-page step for publish day. Linear is named only in the FAQ, as a fact ("inspired by Linear's model, not affiliated"). |
| W-4 | **Structured data.** `SoftwareApplication` (free offer, MIT, operating system) and `WebSite`. Google's software rich result needs ratings or reviews, which Surface doesn't have and won't invent, so no rich result is expected. FAQ markup is left out: Google limits FAQ rich results to a few site types. |
| W-5 | **Address and host.** Canonical `https://surface.pages.dev/` on Cloudflare Pages (user's decision, 2026-11-26: real response headers, and room for a domain later). The first version targeted `https://s-ayush.github.io/surface/` on GitHub Pages. `apps/site/README.md` lists every place the address appears. |
| W-6 | **Motion.** Every animation explains a claim. Content is readable without JS and at rest. Reveals use transform only, never opacity, so nothing hides waiting for an observer. `prefers-reduced-motion` turns motion off, and the demo does not auto-play then. |

## 3. Slices

### S1: Landing page · L · ✅ Done 2026-11-25

- `apps/site` (`@surface/site`): `public/index.html`, `404.html`, `robots.txt`, `sitemap.xml`, `assets/` (favicons, lockups, OG image) and `fonts/` (Inter and JetBrains Mono, OFL, copied from the bundled `@fontsource-variable` files).
- Sections: nav · hero with the surface line and the interactive demo · budgets · three pillars · the sync simulation · features today · self-host terminal · open source · roadmap · FAQ · final call to action · footer.
- **Test** (`apps/site/test/site.test.ts`): the title and description lengths; canonical, Open Graph and Twitter tags; the JSON-LD parses and has the required fields; exactly one `h1`; no skipped heading levels; every image has `alt`; every local `href`/`src` resolves to a file; no external `src` (scripts, styles, fonts, images); `sitemap.xml` and `robots.txt` agree with the canonical address.
- No deploy in this slice: publishing waits for the user ([publishing.md](../publishing.md)).

> **As built (2026-11-25):**
> - **Files:** `apps/site/public/` holds `index.html` (about 85 KB, roughly 20 KB gzipped, CSS and the logo sprite inline), `site.js` (no dependencies), `404.html` (self-contained, `noindex`), `robots.txt`, `sitemap.xml`, `assets/` and `fonts/` (88 KB). Nothing else loads, and the OG image is fetched only by link previews.
> - **CSP** in a `<meta>` (GitHub Pages can't set headers): `default-src 'self'; script-src 'self'; connect-src 'none'`, plus `style-src 'unsafe-inline'` for the inline CSS. `frame-ancestors` can't be set from a meta tag.
> - **Demo:** a simplified copy of the list. Its keys are the shipped M0 and M1 shortcuts (`J`/`K`, `S`, `P` with `0`–`4`, `I`, `C`, `Mod+K`, `Esc`), and its groups come in Linear's order (started, unstarted, backlog, closed). The autoplay loop stops at the visitor's first click or focus, never takes focus, pauses off screen, and doesn't run with reduced motion. The pill shows this page's own render time, and the budgets note says so.
> - **Copy changed from the first draft** to stay true for M1: global search and filters are M2, so the hero says "opening and changing issues never waits on the network", not search. Private teams (M7) are not claimed.
> - **Deploy:** `.github/workflows/pages.yml`, `workflow_dispatch` only, plus [publishing.md](../publishing.md) §6 (Pages, Search Console, directory listings). Nothing deployed.
> - **Verified:** `site.test.ts` (13 tests), and by hand in headless Chromium on a local server: 1440 and 390 px wide, light and dark, no console errors, no request to another origin, no horizontal scroll. A scripted run drove the demo (keys, picker, composer, command menu, no page scroll from demo keys), the sync simulation (local change, delivery, offline queue, flush) and the terminal. With reduced motion nothing plays; with JavaScript off all the content is present.
> - **Not verified:** Lighthouse or real Core Web Vitals (no network here); Safari and Firefox; a real screen reader; how search engines index it, which needs the deployed page.
> - **Lint gap:** Stylelint checks `*.css` files only, so the inline CSS in `index.html` uses raw hex and px values, as the brand book does. Prettier formats the HTML.

### S2: Host on Cloudflare Pages · S · ✅ Done 2026-11-26

- `public/_headers`: the page's CSP as a real header, plus `frame-ancestors 'none'`, HSTS, `nosniff`, a referrer policy, a permissions policy, COOP, and cache rules for `fonts/` and `assets/`.
- The canonical address becomes `https://surface.pages.dev/` everywhere. `.github/workflows/pages.yml` and `.nojekyll` are removed.
- Cloudflare builds from Git (the user connects it; [publishing.md](../publishing.md) §6): no build command, output `apps/site/public`, `SKIP_DEPENDENCY_INSTALL=1`, watch path `apps/site/*`.
- **Test:** `site.test.ts` checks that the `_headers` policy equals the page's meta policy plus `frame-ancestors 'none'`, and that HSTS and `nosniff` are set. It fails when the two policies drift (checked by changing `connect-src` in `_headers`).

> **As built (2026-11-26):** the meta CSP stays, so the policy still holds if the page is served somewhere without the headers file. Both policies apply, and they are the same. `surface.pages.dev` is assumed to be free; if Cloudflare appends a suffix, change the address in the places `apps/site/README.md` lists. Not verified: the deployed headers, which need the live project.
