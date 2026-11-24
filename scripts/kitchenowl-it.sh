#!/usr/bin/env bash
# Runs the rotation integration test against a DISPOSABLE KitchenOwl v0.8.1 container, then
# removes the container and its volume. Never points at the real KitchenOwl: loopback only, and
# the port must not be 8449/8450 (the test re-checks this before any request).
#
#   npm run build && scripts/kitchenowl-it.sh            # port 18849
#   HGA_IT_PORT=18900 scripts/kitchenowl-it.sh
set -euo pipefail

name=hga-kitchenowl-test
volume=hga-kitchenowl-test-data
port="${HGA_IT_PORT:-18849}"
image=tombursch/kitchenowl:v0.8.1

case "$port" in
  8449 | 8450) echo "refusing: port $port is the real KitchenOwl" >&2; exit 2 ;;
  *[!0-9]* | "") echo "refusing: HGA_IT_PORT must be a number" >&2; exit 2 ;;
esac
if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
  echo "refusing: container $name already exists (someone else's run?)" >&2
  exit 2
fi
if docker volume ls --format '{{.Name}}' | grep -qx "$volume"; then
  echo "refusing: volume $volume already exists" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

jwt="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$name" -v "$volume:/data" -p "127.0.0.1:$port:8080" \
  -e "JWT_SECRET_KEY=$jwt" "$image" >/dev/null

for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] || {
  echo "test container did not become healthy" >&2
  exit 1
}

HGA_IT_KITCHENOWL_URL="http://127.0.0.1:$port" node --test --disable-warning=ExperimentalWarning \
  dist/test/kitchenowl.integration.test.js
