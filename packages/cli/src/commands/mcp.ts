/**
 * conclave mcp: Conclave as a stdio MCP server for Claude Code, Codex,
 * OpenCode and Gemini CLI. It forwards every message to the hub's /mcp
 * endpoint with this machine's saved login, so the tools (memory_search,
 * memory_save, ...) are the hub's.
 *
 * stdout carries the MCP protocol: nothing else may be printed there.
 *
 *   conclave mcp            run the stdio server
 *   conclave mcp snippets   print ready-to-paste config for each CLI
 */
import type { ParsedArgs } from '../args';
import { bool } from '../args';
import { err as e, out as p } from '../ansi';
import { getClient, json, print } from './shared';

export async function mcpCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1];
  if (sub === 'snippets' || sub === 'config') return snippets(args);
  if (sub && sub !== 'serve') {
    process.stderr.write(`Unknown subcommand "${sub}". Run \`conclave help mcp\`.\n`);
    return 1;
  }
  // progress lines (starting the local hub) go to stderr; stdout is the protocol
  const { target } = await getClient(args, { quiet: false });
  const { runStdioProxy } = await import('@conclave/core/engine/hub-mcp.ts');
  await runStdioProxy({ url: `${target.url}/mcp`, token: target.token, onError: (msg) => process.stderr.write(e.dim(`conclave mcp: ${msg}`) + '\n') });
  return 0;
}

async function snippets(args: ParsedArgs): Promise<number> {
  const { client } = await getClient(args);
  const s = await client.mcpServerSnippets();
  if (bool(args, 'json')) return json(s), 0;
  print(p.bold(`Conclave MCP endpoint: ${s.url}`));
  print(p.dim(`Tools: ${s.tools.map((t) => t.name).join(', ')}`));
  for (const [title, steps] of [
    ['Over HTTP (any machine that reaches the hub)', s.http],
    ['Over stdio (this machine, uses `conclave mcp`)', s.stdio],
  ] as const) {
    print('');
    print(p.bold(title));
    for (const step of steps) {
      print('');
      print(`  ${p.bold(step.cli)}${step.note ? p.dim(`  (${step.note})`) : ''}`);
      if (step.command) print(`  ${step.command}`);
      else print(p.dim(`  add to ${step.file}:`) + '\n' + step.snippet.split('\n').map((l) => '    ' + l).join('\n'));
    }
  }
  print('');
  for (const n of s.notes) print(p.dim(`- ${n}`));
  return 0;
}
