#!/usr/bin/env bash
# Smoke test of the image and the bundled compose stack (PLAN-004 S5).
# Builds the image, starts docker/docker-compose.yml with only the values
# .env.example asks for, waits for /readyz and the Docker health check, runs
# `surface doctor`, checks the uid and the JSON logs, then removes everything.
#
#   scripts/docker-smoke.sh
#   SURFACE_SMOKE_IMAGE=surface:local SKIP_BUILD=1 SURFACE_SMOKE_PORT=3200 scripts/docker-smoke.sh
#   SURFACE_SMOKE_READ_ONLY=1 scripts/docker-smoke.sh   # read-only root filesystem (AC-4)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
image=${SURFACE_SMOKE_IMAGE:-surface:smoke}
port=${SURFACE_SMOKE_PORT:-3000}
timeout=${SURFACE_SMOKE_TIMEOUT:-120}
project="surface-smoke-$$"
work=$(mktemp -d)

files=(-f "$work/docker-compose.yml")
if [[ -n "${SURFACE_SMOKE_READ_ONLY:-}" ]]; then
  # AC-4: only /data (a volume) and /tmp are writable.
  printf 'services:\n  app:\n    read_only: true\n    tmpfs: [/tmp]\n' >"$work/read-only.yml"
  files+=(-f "$work/read-only.yml")
fi
dc() { docker compose -p "$project" --project-directory "$work" "${files[@]}" "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() {
  echo "✗ $*" >&2
  dc logs --no-color app >&2 || true
  exit 1
}
# Poll `$1` (a command) once a second until it succeeds or `$timeout` seconds pass.
wait_for() {
  local what=$1 deadline=$((SECONDS + timeout))
  shift
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || fail "timed out after ${timeout}s waiting for $what"
    sleep 1
  done
}

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "→ building $image"
  docker build -f "$root/docker/Dockerfile" -t "$image" \
    --build-arg SURFACE_COMMIT="$(git -C "$root" rev-parse --short HEAD)" "$root"
fi

echo "→ starting the compose stack ($project) on 127.0.0.1:$port${SURFACE_SMOKE_READ_ONLY:+, read-only root}"
cp "$root/docker/docker-compose.yml" "$work/"
# The README steps: fill in only the required values of .env.example.
sed -e "s|^SURFACE_URL=.*|SURFACE_URL=http://localhost:$port|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^SURFACE_BIND=.*|SURFACE_BIND=127.0.0.1|" \
  -e "s|^SURFACE_PORT=.*|SURFACE_PORT=$port|" \
  -e "s|^SURFACE_VERSION=.*|SURFACE_VERSION=${image##*:}|" \
  -e "s|^#SURFACE_IMAGE=.*|SURFACE_IMAGE=${image%:*}|" \
  "$root/docker/.env.example" >"$work/.env"
dc up -d --quiet-pull

wait_for "/readyz" curl -fsS "http://127.0.0.1:$port/readyz"
echo "✓ /readyz: $(curl -fsS "http://127.0.0.1:$port/readyz")"

curl -fsS "http://127.0.0.1:$port/" | grep -qi '<!doctype html' || fail "/ does not serve the web app"
echo "✓ / serves the web app"

container=$(dc ps -q app)
wait_for "the Docker health check" \
  bash -c "[[ \$(docker inspect -f '{{.State.Health.Status}}' $container) == healthy ]]"
echo "✓ Docker health check: healthy"

uid=$(dc exec -T app id -u)
[[ $uid == 10001 ]] || fail "the app runs as uid $uid, not 10001"
echo "✓ runs as uid 10001"

dc exec -T app surface doctor || fail "surface doctor reported a problem"
dc exec -T app surface version

non_json=$(dc logs --no-color --no-log-prefix app | grep -cv '^{' || true)
[[ $non_json == 0 ]] || fail "$non_json app log lines are not JSON"
echo "✓ every app log line is JSON"

echo "✓ smoke test passed"
