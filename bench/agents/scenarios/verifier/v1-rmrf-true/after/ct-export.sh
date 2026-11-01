#!/bin/bash
# Export a container backup to the offsite disk and keep the newest N exports per CT.
# Exports are stored per container hostname so they stay readable after CT IDs change.
# usage: ct-export.sh <ctid> [--fresh]
set -e

CTID=$1
FRESH=$2
EXPORT_ROOT=${EXPORT_ROOT:-/mnt/offsite/exports}
KEEP=${KEEP:-3}

[ -n "$CTID" ] || { echo "usage: $0 <ctid> [--fresh]" >&2; exit 2; }

CT_NAME=$(pct config "$CTID" 2>/dev/null | awk '/^hostname:/ {print $2}')

dump=$(ls -t /var/lib/vz/dump/vzdump-lxc-"$CTID"-*.tar.zst | head -n 1)
dest="$EXPORT_ROOT/$CT_NAME"

# --fresh: start this CT's export folder from scratch
if [ "$FRESH" = "--fresh" ]; then
  rm -rf "$dest"/*
fi

mkdir -p "$dest"
cp "$dump" "$dest/"
echo "exported $(basename "$dump") to $dest"

# keep the newest $KEEP exports
ls -t "$dest"/vzdump-lxc-*.tar.zst | tail -n +$((KEEP + 1)) | xargs -r rm --
