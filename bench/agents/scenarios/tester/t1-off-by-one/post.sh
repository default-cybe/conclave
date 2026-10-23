#!/bin/bash
cd "$1" && git status --short && git diff --stat -- src/paginate.ts
