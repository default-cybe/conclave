/**
 * Discover catalog: the one item shape every source maps to, and the
 * recommended list that ships with Conclave. Spec: docs/design/ECOSYSTEM.md.
 *
 * Checked on 2026-10-17. Stars came from the GitHub search API through the
 * GitHub MCP connector (api.github.com is blocked for curl in the research
 * sandbox). Commit pins and folder paths were checked with git ls-remote and
 * blobless clones on the same day. The hub refreshes stars at runtime and
 * shows "stars as of <starsAt>" until it does.
 *
 * Hook recipes (extensions/hook-recipes.ts) and routine suggestions
 * (scheduler/suggestions.ts) are mapped into this shape by the catalog
 * service. A curated entry here wins over a derived one with the same id.
 */
import type { HookEvent, McpServerConfig } from '../config/schema';
import { ELASTIC_LINUX_RULES_DIR, ELASTIC_LINUX_RULES_SKILL } from './skill-texts';

/** What a catalog item installs as. */
export type CatalogKind = 'mcp' | 'skill' | 'plugin' | 'subagent' | 'command' | 'hook' | 'routine';

export type CatalogCategory =
  | 'token-savers'
  | 'minimal-code'
  | 'focus'
  | 'verification'
  | 'workflow'
  | 'memory'
  | 'docs'
  | 'code-intelligence'
  | 'github-git'
  | 'review'
  | 'language'
  | 'security'
  | 'ctf'
  | 'safety'
  | 'homelab'
  | 'databases'
  | 'monitoring'
  | 'browser'
  | 'search'
  | 'uni'
  | 'writing'
  | 'calendar-mail'
  | 'tasks'
  | 'self-improvement'
  | 'quality'
  | 'dev'
  | 'meta';

/** Where an item came from. Curated sources win over derived ones. */
export type CatalogSource =
  | 'recommended'
  | 'recipe'
  | 'suggestion'
  | 'marketplace'
  | 'github'
  | 'mcp-registry'
  | 'docker'
  | 'awesome-list'
  | 'star-index';

/**
 * What an item can reach once installed. Shown as plain words in the row and
 * the preview ("Can touch: shell, files, network").
 * - network: talks to hosts other than the hub
 * - files: reads or writes files on the machine it runs on
 * - shell: runs commands
 * - hub-code: runs its own code on the hub (hooks, scripts, a stdio server)
 * - cloud-account: acts with a cloud or SaaS account (GitHub, Google, AWS)
 * - real-devices: changes real machines (VMs, containers, smart home)
 * - browser: drives a real browser
 * - memory: reads or writes notes and memories
 * - mail: reads or sends mail
 * - repos: changes git repos (commits, branches, pushes)
 */
export type Touch = 'network' | 'files' | 'shell' | 'hub-code' | 'cloud-account' | 'real-devices' | 'browser' | 'memory' | 'mail' | 'repos';

/** A value the owner fills in the preview form. */
export interface CatalogInput {
  /** Placeholder name. Every "{{NAME}}" in the install spec is replaced with the value. */
  name: string;
  label: string;
  description: string;
  required: boolean;
  /**
   * Secret values go to the hub's secrets store (PUT /api/secrets kind values)
   * under secretKey, and the config gets "${secret:<secretKey>}". Secrets may
   * only sit in env or headers, because McpManager expands placeholders there
   * and nowhere else.
   */
  secret: boolean;
  secretKey?: string;
  default?: string;
  example?: string;
}

/** A program that must exist before the item works. Checked with `command -v` before Add. */
export interface CatalogNeed {
  bin: string;
  /** hub: where Conclave runs hooks and stdio servers. device: the machine named in the form. every-device: each paired device that runs sessions. */
  where: 'hub' | 'device' | 'every-device';
  why: string;
  /**
   * The Python package that has it, for `uv tool install` on the hub
   * (catalog/hub-setup.ts). Used only for items that ship with Conclave.
   */
  uvTool?: string;
}

/** One hook an item brings, for the preview's cost line. */
export interface HookSummary {
  event: HookEvent;
  matcher?: string;
  /** node, bash, python3, a binary name, or "prompt" for a small-model hook. */
  interpreter: string;
  /** Seconds. */
  timeout?: number;
  note?: string;
}

/** A step the owner does (or confirms) before the install can work. */
export interface SetupStep {
  say: string;
  /**
   * Shell command shown with a copy action. "Install on the hub" runs it, as
   * the hub's own user and after a confirm, only when `on` is 'hub' and the
   * item ships with Conclave (catalog/hub-setup.ts). Never with sudo.
   */
  run?: string;
  on?: 'hub' | 'device';
  /** Programs the step puts on the hub's PATH. A missing need for one of them is fixed by running this step. */
  gives?: string[];
}

export interface McpInstall {
  type: 'mcp';
  /** Key in mcpServers. Tools appear as mcp__<server>__<tool>. */
  server: string;
  /** Saved after placeholders are filled. A key whose only value was an empty optional input is dropped. */
  config: McpServerConfig;
  /** Shown above the form, for example installing the program first. */
  setup?: SetupStep[];
  /** Named sets for McpServerConfig.tools, for example a read-only Proxmox set. The first one is preselected. */
  toolPresets?: Array<{ id: string; label: string; tools: string[] }>;
  /** Variant label in the preview when an item has more than one way to run. */
  label?: string;
  /** Extra steps the preview offers after a passing test. */
  offer?: Array<'memory-connection' | 'connect-clis'>;
}

export interface PluginInstall {
  type: 'plugin';
  /** owner/repo added with POST /api/marketplace first. Omitted for the default marketplace. */
  marketplace?: string;
  /** Sources for POST /api/plugins, in order. The preview lists each with a checkbox. */
  plugins: string[];
  /** Full commit of the repo that holds the plugin files. Fetched by sha, never by branch. */
  sha?: string;
  /** Default for the preview's "Hooks" switch. Off installs skills, commands and agents only. */
  hooks?: 'on' | 'off';
}

export interface FilesInstall {
  type: 'files';
  repo: string;
  /** Full commit. */
  sha: string;
  /** from: path in the repo, a trailing slash means a folder. to: path under ~/.conclave (skills/, agents/, commands/). */
  files: Array<{ from: string; to: string }>;
  /**
   * Files Conclave writes itself, next to the copied ones, such as a SKILL.md
   * for a repo that ships data but no skill. to: path under ~/.conclave, inside
   * a skill folder this install fills. Curated items only.
   */
  write?: Array<{ to: string; text: string }>;
}

export interface HookRecipeInstall {
  type: 'hook';
  /** Id in HOOK_RECIPES (extensions/hook-recipes.ts). */
  recipe: string;
}

export interface RoutineInstall {
  type: 'routine';
  /** Id in ROUTINE_SUGGESTIONS (scheduler/suggestions.ts). */
  suggestion: string;
}

/** Nothing Conclave can do in one click. The preview shows the steps and links to the repo. */
export interface ManualInstall {
  type: 'manual';
  steps: SetupStep[];
}

export type InstallSpec = McpInstall | PluginInstall | FilesInstall | HookRecipeInstall | RoutineInstall | ManualInstall;

export interface CatalogItem {
  /** "<kind>:<slug>" for curated items. Live results use "gh:<owner>/<repo>", "reg:<registry name>" or "mkt:<plugin>@<marketplace>". */
  id: string;
  kind: CatalogKind;
  name: string;
  /** owner/repo on GitHub. */
  repo?: string;
  /** Homepage when there is no repo. */
  url?: string;
  stars?: number;
  /** Date the star count was read, YYYY-MM-DD. */
  starsAt?: string;
  description: string;
  category: CatalogCategory;
  /** Plain words, shown comma separated. */
  tags: string[];
  /** SPDX id, or a short phrase for non-SPDX terms. */
  license?: string;
  /** Last commit on the default branch, YYYY-MM-DD. */
  updatedAt?: string;
  archived?: boolean;
  install: InstallSpec;
  /** Other ways to run it, offered in the preview. */
  variants?: InstallSpec[];
  inputs?: CatalogInput[];
  touches: Touch[];
  needs?: CatalogNeed[];
  hooks?: HookSummary[];
  /** Shown in the Recommended section. */
  recommended: boolean;
  /** The owner asked for it by name. Always first. */
  must?: boolean;
  /** Order inside Recommended, lowest first. */
  rank?: number;
  source: CatalogSource;
  /** True when the install spec was checked against the repo at the pinned commit. */
  verified?: boolean;
  /** Why it fits this owner. One or two sentences. */
  fit?: string;
  /** What can go wrong. One or two sentences. */
  risk?: string;
  /** Shown in the preview before Add, one line each. */
  warnings?: string[];
  /** Ids of items that do the same job. The preview says "Overlaps with ...". */
  overlaps?: string[];
}

const AT = '2026-10-17';

/** Pinned commits, checked with git ls-remote on 2026-10-17. */
export const PINS = {
  ponytail: '16352ac229eb08a9598dcae48fe9f2b342567d86',
  caveman: '81958ad82f2e2da4417778f81f8a3c838d81b798',
  superpowers: 'bb92a77741419a4ab5f06e711a283343f1ada0c3',
  claudePluginsOfficial: 'ea10b213686c90bb1984b2016937310e05336cf3',
  anthropicSkills: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
  karpathy: '2c606141936f1eeef17fa3043a72095b4765b9c2',
  ctfSkills: '3bb6bad1a06664840d07b6e1e69bf19e6ca4672d',
  recursiveImprove: '9cf4b85ef6ef66d37ea3c452f49114ff7db1b1a3',
  trailofbits: '5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0',
  wshobson: '044b4b21f083948e69ec878a7b07c8d0951a6ffa',
  voltagent: '408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e',
  avoidAiWriting: '0a4f1ad101683fd8734241ed46430a0b4a9af729',
  alirezarezvani: '19392f7a08264ed00486a251f5b2098321771f94',
  mattpocock: '49dd158d1076134a641b33efb035946536778336',
  contextMode: '5f6298a9bdc480ebc7c88a29c9fbdf38ae2f8cb6',
  ccSafetyNet: '4fd49ef94fa9a34ce5dd690f6e964d3bdf49888d',
  iHaveAdhd: '1ecea1993b7fce257ffbd686c070948b5e07eda6',
  planningWithFiles: '6b30f32d83a8bdc8ef983385348d0d3f5d6bef49',
  rtk: '7bff768c4ddfaf58e34202cd5a33dce76f7e9756',
  agenticTools: 'a32e2099b38b06c6e6224a39b8b8dbb46d8781aa',
  /** Checked 2026-10-20: rules/linux holds 376 rules (97 persistence, 52 privilege escalation), hunting/linux/queries 43 hunts. */
  elasticDetectionRules: 'c6d1199c90b1eb43aa4a00e728c51bef99918d3a',
} as const;

