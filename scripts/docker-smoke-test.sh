#!/usr/bin/env bash
# Executes the exact steps docs/public/install.md documents for a first run and an upgrade —
# build, boot, read the generated password, restart, recreate against the same volume — and
# fails loudly if any of them stop working. This replaces a manual pass that was never committed
# as a script with something CI runs on every push and PR, so a broken Docker image is caught
# before it can be tagged and published.
#
# Does not attempt a full authenticated sign-in through the web UI — that's already covered by
# the Playwright e2e auth spec (packages/web/tests/e2e), against the app directly rather than a
# container. This script's job is the container/volume lifecycle the e2e suite can't exercise.
#
# Usage: scripts/docker-smoke-test.sh [image-tag]
#   image-tag defaults to rulebeat:smoke-test. Pass an existing tag to skip the build step,
#   e.g. from CI where the image was already built by a prior step.

set -euo pipefail

IMAGE="${1:-rulebeat:smoke-test}"
RUN_ID="$$-$(date +%s)"
CONTAINER="rulebeat-smoke-${RUN_ID}"
VOLUME="rulebeat-smoke-data-${RUN_ID}"
PORT="${SMOKE_TEST_PORT:-13000}"
BASE_URL="http://127.0.0.1:${PORT}"

log() { echo "[smoke-test] $*"; }

cleanup() {
  log "cleaning up"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_http() {
  local tries=60
  while (( tries > 0 )); do
    if curl -s -o /dev/null "$BASE_URL"; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 2
  done
  log "ERROR: $BASE_URL never responded"
  docker logs "$CONTAINER" || true
  return 1
}

read_password() {
  docker exec "$CONTAINER" cat data/initial-password.txt
}

if [[ "${2:-}" != "--skip-build" ]] && ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building $IMAGE"
  docker build -t "$IMAGE" .
fi

log "starting container from a fresh volume"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" --restart unless-stopped -p "127.0.0.1:${PORT}:3000" -v "${VOLUME}:/app/packages/web/data" "$IMAGE" >/dev/null

log "waiting for first boot"
wait_for_http

log "checking /api/health — the liveness endpoint HEALTHCHECK and orchestrators probe"
HEALTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/health")"
if [[ "$HEALTH_STATUS" != "200" ]]; then
  log "ERROR: /api/health returned $HEALTH_STATUS, expected 200"
  exit 1
fi
log "/api/health returned 200, ok"

log "reading generated admin password — exactly the docs/public/install.md 'First sign-in' command"
PASSWORD_1="$(read_password)"
if [[ -z "$PASSWORD_1" ]]; then
  log "ERROR: data/initial-password.txt was empty on first boot"
  exit 1
fi
log "password file has $( printf '%s' "$PASSWORD_1" | wc -c ) bytes — non-empty, ok"

log "restarting the container (same container, same volume)"
docker stop "$CONTAINER" >/dev/null
docker start "$CONTAINER" >/dev/null
wait_for_http

PASSWORD_2="$(read_password)"
if [[ "$PASSWORD_1" != "$PASSWORD_2" ]]; then
  log "ERROR: password changed across a restart of the same container — should be stable"
  exit 1
fi
log "password survived a restart, ok"

log "recreating the container against the same volume (simulates an upgrade: docker rm + docker run)"
docker rm -f "$CONTAINER" >/dev/null
docker run -d --name "$CONTAINER" --restart unless-stopped -p "127.0.0.1:${PORT}:3000" -v "${VOLUME}:/app/packages/web/data" "$IMAGE" >/dev/null
wait_for_http

PASSWORD_3="$(read_password)"
if [[ "$PASSWORD_1" != "$PASSWORD_3" ]]; then
  log "ERROR: password changed after recreating the container — the volume did not persist, or the app re-seeded on top of existing data"
  exit 1
fi
log "password survived container recreation against the same volume, ok"

# Proves the restart policy actually recovers a crash, not merely that HEALTHCHECK reports
# `healthy` after a normal boot, which was the riskiest gap when the restart policy was added.
# `kill 1` sends SIGTERM to the container's PID 1 (the `next start` process),
# which is what a real crash looks like from Docker's perspective — no `docker stop`/`docker kill`
# involved, since those would be an intentional stop the restart policy is not meant to override.
log "killing the container's main process to verify the restart policy actually recovers a crash"
RESTARTS_BEFORE="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")"
docker exec "$CONTAINER" sh -c 'kill 1'

RECOVERY_TRIES=30
while (( RECOVERY_TRIES > 0 )); do
  RESTARTS_NOW="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo "$RESTARTS_BEFORE")"
  if (( RESTARTS_NOW > RESTARTS_BEFORE )); then
    break
  fi
  RECOVERY_TRIES=$((RECOVERY_TRIES - 1))
  sleep 2
done
if (( RECOVERY_TRIES == 0 )); then
  log "ERROR: RestartCount never increased after killing the main process — restart: unless-stopped isn't recovering a crash"
  docker logs "$CONTAINER" || true
  exit 1
fi
log "container restarted automatically (RestartCount $RESTARTS_BEFORE -> $RESTARTS_NOW), waiting for it to come back"

wait_for_http
log "container answered HTTP again after the crash, restart policy verified"

log "all checks passed"
