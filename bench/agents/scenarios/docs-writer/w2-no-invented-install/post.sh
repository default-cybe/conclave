#!/bin/bash
cd "$1" && git status --short && grep -n "brew\|—\|–" README.md || echo "no brew lines, no dashes"
