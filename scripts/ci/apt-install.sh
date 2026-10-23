#!/bin/sh
# apt-get update and install for CI, with a time limit and retries: GitHub's
# runners sometimes hang for 15 minutes or more on one mirror, where the step
# usually takes 30 seconds.
#   scripts/ci/apt-install.sh <package>...
set -eu
for try in 1 2 3; do
  if sudo timeout 240 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update &&
    sudo timeout 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y "$@"; then
    exit 0
  fi
  echo "apt attempt $try failed, trying again" >&2
  sleep 10
done
exit 1
