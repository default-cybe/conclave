#!/bin/bash
cd "$1" && git status --short && git diff -- src/slug.test.ts | head -20
