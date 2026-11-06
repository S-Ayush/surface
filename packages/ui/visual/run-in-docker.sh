#!/bin/sh
# Runs the visual tests in the pinned Playwright image (linux/amd64, like CI), so baselines are
# identical across machines. Usage: visual/run-in-docker.sh [--update-snapshots]
set -eu
IMAGE="mcr.microsoft.com/playwright:v1.65.0-noble"
ROOT="$(git rev-parse --show-toplevel)"
exec docker run --rm --init --ipc=host --platform linux/amd64 \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  -v "$ROOT:/work" -w /work/packages/ui \
  "$IMAGE" ./node_modules/.bin/playwright test -c visual/playwright.config.ts "$@"
