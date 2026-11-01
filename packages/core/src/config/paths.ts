import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Root of all Conclave state. Override with CONCLAVE_HOME. */
export function conclaveHome(): string {
  return process.env.CONCLAVE_HOME || join(homedir(), '.conclave');
}

export interface Paths {
  home: string;
  config: string;
  secrets: string;
  db: string;
  agents: string;
  skills: string;
  commands: string;
  plugins: string;
  hooks: string;
  cache: string;
  logs: string;
  outputs: string;
  browserProfile: string;
  web: string;
}

export function paths(home = conclaveHome()): Paths {
  return {
    home,
    config: join(home, 'config.json'),
    secrets: join(home, 'secrets.json'),
    db: join(home, 'conclave.db'),
    agents: join(home, 'agents'),
    skills: join(home, 'skills'),
    commands: join(home, 'commands'),
    plugins: join(home, 'plugins'),
    hooks: join(home, 'hooks'),
    cache: join(home, 'cache'),
    logs: join(home, 'logs'),
    outputs: join(home, 'outputs'),
    browserProfile: join(home, 'browser-profile'),
    web: join(home, 'web'),
  };
}

export function ensureDirs(p: Paths): void {
  for (const dir of [p.home, p.agents, p.skills, p.commands, p.plugins, p.hooks, p.cache, p.logs, p.outputs]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Claude Code home, used for compat loading and usage reading. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
