# PLAN-017: Brand in the app, and open-source groundwork

Implements: [brand v0.1](../05-design/brand.md) (§7 "Where the brand appears", decisions B-1 to B-4) · the user's decisions of 2026-11-25: **MIT licence**, and **prepare the repo for publishing but publish nothing yet** · Status: **Ready** · Date: 2026-11-25
Order: **S1 and S3 in parallel.** S4 after S3. S2 is held until the user decides on it.

---

## 1. Problem & goal

Surface now has a brand: a mark, a wordmark, a lockup and app icons ([brand.md](../05-design/brand.md)). None of it is in the product. The browser tab shows a blank icon, the sidebar shows nothing when an admin hasn't set a workspace logo, and the sign-in pages carry no identity.

The user also wants Surface to be open source under the MIT licence, with the descriptor *"The only open-source issue tracker your team needs."* Today the repo has no licence, the vision calls Surface "an internal tool, forever", and nothing tells an outside reader how to run, contribute or report a vulnerability.

The goal: the brand appears where brand.md §7 says it should, and the repo is ready to publish whenever the user decides, with nothing pushed or made public in this plan.

**Not in scope:** making the repo public, choosing a host, a project website, release automation, and a desktop app.

## 2. Modules touched

| Area | Paths |
| --- | --- |
| Brand components | `packages/ui/src/components/Brand/*` (new: `SurfaceMark`, `SurfaceLockup`), its story, `packages/ui/src/index.ts` |
| Web app | `apps/web/index.html`, `apps/web/src/brand/*` (new: icon files and the web manifest), `apps/web/src/shell/Sidebar.tsx` and `Shell.module.css`, `apps/web/src/pages/PublicPage.tsx` and `Pages.module.css`, `apps/web/src/routes/setup/SetupView.tsx` |
| Server | none in S1 (the CSP already allows same-origin images and the manifest). S2 would touch `apps/server/src/mail/*` |
| Repo | `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, every `package.json` (`license`), `CLAUDE.md`, `scripts/` (licence check) |
| Docs | `docs/01-vision/VISION.md`, `docs/02-product/PRD.md`, a new ADR, `docs/05-design/brand.md`, `docs/publishing.md` (new) |

No schema, sync, operation or wire changes. No new runtime dependencies.

## 3. Migration & rollback

Static assets, components, docs and metadata only. Each slice is one PR, and rollback is reverting it. A reverted favicon only leaves the old blank tab icon.

## 4. Slices

**Rules for every slice:** one branch and one PR named `p017-sN-<topic>`, with a green `pnpm check`. The testing hold ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)) applies: no new browser, e2e, visual or integration tests. Check by hand with a local headless Playwright screenshot, and record it in "As built".

### S1: Brand in the web app · M · ✅ Done 2026-11-25

- **Brand components** in `packages/ui`: `SurfaceMark` (the colour mark, or `mono` in `currentColor`) and `SurfaceLockup` (the colour mark, with the wordmark in `currentColor`). They are inline SVG, with path data copied from `docs/05-design/brand/assets/`. Decorative by default (`aria-hidden`). With a `title` prop they become `role="img"` with that name. They take a size, and the lockup scales from its height. A story covers both themes.
- **Favicon and icons** in `apps/web/src/brand/`, linked from `index.html` so Vite hashes them into `assets/`. The offline app cache only keeps `assets/` (ADR-0019, `vite-app-cache.ts`), so the icons also work offline. The links are `favicon.svg`, `favicon.ico` as the fallback, and `apple-touch-icon.png`.
- **Web manifest:** name "Surface", the icons 192, 512 and maskable 512, `display: standalone`, and `theme_color` / `background_color` taken from the tokens. Also `<meta name="theme-color">` for light and dark. If Vite can't hash the manifest and its icons into `assets/`, record what you did instead in "As built".
- **Sidebar fallback (B-3):** if the workspace has no logo, or the logo fails to load, the header shows `SurfaceMark` at the same size as the logo (`--avatar-sm`). A workspace logo still comes first.
- **Public pages:** `PublicPage` (sign-in, magic link, reset, invite) and the setup wizard show `SurfaceLockup` above the screen, 24 px tall, with the label "Surface".
- No change to the CSP, the server, or emails.

> **As built (S1).**
>
> - **Components:** `packages/ui/src/components/Brand/` (`Brand.tsx`, `paths.ts`, story). `SurfaceMark` takes `size` and `mono`; `SurfaceLockup` takes `height` (width follows the 156.794 : 32 ratio). Both accept `title`. The brand colours (#2EC4BF, #0A7A77) are `fill` attributes in the TSX, so component CSS stays token-only. The path data in `paths.ts` was extracted from `surface-mark.svg` and `surface-lockup-mono.svg` by script, not retyped; `ui/test/brand.test.tsx` reads those files and fails if the components drift.
> - **Icons:** `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192/512/maskable-512.png` and `manifest.webmanifest` are in `apps/web/src/brand/`, linked from `index.html` with `/src/brand/...` paths. Vite hashes them into `assets/`. `build.assetsInlineLimit` is set so files in `src/brand/` are never inlined as `data:` URLs (they are under 4 kB, so Vite would otherwise inline them and the manifest could not point at them).
> - **Manifest approach:** Vite hashes the manifest file but does not rewrite the icon URLs inside it. A small build plugin, `apps/web/vite-brand.ts` (`brandManifest`, build only, `enforce: 'post'`), emits the three icons as hashed assets in `generateBundle` and rewrites the manifest's `src` values to those names. So the built manifest, its icons, the favicons and the apple-touch icon are all under `assets/` and the offline cache keeps them without changing `vite-app-cache.ts`. In `vite dev` the manifest's `/src/brand/...` paths are served as they are. Checked on a real `vite build`: the manifest's icons point at `assets/icon-*-<hash>.png`, all present in `dist/assets/`. `theme_color` and `background_color` are #F3F4F6 (the light `--bg-app`); the manifest can't switch with the theme, so dark is covered by the two `<meta name="theme-color">` tags (#F3F4F6 light, #0B0D0F dark).
> - **Sidebar:** `WorkspaceLogo` renders `SurfaceMark` with the logo's class (`--avatar-sm`) when there is no logo or it fails to load. The logo still wins (B-3).
> - **Public screens:** `PublicPage`, `LoginPage` and the setup wizard's `Shell` show `SurfaceLockup` (24 px, title "Surface"). **Deviation from the brief:** the sign-in page is `pages/LoginPage.tsx`, not `PublicPage`, so it got the lockup separately. `Pages.module.css` has a `.publicColumn` (one column as wide as the card) shared by both; the wizard's `.page` became a column with a gap.
> - **Tests (jsdom or file-level only, all in the gate):** `ui/test/brand.test.tsx` (path match, brand colours and `currentColor`, aria-hidden vs named, sizing); `web/test/sidebar-brand.test.tsx` (the two fallbacks and the logo-first case); `web/test/public-page.test.tsx` (public page, sign-in, wizard); `web/test/index-html.test.ts` (icon, manifest and theme-colour links, one inline script, manifest fields); `web/test/brand-assets.test.ts` (the manifest rewrite, the offline cache list, the source files exist). The plan's `app-cache.test.ts` row is covered by `brand-assets.test.ts`, which tests `withIconUrls` and `appBuild` rather than a build output.
> - **Checked:** `pnpm check` green; `pnpm --filter @surface/ui test:storybook` passes both Brand stories (including the axe check) in both themes. Six `editor.stories.tsx` tests fail there on an `aria-expanded` axe violation in the editor; that is not from this slice (no editor file changed). A `vite build` was run and its output inspected. **Not checked:** no by-hand screenshot of the sidebar, sign-in or wizard (Docker was down, so no server stack), and the manifest's install behaviour in a browser, or that the server sends `.webmanifest` with the right content type, were not exercised.

### S2: Logo in emails · S · ⏸ held

SPEC-001 keeps emails image-free on purpose. This slice would put `email-lockup.png` into the magic-link, reset and invite emails as an inline CID attachment, which needs no remote fetch and so keeps CLAUDE.md rule 5. **It needs the user's decision** (a SPEC-001 decision row) before it starts.

### S3: Open-source groundwork · M · ✅ Done 2026-11-25

- `LICENSE`: MIT, "Copyright (c) 2026 The Surface contributors".
- `"license": "MIT"` in the root `package.json` and every workspace package. Packages stay `"private": true`, because nothing is published to npm.
- **ADR-0026, "Surface is open source under MIT":** context, options (MIT, Apache-2.0, AGPL-3.0), the decision, and its consequences. Its key points: the product scope does not change (one company per install, no commercial or cloud edition, no telemetry), contributions arrive under MIT, and brand use follows brand.md. Add it to `adr/README.md`.
- **VISION §5 principle 2** becomes "Free and open source, never sold". Update CLAUDE.md line 4 and PRD §1 to match, with a "Changed 2026-11-25" note.
- **README.md** for outside readers: the lockup in a `<picture>` that switches on the colour scheme, the descriptor, what Surface is, a quick start with Docker Compose, development setup (Node 24, pnpm 10, Docker), the doc map, and the licence. Keep the internal agent workflow in CLAUDE.md, not in the README.
- **CONTRIBUTING.md** (the slice workflow, `pnpm check`, Conventional Commits, scope rules and the out-of-scope list), **SECURITY.md** (report privately through the host's private vulnerability reporting, with no personal email address; the supported version is the latest release), and **CODE_OF_CONDUCT.md** (Contributor Covenant 2.1).
- **Licence check:** `pnpm licenses:check` fails when a production dependency has a licence outside an allowlist (MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, Unlicense, MIT-0, CC0-1.0, OFL-1.1, PSF-2.0). Exceptions are named one by one: today only `@img/sharp-libvips-*` (LGPL-3.0-or-later, dynamically linked). The gate runs it.
- brand.md B-4 becomes resolved.

> **As built (2026-11-25).**
>
> - **Files:** `LICENSE`, `README.md` (rewritten: the install section is kept from before, with a `<picture>` lockup, the descriptor, a doc map and the licence added), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, enforcement through the maintainers' private reporting, no email), [ADR-0026](../04-architecture/adr/0026-open-source-mit.md) and its row in `adr/README.md`. `"license": "MIT"` is in the root and all 11 workspace `package.json` files (apps, packages and `tests/sync-sim`); `"private": true` is unchanged.
> - **Docs changed:** VISION §5 principle 2 ("Free and open source, never sold", with the dated note), a dated note in PRD §1, CLAUDE.md line 4, and brand.md B-4 (resolved) and the descriptor line. No existing ADR said Surface was internal or proprietary, so none was superseded.
> - **Licence check:** the policy is pure code in `packages/config/licenses.js` (`ALLOWED_LICENSES`, `LICENSE_EXCEPTIONS`, `isAllowedExpression`, `findViolations`, exported as `@surface/config/licenses`). `scripts/check-licenses.mjs` runs `pnpm licenses list --prod --json` and calls it. Root script `licenses:check`; it is a root Turbo task (`//#licenses:check` in `turbo.json`, inputs: the lockfile, root `package.json`, the script and the policy file), and `pnpm check` and `pnpm check:fast` both run it. SPDX expressions are parsed: any side of an OR, every side of an AND. `@img/sharp-libvips-*` is accepted only with `LGPL-3.0-or-later`.
> - **Tests** (`packages/config/test/licence.test.ts`; `@surface/config` gained a `test` script and a `vitest.config.js`): "every package.json declares MIT", "LICENSE is the MIT text for the Surface contributors", "rejects GPL-3.0 and accepts the named libvips exception", "accepts OR expressions with one allowed side and rejects when none is allowed".
> - **Deviation:** the test file sits in `packages/config/test/` (as the test plan allowed) rather than under `scripts/`, so the existing `pnpm test` gate runs it.
> - **Notes for later:** `pnpm licenses` only lists what is installed, so on Linux the libvips package is `@img/sharp-libvips-linux-*`; the pattern covers it, but only the macOS arm64 install was checked here. Nothing was pushed, no remote was added and nothing was made public.

