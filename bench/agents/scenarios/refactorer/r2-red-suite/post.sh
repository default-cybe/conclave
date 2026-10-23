#!/bin/bash
cd "$1" && git status --short && echo "status done"
