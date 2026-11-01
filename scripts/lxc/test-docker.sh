#!/bin/sh
# Run scripts/lxc/setup.sh in a plain Docker container and check the hub.
#
#   scripts/lxc/test-docker.sh [image]      default debian:12
#
# A Docker container has no systemd, so setup.sh runs with --no-systemd. It
# installs this checkout (--source-dir), then the hub is started by hand as
# the conclave user. The test checks /api/health, the CLI as root, the folder
# of a new session, then runs setup.sh again as an update and checks again.
# Needs Docker, and network for apt, Bun and npm.
#
# CA_CERT=/path/ca.pem trusts more CAs (one or many in the file), for a proxy
# that re-signs TLS.
set -eu

if [ "${1:-}" = --inside ]; then
  if [ -f /extra-ca.crt ]; then
    # One certificate per file, as update-ca-certificates wants. When setup.sh
    # installs ca-certificates, the package picks these up by itself.
    mkdir -p /usr/local/share/ca-certificates
    awk '/BEGIN CERTIFICATE/ { n++ } n { print > ("/usr/local/share/ca-certificates/extra-" n ".crt") }' /extra-ca.crt
    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates >/dev/null 2>&1; fi
    export NODE_EXTRA_CA_CERTS=/extra-ca.crt
  fi

  health() {
    i=0
    until curl -fs http://127.0.0.1:7717/api/health; do
      i=$((i + 1))
      if [ "$i" -ge 60 ]; then
        echo "test: no answer from /api/health. Hub log:"
        cat /tmp/hub.log
        exit 1
      fi
      sleep 1
    done
    echo
  }
  start_hub() {
    conclave serve >/tmp/hub.log 2>&1 &
    health
    hub=''
    for p in /proc/[0-9]*; do
      if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -qE 'conclave serve|index.ts serve'; then
        if [ "$(awk '/^Uid:/ { print $2 }' "$p/status")" != 0 ]; then hub=${p#/proc/}; fi
      fi
    done
    [ -n "$hub" ] || { echo "test: no hub process"; exit 1; }
    # conclave serve as root runs the hub as the conclave user
    uid=$(awk '/^Uid:/ { print $2 }' "/proc/$hub/status")
    echo "test: hub pid $hub runs as uid $uid ($(getent passwd "$uid" | cut -d : -f 1))"
    [ "$uid" = "$(id -u conclave)" ]
  }
  stop_hub() {
    kill "$hub"
    while curl -fsS http://127.0.0.1:7717/api/health >/dev/null 2>&1; do sleep 1; done
  }

  echo "test: first install"
  sh /src/scripts/lxc/setup.sh --no-systemd --source-dir /src
  start_hub
  echo "test: CLI as root"
  conclave remote
  conclave pair-phone | grep -E '^(Code|Hub|Key)'
  token=$(jq -r .server.token /var/lib/conclave/config.json)
  cwd=$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"title":"setup test"}' http://127.0.0.1:7717/api/sessions | jq -r .cwd)
  echo "test: a new session starts in $cwd"
  [ "$cwd" = /home/conclave ]
  ls -ld /opt/conclave /var/lib/conclave /home/conclave /home/conclave/projects
  stop_hub

  echo "test: run again, as an update"
  sh /src/scripts/lxc/setup.sh --no-systemd
  start_hub
  cat /etc/conclave/setup.conf
  stop_hub
  echo "test: ok"
  exit 0
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
image=${1:-debian:12}
set -- --rm -v "$root:/src:ro"
if [ -n "${CA_CERT:-}" ]; then set -- "$@" -v "$CA_CERT:/extra-ca.crt:ro"; fi
echo "test: setup.sh in $image"
docker run "$@" "$image" sh /src/scripts/lxc/test-docker.sh --inside