### S4: Publish readiness · S · _(needs S3)_ · ✅ Done 2026-11-25

- Scan the **full git history** for secrets (keys, tokens, passwords, private hosts and `.env` files). Report each hit by file and commit only, never by value. Any real secret means rotating it, and then rewriting history or publishing fresh history; the user decides which.
- Decide with the user which internal material stays private: `docs/07-plans/sessions/`, `.claude/`, review notes, and anything naming people.
- Write `docs/publishing.md`: the checklist to run on the day the repo goes public (scan, the private-material list, repo settings: private vulnerability reporting, branch protection, the licence detected by the host).

> **As built (2026-11-25).**
> - **Scan:** a read-only pattern scan of all 380 commits on every branch found no real secret. The only hits were test fixtures, documented examples and the all-zero dev `SESSION_SECRET`. Details are in the [coordination log](sessions/p017-coordination.md). `docs/publishing.md` repeats the scan with gitleaks (values redacted) on publishing day.
> - **The user's decisions:** publish the full history as it is (the author's own email is on the commits, and that is fine). Publish `docs/07-plans/sessions/` and `.claude/`. The home is `github.com/s-ayush/surface`.
> - **Gap fixed:** CI runs `pnpm lint`, not `pnpm check`, so S3's `licenses:check` never ran in CI. It is now part of the root `lint` script, and the CI step name says so.
> - **`.gitignore`:** now ignores `.claude/worktrees/`, so a slice worktree can't be committed.
> - **`docs/publishing.md`:** the day-of checklist. Before the push: the gate, a clean tree and the scan. Then create the repo private and push. While still private: private vulnerability reporting, rules for `main`, the About fields, features and Actions permissions. Then go public, verify, and record it.
> - **Not done, as the user decided:** nothing has been pushed, no remote has been added, and no image has been published.

