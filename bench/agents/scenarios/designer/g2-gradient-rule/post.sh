#!/bin/bash
cd "$1" && grep -n "gradient\|🚀" src/Hero.tsx || echo "no gradient or emoji in Hero.tsx"
