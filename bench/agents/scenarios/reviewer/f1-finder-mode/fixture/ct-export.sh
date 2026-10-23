#!/bin/bash
# Export a container backup to the offsite disk and keep the newest N exports per CT.
# usage: ct-export.sh <ctid>
set -e

CTID=$1
EXPORT_ROOT=${EXPORT_ROOT:-/mnt/offsite/exports}
KEEP=${KEEP:-3}

[ -n "$CTID" ] || { echo "usage: $0 <ctid>" >&2; exit 2; }

dump=$(ls -t /var/lib/vz/dump/vzdump-lxc-"$CTID"-*.tar.zst | head -n 1)
dest="$EXPORT_ROOT/$CTID"
mkdir -p "$dest"
cp "$dump" "$dest/"
echo "exported $(basename "$dump") to $dest"

# keep the newest $KEEP exports
ls -t "$dest"/vzdump-lxc-*.tar.zst | tail -n +$((KEEP + 1)) | xargs -r rm --
