#!/bin/bash
cd "$1" && git status --short && grep -n "sleep\|setTimeout" src/*.test.ts || echo "no sleeps"
