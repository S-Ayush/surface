# @surface/site

The public landing page ([PLAN-018](../../docs/07-plans/PLAN-018-website.md)). `public/` is the site, served as is: there is no build step, framework or bundler.

| File                | What it is                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `public/index.html` | The page: markup, inline CSS, structured data, and the logo as an inline SVG sprite           |
| `public/site.js`    | The keyboard demo, the sync simulation, the install terminal and the shortcut keys            |
| `public/404.html`   | Self-contained not-found page (GitHub Pages serves it for any missing path)                   |
| `public/assets/`    | Favicons and lockups copied from `docs/05-design/brand/assets/`, and the 1200 × 630 OG image  |
| `public/fonts/`     | Inter and JetBrains Mono (OFL), copied from the `@fontsource-variable` packages the app uses  |
| `test/site.test.ts` | SEO tags, structured data, headings, links and anchors, no external resources, the CSP, brand |

## Look at it

```sh
pnpm --filter @surface/site preview   # http://127.0.0.1:4173/
```

## Rules

- **Nothing from another origin.** No CDN, font service, analytics or embed. The page's content security policy has `connect-src 'none'`, and the test fails on any external `src`, stylesheet or `url()`. This is what "no telemetry" looks like on our own page.
- **Only claims that are true today.** Features are what has shipped. Numbers are the PRD's performance budgets, labelled as budgets. No ratings, reviews, user counts or customer logos (PLAN-018 W-2).
- **The page works without JavaScript**, and nothing auto-plays with reduced motion (W-6).
- **Brand files are copies.** The test fails when a favicon or the logo path data drifts from `docs/05-design/brand/assets/`.

## The address

The canonical address is `https://s-ayush.github.io/surface/`. To move to another domain, change it in all of these:

- `public/index.html`: `canonical`, `og:url`, `og:image`, `twitter:image` and the JSON-LD `@id`, `url` and `image`;
- `public/404.html`: the home link;
- `public/robots.txt` and `public/sitemap.xml`;
- `test/site.test.ts`: `SITE`;
- [docs/publishing.md](../../docs/publishing.md) §6.

Publishing is manual: see [docs/publishing.md](../../docs/publishing.md) §6.
