#!/bin/bash
# Run one trial of a built-in Conclave agent prompt with the official Claude Code CLI.
# usage: bench/agents/trial.sh <scenario-dir> <run-index>
# env: CLAUDE_BIN (default claude; point it at a wrapper that isolates HOME), AGENT_BENCH_OUT (default /tmp/conclave-agent-bench)
# A scenario folder holds scenario.env, task.txt, rubric.md and optionally fixture/, setup.sh and post.sh.
set -u
SD=$(realpath "$1"); R=${2:-1}
HERE=$(cd "$(dirname "$0")" && pwd)
AGENT= TOOLS="Read Glob Grep" ALLOWED= MAXT=12 BUDGET=0.30 MODEL=sonnet GIT=no
source "$SD/scenario.env"
SLUG=$(basename "$(dirname "$SD")")/$(basename "$SD")
OUT=${AGENT_BENCH_OUT:-/tmp/conclave-agent-bench}/$SLUG/r$R
rm -rf "$OUT"; mkdir -p "$OUT"
W=$(mktemp -d /tmp/agent-bench-w.XXXXXX)/work
mkdir -p "$W"
[ -d "$SD/fixture" ] && cp -a "$SD/fixture/." "$W/"
[ -f "$SD/setup.sh" ] && bash "$SD/setup.sh" "$W" "$SD" > "$OUT/setup.log" 2>&1
bun "$HERE/compose.ts" "$AGENT" "$W" "$([ "$GIT" = yes ] && echo git)" > "$OUT/system-prompt.md" || exit 3
CMD=("${CLAUDE_BIN:-claude}" -p --system-prompt "$(cat "$OUT/system-prompt.md")" --model "$MODEL"
     --output-format stream-json --verbose --max-turns "$MAXT" --max-budget-usd "$BUDGET"
     --permission-mode default --no-session-persistence --setting-sources "" --strict-mcp-config --tools $TOOLS)
[ -n "$ALLOWED" ] && CMD+=(--allowedTools "$ALLOWED")
( cd "$W" && timeout 420 "${CMD[@]}" < "$SD/task.txt" ) > "$OUT/transcript.jsonl" 2> "$OUT/stderr.log"
echo "exit=$?" > "$OUT/exit.txt"
bun "$HERE/summarize.ts" "$OUT/transcript.jsonl" > "$OUT/summary.json"
echo "$W" > "$OUT/workdir.txt"
[ -f "$SD/post.sh" ] && bash "$SD/post.sh" "$W" "$SD" > "$OUT/post.txt" 2>&1
echo "$SLUG r$R cost=$(jq -r .costUsd "$OUT/summary.json") turns=$(jq -r .turns "$OUT/summary.json") out=$OUT"
