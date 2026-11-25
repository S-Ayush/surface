# ADR-0026: Surface is open source under MIT

Status: **Accepted** (decided by the user, 2026-11-25) · Date: 2026-11-25 · Changes [VISION §5](../../01-vision/VISION.md) principle 2; no ADR is superseded.

## Context
Until now Surface had no licence and VISION §5 called it "an internal tool, forever". The user wants Surface to be open source, with the descriptor "The only open-source issue tracker your team needs." ([brand.md](../../05-design/brand.md)). Without a licence file, nobody outside the project may legally use or change the code, so the descriptor would be false. The user also decided to prepare the repo for publishing but to publish nothing yet ([PLAN-017](../../07-plans/PLAN-017-brand-open-source.md)).

No accepted ADR says Surface is internal or proprietary, so none needs superseding.

## Options
1. **MIT.** Short and permissive. Anyone may use, change, host and sell it, if they keep the copyright notice.
2. **Apache-2.0.** Permissive too, with an explicit patent grant and a longer text.
3. **AGPL-3.0.** Strong copyleft. A hosted fork must publish its changes. It would block a closed hosted copy, but many companies refuse to run AGPL software at all.

## Decision
MIT, as the user chose, for the widest adoption and the shortest text. `LICENSE` reads "Copyright (c) 2026 The Surface contributors", and every `package.json` declares `"license": "MIT"`. Packages stay `"private": true`, because nothing is published to npm.

The trade-off is stated plainly: MIT lets anyone run a closed, hosted fork of Surface, with no duty to share their changes. We accept that.

## Consequences
+ Anyone can read, run and change Surface. The descriptor is true.
+ The scope does not change. One company per install, no commercial or cloud edition, no multi-tenancy, no telemetry, no built-in AI ([VISION §6](../../01-vision/VISION.md)). Open source is about the licence, not a new audience.
+ Contributions arrive under MIT (inbound = outbound). There is no CLA. `CONTRIBUTING.md` says so.
+ Brand use follows [brand.md](../../05-design/brand.md). The MIT licence covers the code and docs, and it grants no right to present a fork as Surface itself.
+ Dependency licences are checked by the gate. `pnpm licenses:check` fails when a production dependency has a licence outside an allowlist (MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, Unlicense, MIT-0, CC0-1.0, OFL-1.1, PSF-2.0, or an OR-expression with an allowed side). The one named exception is `@img/sharp-libvips-*` (LGPL-3.0-or-later, linked dynamically). A new exception needs an ADR.
− Closed hosted forks are allowed (see above).
− The repo now needs a public-facing surface: README, CONTRIBUTING, SECURITY and a code of conduct. They are part of PLAN-017 S3.
