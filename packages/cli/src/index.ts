#!/usr/bin/env bun
/** conclave: the CLI and terminal UI for a Conclave hub. */
import { err as e } from './ansi';
import { bool, parseArgs, type ParsedArgs } from './args';
import { commandHelp, HELP, mainHelp } from './help';
import { CliError, describeError, print } from './commands/shared';

import { VERSION } from './version';

export { VERSION };

type Handler = (args: ParsedArgs) => Promise<number>;

const COMMANDS: Record<string, Handler> = {
  chat: async (a) => (await import('./commands/chat')).chatCommand(a, 1),
  run: async (a) => (await import('./commands/run')).runCommand(a, 1),
  serve: async (a) => (await import('./commands/serve')).serveCommand(a),
  login: async (a) => (await import('./commands/login')).loginCommand(a),
  logout: async () => (await import('./commands/login')).logoutCommand(),
  daemon: async (a) => (await import('./commands/daemon')).daemonCommand(a),
  remote: async (a) => (await import('./commands/remote')).remoteCommand(a),
  friends: async (a) => (await import('./commands/friends')).friendsCommand(a),
  projects: async (a) => (await import('./commands/projects')).projectsCommand(a),
  sessions: async (a) => (await import('./commands/data')).sessionsCommand(a),
  github: async (a) => (await import('./commands/github')).githubCommand(a),
  models: async (a) => (await import('./commands/data')).modelsCommand(a),
  agents: async (a) => (await import('./commands/data')).agentsCommand(a),
  usage: async (a) => (await import('./commands/data')).usageCommand(a),
  limits: async (a) => (await import('./commands/data')).limitsCommand(a),
  routines: async (a) => (await import('./commands/data')).routinesCommand(a),
  memory: async (a) => (await import('./commands/data')).memoryCommand(a),
  tasks: async (a) => (await import('./commands/data')).tasksCommand(a),
  import: async (a) => (await import('./commands/data')).importCommand(a),
  'pair-phone': async (a) => (await import('./commands/config')).pairPhoneCommand(a),
  web: async (a) => (await import('./commands/config')).webCommand(a),
  config: async (a) => (await import('./commands/config')).configCommand(a),
  secret: async (a) => (await import('./commands/config')).secretCommand(a),
  password: async (a) => (await import('./commands/password')).passwordCommand(a),
  people: async (a) => (await import('./commands/people')).peopleCommand(a),
  doctor: async (a) => (await import('./commands/doctor')).doctorCommand(a),
  logs: async (a) => (await import('./commands/logs')).logsCommand(a),
  mcp: async (a) => (await import('./commands/mcp')).mcpCommand(a),
  update: async (a) => (await import('./commands/update')).updateCommand(a),
  'system-helper': async (a) => (await import('./commands/system-helper')).systemHelperCommand(a),
  help: async (a) => {
    const topic = a._[1];
    const text = topic ? commandHelp(topic) : mainHelp(VERSION);
    if (!text) throw new CliError(`No help for "${topic}".`);
    print(text);
    return 0;
  },
  version: async () => (print(VERSION), 0),
};

const ALIASES: Record<string, string> = { person: 'people', friend: 'friends', project: 'projects', ls: 'sessions', session: 'sessions', s: 'sessions', model: 'models', agent: 'agents', limit: 'limits', routine: 'routines', task: 'tasks', mem: 'memory', pair: 'pair-phone', open: 'web', exec: 'run', start: 'serve' };

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Which command to run and where its prompt starts. */
export function route(args: ParsedArgs): { name: string; promptFrom: number } | { unknown: string; suggestion?: string } {
  const first = args._[0];
  if (bool(args, 'print')) return { name: 'run', promptFrom: 0 };
  if (!first) return { name: 'chat', promptFrom: 0 };
  const name = ALIASES[first] ?? first;
  if (COMMANDS[name]) return { name, promptFrom: 1 };
  // `conclave fix the tests` starts a chat with that prompt; a lone near-miss word is a typo.
  if (args._.length === 1 && !/\s/.test(first)) {
    const near = Object.keys(COMMANDS).find((c) => distance(c, first) <= (first.length > 4 ? 2 : 1));
    if (near) return { unknown: first, suggestion: near };
  }
  return { name: 'chat', promptFrom: 0 };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (bool(args, 'version') && !args._.length) {
    print(VERSION);
    return 0;
  }
  const r = route(args);
  if ('unknown' in r) {
    process.stderr.write(`Unknown command "${r.unknown}".${r.suggestion ? ` Did you mean \`conclave ${r.suggestion}\`?` : ''}\n`);
    return 1;
  }
  if (bool(args, 'help')) {
    print((args._[0] && commandHelp(ALIASES[args._[0]] ?? args._[0])) || mainHelp(VERSION));
    return 0;
  }
  if (r.name === 'chat') return (await import('./commands/chat')).chatCommand(args, r.promptFrom);
  if (r.name === 'run') return (await import('./commands/run')).runCommand(args, r.promptFrom);
  return COMMANDS[r.name](args);
}

export { HELP };

/** Run the CLI and exit with its code. bin.ts calls it in the compiled binary; `bun src/index.ts` comes in below. */
export function runCli(argv: string[]): void {
  main(argv)
    .then(async (code) => {
      await new Promise<void>((res) => process.stdout.write('', () => res()));
      process.exit(code);
    })
    .catch(async (error) => {
      const code = error instanceof CliError ? error.code : 1;
      process.stderr.write(e.red('Error: ') + describeError(error) + '\n');
      if (process.env.CONCLAVE_DEBUG && error instanceof Error && error.stack) process.stderr.write(e.dim(error.stack) + '\n');
      process.exit(code);
    });
}

if (import.meta.main) runCli(process.argv.slice(2));