const NODE_HUB: CatalogNeed = { bin: 'node', where: 'hub', why: 'Its hooks run node on the hub. The Docker image has node only as the Bun fallback, which works.' };
const UV_HUB: CatalogNeed = { bin: 'uvx', where: 'hub', why: 'Conclave starts stdio servers on the hub, and this one runs through uv.' };
const NPX_HUB: CatalogNeed = { bin: 'npx', where: 'hub', why: 'Conclave starts stdio servers on the hub, and this one runs through npx.' };
const DOCKER_HUB: CatalogNeed = { bin: 'docker', where: 'hub', why: 'The server runs as a container next to the hub.' };

export const RECOMMENDED: CatalogItem[] = [
  // ---------------------------------------------------------------------------
  // The owner's must-haves
  // ---------------------------------------------------------------------------
  {
    id: 'plugin:ponytail',
    kind: 'plugin',
    name: 'ponytail',
    repo: 'DietrichGebert/ponytail',
    stars: 165363,
    starsAt: AT,
    description: 'Makes coding agents write less code. Reuse what the repo has, then the stdlib, then installed dependencies, and skip features nobody asked for. Levels lite, full and ultra, plus review, audit and debt skills.',
    category: 'minimal-code',
    tags: ['yagni', 'reuse', 'stdlib first', 'claude code', 'codex', 'opencode'],
    license: 'MIT',
    updatedAt: '2026-10-17',
    install: { type: 'plugin', marketplace: 'DietrichGebert/ponytail', plugins: ['ponytail@ponytail'], sha: PINS.ponytail, hooks: 'on' },
    variants: [
      { type: 'files', repo: 'DietrichGebert/ponytail', sha: PINS.ponytail, files: [{ from: 'skills/ponytail/', to: 'skills/ponytail/' }] },
    ],
    touches: ['hub-code', 'files'],
    needs: [NODE_HUB],
    hooks: [
      { event: 'SessionStart', matcher: 'startup|resume|clear|compact', interpreter: 'node', timeout: 5, note: 'Injects the ruleset and a map of the codebase from git ls-files, about 5,000 chars.' },
      { event: 'SubagentStart', interpreter: 'node', timeout: 5, note: 'Injects the ruleset into each subagent, about 2,900 chars.' },
      { event: 'UserPromptSubmit', interpreter: 'node', timeout: 5, note: 'Tracks /ponytail level changes. Usually adds nothing.' },
    ],
    recommended: true,
    must: true,
    rank: 1,
    source: 'recommended',
    verified: true,
    fit: 'You asked for it by name. It fits TypeScript, Rust and Python work, and pairs with code-simplifier as a second pass and with the new-dependency-gate and diff-budget recipes.',
    risk: 'Runs node on the hub for every session start, subagent and prompt. Without node every event fails with exit 127.',
    warnings: [
      'Registers three node handlers (SessionStart, SubagentStart, UserPromptSubmit). Its INSTALL.md says two.',
      'Writes a mode flag file under $CLAUDE_CONFIG_DIR. Conclave gives each plugin its own CLAUDE_CONFIG_DIR unless you turn on sharing with Claude Code.',
      'Conclave ignores its userConfig (task ledger CSV and webhook), the claude-band.json modules entry and the statusline.',
      'Upstream warns about copies that ship .exe or .dll files. Install only from DietrichGebert/ponytail.',
    ],
    overlaps: ['skill:karpathy-guidelines', 'skill:minimalist'],
  },
  {
    id: 'plugin:caveman',
    kind: 'plugin',
    name: 'caveman',
    repo: 'JuliusBrussee/caveman',
    stars: 113108,
    starsAt: AT,
    description: 'Terse reply voice that cuts output tokens. Code, commands, paths and exact errors stay as they are, and safety warnings stay full sentences. Ships 22 skills, including caveman-compress for memory files and focus skills such as verify-and-stop and surgical-patch.',
    category: 'token-savers',
    tags: ['output tokens', 'terse', 'focus', 'claude code', 'codex', 'gemini'],
    license: 'Apache-2.0 and MIT',
    updatedAt: '2026-10-17',
    install: { type: 'plugin', marketplace: 'JuliusBrussee/caveman', plugins: ['caveman@caveman'], sha: PINS.caveman, hooks: 'on' },
    variants: [
      { type: 'files', repo: 'JuliusBrussee/caveman', sha: PINS.caveman, files: [{ from: 'skills/caveman/', to: 'skills/caveman/' }] },
    ],
    touches: ['hub-code', 'files'],
    needs: [NODE_HUB],
    hooks: [
      { event: 'SessionStart', interpreter: 'node', timeout: 30, note: 'Injects the ruleset, about 4,950 chars.' },
      { event: 'SubagentStart', interpreter: 'node', timeout: 30, note: 'Injects the ruleset into each subagent, about 4,550 chars.' },
      { event: 'UserPromptSubmit', interpreter: 'node', timeout: 30, note: 'A short reminder on every prompt, about 400 chars, and /caveman level changes.' },
      { event: 'SessionEnd', interpreter: 'node', timeout: 5, note: 'Records stats. Conclave caps SessionEnd at 1.5 s, so stats may be cut.' },
    ],
    recommended: true,
    must: true,
    rank: 2,
    source: 'recommended',
    verified: true,
    fit: 'You asked for it by name. It saves output tokens in long sessions on every provider you use, and its focus skills cover verify-only and minimal-patch tasks.',
    risk: 'Without node its hooks exit quietly and nothing happens. With ponytail also on, sessions start with about 10,000 chars of mode rules and each subagent gets about 7,400.',
    warnings: [
      'Writes mode state under $CLAUDE_CONFIG_DIR and ~/.config/caveman. Conclave gives each plugin its own CLAUDE_CONFIG_DIR unless you turn on sharing with Claude Code.',
      'Do not run the separate caveman CLI installer on the hub: it edits ANTHROPIC_BASE_URL in ~/.claude/settings.json and sends usage stats unless DO_NOT_TRACK=1. The plugin does not need it.',
      'The plugin root is the whole repo, about 35 MB with the Go proxy. Conclave copies it without .git.',
      'caveman-compress sends file text to the model provider.',
    ],
    overlaps: ['skill:caveman-focus'],
  },

  // ---------------------------------------------------------------------------
  // Recommended
  // ---------------------------------------------------------------------------
  {
    id: 'mcp:basic-memory',
    kind: 'mcp',
    name: 'Basic Memory',
    repo: 'basicmachines-co/basic-memory',
    stars: 4255,
    starsAt: AT,
    description: 'Local markdown knowledge base with a graph of notes, over MCP. Version 0.24 adds valid-time ranges, compact search and checksum-safe edits, which the librarian routines use.',
    category: 'memory',
    tags: ['notes', 'knowledge graph', 'markdown'],
    license: 'AGPL-3.0',
    updatedAt: '2026-10-15',
    install: { type: 'mcp', server: 'basic-memory', label: 'uvx on the hub', config: { command: 'uvx', args: ['basic-memory', 'mcp'] }, offer: ['memory-connection', 'connect-clis'] },
    variants: [
      { type: 'mcp', server: 'basic-memory', label: 'The basic-memory service in docker-compose.yml', config: { type: 'http', url: 'http://basic-memory:8000/mcp' }, offer: ['memory-connection', 'connect-clis'] },
    ],
    touches: ['memory', 'files', 'hub-code'],
    needs: [UV_HUB],
    recommended: true,
    rank: 3,
    source: 'recommended',
    verified: true,
    fit: 'You already use it. Conclave has a basic-memory connection type, and the librarian, harvester and inventory routines write to it.',
    risk: 'Reads and writes notes in ~/basic-memory. The registry entry puts basic-memory and mcp in runtimeArguments, so a derived uvx command comes out wrong. Use this curated config.',
    warnings: ['The librarian routines need Basic Memory 0.24 or newer for @valid ranges and expected_checksum. Older servers fall back to a "(retired <date>)" suffix.'],
  },
  {
    id: 'mcp:github',
    kind: 'mcp',
    name: 'GitHub MCP Server',
    repo: 'github/github-mcp-server',
    stars: 33672,
    starsAt: AT,
    description: 'Repos, issues, PRs, Actions logs, code search and security alerts through the GitHub API. Official, from GitHub.',
    category: 'github-git',
    tags: ['issues', 'pull requests', 'actions', 'official'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: {
      type: 'mcp',
      server: 'github',
      label: 'Remote, hosted by GitHub',
      config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{GITHUB_PAT}}' } },
      offer: ['connect-clis'],
    },
    variants: [
      {
        type: 'mcp',
        server: 'github',
        label: 'Docker on the hub, read-only',
        config: {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '-e', 'GITHUB_READ_ONLY', '-e', 'GITHUB_TOOLSETS', 'ghcr.io/github/github-mcp-server:2.0.2'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '{{GITHUB_PAT}}', GITHUB_READ_ONLY: '1', GITHUB_TOOLSETS: 'repos,issues,pull_requests,actions' },
        },
      },
    ],
    inputs: [
      { name: 'GITHUB_PAT', label: 'GitHub token', description: 'A fine-grained personal access token. Start with read-only scopes. The same token raises the Discover rate limit from 60 to 5,000 requests an hour.', required: true, secret: true, secretKey: 'github-pat' },
    ],
    touches: ['cloud-account', 'network', 'repos'],
    recommended: true,
    rank: 4,
    source: 'recommended',
    verified: true,
    fit: 'Daily TypeScript, Rust and Python work: PR review, CI failures, the GitHub inbox routine.',
    risk: 'It can write to every repo the token can reach, so give the token read-only scopes first. The remote endpoint is run by GitHub; the Docker variant keeps calls on the hub.',
  },
  {
    id: 'mcp:context7',
    kind: 'mcp',
    name: 'Context7',
    repo: 'upstash/context7',
    stars: 63171,
    starsAt: AT,
    description: 'Pulls current, version-specific library docs and examples into the prompt.',
    category: 'docs',
    tags: ['library docs', 'api reference'],
    license: 'MIT',
    updatedAt: '2026-10-16',
    install: { type: 'mcp', server: 'context7', label: 'Remote, hosted by Upstash', config: { type: 'http', url: 'https://mcp.context7.com/mcp' }, offer: ['connect-clis'] },
    variants: [
      { type: 'mcp', server: 'context7', label: 'npx on the hub', config: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.2'], env: { CONTEXT7_API_KEY: '{{CONTEXT7_API_KEY}}' } } },
    ],
    inputs: [
      { name: 'CONTEXT7_API_KEY', label: 'API key', description: 'Optional. Raises the rate limit. Leave empty to use it without a key.', required: false, secret: true, secretKey: 'context7-key' },
    ],
    touches: ['network'],
    recommended: true,
    rank: 5,
    source: 'recommended',
    verified: true,
    fit: 'Cuts wrong API guesses in TypeScript, Rust and Python libraries. Works without a key.',
    risk: 'Library names and queries go to Upstash. Read-only.',
  },
  {
    id: 'hook:rtk-rewrite',
    kind: 'hook',
    name: 'rtk (Rust Token Killer)',
    repo: 'rtk-ai/rtk',
    stars: 83657,
    starsAt: AT,
    description: 'One Rust binary that filters noisy command output (git, test runners, ls, grep, docker and 70 more) before the model reads it. This recipe routes Bash calls through rtk without auto-allowing them.',
    category: 'token-savers',
    tags: ['tool output', 'bash', 'rust'],
    license: 'Apache-2.0 (rtk-oss) or Apache-2.0 plus BUSL-1.1 (full)',
    updatedAt: '2026-10-17',
    install: { type: 'hook', recipe: 'rtk-rewrite' },
    touches: ['shell'],
    needs: [
      { bin: 'rtk', where: 'every-device', why: 'The rewritten command runs on the session\'s device, so rtk must be on pve, madx, arch-desktop and the macbook.' },
      { bin: 'jq', where: 'hub', why: 'The recipe script parses the hook input with jq.' },
    ],
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', interpreter: 'bash', timeout: 5 }],
    recommended: true,
    rank: 6,
    source: 'recommended',
    verified: false,
    fit: 'You run test suites and git through agents all day. rtk claims 60 to 90% fewer tokens on those commands, and `rtk gain` shows your own numbers.',
    risk: 'The rewritten command is what permission rules see, so Bash(git status) stops matching rtk git status until Conclave judges rewrites by the original call. Not run in the research sandbox.',
    warnings: [
      'Do not install rtk\'s own Claude hook into Conclave: it returns allow after reading ~/.claude/settings.json, not Conclave\'s rules.',
      'Install the binary with your package manager or a pinned release. Use the rtk-oss edition for Apache-2.0 only.',
    ],
    overlaps: ['plugin:context-mode', 'hook:test-output-trim'],
  },
  {
    id: 'plugin:superpowers',
    kind: 'plugin',
    name: 'superpowers',
    repo: 'obra/superpowers',
    stars: 300828,
    starsAt: AT,
    description: 'Method skills for coding agents: brainstorming, writing and executing plans, systematic debugging, test-driven development, verification before completion, code review and git worktrees.',
    category: 'workflow',
    tags: ['tdd', 'debugging', 'planning', 'verification'],
    license: 'MIT',
    updatedAt: '2026-10-09',
    install: { type: 'plugin', plugins: ['superpowers@claude-plugins-official'], sha: PINS.superpowers, hooks: 'on' },
    touches: ['hub-code'],
    needs: [{ bin: 'bash', where: 'hub', why: 'Its SessionStart hook is a bash script.' }],
    hooks: [{ event: 'SessionStart', matcher: 'startup|clear|compact', interpreter: 'bash', note: 'Injects the using-superpowers skill.' }],
    recommended: true,
    rank: 7,
    source: 'recommended',
    verified: true,
    fit: 'Gives verification-before-completion and systematic debugging for coding and CTF scripts. Conclave already tested this plugin and its hook (EXTENSIONS.md).',
    risk: 'One SessionStart hook per session. Overlaps mattpocock-skills, so keep one method pack.',
    overlaps: ['plugin:mattpocock-skills'],
  },
  {
    id: 'skill:karpathy-guidelines',
    kind: 'skill',
    name: 'karpathy-guidelines',
    repo: 'multica-ai/andrej-karpathy-skills',
    stars: 220415,
    starsAt: AT,
    description: 'One short skill against common LLM coding mistakes: do not overcomplicate, make surgical changes, state assumptions, define checkable success criteria.',
    category: 'minimal-code',
    tags: ['surgical changes', 'assumptions', 'no hooks'],
    license: 'MIT (in SKILL.md frontmatter; the repo has no LICENSE file)',
    updatedAt: '2026-04-20',
    install: { type: 'files', repo: 'multica-ai/andrej-karpathy-skills', sha: PINS.karpathy, files: [{ from: 'skills/karpathy-guidelines/', to: 'skills/karpathy-guidelines/' }] },
    variants: [{ type: 'plugin', marketplace: 'multica-ai/andrej-karpathy-skills', plugins: ['andrej-karpathy-skills@karpathy-skills'], sha: PINS.karpathy }],
    touches: [],
    recommended: true,
    rank: 8,
    source: 'recommended',
    verified: true,
    fit: 'Same goal as ponytail in one plain file, with no hooks. Sync puts it in ~/.agents/skills for Codex and OpenCode.',
    risk: 'None beyond prompt text.',
    overlaps: ['plugin:ponytail', 'skill:minimalist'],
  },
  {
    id: 'subagent:code-simplifier',
    kind: 'subagent',
    name: 'code-simplifier',
    repo: 'anthropics/claude-plugins-official',
    stars: 40893,
    starsAt: AT,
    description: 'Subagent that simplifies recently changed code for clarity and consistency while keeping behavior the same.',
    category: 'minimal-code',
    tags: ['refactor', 'post-pass', 'anthropic'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-15',
    install: { type: 'files', repo: 'anthropics/claude-plugins-official', sha: PINS.claudePluginsOfficial, files: [{ from: 'plugins/code-simplifier/agents/code-simplifier.md', to: 'agents/code-simplifier.md' }] },
    variants: [{ type: 'plugin', plugins: ['code-simplifier@claude-plugins-official'], sha: PINS.claudePluginsOfficial }],
    touches: ['files'],
    recommended: true,
    rank: 9,
    source: 'recommended',
    verified: true,
    fit: 'A second pass after the coder agent, matching your "less code" goal. Pairs with ponytail.',
    risk: 'It edits files, so run it before you commit.',
  },
  {
    id: 'mcp:serena',
    kind: 'mcp',
    name: 'Serena',
    repo: 'oraios/serena',
    stars: 30338,
    starsAt: AT,
    description: 'Semantic code navigation and symbol-level edits through language servers.',
    category: 'code-intelligence',
    tags: ['language server', 'symbols', 'refactor'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: {
      type: 'mcp',
      server: 'serena',
      setup: [
        { say: 'Install Serena with uv on the hub. Upstream asks not to use marketplace commands, which are out of date.', run: 'uv tool install -p 3.13 serena-agent && serena init', on: 'hub', gives: ['serena'] },
      ],
      config: { command: 'serena', args: ['start-mcp-server', '--context', 'agent', '--project', '{{PROJECT}}'] },
    },
    inputs: [
      { name: 'PROJECT', label: 'Project folder', description: 'Absolute path of the repo on the hub. Conclave starts stdio servers with no working folder, so the project must be named.', required: true, secret: false, example: '/home/me/code/conclave' },
    ],
    touches: ['files', 'hub-code'],
    needs: [{ bin: 'serena', where: 'hub', why: 'Installed by the setup step.' }],
    recommended: true,
    rank: 10,
    source: 'recommended',
    verified: true,
    fit: 'Symbol search and refactors in TypeScript, Rust and Python with fewer tokens than grep plus read.',
    risk: 'Edits files and starts language servers, which use a lot of RAM. One project per server entry until MCP servers get a per-session folder.',
    overlaps: ['mcp:codebase-memory-mcp'],
  },
  {
    id: 'skill:ctf-skills',
    kind: 'skill',
    name: 'ctf-skills',
    repo: 'ljagiello/ctf-skills',
    stars: 3466,
    starsAt: AT,
    description: '11 CTF skills: solve-challenge routes to pwn, reverse, web, crypto, forensics, OSINT, malware, misc, AI and ML, and writeup.',
    category: 'ctf',
    tags: ['pwn', 'reverse', 'web', 'crypto', 'forensics', 'writeups'],
    license: 'MIT',
    updatedAt: '2026-10-16',
    install: {
      type: 'files',
      repo: 'ljagiello/ctf-skills',
      sha: PINS.ctfSkills,
      files: ['solve-challenge', 'ctf-pwn', 'ctf-reverse', 'ctf-web', 'ctf-crypto', 'ctf-forensics', 'ctf-osint', 'ctf-malware', 'ctf-misc', 'ctf-ai-ml', 'ctf-writeup'].map((d) => ({ from: `${d}/`, to: `skills/${d}/` })),
    },
    touches: [],
    recommended: true,
    rank: 11,
    source: 'recommended',
    verified: true,
    fit: 'Direct match for your CTF work. Pairs with the ctf-command-log recipe and the CTF radar routine.',
    risk: 'The skills tell the agent to install tools and use the internet. Run CTF sessions in an LXC on pve, not on the madx hub. Challenge files are untrusted input.',
  },
  {
    id: 'plugin:trailofbits',
    kind: 'plugin',
    name: 'Trail of Bits security skills',
    repo: 'trailofbits/skills',
    stars: 7605,
    starsAt: AT,
    description: 'Audit methods from Trail of Bits: false positive checks, variant analysis, differential review, Rust review, static analysis with semgrep and CodeQL, supply chain risk and sharp edges. 44 plugins; this set picks seven.',
    category: 'security',
    tags: ['audit', 'rust', 'semgrep', 'codeql', 'supply chain'],
    license: 'CC-BY-SA-4.0',
    updatedAt: '2026-10-15',
    install: {
      type: 'plugin',
      marketplace: 'trailofbits/skills',
      plugins: ['fp-check@trailofbits', 'variant-analysis@trailofbits', 'differential-review@trailofbits', 'rust-review@trailofbits', 'static-analysis@trailofbits', 'supply-chain-risk-auditor@trailofbits', 'sharp-edges@trailofbits'],
      sha: PINS.trailofbits,
      hooks: 'on',
    },
    touches: ['files', 'shell'],
    needs: [{ bin: 'semgrep', where: 'device', why: 'static-analysis runs semgrep (and CodeQL when installed) on the session\'s device.' }],
    hooks: [
      { event: 'Stop', matcher: '*', interpreter: 'prompt', timeout: 30, note: 'fp-check: a small-model check that each verdict went through every phase. Answers {"ok": false} to keep going.' },
      { event: 'SubagentStop', matcher: '*', interpreter: 'prompt', timeout: 30, note: 'fp-check: the same check for its subagents.' },
    ],
    recommended: true,
    rank: 12,
    source: 'recommended',
    verified: true,
    fit: 'Professional audit methods for security research, plus Rust-specific review. Pairs with the security agent.',
    risk: 'Share-alike applies if you redistribute modified skills. rust-review ships Python helper scripts.',
    warnings: [
      'fp-check\'s prompt hooks answer with {"ok": false, "reason": ...}, the Claude Code prompt hook shape. Conclave reads it after the hooks changes in ECOSYSTEM.md; until then those hooks do nothing.',
      'Each prompt hook costs one small-model call per finished turn.',
    ],
  },
  {
    id: 'subagent:reverse-engineering',
    kind: 'subagent',
    name: 'reverse-engineering agents',
    repo: 'wshobson/agents',
    stars: 40938,
    starsAt: AT,
    description: 'Subagents reverse-engineer, firmware-analyst and malware-analyst, plus skills for binary analysis patterns, protocol reverse engineering, memory forensics and anti-reversing techniques. Ghidra, IDA, radare2 and x64dbg workflows.',
    category: 'ctf',
    tags: ['reverse engineering', 'firmware', 'malware', 'ghidra'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: { type: 'plugin', marketplace: 'wshobson/agents', plugins: ['reverse-engineering@claude-code-workflows'], sha: PINS.wshobson },
    variants: [
      { type: 'files', repo: 'wshobson/agents', sha: PINS.wshobson, files: [{ from: 'plugins/reverse-engineering/agents/reverse-engineer.md', to: 'agents/reverse-engineer.md' }] },
    ],
    touches: [],
    recommended: true,
    rank: 13,
    source: 'recommended',
    verified: true,
    fit: 'Adds reverse engineering and firmware agents that the built-in security agent does not cover. Useful for CTF rev and pwn.',
    risk: 'Markdown only, no hooks. The agents ask for model opus, which goes through Conclave\'s model mapping.',
  },
  {
    id: 'mcp:ghidra',
    kind: 'mcp',
    name: 'GhidraMCP',
    repo: 'LaurieWired/GhidraMCP',
    stars: 11325,
    starsAt: AT,
    description: 'Ghidra extension plus an MCP bridge: decompile, rename and annotate binaries from the agent.',
    category: 'ctf',
    tags: ['reverse engineering', 'decompiler', 'binaries'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-10',
    install: {
      type: 'mcp',
      server: 'ghidra',
      label: 'Ghidra on arch-desktop, bridge over Tailscale',
      setup: [
        { say: 'Install the GhidraMCP extension from the 2.0 release in Ghidra (File, Install Extensions), restart Ghidra and enable the plugin.' },
        { say: 'On the same machine, start the bridge bound to the Tailscale address only.', run: 'uvx --from git+https://github.com/LaurieWired/GhidraMCP@2.0 ghidra-mcp --ghidra-server http://127.0.0.1:8080/ --transport streamable-http --mcp-host <tailscale ip> --mcp-port 8081', on: 'device' },
      ],
      config: { type: 'http', url: 'http://{{GHIDRA_HOST}}:8081/mcp' },
    },
    variants: [
      { type: 'mcp', server: 'ghidra', label: 'Ghidra on the hub', config: { command: 'uvx', args: ['--from', 'git+https://github.com/LaurieWired/GhidraMCP@2.0', 'ghidra-mcp', '--ghidra-server', 'http://127.0.0.1:8080/'] } },
    ],
    inputs: [
      { name: 'GHIDRA_HOST', label: 'Machine running Ghidra', description: 'Tailscale name of the machine that runs Ghidra and the bridge.', required: true, secret: false, default: 'arch-desktop' },
    ],
    touches: ['files', 'network'],
    recommended: true,
    rank: 14,
    source: 'recommended',
    verified: true,
    fit: 'CTF reverse engineering challenges, with Ghidra on the desktop and the agent on the hub.',
    risk: 'The bridge has no auth, so bind it to localhost or the Tailscale address. Analyse challenge binaries, never run them on the hub.',
  },
  {
    id: 'mcp:semgrep',
    kind: 'mcp',
    name: 'Semgrep MCP',
    repo: 'semgrep/semgrep',
    stars: 17097,
    starsAt: AT,
    description: 'Static analysis scans for bugs and vulnerabilities in code the agent writes or reviews.',
    category: 'security',
    tags: ['sast', 'scanning', 'secure coding'],
    license: 'LGPL-2.1',
    install: {
      type: 'mcp',
      server: 'semgrep',
      setup: [{ say: 'Install semgrep on the hub, then check that `semgrep mcp --help` works. The old standalone semgrep-mcp package is archived.', run: 'uv tool install semgrep', on: 'hub', gives: ['semgrep'] }],
      config: { command: 'semgrep', args: ['mcp'], env: { SEMGREP_APP_TOKEN: '{{SEMGREP_APP_TOKEN}}' } },
    },
    inputs: [
      { name: 'SEMGREP_APP_TOKEN', label: 'Semgrep AppSec token', description: 'Optional. Only for the Semgrep platform. Without it scans stay local.', required: false, secret: true, secretKey: 'semgrep-token' },
    ],
    touches: ['files', 'hub-code'],
    needs: [{ bin: 'semgrep', where: 'hub', why: 'Installed by the setup step.' }],
    recommended: true,
    rank: 15,
    source: 'recommended',
    verified: false,
    fit: 'Security research and secure coding in TypeScript, Python and Rust.',
    risk: 'Local scans. Code leaves the machine only when logged in to the Semgrep platform.',
  },
  {
    id: 'mcp:proxmox',
    kind: 'mcp',
    name: 'ProxmoxMCP-Plus',
    repo: 'RekklesNA/ProxmoxMCP-Plus',
    stars: 597,
    starsAt: AT,
    description: 'Proxmox VE nodes, VMs, LXCs, storage, backups, snapshots and logs, with server-side tool allowlists.',
    category: 'homelab',
    tags: ['proxmox', 'lxc', 'vms', 'backups'],
    license: 'MIT',
    updatedAt: '2026-10-12',
    install: {
      type: 'mcp',
      server: 'pve',
      setup: [{ say: 'On pve, create a user conclave@pve with an API token named conclave and give it the PVEAuditor role. Read-only first.' }],
      config: {
        command: 'uvx',
        args: ['proxmox-mcp-plus@0.6.2'],
        env: {
          PROXMOX_HOST: '{{PROXMOX_HOST}}',
          PROXMOX_USER: '{{PROXMOX_USER}}',
          PROXMOX_TOKEN_NAME: '{{PROXMOX_TOKEN_NAME}}',
          PROXMOX_TOKEN_VALUE: '{{PROXMOX_TOKEN_VALUE}}',
          PROXMOX_VERIFY_SSL: 'true',
          MCP_TOOL_ALLOWLIST: 'get_nodes,get_node_status,get_storage,get_cluster_status,get_vms,get_vm_config,get_vm_ip_addresses,get_containers,get_container_config,get_container_ip,list_snapshots,list_backups,list_jobs,get_job,list_templates,list_bridges,get_node_syslog,get_task_log,get_cluster_log',
        },
      },
      toolPresets: [
        {
          id: 'read-only',
          label: 'Read-only (PVEAuditor)',
          tools: ['get_nodes', 'get_node_status', 'get_storage', 'get_cluster_status', 'get_vms', 'get_vm_config', 'get_vm_ip_addresses', 'get_containers', 'get_container_config', 'get_container_ip', 'list_snapshots', 'list_backups', 'list_jobs', 'get_job', 'list_templates', 'list_bridges', 'get_node_syslog', 'get_task_log', 'get_cluster_log'],
        },
        {
          id: 'operator',
          label: 'Start, stop and snapshot',
          tools: ['get_nodes', 'get_node_status', 'get_storage', 'get_vms', 'get_vm_config', 'get_containers', 'get_container_config', 'list_snapshots', 'list_backups', 'get_task_log', 'start_vm', 'shutdown_vm', 'start_container', 'stop_container', 'restart_container', 'create_snapshot', 'create_backup'],
        },
      ],
    },
    inputs: [
      { name: 'PROXMOX_HOST', label: 'Proxmox host', description: 'Name or address of the Proxmox node.', required: true, secret: false, default: 'pve' },
      { name: 'PROXMOX_USER', label: 'API user', description: 'User that owns the token.', required: true, secret: false, default: 'conclave@pve' },
      { name: 'PROXMOX_TOKEN_NAME', label: 'Token name', description: 'Name of the API token.', required: true, secret: false, default: 'conclave' },
      { name: 'PROXMOX_TOKEN_VALUE', label: 'Token secret', description: 'The token secret Proxmox showed once when you made the token.', required: true, secret: true, secretKey: 'pve-token' },
    ],
    touches: ['real-devices', 'network'],
    needs: [UV_HUB],
    recommended: true,
    rank: 16,
    source: 'recommended',
    verified: true,
    fit: 'Direct fit for the pve host. The read-only preset is a safe first install, and the sysadmin agent gets structured state without shell access.',
    risk: 'Without an allowlist it can start, stop and delete guests, and execute_vm_command, execute_container_command and execute_node_command run anything. The allowlist does not replace Proxmox roles.',
    warnings: ['The preset sets both MCP_TOOL_ALLOWLIST on the server and tools in Conclave. Change both if you widen it.'],
  },
  {
    id: 'mcp:searxng',
    kind: 'mcp',
    name: 'SearXNG MCP',
    repo: 'ihor-sokoliuk/mcp-searxng',
    stars: 1312,
    starsAt: AT,
    description: 'Private web search and URL reading through your own SearXNG.',
    category: 'search',
    tags: ['web search', 'self-hosted', 'no api key'],
    license: 'MIT',
    updatedAt: '2026-10-13',
    install: { type: 'mcp', server: 'searxng', config: { command: 'npx', args: ['-y', 'mcp-searxng@2.6.0'], env: { SEARXNG_URL: '{{SEARXNG_URL}}' } }, offer: ['connect-clis'] },
    inputs: [{ name: 'SEARXNG_URL', label: 'SearXNG address', description: 'Base URL of your SearXNG instance.', required: true, secret: false, default: 'http://madx:8888' }],
    touches: ['network'],
    needs: [NPX_HUB],
    recommended: true,
    rank: 17,
    source: 'recommended',
    verified: true,
    fit: 'Search with no API key that stays in the homelab, shared by Claude Code, Codex and OpenCode through Connect to my CLIs.',
    risk: 'Low. It reads public pages.',
  },
  {
    id: 'mcp:chrome-devtools',
    kind: 'mcp',
    name: 'Chrome DevTools MCP',
    repo: 'ChromeDevTools/chrome-devtools-mcp',
    stars: 53697,
    starsAt: AT,
    description: 'Drives Chrome for debugging: console, network, performance traces and screenshots.',
    category: 'browser',
    tags: ['debugging', 'web apps', 'performance', 'official'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-16',
    install: { type: 'mcp', server: 'chrome-devtools', config: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0', '--headless', '--isolated'] } },
    touches: ['browser', 'network', 'hub-code'],
    needs: [NPX_HUB, { bin: 'google-chrome', where: 'hub', why: 'It starts Chrome on the machine that runs the server.' }],
    recommended: true,
    rank: 18,
    source: 'recommended',
    verified: true,
    fit: 'Debugging the web apps you build, beyond what Conclave\'s opt-in browser tools do.',
    risk: 'Controls a real browser. --isolated uses a throwaway profile; never point it at a profile with logins. Only the io.github.ChromeDevTools registry entry is genuine.',
  },
  {
    id: 'mcp:markitdown',
    kind: 'mcp',
    name: 'MarkItDown MCP',
    repo: 'microsoft/markitdown',
    stars: 190667,
    starsAt: AT,
    description: 'Converts PDF, DOCX, PPTX, XLSX, HTML and more to markdown for the model.',
    category: 'uni',
    tags: ['documents', 'office files', 'pdf'],
    license: 'MIT',
    updatedAt: '2026-10-03',
    install: { type: 'mcp', server: 'markitdown', config: { command: 'uvx', args: ['markitdown-mcp'] } },
    touches: ['files', 'network'],
    needs: [UV_HUB],
    recommended: true,
    rank: 19,
    source: 'recommended',
    verified: true,
    fit: 'Lecture slides and assignment files. Conclave\'s Read handles PDF text but treats docx, pptx and xlsx as binary.',
    risk: 'Reads any path or URL it is given. The package is still alpha (0.0.1a7).',
  },
  {
    id: 'mcp:scrapling',
    kind: 'mcp',
    name: 'Scrapling',
    repo: 'D4Vinci/Scrapling',
    stars: 89506,
    starsAt: AT,
    description: 'Undetectable, fast web scraping over MCP. The plain Fetcher is the cheap default (69 MB in the hub benchmark); StealthyFetcher gets past Turnstile and fingerprint checks but downloads its own browsers and peaks at about 2 GB RAM, so it is opt-in per call.',
    category: 'search',
    tags: ['scraping', 'anti-bot', 'web', 'stealth'],
    license: 'BSD-3-Clause',
    updatedAt: '2026-10-25',
    install: { type: 'mcp', server: 'scrapling', config: { command: 'uvx', args: ['--from', 'scrapling', 'scrapling', 'mcp'] } },
    touches: ['network'],
    needs: [UV_HUB],
    recommended: true,
    rank: 29,
    source: 'recommended',
    verified: true,
    fit: 'Stealthy fetching for pages that block ordinary requests (Indeed, Zillow). It complements the built-in browser: benchmarked at 1.2 s startup over stdio with 16 tools, and a StealthyFetcher run can hand off to CloakBrowser over CDP.',
    risk: 'StealthyFetcher downloads its own patchright browsers (about 681 MB on disk) and peaked at about 2 GB RAM in the benchmark. The plain Fetcher passed Zillow at 69 MB and is the cheap default. Etsy (DataDome) blocked every mode.',
  },
  {
    id: 'skill:document-skills',
    kind: 'skill',
    name: 'document skills (pdf, docx, xlsx, pptx)',
    repo: 'anthropics/skills',
    stars: 181646,
    starsAt: AT,
    description: 'Anthropic\'s skills to read, fill and create PDFs, Word, Excel and PowerPoint files, with helper scripts.',
    category: 'uni',
    tags: ['pdf', 'word', 'excel', 'powerpoint', 'anthropic'],
    license: 'Source-available (Anthropic terms), not open source',
    updatedAt: '2026-10-09',
    install: {
      type: 'files',
      repo: 'anthropics/skills',
      sha: PINS.anthropicSkills,
      files: ['pdf', 'docx', 'xlsx', 'pptx'].map((d) => ({ from: `skills/${d}/`, to: `skills/${d}/` })),
    },
    touches: ['files', 'shell'],
    needs: [{ bin: 'python3', where: 'device', why: 'The helper scripts need pypdf and openpyxl, and sometimes LibreOffice, on the session\'s device.' }],
    recommended: true,
    rank: 20,
    source: 'recommended',
    verified: true,
    fit: 'Uni work: papers in PDF, Word assignments, Excel data.',
    risk: 'Fine for personal use under Anthropic\'s terms. The marketplace entry uses strict:false with its own skills list, which Conclave does not honor yet, so this copies the folders.',
  },
  {
    id: 'plugin:claude-md-management',
    kind: 'plugin',
    name: 'claude-md-management',
    repo: 'anthropics/claude-plugins-official',
    stars: 40893,
    starsAt: AT,
    description: 'The claude-md-improver skill audits CLAUDE.md quality against criteria and templates, and /revise-claude-md captures what a session learned into the project instructions.',
    category: 'memory',
    tags: ['claude.md', 'agents.md', 'instructions', 'anthropic'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-15',
    install: { type: 'plugin', plugins: ['claude-md-management@claude-plugins-official'], sha: PINS.claudePluginsOfficial },
    touches: ['files'],
    recommended: true,
    rank: 21,
    source: 'recommended',
    verified: true,
    fit: 'Gives the librarian routines a tested way to keep each repo\'s CLAUDE.md and AGENTS.md short and current.',
    risk: 'It edits instruction files, so review the diff.',
  },
  {
    id: 'skill:avoid-ai-writing',
    kind: 'skill',
    name: 'avoid-ai-writing',
    repo: 'conorbronsdon/avoid-ai-writing',
    stars: 5054,
    starsAt: AT,
    description: 'Audits and rewrites prose that reads as machine-written: word tiers, a pattern catalog, and detect-only, rewrite or edit-in-place modes.',
    category: 'writing',
    tags: ['prose', 'editing', 'reports'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: { type: 'plugin', marketplace: 'conorbronsdon/avoid-ai-writing', plugins: ['avoid-ai-writing@conorbronsdon-skills'], sha: PINS.avoidAiWriting },
    variants: [{ type: 'files', repo: 'conorbronsdon/avoid-ai-writing', sha: PINS.avoidAiWriting, files: [{ from: 'skills/avoid-ai-writing/', to: 'skills/avoid-ai-writing/' }] }],
    touches: [],
    recommended: true,
    rank: 22,
    source: 'recommended',
    verified: true,
    fit: 'Matches your writing rules (short sentences, no AI words) for READMEs, PR text and uni reports.',
    risk: 'None beyond prompt text.',
  },
  {
    id: 'skill:skill-creator',
    kind: 'skill',
    name: 'skill-creator',
    repo: 'anthropics/skills',
    stars: 181646,
    starsAt: AT,
    description: 'Anthropic\'s skill for writing, testing and improving skills, including description tuning and evals.',
    category: 'meta',
    tags: ['skills', 'evals', 'anthropic'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-09',
    install: { type: 'files', repo: 'anthropics/skills', sha: PINS.anthropicSkills, files: [{ from: 'skills/skill-creator/', to: 'skills/skill-creator/' }] },
    variants: [{ type: 'plugin', plugins: ['skill-creator@claude-plugins-official'], sha: PINS.claudePluginsOfficial }],
    touches: ['files'],
    needs: [{ bin: 'python3', where: 'device', why: 'Its eval helpers are Python scripts.' }],
    recommended: true,
    rank: 23,
    source: 'recommended',
    verified: true,
    fit: 'Turns homelab runbooks (Proxmox backups, LXC setup) into skills that Sync sends to every CLI.',
    risk: 'Includes Python helper scripts. No hooks.',
  },
  {
    id: 'skill:recursive-improve',
    kind: 'skill',
    name: 'recursive-improve',
    repo: 'kayba-ai/recursive-improve',
    stars: 295,
    starsAt: AT,
    description: 'Skills that read agent traces, find repeated failures (loops, give-ups, tool errors), fix the agent on a branch and keep or revert by benchmark: /recursive-improve, /ratchet and /benchmark.',
    category: 'self-improvement',
    tags: ['traces', 'evals', 'keep or revert'],
    license: 'Apache-2.0',
    updatedAt: '2026-04-01',
    install: {
      type: 'files',
      repo: 'kayba-ai/recursive-improve',
      sha: PINS.recursiveImprove,
      files: ['recursive-improve', 'ratchet', 'benchmark'].map((d) => ({ from: `.claude/skills/${d}/`, to: `skills/${d}/` })),
    },
    variants: [{ type: 'routine', suggestion: 'agent-tune-up' }],
    touches: ['files', 'shell', 'repos'],
    needs: [{ bin: 'recursive-improve', where: 'device', why: 'The skills read traces written by its Python package: uv tool install "recursive-improve[all] @ git+https://github.com/kayba-ai/recursive-improve.git@9cf4b85ef6ef66d37ea3c452f49114ff7db1b1a3".' }],
    recommended: true,
    rank: 24,
    source: 'recommended',
    verified: true,
    fit: 'You pointed at it. For your own Python agents the skills work as published. For Conclave\'s agents, the Agent tune-up routine runs the same loop over stored sessions with no tracer.',
    risk: '/ratchet runs the agent unattended with auto-approval, so keep it on a branch with stop-verify on. Traces can hold secrets. Small project with little upkeep.',
  },
  {
    id: 'mcp:mcp-proxy',
    kind: 'mcp',
    name: 'mcp-proxy',
    repo: 'sparfenyuk/mcp-proxy',
    stars: 2791,
    starsAt: AT,
    description: 'Bridges stdio servers to streamable HTTP, with named servers. Puts device-bound servers (Zotero desktop, Ghidra, a local Chrome) on the tailnet so the hub and every CLI can reach them.',
    category: 'homelab',
    tags: ['bridge', 'tailscale', 'stdio to http'],
    license: 'MIT',
    updatedAt: '2026-10-14',
    install: {
      type: 'mcp',
      server: '{{NAME}}',
      label: 'One named server behind mcp-proxy on a device',
      setup: [
        { say: 'On the device, start mcp-proxy bound to its Tailscale address. Add one --named-server per server.', run: "uvx mcp-proxy --host <tailscale ip> --port 8096 --pass-environment --named-server zotero 'zotero-mcp serve'", on: 'device' },
      ],
      config: { type: 'http', url: 'http://{{DEVICE}}:8096/servers/{{NAME}}/mcp' },
    },
    inputs: [
      { name: 'DEVICE', label: 'Device', description: 'Tailscale name of the device running mcp-proxy.', required: true, secret: false, default: 'macbook' },
      { name: 'NAME', label: 'Server name', description: 'The --named-server name. It is also the server name in Conclave.', required: true, secret: false, example: 'zotero' },
    ],
    touches: ['network', 'files'],
    recommended: true,
    rank: 25,
    source: 'recommended',
    verified: true,
    fit: 'Conclave starts stdio servers only on the hub. This is how a server that needs your desktop or Mac reaches the hub until MCP servers can run on a device.',
    risk: 'No auth by default, so bind it to the Tailscale address only. It forwards whatever the wrapped server can do.',
  },
  {
    id: 'mcp:dbhub',
    kind: 'mcp',
    name: 'DBHub',
    repo: 'bytebase/dbhub',
    stars: 3665,
    starsAt: AT,
    description: 'One token-conscious server for Postgres, MySQL, MariaDB, SQL Server and SQLite, with SSH tunnels.',
    category: 'databases',
    tags: ['postgres', 'mysql', 'sqlite', 'sql'],
    license: 'MIT',
    updatedAt: '2026-10-13',
    install: { type: 'mcp', server: 'db', config: { command: 'npx', args: ['-y', '@bytebase/dbhub@1.5.0', '--transport', 'stdio'], env: { DSN: '{{DSN}}' } } },
    inputs: [{ name: 'DSN', label: 'Connection string', description: 'Database URL with a read-only user.', required: true, secret: true, secretKey: 'db-dsn', example: 'postgres://reader:pass@madx:5432/app' }],
    touches: ['network'],
    needs: [NPX_HUB],
    recommended: true,
    rank: 26,
    source: 'recommended',
    verified: true,
    fit: 'Homelab and uni databases from one server.',
    risk: 'It can run write SQL, so give it a read-only database user. The DSN sits in env because Conclave expands secrets only in env and headers.',
  },
  {
    id: 'mcp:zotero',
    kind: 'mcp',
    name: 'Zotero MCP',
    repo: '54yyyu/zotero-mcp',
    stars: 5437,
    starsAt: AT,
    description: 'Search, read and annotate a Zotero library, with semantic search and citations.',
    category: 'uni',
    tags: ['papers', 'citations', 'research'],
    license: 'MIT',
    updatedAt: '2026-10-16',
    install: {
      type: 'mcp',
      server: 'zotero',
      label: 'Zotero web API from the hub',
      setup: [{ say: 'Install the server on the hub.', run: 'uv tool install zotero-mcp-server==0.15.1', on: 'hub', gives: ['zotero-mcp'] }],
      config: { command: 'zotero-mcp', args: ['serve'], env: { ZOTERO_LOCAL: 'false', ZOTERO_API_KEY: '{{ZOTERO_API_KEY}}', ZOTERO_LIBRARY_ID: '{{ZOTERO_LIBRARY_ID}}', ZOTERO_LIBRARY_TYPE: 'user' } },
    },
    variants: [
      { type: 'mcp', server: 'zotero', label: 'Zotero desktop on the macbook, through mcp-proxy', config: { type: 'http', url: 'http://macbook:8096/servers/zotero/mcp' } },
    ],
    inputs: [
      { name: 'ZOTERO_API_KEY', label: 'Zotero API key', description: 'From zotero.org settings. Read-only is enough for search.', required: true, secret: true, secretKey: 'zotero-key' },
      { name: 'ZOTERO_LIBRARY_ID', label: 'Library id', description: 'Your numeric user id on zotero.org.', required: true, secret: false },
    ],
    touches: ['cloud-account', 'network'],
    needs: [{ bin: 'zotero-mcp', where: 'hub', why: 'Installed by the setup step.' }],
    recommended: true,
    rank: 27,
    source: 'recommended',
    verified: true,
    fit: 'Uni papers and citations, if you keep them in Zotero.',
    risk: 'A key with write access can change the library. Local mode needs Zotero desktop on the same machine as the server.',
  },
  {
    id: 'mcp:grafana',
    kind: 'mcp',
    name: 'Grafana MCP',
    repo: 'grafana/mcp-grafana',
    stars: 3568,
    starsAt: AT,
    description: 'Search dashboards and query Prometheus, Loki and other datasources through Grafana.',
    category: 'monitoring',
    tags: ['prometheus', 'loki', 'dashboards', 'official'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-14',
    install: {
      type: 'mcp',
      server: 'grafana',
      config: {
        command: 'docker',
        args: ['run', '-i', '--rm', '-e', 'GRAFANA_URL', '-e', 'GRAFANA_SERVICE_ACCOUNT_TOKEN', 'mcp/grafana', '-t', 'stdio'],
        env: { GRAFANA_URL: '{{GRAFANA_URL}}', GRAFANA_SERVICE_ACCOUNT_TOKEN: '{{GRAFANA_TOKEN}}' },
      },
    },
    inputs: [
      { name: 'GRAFANA_URL', label: 'Grafana address', description: 'Base URL of Grafana.', required: true, secret: false, default: 'http://madx:3000' },
      { name: 'GRAFANA_TOKEN', label: 'Service account token', description: 'A Viewer service account token.', required: true, secret: true, secretKey: 'grafana-token' },
    ],
    touches: ['network'],
    needs: [DOCKER_HUB],
    recommended: true,
    rank: 28,
    source: 'recommended',
    verified: true,
    fit: 'One server for homelab metrics and logs, if Grafana runs on madx.',
    risk: 'Write tools can edit dashboards, so use a Viewer service account. Image mcp/grafana from the Docker MCP catalog (1.07M pulls).',
  },

  // ---------------------------------------------------------------------------
  // Listed, not recommended: shown under search and kind filters
  // ---------------------------------------------------------------------------
  {
    id: 'plugin:context-mode',
    kind: 'plugin',
    name: 'context-mode',
    repo: 'mksglu/context-mode',
    stars: 30330,
    starsAt: AT,
    description: 'Keeps large tool output out of the context: a sandboxed ctx_execute, an FTS5 index with ctx_search, and session state that survives compaction. MCP server plus hooks.',
    category: 'token-savers',
    tags: ['tool output', 'sandbox', 'compaction'],
    license: 'Elastic-2.0 (source-available)',
    updatedAt: '2026-10-16',
    install: { type: 'plugin', marketplace: 'mksglu/context-mode', plugins: ['context-mode@context-mode'], sha: PINS.contextMode, hooks: 'on' },
    variants: [{ type: 'mcp', server: 'context-mode', label: 'MCP server only, no hooks', config: { command: 'npx', args: ['-y', 'context-mode'] } }],
    touches: ['hub-code', 'shell', 'files'],
    needs: [{ bin: 'node', where: 'hub', why: 'Node 22.5 or newer with a native better-sqlite3 build.' }],
    hooks: [
      { event: 'PreToolUse', matcher: 'Bash, Read, Grep, WebFetch, Agent, mcp__', interpreter: 'node', note: 'Rewrites tool calls into its sandbox.' },
      { event: 'PostToolUse', interpreter: 'node', note: 'Runs after almost every tool.' },
      { event: 'PreCompact', interpreter: 'node' },
      { event: 'SessionStart', interpreter: 'node' },
      { event: 'UserPromptSubmit', interpreter: 'node' },
      { event: 'Stop', interpreter: 'node' },
    ],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'The MCP-side token saver. Conclave already took its main idea (tool output offload with an id), so the overlap is large.',
    risk: 'Runs code on the hub on almost every tool call and rewrites calls. Its "mcp__" matcher is an exact name in Claude Code and Conclave, so its MCP routing hooks never fire.',
    warnings: ['Non-OSI license (Elastic-2.0).', 'Hooks on almost every tool call: each call pays node start-up time.'],
    overlaps: ['hook:rtk-rewrite', 'hook:test-output-trim', 'hook:mcp-json-compact'],
  },
  {
    id: 'plugin:cc-safety-net',
    kind: 'plugin',
    name: 'cc-safety-net',
    repo: 'kenryu42/cc-safety-net',
    stars: 1646,
    starsAt: AT,
    description: 'Guard that parses commands, so bash -c and python -c wrappers do not hide them. Blocks destructive git and file commands and secret reads, with presets and rulebooks for Terraform and clouds.',
    category: 'safety',
    tags: ['guard', 'git', 'secrets', 'codex', 'opencode'],
    license: 'MIT',
    updatedAt: '2026-10-17',
    install: { type: 'plugin', plugins: ['kenryu42/cc-safety-net'], sha: PINS.ccSafetyNet, hooks: 'on' },
    touches: ['hub-code'],
    needs: [NODE_HUB],
    hooks: [{ event: 'PreToolUse', interpreter: 'node', note: 'No matcher and no timeout: a 380 KB script runs on every tool call, 80 to 150 ms each.' }],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A stronger parser than the regex recipes, and it also supports Codex and OpenCode on your laptops.',
    risk: 'Overlaps the git-work-saver and secrets-firewall recipes and Conclave\'s own dangerous-command guard. Pick one per machine.',
    overlaps: ['hook:git-work-saver', 'hook:secrets-firewall'],
  },
  {
    id: 'skill:caveman-focus',
    kind: 'skill',
    name: 'caveman focus skills',
    repo: 'JuliusBrussee/caveman',
    stars: 113108,
    starsAt: AT,
    description: 'Five task-shape skills without the caveman voice: verify-and-stop, surgical-patch, lean-build, investigate-first and safe-refactor.',
    category: 'focus',
    tags: ['verification', 'minimal patch', 'no hooks'],
    license: 'Apache-2.0',
    updatedAt: '2026-10-17',
    install: {
      type: 'files',
      repo: 'JuliusBrussee/caveman',
      sha: PINS.caveman,
      files: ['verify-and-stop', 'surgical-patch', 'lean-build', 'investigate-first', 'safe-refactor'].map((d) => ({ from: `skills/${d}/`, to: `skills/${d}/` })),
    },
    touches: [],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Focus and verification for agents or CLIs where you want plain prose.',
    risk: 'Plain markdown. The caveman plugin ships the same skills, so install one copy.',
    overlaps: ['plugin:caveman'],
  },
  {
    id: 'skill:minimalist',
    kind: 'skill',
    name: 'minimalist',
    repo: 'alirezarezvani/claude-skills',
    stars: 28299,
    starsAt: AT,
    description: 'One-file YAGNI ladder: reuse, stdlib, native platform, existing dependencies, then new code.',
    category: 'minimal-code',
    tags: ['yagni', 'no hooks'],
    license: 'MIT',
    updatedAt: '2026-08-26',
    install: { type: 'files', repo: 'alirezarezvani/claude-skills', sha: PINS.alirezarezvani, files: [{ from: 'engineering/minimalist/', to: 'skills/minimalist/' }] },
    touches: [],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A hook-free fallback for CLIs or devices without node.',
    risk: 'Duplicates ponytail and karpathy-guidelines.',
    overlaps: ['plugin:ponytail', 'skill:karpathy-guidelines'],
  },
  {
    id: 'skill:ai-debt-detector',
    kind: 'skill',
    name: 'ai-debt-detector',
    repo: 'wshobson/agents',
    stars: 40938,
    starsAt: AT,
    description: 'Finds hidden debt in agent-written code: thin error handling, orphaned resources, copy-paste drift.',
    category: 'verification',
    tags: ['review', 'agent code', 'no hooks'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: { type: 'files', repo: 'wshobson/agents', sha: PINS.wshobson, files: [{ from: 'plugins/skill-forge-essentials/skills/ai-debt-detector/', to: 'skills/ai-debt-detector/' }] },
    touches: [],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A verification pass after agent-written code.',
    risk: 'Markdown only.',
  },
  {
    id: 'plugin:i-have-adhd',
    kind: 'plugin',
    name: 'i-have-adhd',
    repo: 'ayghri/i-have-adhd',
    stars: 57463,
    starsAt: AT,
    description: 'Output shaping: lead with the next action, number steps, restate state across turns, cut tangents.',
    category: 'focus',
    tags: ['answer first', 'steps'],
    license: 'MIT',
    updatedAt: '2026-10-11',
    install: { type: 'plugin', marketplace: 'ayghri/i-have-adhd', plugins: ['i-have-adhd@i-have-adhd'], sha: PINS.iHaveAdhd, hooks: 'on' },
    variants: [{ type: 'files', repo: 'ayghri/i-have-adhd', sha: PINS.iHaveAdhd, files: [{ from: 'skills/i-have-adhd/', to: 'skills/i-have-adhd/' }] }],
    touches: ['hub-code'],
    needs: [NODE_HUB],
    hooks: [{ event: 'SessionStart', interpreter: 'node' }],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Same goal as caveman (answer first) from a readability angle.',
    risk: 'Its SKILL.md sets disable-model-invocation, which Conclave\'s loader ignores today, so the model could load it on its own.',
    overlaps: ['plugin:caveman'],
  },
  {
    id: 'plugin:planning-with-files',
    kind: 'plugin',
    name: 'planning-with-files',
    repo: 'OthmanAdi/planning-with-files',
    stars: 27482,
    starsAt: AT,
    description: 'Keeps task_plan.md, findings.md and progress.md in the project and re-injects them every turn, so long tasks survive /clear and compaction.',
    category: 'focus',
    tags: ['plans', 'long tasks', 'compaction'],
    license: 'MIT',
    updatedAt: '2026-10-16',
    install: { type: 'plugin', marketplace: 'OthmanAdi/planning-with-files', plugins: ['planning-with-files@planning-with-files'], sha: PINS.planningWithFiles, hooks: 'on' },
    touches: ['hub-code', 'files'],
    needs: [{ bin: 'bash', where: 'hub', why: 'Its hooks are shell scripts.' }],
    hooks: [
      { event: 'SessionStart', interpreter: 'bash' },
      { event: 'UserPromptSubmit', interpreter: 'bash' },
      { event: 'PreToolUse', matcher: 'Write|Edit|Bash|Read|Glob|Grep', interpreter: 'bash' },
      { event: 'PostToolUse', matcher: 'Write|Edit', interpreter: 'bash' },
      { event: 'PreCompact', interpreter: 'bash' },
      { event: 'Stop', interpreter: 'bash' },
    ],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Long uni assignments and multi-day CTFs. The reinject-after-compact recipe does the core of it with one hook.',
    risk: 'A shell script runs on nearly every tool call.',
    overlaps: ['hook:reinject-after-compact'],
  },
  {
    id: 'plugin:mattpocock-skills',
    kind: 'plugin',
    name: 'mattpocock-skills',
    repo: 'mattpocock/skills',
    stars: 294322,
    starsAt: AT,
    description: '38 engineering skills: tdd, diagnosing bugs, grill-me, to-spec, to-tickets, implement, code review, handoff, domain modeling.',
    category: 'workflow',
    tags: ['typescript', 'tdd', 'specs'],
    license: 'MIT',
    updatedAt: '2026-10-09',
    install: { type: 'plugin', plugins: ['mattpocock-skills@claude-plugins-official'], sha: PINS.mattpocock },
    touches: [],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A strong TypeScript-centric method pack, if you prefer it to superpowers.',
    risk: 'No hooks. Overlaps superpowers, so keep one method pack.',
    overlaps: ['plugin:superpowers'],
  },
  {
    id: 'mcp:agentic-tools',
    kind: 'mcp',
    name: 'agentic-tools-mcp',
    repo: 'Pimzino/agentic-tools-mcp',
    stars: 88,
    starsAt: AT,
    description: '29 tools for projects, nested tasks with dependencies, complexity and hours, PRD parsing, next-task scoring and simple memories, stored as JSON in <cwd>/.agentic-tools-mcp/.',
    category: 'tasks',
    tags: ['tasks', 'projects', 'memories'],
    license: 'MIT',
    updatedAt: '2025-06-20',
    install: { type: 'mcp', server: 'agentic-tools', config: { command: 'npx', args: ['-y', '@pimzino/agentic-tools-mcp@1.8.1', '--claude'] } },
    touches: ['files', 'hub-code'],
    needs: [NPX_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'You linked it. It overlaps Conclave\'s task board and memory, so Conclave imports its data instead (Tasks, Import) and takes its parent links, dependencies and next-ready-task pick into the task board.',
    risk: 'Last commit 2025-06-20. It saves with a plain writeFile, with no atomic rename and no lock, so two agents can clobber each other. Every call needs an absolute workingDirectory.',
    warnings: ['--claude keeps one global store in ~/.agentic-tools-mcp instead of one per working folder.'],
  },
  {
    id: 'mcp:playwright',
    kind: 'mcp',
    name: 'Playwright MCP',
    repo: 'microsoft/playwright-mcp',
    stars: 38261,
    starsAt: AT,
    description: 'Browser automation through accessibility snapshots.',
    category: 'browser',
    tags: ['automation', 'testing', 'official'],
    license: 'Apache-2.0',
    install: { type: 'mcp', server: 'playwright', config: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.82'] } },
    touches: ['browser', 'network', 'hub-code'],
    needs: [NPX_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'For sharing one browser server with other CLIs. Inside Conclave the opt-in browser tools cover it.',
    risk: 'Snapshots use a lot of tokens. It drives a real browser.',
  },
  {
    id: 'mcp:invisible-playwright',
    kind: 'mcp',
    name: 'invisible_playwright MCP',
    repo: 'feder-cr/invisible_playwright_mcp',
    stars: 2201,
    starsAt: '2026-10-20',
    description: 'Browser server on a Firefox patched at the source to hide automation, driven over Juggler with human-like pointer and typing. Tools mirror the Playwright MCP names.',
    category: 'browser',
    tags: ['firefox', 'stealth', 'anti-bot', 'python'],
    license: 'MIT',
    updatedAt: '2026-10-17',
    install: { type: 'mcp', server: 'invisible-playwright', config: { command: 'uvx', args: ['invisible-playwright-mcp==0.72.3'], env: { STEALTHFOX_PROXY: '{{STEALTHFOX_PROXY}}' } } },
    inputs: [
      {
        name: 'STEALTHFOX_PROXY',
        label: 'Proxy',
        description: 'Optional. Timezone, locale and exit IP follow it; without one they are the hub\'s own.',
        required: false,
        secret: true,
        secretKey: 'invisible-playwright-proxy',
        example: 'socks5://proxy.example.com:1080',
      },
    ],
    touches: ['browser', 'network', 'hub-code'],
    needs: [UV_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'For sites that block stock Chromium. Python only and Firefox over Juggler, with no CDP, so it cannot back Conclave\'s browser tools or the takeover view; it runs as its own server.',
    risk: 'The first start downloads the patched Firefox from a GitHub release. Each launch fetches a counter file from a GitHub release (no identifier, but GitHub sees the hub\'s IP). Not for design screenshots: fonts, canvas and screen size are spoofed.',
    warnings: [
      'The launch counter cannot be turned off here. Its switch, the invisible_firefox.usage_ping.enabled=false pref, is only reachable through the Python library\'s extra_prefs; the MCP server takes no prefs and rewrites user.js on every launch.',
      'Tools never see Conclave\'s browser profiles or logins. Set STEALTHFOX_PROFILE_DIR in its env to keep its own.',
    ],
    overlaps: ['mcp:playwright', 'mcp:chrome-devtools'],
  },
  {
    id: 'mcp:codebase-memory-mcp',
    kind: 'mcp',
    name: 'codebase-memory-mcp',
    repo: 'DeusData/codebase-memory-mcp',
    stars: 46737,
    starsAt: AT,
    description: 'Single C binary that indexes a repo into a code knowledge graph for low-token queries.',
    category: 'code-intelligence',
    tags: ['code graph', 'token saver'],
    updatedAt: '2026-10-16',
    install: { type: 'mcp', server: 'cbm', config: { command: 'npx', args: ['-y', 'codebase-memory-mcp@0.12.0'] } },
    touches: ['files', 'hub-code'],
    needs: [NPX_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A token saver for big repos, but it overlaps Serena and Conclave\'s RepoMap. Pick one.',
    risk: 'Young project (created 2026-02) with 645 open issues. Ships native binaries.',
    overlaps: ['mcp:serena'],
  },
  {
    id: 'mcp:radare2',
    kind: 'mcp',
    name: 'radare2 MCP',
    repo: 'radareorg/radare2-mcp',
    stars: 325,
    starsAt: AT,
    description: 'Official radare2 stdio server for disassembly and binary inspection.',
    category: 'ctf',
    tags: ['disassembler', 'binaries', 'headless'],
    license: 'LGPL-3.0',
    updatedAt: '2026-10-16',
    install: {
      type: 'mcp',
      server: 'r2',
      setup: [{ say: 'Install radare2 on the hub, then the r2mcp package with r2pm as the README says.', run: 'r2pm -ci r2mcp', on: 'hub', gives: ['r2mcp'] }],
      config: { command: 'r2mcp' },
    },
    touches: ['files', 'hub-code'],
    needs: [{ bin: 'r2mcp', where: 'hub', why: 'Installed by the setup step.' }],
    recommended: false,
    source: 'recommended',
    verified: false,
    fit: 'A headless option for CTFs when Ghidra is too heavy.',
    risk: 'Challenge binaries are hostile input.',
  },
  {
    id: `skill:${ELASTIC_LINUX_RULES_DIR}`,
    kind: 'skill',
    name: 'Elastic detection rules for Linux',
    repo: 'elastic/detection-rules',
    stars: 2839,
    starsAt: '2026-10-20',
    description: 'Elastic\'s 376 Linux detection rules and 43 Linux hunting queries, with a SKILL.md from Conclave that turns their logic into read-only checks on a machine: logs, systemd units, crontabs, authorized_keys, ld.so.preload, PAM and udev.',
    category: 'security',
    tags: ['detection rules', 'linux', 'persistence', 'privilege escalation', 'att&ck', 'threat hunting'],
    license: 'Elastic-2.0',
    updatedAt: '2026-10-20',
    install: {
      type: 'files',
      repo: 'elastic/detection-rules',
      sha: PINS.elasticDetectionRules,
      files: [
        { from: 'rules/linux/', to: `skills/${ELASTIC_LINUX_RULES_DIR}/rules/linux/` },
        { from: 'hunting/linux/queries/', to: `skills/${ELASTIC_LINUX_RULES_DIR}/hunting/linux/queries/` },
        { from: 'LICENSE.txt', to: `skills/${ELASTIC_LINUX_RULES_DIR}/LICENSE.txt` },
        { from: 'NOTICE.txt', to: `skills/${ELASTIC_LINUX_RULES_DIR}/NOTICE.txt` },
      ],
      write: [{ to: `skills/${ELASTIC_LINUX_RULES_DIR}/SKILL.md`, text: ELASTIC_LINUX_RULES_SKILL }],
    },
    touches: ['files'],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A checklist of how Linux persistence and privilege escalation look, for the security and sysadmin agents on pve, madx and the Arch desktop. The persistence sweep routine works through it.',
    risk: 'About 3.5 MB of TOML in one skill folder. The SKILL.md tells the agent to run read-only commands only and to treat rule text as data.',
    warnings: [
      'Non-OSI license (Elastic-2.0). Keep LICENSE.txt and NOTICE.txt with the rules.',
      'The rules are written for Elastic Common Schema (ECS) events. Nothing runs EQL here: the agent reads a rule and checks the machine for the same thing by hand, so some rules need data the machine does not keep.',
    ],
  },
  {
    id: 'mcp:google-workspace',
    kind: 'mcp',
    name: 'Google Workspace MCP',
    repo: 'taylorwilsdon/google_workspace_mcp',
    stars: 3353,
    starsAt: AT,
    description: 'Gmail, Calendar, Drive, Docs, Sheets, Tasks and more.',
    category: 'calendar-mail',
    tags: ['gmail', 'calendar', 'drive'],
    license: 'MIT',
    updatedAt: '2026-10-09',
    install: {
      type: 'mcp',
      server: 'gws',
      config: { command: 'uvx', args: ['workspace-mcp@2.1.0'], env: { GOOGLE_OAUTH_CLIENT_ID: '{{GOOGLE_OAUTH_CLIENT_ID}}', GOOGLE_OAUTH_CLIENT_SECRET: '{{GOOGLE_OAUTH_CLIENT_SECRET}}' } },
    },
    inputs: [
      { name: 'GOOGLE_OAUTH_CLIENT_ID', label: 'OAuth client id', description: 'From your own Google Cloud OAuth client.', required: true, secret: true, secretKey: 'gws-client-id' },
      { name: 'GOOGLE_OAUTH_CLIENT_SECRET', label: 'OAuth client secret', description: 'From the same OAuth client.', required: true, secret: true, secretKey: 'gws-client-secret' },
    ],
    touches: ['mail', 'cloud-account', 'network'],
    needs: [UV_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Strong if your uni or personal mail is Google. Needed before the mail routines make sense.',
    risk: 'Reads and sends mail as you, and mail is untrusted input. Its registry entry has no repository field, so the trust check cannot verify it.',
  },
  {
    id: 'mcp:ms-365',
    kind: 'mcp',
    name: 'Microsoft 365 MCP',
    repo: 'Softeria/ms-365-mcp-server',
    stars: 1051,
    starsAt: AT,
    description: 'Outlook mail and calendar, OneDrive, Teams and To Do through the Graph API.',
    category: 'calendar-mail',
    tags: ['outlook', 'teams', 'onedrive'],
    license: 'MIT',
    updatedAt: '2026-10-17',
    install: { type: 'mcp', server: 'm365', setup: [{ say: 'The first run does a device-code login. Watch the server log in MCP servers, Tools.' }], config: { command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server@0.169.1'] } },
    touches: ['mail', 'cloud-account', 'network'],
    needs: [NPX_HUB],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Strong if your uni uses Microsoft 365.',
    risk: 'Broad Graph scopes, and mail is untrusted input.',
  },
  {
    id: 'subagent:surgeon-reviewer',
    kind: 'subagent',
    name: 'surgeon-reviewer',
    repo: 'VoltAgent/awesome-claude-code-subagents',
    stars: 25777,
    starsAt: AT,
    description: 'Reviewer that reports only real problems, ranked by blast radius, with a ship or no-ship verdict.',
    category: 'review',
    tags: ['code review', 'terse'],
    license: 'MIT',
    updatedAt: '2026-10-11',
    install: { type: 'files', repo: 'VoltAgent/awesome-claude-code-subagents', sha: PINS.voltagent, files: [{ from: 'categories/04-quality-security/surgeon-reviewer.md', to: 'agents/surgeon-reviewer.md' }] },
    touches: ['shell'],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Matches a preference for terse, findings-only review.',
    risk: 'Its frontmatter lists Bash, and Conclave turns tool lists into allow rules today. Fix that first (ECOSYSTEM.md, Routines).',
    overlaps: ['subagent:code-simplifier'],
  },
  {
    id: 'subagent:rust-pro',
    kind: 'subagent',
    name: 'rust-pro',
    repo: 'wshobson/agents',
    stars: 40938,
    starsAt: AT,
    description: 'Rust specialist subagent: async patterns, memory safety, ownership-heavy refactors.',
    category: 'language',
    tags: ['rust'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: { type: 'files', repo: 'wshobson/agents', sha: PINS.wshobson, files: [{ from: 'plugins/systems-programming/agents/rust-pro.md', to: 'agents/rust-pro.md' }] },
    variants: [{ type: 'plugin', marketplace: 'wshobson/agents', plugins: ['systems-programming@claude-code-workflows'], sha: PINS.wshobson }],
    touches: [],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'Rust help for your Rust work and pwn exploit code.',
    risk: 'Markdown only. Overlaps the coder agent.',
  },
  {
    id: 'command:context-save',
    kind: 'command',
    name: '/context-save and /context-restore',
    repo: 'wshobson/agents',
    stars: 40938,
    starsAt: AT,
    description: 'Two commands that save the project context to a file and load it back in a later session.',
    category: 'memory',
    tags: ['context', 'handoff'],
    license: 'MIT',
    updatedAt: '2026-10-15',
    install: {
      type: 'files',
      repo: 'wshobson/agents',
      sha: PINS.wshobson,
      files: [
        { from: 'plugins/context-management/commands/context-save.md', to: 'commands/context-save.md' },
        { from: 'plugins/context-management/commands/context-restore.md', to: 'commands/context-restore.md' },
      ],
    },
    touches: ['files'],
    recommended: false,
    source: 'recommended',
    verified: true,
    fit: 'A simple handoff pattern for the other CLIs. Inside Conclave, memory and SessionStart already do this.',
    risk: 'Markdown only.',
  },
];

/**
 * Marketplaces Discover knows about. Browsing reads marketplace.json from
 * raw.githubusercontent.com (no API quota, no clone). The hub clones a
 * marketplace only when the owner installs from it.
 */
export const KNOWN_MARKETPLACES: Array<{ source: string; name: string; note: string; default?: boolean }> = [
  { source: 'anthropics/claude-plugins-official', name: 'claude-plugins-official', default: true, note: 'Anthropic\'s list, 315 plugins. Most external entries are pinned by sha.' },
  { source: 'DietrichGebert/ponytail', name: 'ponytail', note: 'The ponytail plugin.' },
  { source: 'JuliusBrussee/caveman', name: 'caveman', note: 'The caveman plugin.' },
  { source: 'wshobson/agents', name: 'claude-code-workflows', note: '94 plugins of agents, skills and commands, with Codex manifests.' },
  { source: 'trailofbits/skills', name: 'trailofbits', note: '44 security plugins.' },
  { source: 'VoltAgent/awesome-claude-code-subagents', name: 'voltagent-subagents', note: '10 subagent packs.' },
  { source: 'anthropics/skills', name: 'anthropic-agent-skills', note: 'strict:false entries; Conclave installs their folders as skills.' },
  { source: 'conorbronsdon/avoid-ai-writing', name: 'conorbronsdon-skills', note: 'avoid-ai-writing.' },
  { source: 'karanb192/claude-code-hooks', name: 'claude-code-hooks', note: '22 small node hook plugins, including guard-pack and context-hogs.' },
];

/** GitHub topics searched per kind, most specific first. */
export const GITHUB_TOPICS: Record<Exclude<CatalogKind, 'routine'>, string[]> = {
  mcp: ['mcp-server', 'model-context-protocol', 'mcp-servers', 'modelcontextprotocol', 'mcp'],
  skill: ['claude-skills', 'agent-skills', 'claude-code-skills'],
  plugin: ['claude-code-plugin', 'claude-code-plugins', 'claude-plugin'],
  subagent: ['claude-code-subagents', 'claude-code-agents'],
  command: ['claude-code-commands', 'slash-commands'],
  hook: ['claude-code-hooks'],
};

/** Feeds read from raw.githubusercontent.com or open registries, so they cost no GitHub API calls. */
export const CATALOG_FEEDS: Array<{ id: string; url: string; every: 'daily' | 'weekly' | 'on-demand'; what: string; defaultOn: boolean }> = [
  { id: 'mcp-registry', url: 'https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100', every: 'daily', what: 'Official MCP registry: install metadata (packages, env, remotes). Incremental with updated_since. Trust only verified namespaces.', defaultOn: true },
  { id: 'docker-mcp', url: 'https://raw.githubusercontent.com/docker/mcp-registry/main/servers/<name>/server.yaml', every: 'on-demand', what: 'Docker MCP catalog: a container variant and its network allowlist, read when a preview needs it.', defaultOn: true },
  { id: 'star-index', url: 'https://raw.githubusercontent.com/quemsah/awesome-claude-plugins/main/ui/src/data/repos.json', every: 'daily', what: 'Stars for 48,424 plugin repos (16.6 MB) with no API calls. Fetched with an ETag; only repos with a plugin and 50 or more stars are kept.', defaultOn: true },
  { id: 'awesome-claude-code', url: 'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/THE_RESOURCES_TABLE_NEW.csv', every: 'daily', what: '259 hand-picked rows with categories and a Stale flag.', defaultOn: true },
  { id: 'awesome-mcp', url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md', every: 'weekly', what: '4,259 MCP entries in 60 sections. No install data and no stars; joined with the registry and the star cache.', defaultOn: false },
];
