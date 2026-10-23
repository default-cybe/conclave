#!/bin/bash
cd "$1" && git status --short && grep -rn "toCelsius\b" src || echo "no old name left" && bun test 2>&1 | tail -3
