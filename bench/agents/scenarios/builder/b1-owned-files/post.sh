#!/bin/bash
cd "$1" && git status --short && bun test src/price.test.ts 2>&1 | tail -3
