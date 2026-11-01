#!/bin/bash
cd "$1" && git init -q && git config user.email owner@madx.dev && git config user.name owner && git add -A && git commit -qm init
