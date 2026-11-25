# Surface: Brand

Status: **Draft v0.1** · Date: 2026-11-25 · Assets: [`brand/assets/`](brand/assets/) · Related: [design system](design-system.md) (tokens §2, iconography §2.7), [vision](../01-vision/VISION.md)

> The brand follows decision D-a in the [design system](design-system.md#8-decisions). Surface has its own identity: the teal accent, its own palette and its own logo. It takes nothing from Linear's branding. Every colour here is an existing token. The brand adds no new colours and no new fonts.

---

## 1. The idea

**Everything on the surface.**

Surface keeps your team's work on the client, so nothing hides behind a spinner or a round trip. Lists, boards and searches are already there when you look. The name and the mark say the same thing: the work sits at the surface, in plain view.

- **Line:** *Everything on the surface.*
- **Descriptor:** *The only open-source issue tracker your team needs.* (Chosen by the user, 2026-11-25. The licence question is resolved: see B-4.)
- **One sentence:** *Surface is a fast, keyboard-first issue tracker that one team hosts for itself, on its own server.*

Put the descriptor under the lockup on the sign-in page, in the README and in the docs, with the line near it. Don't use them inside the app chrome.

## 2. The mark

The mark is a rounded tile cut by one rising curve, the **surface line**:

- The **upper part** (Tide) is the surface, lit and in view.
- The **lower part** (Teal) is the body underneath.
- The curve rises from left to right, for progress. Turned on its side, it is a soft **S**.

The gap between the two parts is part of the mark, not a stroke. In single-colour use it is the only detail, so the mark still reads in one ink at 16 px.

### 2.1 Construction (32-unit grid)

| Part | Value |
| --- | --- |
| Tile | 32 × 32, corner radius 8 (25 %) |
| Surface line | Cubic Bézier `M0 22 C15 22 17 10 32 10`. Both ends are horizontal, so the line meets the straight sides of the tile square on |
| Gap | 2.75, measured along the curve's normal, so it keeps one width through the steep middle |
| Upper part | The tile above the line, minus half the gap. Fill **Tide** `#2EC4BF` |
| Lower part | The tile below the line, minus half the gap. Fill **Teal** `#0A7A77` |

The SVGs are plain paths: no masks, strokes, filters or embedded fonts. They render the same in browsers, email clients, design tools and `librsvg`.

### 2.2 Versions

| Version | Use | File |
| --- | --- | --- |
| Colour mark | The default everywhere, on light and dark | `surface-mark.svg` |
| Mono mark | One ink (`currentColor`): a coloured background, print, an embossed or engraved surface | `surface-mark-mono.svg` |
| iOS icon | Full bleed with square corners, because iOS cuts its own rounded shape (pre-rounded corners would fill with black). The gap is drawn in **Deep** `#04201F`, so nothing is transparent | `app-icon.svg`, `apple-touch-icon.png` |
| Desktop app icon | The rounded colour mark at 824 on a clear 1024 canvas, on the macOS icon grid. Chrome and Edge show the manifest's `any` icons as drawn on macOS and Windows, so this one carries its own corners | `app-icon-any.svg`, `icon-192.png`, `icon-512.png` |
| Maskable icon | The rounded mark at 62.5 % on Deep, inside the 80 % safe circle | `app-icon-maskable.svg`, `icon-maskable-512.png` |
| Favicon | The colour mark | `favicon.svg`, `favicon.ico` (16, 32, 48) |

### 2.3 Contrast

The colour mark works on both themes without a variant. In each theme one of the two parts carries the silhouette at 3:1 or more:

| Background | Tide (upper) | Teal (lower) |
| --- | --- | --- |
| White `#FFFFFF` | 2.15:1 | **5.17:1** |
| Light `--bg-app` `#F3F4F6` | 1.95:1 | **4.70:1** |
| Dark `--bg-app` `#0B0D0F` | **9.05:1** | 3.77:1 |
| Dark `--bg-panel` `#121518` | **8.52:1** | 3.54:1 |

WCAG exempts logos from contrast rules. We hold the mark to 3:1 anyway, so it stays visible.

### 2.4 Space and size

- **Clear space:** keep a quarter of the mark's height free on every side (8 units on the 32 grid). In a lockup, measure from the outer edges.
- **Minimum size:** the mark at 16 px, and the lockup at 20 px tall. Below 16 px, use no logo.
- **Pixel fit:** at 16, 24 and 32 px, align the tile to whole pixels so its edges stay sharp.

## 3. Wordmark and lockup

| Part | Value |
| --- | --- |
| Wordmark | "Surface" in **Inter** at weight **600**, tracking **−0.02em**, outlined to paths. Title case, never all caps or all lowercase |
| Lockup | The mark on the left of the wordmark. The mark is **1.375 ×** the cap height. The gap is **10/32** of the mark's height. The cap band is centred on the mark |
| Wordmark colour | Ink `#16181D` on light (`surface-lockup.svg`), Mist `#ECEEF1` on dark (`surface-lockup-dark.svg`), `currentColor` (`surface-lockup-mono.svg`, `surface-wordmark.svg`) |

The wordmark is outlined from the Inter file that the app already bundles (`@fontsource-variable/inter` 5.3), so it matches the UI exactly and needs no font at render time. Use the wordmark alone only where the mark already appears nearby, such as a page footer.

## 4. Colour

The brand palette is a subset of the existing tokens. Components keep using semantic tokens ([design system §2](design-system.md#2-tokens)). These names are for brand material only: the README, docs, slides and email.

| Name | Hex | Token it comes from | Role |
| --- | --- | --- | --- |
| **Teal** | `#0A7A77` | light `--accent` | The primary brand colour and the lower part of the mark |
| **Tide** | `#2EC4BF` | dark `--accent` | The upper part of the mark, and highlights on dark |
| **Deep** | `#04201F` | dark `--on-accent` | App icon ground, and dark brand backgrounds |
| **Foam** | `#E2F3F2` | light `--accent-subtle` | Quiet brand backgrounds on light |
| **Ink** | `#16181D` | light `--text-primary` | Text, and the wordmark on light |
| **Mist** | `#ECEEF1` | dark `--text-primary` | The wordmark on dark |
| **Slate** | `#0B0D0F` | dark `--bg-app` | The dark ground |
| **Paper** | `#FCFCFD` | light `--bg-panel` | The light ground |

**Proportion:** mostly neutral (Paper or Slate, with Ink or Mist), then a little Teal. Tide is for the mark and small highlights. This follows the product's rule of quiet chrome and loud content ([design system §1](design-system.md#1-design-principles)).

## 5. Type

The brand uses the product's two fonts and nothing more. Both are OFL and bundled locally, never loaded from a CDN (CLAUDE.md rule 5).

| Use | Font |
| --- | --- |
| Headlines in brand material | Inter 600, `--tracking-tight` or tighter (−0.02em) above 24 px |
| Body | Inter 450 |
| Identifiers, keys, code | JetBrains Mono |

## 6. Voice

Surface speaks like a calm, competent teammate. The product's content rules ([design system §6](design-system.md#6-content-style)) apply to brand material too.

- **Short and concrete.** "Opens in 40 ms." Not "Blazing-fast performance."
- **Owned, not sold.** No pricing, plans, "upgrade" or "enterprise" language. Surface is never sold (VISION §5).
- **Sentence case** everywhere except the name Surface.
- **No hype words:** revolutionary, seamless, supercharge, AI-powered.

## 7. Where the brand appears

| Place | What | Notes |
| --- | --- | --- |
| Browser tab | `favicon.svg`, with `favicon.ico` as the fallback. The title is "Surface", or "Page · Surface" | `apps/web/index.html` |
| iOS home screen and PWA | `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Needs a web manifest |
| Sidebar header | The **workspace logo** if an admin set one (FR-ADM-01), otherwise the colour mark at 20 px | The workspace's own identity comes first |
| Sign-in, setup, magic link and error pages | The lockup above the form, at 24–32 px tall | The line may sit under the form |
| Email (magic link, invite) | `email-lockup.png` (2×, shown at 157 × 32) | Inline it as a CID attachment, so the email never fetches a remote image |
| Docs and README | `surface-lockup.svg` / `-dark.svg` in a `<picture>` that switches on `prefers-color-scheme` | |
| Docker image | `org.opencontainers.image.title=Surface` and the descriptor as `…description` | |

**Wired (PLAN-017 S1, 2026-11-25):** the favicon, icons and manifest (`apps/web/src/brand/`), the sidebar fallback and the lockup on sign-in, the other public pages and the setup wizard (`SurfaceMark` and `SurfaceLockup` in `packages/ui`). The README shows the lockup and the descriptor (PLAN-017 S3). **Not wired yet:** the email header (PLAN-017 S2, held) and the Docker labels. The assets live under `docs/05-design/brand/assets/`; the app's copies in `apps/web/src/brand/` must match them.

## 8. Don'ts

- Don't recolour the mark outside the palette, add a gradient, or swap Tide and Teal.
- Don't flip or rotate it. The line always rises from left to right.
- Don't close the gap, draw it as a stroke, or outline the tile.
- Don't put the colour mark on Teal, Tide or a photo. Use the mono mark there.
- Don't stretch it, add a shadow or glow, or put it in another container shape.
- Don't set the wordmark in live text or another font. Use the outlined file.
- Don't use any of Linear's marks, colours or layouts in brand material.

## 9. Files

All of these are in [`brand/assets/`](brand/assets/).

| File | Size | Use |
| --- | --- | --- |
| `surface-mark.svg` · `surface-mark-mono.svg` | 32 × 32 | The mark |
| `surface-wordmark.svg` | 118.4 × 25.5 | The wordmark (`currentColor`) |
| `surface-lockup.svg` · `-dark.svg` · `-mono.svg` | 156.8 × 32 | The lockup |
| `favicon.svg` · `favicon.ico` | 32 / 16, 32, 48 | The browser tab |
| `app-icon.svg` · `apple-touch-icon.png` | 1024 / 180 | iOS home screen (square; iOS rounds it) |
| `app-icon-any.svg` · `icon-192.png` · `icon-512.png` | 1024 / 192 / 512 | Installed app on desktop (rounded, clear corners) |
| `app-icon-maskable.svg` · `icon-maskable-512.png` | 1024 / 512 | PWA maskable icon |
| `mark-32.png` · `mark-256.png` | 32 / 256 | Places that can't take SVG |
| `email-lockup.png` · `email-lockup-dark.png` | 314 × 64 | Email headers (2×) |

The SVGs are generated from the geometry in §2.1 and §3, and the PNGs are rendered from the SVGs. To change the mark, change those numbers here first, then regenerate every file, so the document and the files never disagree.

## 10. Decisions

| # | Decision | Date |
| --- | --- | --- |
| B-1 | **The mark is the split tile with the surface line.** Two other concepts were explored and dropped. A keycap with a home-row bump read as a face at small sizes. Two stacked bars were too generic. | 2026-11-25 |
| B-2 | **No new colours or fonts.** The brand palette is a subset of the existing tokens, and the wordmark is outlined from the bundled Inter. | 2026-11-25 |
| B-3 | **The workspace logo comes before the Surface mark** in the sidebar, because one install is one company (VISION §3). | 2026-11-25 |
| B-4 | **Surface is described as open source.** The descriptor is the user's. *Resolved by [ADR-0026](../04-architecture/adr/0026-open-source-mit.md): the licence is MIT, `LICENSE` and the `license` fields are in, and VISION §5 now reads "Free and open source, never sold".* | 2026-11-25 |
| B-5 | **Icons the OS masks are square; icons shown as drawn are rounded.** iOS (`apple-touch-icon`) and Android (the maskable icon) cut their own shape. The manifest's `any` icons are shown as drawn by desktop installs, so they carry the rounded tile. Changed after the user saw square corners on the 192 and 512 icons. | 2026-11-25 |
