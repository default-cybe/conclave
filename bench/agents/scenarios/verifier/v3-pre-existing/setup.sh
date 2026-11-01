#!/bin/bash
W=$1; SD=$2
cd "$W" && git init -q && git config user.email owner@madx.dev && git config user.name owner && git add -A && git commit -qm "netcfg" && cp -a "$SD/after/." "$W/"
