#!/bin/bash
# Count the dumps for one container and print a report line.
set -e
CTID=${1:?usage: report.sh <ctid>}
count=$(ls /var/lib/vz/dump/vzdump-lxc-"$CTID"-*.tar.zst 2>/dev/null | wc -l)
echo "CT $CTID has $count dumps"