## 5. Test plan (behaviour → test)

> ⏸ Browser, e2e, visual and integration tests are held. Names are proposals; a slice may adjust a file name but keeps the behaviour in the title.

| Slice | Required behaviour | Test |
| --- | --- | --- |
| S1 | The mark and lockup components draw the same paths as the brand SVG files | `ui/test/brand.test.tsx`: "SurfaceMark and SurfaceLockup match the brand asset paths" |
| S1 | The mark is decorative by default and named when given a title | `ui/test/brand.test.tsx`: "the mark is aria-hidden by default and role img with a title" |
| S1 | The sidebar shows the Surface mark when there is no workspace logo, or when it fails to load | `web/test/sidebar-brand.test.tsx`: "falls back to the Surface mark without a workspace logo" and "…when the logo fails" |
| S1 | A workspace logo still comes first | `web/test/sidebar-brand.test.tsx`: "shows the workspace logo instead of the mark" |
| S1 | Public pages and the setup wizard show the lockup named "Surface" | `web/test/public-page.test.tsx`: "public pages show the Surface lockup" |
| S1 | `index.html` links the favicon, the apple-touch icon, the manifest and the theme colours | `web/test/index-html.test.ts`: "index.html links the brand icons and manifest" |
| S1 | The built icons land under `assets/`, so the offline cache keeps them | `web/test/app-cache.test.ts`: "brand icons are hashed into assets" (on the build output, or via `appBuild`) |
| S1 | Brand stories have no axe violations in both themes | `pnpm test:storybook` (existing runner) |
| S3 | Every package declares the MIT licence | `scripts` test, or `config/test/licence.test.ts`: "every package.json declares MIT" |
| S3 | A production dependency outside the allowlist fails the check | `licenses:check` unit test with a fixture list: "rejects GPL-3.0 and accepts the named libvips exception" |
| S4 | — (a by-hand scan and a checklist; recorded in "As built") | — |
