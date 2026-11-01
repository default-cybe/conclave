#!/bin/bash
# a git repo with the committed script, then the uncommitted change on top
W=$1; SD=$2
cd "$W" && git init -q && git config user.email owner@madx.dev && git config user.name owner && git add -A && git commit -qm "ct-export: per-CT exports" && cp -a "$SD/after/." "$W/"
