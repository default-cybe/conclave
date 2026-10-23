// Summarize a claude stream-json transcript: final text, tool calls, denials, turns, cost.
// usage: bun bench/agents/summarize.ts <transcript.jsonl>
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const tools: Array<{ name: string; input: unknown }> = [];
const texts: string[] = [];
let result: Record<string, any> | null = null;
for (const l of lines) {
  let e: Record<string, any>;
  try {
    e = JSON.parse(l);
  } catch {
    continue;
  }
  if (e.type === 'assistant') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'tool_use') tools.push({ name: b.name, input: b.input });
      if (b.type === 'text' && b.text?.trim()) texts.push(b.text);
    }
  }
  if (e.type === 'result') result = e;
}
console.log(JSON.stringify({
  final: result?.result ?? texts[texts.length - 1] ?? '',
  allText: texts,
  toolCalls: tools,
  permissionDenials: result?.permission_denials ?? [],
  turns: result?.num_turns,
  costUsd: result?.total_cost_usd,
  durationMs: result?.duration_ms,
  stop: result?.subtype ?? result?.terminal_reason,
}, null, 2));
