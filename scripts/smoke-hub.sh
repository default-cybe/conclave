#!/bin/sh
# Start a compiled hub on a spare port with a throwaway home and check it answers.
#
#   scripts/smoke-hub.sh path/to/conclave              # /api/health only
#   scripts/smoke-hub.sh path/to/conclave --expect-web # also needs web/ next to the binary
#
# Used by CI and the release workflow.
set -eu

bin=$1
mode=${2:-}
port=${SMOKE_PORT:-7799}
home=$(mktemp -d)

if [ "${SMOKE_STDIN_PIPE:-}" = 1 ]; then
  # as the desktop app starts it: stdin a pipe that stays open, and stop when it ends
  sleep 120 | CONCLAVE_HOME="$home" CONCLAVE_DETACHED=1 CONCLAVE_STOP_ON_STDIN_END=1 "$bin" serve --port "$port" >"$home/hub.log" 2>&1 &
else
  CONCLAVE_HOME="$home" "$bin" serve --port "$port" >"$home/hub.log" 2>&1 &
fi
pid=$!
# Windows keeps the database locked until the hub has exited: wait, and never fail on the cleanup
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$home" 2>/dev/null || true' EXIT

tries=0
until curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "smoke: hub did not become healthy. Log:"
    cat "$home/hub.log"
    exit 1
  fi
  sleep 1
done
echo "smoke: /api/health ok"

if [ "$mode" = --expect-web ]; then
  if curl -fsS "http://127.0.0.1:$port/" | grep -q "web app is not built"; then
    echo "smoke: the hub did not find the web/ folder next to the binary"
    exit 1
  fi
  echo "smoke: web app served"
fi
