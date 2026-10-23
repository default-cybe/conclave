/**
 * Mock routes. Extensions runtime: hooks and their test runner, project
 * trust, plugins and the marketplace, MCP servers and "connect to my CLIs".
 *
 * The owner's homelab: hub madx (home /root), arch-desktop and a macbook.
 * Claude Code, Codex and OpenCode are on the hub, Gemini CLI is not.
 * Shapes follow packages/core/src/client/index.ts and the real hub's JSON
 * (checked with curl against `conclave serve`).
 */
import type {
  BuiltinHookDto,
  CliName,
  HookEventInfo,
  HookLintIssue,
  HookGroupDto,
  HookHandlerDto,
  HookImportResult,
  HookOriginDto,
  HookRunDto,
  HookTestInput,
  HookTestResult,
  HookTraceDto,
  HooksOverview,
  MarketplaceSearchItem,
  McpCallResult,
  McpConnectRunResult,
  McpConnectStepDto,
  McpImportFormat,
  McpStatus,
  McpTestResult,
  McpToolDto,
  PluginDetailDto,
  ProjectTrustInfo,
} from '@conclave/core/client';
import type { HookEvent, HookMatcher, HooksConfig, McpServerConfig } from '@conclave/core/config/schema';
import type { AgentDef, CommandDef, InstalledPlugin, MarketplaceEntry, SkillDef } from '@conclave/core/extensions/types';
import type { MockCtx } from './index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => Date.now() - ms;

const HOME = '/root';
const CONFIG_PATH = `${HOME}/.conclave/config.json`;
const CLAUDE_USER = `${HOME}/.claude/settings.json`;
const pluginDir = (n: string) => `${HOME}/.conclave/plugins/${n}`;
const pluginData = (n: string) => `${HOME}/.conclave/plugins/.data/${n}`;

// ---------------------------------------------------------------------------
// Hook events
// ---------------------------------------------------------------------------

const EVENTS: Array<[HookEvent, string, string | null]> = [
  ['SessionStart', 'When a session starts, resumes, is cleared or compacted', 'startup, resume, clear, compact'],
  ['UserPromptSubmit', 'Before your message reaches the model', null],
  ['PreToolUse', 'Before a tool runs', 'tool name'],
  ['PermissionRequest', 'When Conclave is about to ask you to approve a tool call', 'tool name'],
  ['PostToolUse', 'After a tool succeeds', 'tool name'],
  ['PostToolUseFailure', 'After a tool fails', 'tool name'],
  ['Notification', 'When Conclave notifies you', 'permission_prompt, idle_prompt, errors, ...'],
  ['SubagentStart', 'When a subagent starts', 'agent name'],
  ['SubagentStop', 'When a subagent finishes', 'agent name'],
  ['PreCompact', 'Before old messages are summarized', 'manual, auto'],
  ['Stop', 'When the agent is about to finish its turn', null],
  ['SessionEnd', 'When a session is cleared or deleted, or the hub stops', 'clear, other'],
];
const EVENT_NAMES = EVENTS.map((e) => e[0]);

/** A handler as stored in a settings file. `if` and `async` ride along like on the real hub. */
type Handler = HookHandlerDto;
const cmd = (command: string, extra: Partial<Handler> = {}): Handler => ({ type: 'command', command, ...extra });

const STOP_PROMPT = 'If the last message says tests pass but no test command ran in this turn, block and ask the agent to run bun test.';

const USER_HOOKS: HooksConfig = {
  SessionStart: [
    { matcher: 'startup', hooks: [cmd('~/.conclave/hooks/session-context.sh', { timeout: 10 })] },
    // memory-aware: Basic Memory notes about this folder, through the MCP server (no jq, no process)
    { matcher: 'startup', hooks: [{ type: 'mcp_tool', server: 'basic-memory', tool: 'search_notes', input: { query: '${cwd}', page_size: 5 }, timeout: 10 }] },
  ],
  PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/.conclave/hooks/guard-push.sh', { timeout: 10, if: 'Bash(git push *)', onFailure: 'block' })] }],
  PostToolUse: [
    { matcher: 'Edit|Write', hooks: [cmd('bunx biome format --write "$CLAUDE_FILE_PATHS"', { timeout: 30 })] },
    // two classic mistakes the lint catches: a bare server matcher and a timeout in milliseconds
    { matcher: 'mcp__github', hooks: [cmd('~/.conclave/hooks/log-github.sh', { timeout: 5000 })] },
  ],
  Notification: [{ hooks: [cmd('notify-send Conclave "$(jq -r .message)"', { async: true, timeout: 10 })] }],
  Stop: [
    {
      hooks: [{ type: 'prompt', prompt: STOP_PROMPT, timeout: 30 }],
    },
  ] as HookMatcher[],
} as HooksConfig;

const CLAUDE_USER_HOOKS: HooksConfig = {
  UserPromptSubmit: [{ hooks: [cmd('python3 ~/.claude/hooks/redact_secrets.py', { timeout: 5 })] }],
  PostToolUseFailure: [{ matcher: 'Bash', hooks: [cmd('curl -fsS -X POST http://pve.lan:8085/hooks/tool-failed --data-binary @-')] }],
} as HooksConfig;

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

interface PluginTemplate {
  version?: string;
  description: string;
  author?: string;
  homepage?: string;
  agents?: Array<[string, string]>;
  skills?: Array<[string, string]>;
  commands?: Array<[string, string, string?]>;
  /** event -> [matcher, script relative to the plugin root, timeout] */
  hooks?: Array<[HookEvent, string | undefined, string, number?]>;
  mcpServers?: Record<string, McpServerConfig>;
}

const ROOT = '${CLAUDE_PLUGIN_ROOT}';

const TEMPLATES: Record<string, PluginTemplate> = {
  hookify: {
    version: '0.1.0',
    description: 'Easily create custom hooks to prevent unwanted behaviors by analyzing conversation patterns or from explicit instructions. Define rules via simple markdown files.',
    author: 'Daisy Hollman',
    agents: [['conversation-analyzer', 'Finds behaviors in this conversation that are worth a hookify rule.']],
    skills: [['writing-rules', 'How to write hookify rules: event, pattern, action and message.']],
    commands: [
      ['hookify', 'Create a rule from what went wrong in this conversation', '[instruction]'],
      ['list', 'List hookify rules in this project'],
      ['configure', 'Turn hookify rules on or off'],
      ['help', 'How hookify works'],
    ],
    hooks: [
      ['PreToolUse', undefined, `python3 ${ROOT}/hooks/pretooluse.py`, 10],
      ['PostToolUse', undefined, `python3 ${ROOT}/hooks/posttooluse.py`, 10],
      ['Stop', undefined, `python3 ${ROOT}/hooks/stop.py`, 10],
      ['UserPromptSubmit', undefined, `python3 ${ROOT}/hooks/userpromptsubmit.py`, 10],
    ],
  },
  superpowers: {
    version: '4.0.3',
    description: 'Superpowers teaches Claude brainstorming, subagent driven development with built in code review, systematic debugging, and red/green TDD. Additionally, it teaches Claude how to author and test new skills.',
    author: 'Jesse Vincent',
    homepage: 'https://github.com/obra/superpowers',
    agents: [['code-reviewer', 'Reviews a finished step against the plan and coding standards.']],
    skills: [
      ['using-superpowers', 'Read first in every session: how to find and use skills.'],
      ['brainstorming', 'Turn a rough idea into a design through questions, before writing code.'],
      ['writing-plans', 'Write a step by step plan with exact files and tests.'],
      ['executing-plans', 'Carry out a written plan in batches with review checkpoints.'],
      ['test-driven-development', 'Write the failing test first, then the code.'],
      ['systematic-debugging', 'Find the root cause in four phases before fixing.'],
      ['verification-before-completion', 'Run the checks before saying something works.'],
      ['requesting-code-review', 'Ask a reviewer subagent to check work before merging.'],
      ['using-git-worktrees', 'Start isolated work in a git worktree.'],
      ['finishing-a-development-branch', 'Merge, open a PR or clean up when work is done.'],
      ['dispatching-parallel-agents', 'Split independent problems across subagents.'],
      ['writing-skills', 'Write and test new skills.'],
    ],
    commands: [
      ['brainstorm', 'Refine an idea into a design', '[idea]'],
      ['write-plan', 'Write an implementation plan'],
      ['execute-plan', 'Execute a plan in batches'],
    ],
    hooks: [['SessionStart', 'startup|resume|clear|compact', `${ROOT}/hooks/session-start.sh`, undefined]],
  },
  context7: {
    version: '1.0.0',
    description: "Upstash Context7 MCP server for up-to-date documentation lookup. Connects to Context7's hosted remote MCP server (https://mcp.context7.com/mcp), so no local Node.js or npx is required.",
    author: 'Upstash',
    mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  },
  'ralph-loop': {
    version: '1.0.0',
    description: 'Interactive self-referential AI loops for iterative development, implementing the Ralph Wiggum technique. Claude works on the same task repeatedly, seeing its previous work, until completion.',
    commands: [
      ['ralph-loop', 'Start a loop on a task until it is done', '<prompt> [--max-iterations N]'],
      ['cancel-ralph', 'Stop the running loop'],
      ['help', 'How the Ralph loop works'],
    ],
    hooks: [['Stop', undefined, `${ROOT}/hooks/stop-hook.sh`, undefined]],
  },
  playwright: {
    description: 'Browser automation and end-to-end testing MCP server by Microsoft.',
    mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
  },
  github: {
    description: "Official GitHub MCP server for repository management. Create issues, manage pull requests, review code, search repositories, and interact with GitHub's full API.",
    mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } } },
  },
  'security-guidance': {
    version: '2.0.14',
    description: 'Security review for Claude-generated code. Pattern-based warnings on edits, LLM-powered diff review on Stop, and an agentic commit reviewer.',
    agents: [['commit-reviewer', 'Reviews a commit for injection, XSS, SSRF and hardcoded secrets.']],
    hooks: [
      ['PreToolUse', 'Edit|Write|MultiEdit', `python3 ${ROOT}/hooks/security_reminder_hook.py`, 10],
      ['Stop', undefined, `python3 ${ROOT}/hooks/diff_review.py`, 120],
    ],
  },
  'commit-commands': {
    description: 'Commands for git commit workflows including commit, push, and PR creation',
    commands: [
      ['commit', 'Create a git commit'],
      ['commit-push-pr', 'Commit, push and open a pull request'],
      ['clean_gone', 'Delete local branches whose remote is gone'],
    ],
  },
  'pr-review-toolkit': {
    description: 'PR review agents specializing in comments, tests, error handling, type design, code quality, and code simplification',
    agents: [
      ['comment-analyzer', 'Checks code comments for accuracy.'],
      ['pr-test-analyzer', 'Checks test coverage of a PR.'],
      ['silent-failure-hunter', 'Finds swallowed errors.'],
      ['type-design-analyzer', 'Reviews new types.'],
      ['code-reviewer', 'General review against project rules.'],
      ['code-simplifier', 'Suggests simpler code.'],
    ],
    commands: [['review-pr', 'Review the current PR with the agents', '[aspects]']],
  },
};

function component(plugin: string, name: string) {
  return `${plugin}:${name}`;
}

function buildDetail(name: string, marketplace: string | undefined, base: Partial<InstalledPlugin> & { enabled: boolean; installedAt: number; source: string }): PluginDetailDto {
  const t = TEMPLATES[name] ?? { description: `Plugin ${name}` };
  const dir = pluginDir(name);
  const agents: AgentDef[] = (t.agents ?? []).map(([n, d]) => ({ name: component(name, n), description: d, prompt: `${d}\n\nWork from what is in this session. Say what you found and where, with file paths.`, source: 'plugin', plugin: name, path: `${dir}/agents/${n}.md` }));
  const skills: SkillDef[] = (t.skills ?? []).map(([n, d]) => ({ name: component(name, n), description: d, dir: `${dir}/skills/${n}`, path: `${dir}/skills/${n}/SKILL.md`, source: 'plugin', plugin: name }));
  const commands: CommandDef[] = (t.commands ?? []).map(([n, d, hint]) => ({ name: component(name, n), description: d, ...(hint ? { argumentHint: hint } : {}), body: '', source: 'plugin', plugin: name, path: `${dir}/commands/${n}.md` }));
  const hooks: HooksConfig = {};
  for (const [ev, matcher, command, timeout] of t.hooks ?? []) {
    const h = { type: 'command' as const, command: command.replaceAll(ROOT, dir), ...(timeout ? { timeout } : {}), plugin: name, pluginRoot: dir, pluginData: pluginData(name) };
    (hooks[ev] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [h] });
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [s, cfg] of Object.entries(t.mcpServers ?? {})) mcpServers[`plugin_${name}_${s}`] = cfg;
  return {
    name,
    dir,
    manifest: {
      name,
      ...(t.version ? { version: t.version } : {}),
      description: t.description,
      ...(t.author ? { author: { name: t.author } } : {}),
      ...(t.homepage ? { homepage: t.homepage } : {}),
    },
    enabled: base.enabled,
    source: base.source ?? (marketplace ? `${name}@${marketplace}` : name),
    installedAt: base.installedAt,
    agents,
    skills,
    commands,
    hooks,
    mcpServers,
  };
}

// ---------------------------------------------------------------------------
// Marketplace (entries copied from claude-plugins-official, October 2026)
// ---------------------------------------------------------------------------

interface MktEntry {
  name: string;
  description?: string;
  category?: string;
  version?: string;
  sourceKind: string;
}

const OFFICIAL: MktEntry[] = [
  { name: 'hookify', description: 'Easily create custom hooks to prevent unwanted behaviors by analyzing conversation patterns or from explicit instructions. Define rules via simple markdown files.', category: 'productivity', sourceKind: 'path' },
  { name: 'context7', description: "Upstash Context7 MCP server for up-to-date documentation lookup. Connects to Context7's hosted remote MCP server (https://mcp.context7.com/mcp), so no local Node.js or npx is required. Works anonymously out of the box; set CONTEXT7_API_KEY for higher rate limits.", category: 'development', sourceKind: 'path' },
  { name: 'ralph-loop', description: 'Interactive self-referential AI loops for iterative development, implementing the Ralph Wiggum technique. Claude works on the same task repeatedly, seeing its previous work, until completion.', category: 'development', sourceKind: 'path' },
  { name: 'playwright', description: 'Browser automation and end-to-end testing MCP server by Microsoft. Enables Claude to interact with web pages, take screenshots, fill forms, click elements, and perform automated browser testing workflows.', category: 'testing', sourceKind: 'path' },
  { name: 'github', description: "Official GitHub MCP server for repository management. Create issues, manage pull requests, review code, search repositories, and interact with GitHub's full API directly from Claude Code.", category: 'productivity', sourceKind: 'path' },
  { name: 'security-guidance', description: 'Security review for Claude-generated code. Pattern-based warnings on edits, LLM-powered diff review on Stop, and an agentic commit reviewer that catches injection, XSS, SSRF, hardcoded secrets, and 25+ other vulnerability classes.', category: 'security', version: '2.0.14', sourceKind: 'path' },
  { name: 'commit-commands', description: 'Commands for git commit workflows including commit, push, and PR creation', category: 'productivity', sourceKind: 'path' },
  { name: 'pr-review-toolkit', description: 'Comprehensive PR review agents specializing in comments, tests, error handling, type design, code quality, and code simplification', category: 'productivity', sourceKind: 'path' },
  { name: 'feature-dev', description: 'Comprehensive feature development workflow with specialized agents for codebase exploration, architecture design, and quality review', category: 'development', sourceKind: 'path' },
  { name: 'code-review', description: 'Automated code review for pull requests using multiple specialized agents with confidence-based scoring to filter false positives', category: 'productivity', sourceKind: 'path' },
  { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', category: 'development', sourceKind: 'path' },
  { name: 'plugin-dev', description: 'Toolkit for developing Claude Code plugins. Includes 7 expert skills covering hooks, MCP integration, commands, agents, and best practices.', category: 'development', sourceKind: 'path' },
  { name: 'agent-sdk-dev', description: 'Development kit for working with the Claude Agent SDK', category: 'development', sourceKind: 'path' },
  { name: 'explanatory-output-style', description: 'Adds educational insights about implementation choices and codebase patterns (mimics the deprecated Explanatory output style)', category: 'learning', sourceKind: 'path' },
  { name: 'learning-output-style', description: 'Interactive learning mode that requests meaningful code contributions at decision points (mimics the unshipped Learning output style)', category: 'learning', sourceKind: 'path' },
  { name: 'pyright-lsp', description: 'Python language server (Pyright) for type checking and code intelligence', category: 'development', version: '1.0.0', sourceKind: 'path' },
  { name: 'typescript-lsp', description: 'TypeScript/JavaScript language server for enhanced code intelligence', category: 'development', version: '1.0.0', sourceKind: 'path' },
  { name: 'rust-analyzer-lsp', description: 'Rust language server for code intelligence and analysis', category: 'development', version: '1.0.0', sourceKind: 'path' },
  { name: 'serena', description: 'Semantic code analysis MCP server providing code understanding, refactoring suggestions, and codebase navigation through language server protocol integration.', category: 'development', sourceKind: 'path' },
  { name: 'linear', description: 'Linear issue tracking integration. Create issues, manage projects, update statuses and search across workspaces.', category: 'productivity', sourceKind: 'path' },
  { name: 'sentry', description: 'Sentry error monitoring integration. Access error reports, analyze stack traces, search issues by fingerprint, and debug production errors directly from your development environment.', category: 'monitoring', sourceKind: 'url' },
  { name: 'supabase', description: 'Supabase MCP integration for database operations, authentication, storage, and real-time subscriptions.', category: 'database', sourceKind: 'url' },
  { name: 'greptile', description: "AI code review agent for GitHub and GitLab. View and resolve Greptile's PR review comments and run reviews on your working branch.", category: 'development', sourceKind: 'git-subdir' },
  { name: 'firebase', description: 'Google Firebase MCP integration. Manage Firestore databases, authentication, cloud functions, hosting, and storage.', category: 'database', sourceKind: 'path' },
  { name: 'vercel', description: 'Vercel deployment platform integration. Manage deployments, check build status, access logs and configure domains.', category: 'deployment', sourceKind: 'url' },
  { name: 'gitlab', description: 'GitLab DevOps platform integration. Manage repositories, merge requests, CI/CD pipelines, issues, and wikis.', category: 'productivity', sourceKind: 'path' },
  { name: 'huggingface-skills', description: 'Build, train, evaluate, and use open source AI models, datasets, and spaces.', category: 'development', sourceKind: 'url' },
  { name: 'claude-code-setup', description: 'Analyze codebases and recommend tailored Claude Code automations such as hooks, skills, MCP servers, and subagents.', category: 'productivity', sourceKind: 'path' },
  { name: 'cockroachdb', description: 'Connect Claude Code to your CockroachDB clusters: explore schemas, write optimized SQL and debug queries.', category: 'database', sourceKind: 'git-subdir' },
];

const SUPERPOWERS_MKT: MktEntry[] = [
  { name: 'superpowers', description: 'Core skills library: TDD, debugging, collaboration patterns, and proven techniques.', category: 'development', version: '4.1.1', sourceKind: 'github' },
  { name: 'episodic-memory', description: 'Semantic search for past Claude Code conversations, so Claude remembers what you worked on.', category: 'productivity', version: '1.0.9', sourceKind: 'github' },
  { name: 'superpowers-developing-for-claude-code', description: 'Skills and docs for building Claude Code plugins, skills and MCP servers.', category: 'development', version: '0.3.1', sourceKind: 'github' },
];

const KNOWN_MARKETPLACES: Record<string, { name: string; entries: MktEntry[] }> = {
  'anthropics/skills': {
    name: 'anthropic-agent-skills',
    entries: [
      { name: 'document-skills', description: 'Create and edit Word, Excel, PowerPoint and PDF files.', category: 'productivity', sourceKind: 'path' },
      { name: 'example-skills', description: 'Example skills: art, MCP builder, web app testing and more.', category: 'development', sourceKind: 'path' },
    ],
  },
};

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

type ToolSpec = [name: string, description: string, readOnly: boolean, props?: Record<string, { type: string; description?: string }>, required?: string[]];

function tools(server: string, list: ToolSpec[]): McpToolDto[] {
  return list.map(([name, description, readOnly, props, required]) => ({
    name,
    fullName: `mcp__${server}__${name}`,
    description,
    readOnly,
    inputSchema: { type: 'object', properties: props ?? {}, ...(required?.length ? { required } : {}) },
  }));
}

const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'number', description });

const TOOLS: Record<string, ToolSpec[]> = {
  'basic-memory': [
    ['search_notes', 'Search notes by text, title or permalink.', true, { query: S('Words to look for'), page: N('Page, from 1'), page_size: N('Results per page') }, ['query']],
    ['read_note', 'Read a note by title or permalink.', true, { identifier: S('Title, permalink or memory:// URL') }, ['identifier']],
    ['view_note', 'Show a note as a formatted artifact.', true, { identifier: S('Title or permalink') }, ['identifier']],
    ['build_context', 'Follow links from a memory:// URL to build context.', true, { url: S('memory:// URL'), depth: N('Link depth') }, ['url']],
    ['recent_activity', 'Notes changed in a time frame.', true, { timeframe: S('For example 7d or "2 weeks"') }],
    ['list_directory', 'List notes in a folder.', true, { dir_name: S('Folder, / for the root') }],
    ['read_content', 'Read a raw file from the knowledge base.', true, { path: S('File path') }, ['path']],
    ['list_memory_projects', 'List Basic Memory projects.', true],
    ['sync_status', 'Show sync progress for the knowledge base.', true],
    ['write_note', 'Create or replace a note.', false, { title: S('Note title'), content: S('Markdown body'), folder: S('Folder') }, ['title', 'content', 'folder']],
    ['edit_note', 'Append, prepend or replace a section of a note.', false, { identifier: S('Title or permalink'), operation: S('append, prepend, find_replace, replace_section'), content: S('New text') }, ['identifier', 'operation', 'content']],
    ['move_note', 'Move a note to another folder.', false, { identifier: S('Title or permalink'), destination_path: S('New path') }, ['identifier', 'destination_path']],
    ['delete_note', 'Delete a note.', false, { identifier: S('Title or permalink') }, ['identifier']],
    ['canvas', 'Write an Obsidian canvas file.', false, { nodes: { type: 'array' }, edges: { type: 'array' }, title: S('Canvas title'), folder: S('Folder') }, ['nodes', 'edges', 'title', 'folder']],
  ],
  github: [
    ['get_me', 'Details of the signed in GitHub user.', true],
    ['search_repositories', 'Search repositories.', true, { query: S('GitHub search syntax') }, ['query']],
    ['get_file_contents', 'Read a file or folder from a repository.', true, { owner: S('Owner'), repo: S('Repository'), path: S('Path') }, ['owner', 'repo', 'path']],
    ['search_code', 'Search code across GitHub.', true, { query: S('Code search query') }, ['query']],
    ['list_issues', 'List issues in a repository.', true, { owner: S('Owner'), repo: S('Repository'), state: S('open, closed or all') }, ['owner', 'repo']],
    ['get_issue', 'Read one issue.', true, { owner: S('Owner'), repo: S('Repository'), issue_number: N('Issue number') }, ['owner', 'repo', 'issue_number']],
    ['list_pull_requests', 'List pull requests.', true, { owner: S('Owner'), repo: S('Repository') }, ['owner', 'repo']],
    ['get_pull_request', 'Read one pull request.', true, { owner: S('Owner'), repo: S('Repository'), pullNumber: N('PR number') }, ['owner', 'repo', 'pullNumber']],
    ['list_commits', 'List commits on a branch.', true, { owner: S('Owner'), repo: S('Repository'), sha: S('Branch or SHA') }, ['owner', 'repo']],
    ['list_workflow_runs', 'List GitHub Actions runs.', true, { owner: S('Owner'), repo: S('Repository') }, ['owner', 'repo']],
    ['create_issue', 'Open an issue.', false, { owner: S('Owner'), repo: S('Repository'), title: S('Title'), body: S('Body') }, ['owner', 'repo', 'title']],
    ['add_issue_comment', 'Comment on an issue or PR.', false, { owner: S('Owner'), repo: S('Repository'), issue_number: N('Number'), body: S('Comment') }, ['owner', 'repo', 'issue_number', 'body']],
    ['create_branch', 'Create a branch.', false, { owner: S('Owner'), repo: S('Repository'), branch: S('New branch') }, ['owner', 'repo', 'branch']],
    ['create_pull_request', 'Open a pull request.', false, { owner: S('Owner'), repo: S('Repository'), title: S('Title'), head: S('Head branch'), base: S('Base branch') }, ['owner', 'repo', 'title', 'head', 'base']],
    ['merge_pull_request', 'Merge a pull request.', false, { owner: S('Owner'), repo: S('Repository'), pullNumber: N('PR number') }, ['owner', 'repo', 'pullNumber']],
    ['push_files', 'Commit and push several files.', false, { owner: S('Owner'), repo: S('Repository'), branch: S('Branch'), message: S('Commit message') }, ['owner', 'repo', 'branch', 'message']],
    ['list_branches', 'List branches in a repository.', true, { owner: S('Owner'), repo: S('Repository') }, ['owner', 'repo']],
    ['get_commit', 'Read a commit with its diff.', true, { owner: S('Owner'), repo: S('Repository'), sha: S('Commit SHA') }, ['owner', 'repo', 'sha']],
    ['get_pull_request_files', 'List the files changed in a pull request.', true, { owner: S('Owner'), repo: S('Repository'), pullNumber: N('PR number') }, ['owner', 'repo', 'pullNumber']],
    ['search_issues', 'Search issues and pull requests.', true, { query: S('GitHub search syntax') }, ['query']],
    ['list_notifications', 'List your GitHub notifications.', true],
    ['update_issue', 'Edit an issue: title, body, labels or state.', false, { owner: S('Owner'), repo: S('Repository'), issue_number: N('Issue number') }, ['owner', 'repo', 'issue_number']],
    ['create_or_update_file', 'Create or update one file in a repository.', false, { owner: S('Owner'), repo: S('Repository'), path: S('Path'), content: S('New content'), message: S('Commit message'), branch: S('Branch') }, ['owner', 'repo', 'path', 'content', 'message', 'branch']],
    ['delete_file', 'Delete a file from a repository.', false, { owner: S('Owner'), repo: S('Repository'), path: S('Path'), message: S('Commit message'), branch: S('Branch') }, ['owner', 'repo', 'path', 'message', 'branch']],
  ],
  proxmox: [
    ['node_status', 'CPU, memory and uptime of a node.', true, { node: S('Node name, for example pve') }],
    ['list_guests', 'List VMs and containers with their state.', true, { type: S('lxc, qemu or all') }],
    ['guest_status', 'State and resource use of one guest.', true, { vmid: N('Guest id') }, ['vmid']],
    ['list_storage', 'Storage pools and their usage.', true],
    ['list_snapshots', 'Snapshots of a guest.', true, { vmid: N('Guest id') }, ['vmid']],
    ['list_backups', 'Backups of a guest on PBS.', true, { vmid: N('Guest id') }, ['vmid']],
    ['start_guest', 'Start a guest.', false, { vmid: N('Guest id') }, ['vmid']],
    ['stop_guest', 'Shut down a guest.', false, { vmid: N('Guest id') }, ['vmid']],
    ['snapshot', 'Snapshot a guest.', false, { vmid: N('Guest id'), name: S('Snapshot name') }, ['vmid', 'name']],
    ['rollback_snapshot', 'Roll a guest back to a snapshot.', false, { vmid: N('Guest id'), name: S('Snapshot name') }, ['vmid', 'name']],
    ['backup_guest', 'Back up a guest to PBS now.', false, { vmid: N('Guest id') }, ['vmid']],
    ['exec_in_container', 'Run a command inside a container.', false, { vmid: N('Container id'), command: S('Shell command') }, ['vmid', 'command']],
  ],
  plugin_context7_context7: [
    ['resolve-library-id', 'Find the Context7 id of a library from its name.', true, { libraryName: S('Library name, for example hono') }, ['libraryName']],
    ['get-library-docs', 'Fetch current docs for a library id.', true, { context7CompatibleLibraryID: S('Id from resolve-library-id'), topic: S('Topic'), tokens: N('Max tokens') }, ['context7CompatibleLibraryID']],
  ],
};

/** The tools a connected server lists, so the Tools tab and Overview count the same ones. */
export function mockMcpToolList(server: string): McpToolDto[] | undefined {
  const list = TOOLS[server];
  return list ? tools(server, list) : undefined;
}

// ---------------------------------------------------------------------------
// Projects and trust
// ---------------------------------------------------------------------------

interface ProjectFiles {
  claude?: { hooks?: HooksConfig; allow?: string[] };
  conclave?: { hooks?: HooksConfig; allow?: string[] };
  /** .conclave/settings.local.json: personal, not written by saveHooks. */
  conclaveLocal?: { hooks?: HooksConfig };
  mcp?: number;
}

function expand(cwd: string) {
  return cwd.replace(/^~(?=\/|$)/, '/home/kai').replace(/\/+$/, '');
}

/** What each known project folder holds. Unknown folders have nothing to trust. */
function projectFiles(cwd: string): ProjectFiles {
  const p = expand(cwd);
  if (p.endsWith('/code/conclave'))
    return {
      claude: { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [cmd('bun run lint:changed', { timeout: 60 })] }] } as HooksConfig, allow: ['Bash(bun test:*)', 'Bash(bun run typecheck)'] },
      conclave: { hooks: { Stop: [{ hooks: [cmd('bun run typecheck', { timeout: 120 })] }] } as HooksConfig },
      conclaveLocal: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [cmd('~/.local/bin/log-bash.sh', { async: true, timeout: 5 })] }] } as HooksConfig },
    };
  if (p.endsWith('/code/scantools'))
    return {
      claude: {
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [cmd('./scripts/setup-venv.sh', { timeout: 120 })] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [cmd('python3 .claude/hooks/check_cmd.py', { timeout: 5 })] }],
        } as HooksConfig,
        allow: ['Bash(pytest:*)', 'Bash(nmap:*)', 'WebFetch(domain:nmap.org)'],
      },
      mcp: 1,
    };
  if (p.endsWith('/uni/os/a3')) return { conclave: { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('make -s check', { timeout: 60 })] }] } as HooksConfig } };
  return {};
}

const handlerCount = (h?: HooksConfig) => Object.values(h ?? {}).reduce((n, list) => n + (list ?? []).reduce((m, g) => m + g.hooks.length, 0), 0);

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Test switches for screenshots of loading and error states:
 * sessionStorage "conclave.mock.ext" = "slow" (4 s) or "fail" (503) for the
 * list routes of this module.
 */
function testMode(): string | null {
  try {
    return sessionStorage.getItem('conclave.mock.ext');
  } catch {
    return null;
  }
}

export function registerExtensionRuntime(ctx: MockCtx) {
  const { db, FRESH, sleep } = ctx;
  const fail = ctx.fail;
  const LISTS = new Set(['/api/hooks', '/api/plugins', '/api/mcp', '/api/marketplace/search']);
  const on: MockCtx['on'] = (method, path, h) =>
    ctx.on(method, path, async (p) => {
      const mode = method === 'GET' && LISTS.has(path) ? testMode() : null;
      if (mode === 'slow') await sleep(4000);
      if (mode === 'fail') fail(503, 'the hub did not answer in time');
      return h(p);
    });
  const changed = () => ctx.emit({ type: 'config.updated' });

  // ----- state ---------------------------------------------------------------

  const cfg = db.config as { hooks?: HooksConfig; mcpServers?: Record<string, McpServerConfig> };
  if (!FRESH) {
    cfg.hooks = structuredClone(USER_HOOKS);
    cfg.mcpServers = {
      'basic-memory': { command: 'uvx', args: ['basic-memory', 'mcp'], env: { BASIC_MEMORY_HOME: '/srv/notes' } },
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${secret:GITHUB_TOKEN}' } },
      proxmox: { command: 'pve-mcp', args: ['--host', 'pve.lan'], env: { PVE_TOKEN: '${secret:PVE_API_TOKEN}' } },
      playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
      homeassistant: { type: 'sse', url: 'http://ha.lan:8123/mcp_server/sse', headers: { Authorization: 'Bearer ${secret:HASS_TOKEN}' }, enabled: false },
    };
  }
  cfg.hooks ??= {};
  cfg.mcpServers ??= {};

  // the hub (madx) runs Claude Code, Codex and OpenCode; Gemini CLI is not installed there
  const hubDevice = db.devices.get('local');
  if (hubDevice?.info) hubDevice.info.clis = { ...hubDevice.info.clis, claude: '2.4.1', codex: '0.98.0', opencode: '1.3.2' };

  const plugins: PluginDetailDto[] = FRESH
    ? []
    : [
        buildDetail('hookify', 'claude-plugins-official', { enabled: true, installedAt: ago(26 * DAY), source: 'hookify@claude-plugins-official' }),
        buildDetail('superpowers', 'superpowers-marketplace', { enabled: true, installedAt: ago(41 * DAY), source: 'superpowers@superpowers-marketplace' }),
        buildDetail('context7', 'claude-plugins-official', { enabled: true, installedAt: ago(12 * DAY), source: 'context7@claude-plugins-official' }),
        buildDetail('ralph-loop', 'claude-plugins-official', { enabled: false, installedAt: ago(33 * DAY), source: 'ralph-loop@claude-plugins-official' }),
      ];
  // Agents of enabled plugins are listed with the other agents as plugin:name, like on the hub.
  let pluginAgents = new Set<string>();
  const syncPlugins = () => {
    db.plugins.length = 0;
    db.plugins.push(...plugins.map(installed));
    const next = plugins.filter((p) => p.enabled).flatMap((p) => p.agents);
    db.agents = [...db.agents.filter((a) => !pluginAgents.has(a.name)), ...next];
    pluginAgents = new Set(next.map((a) => a.name));
  };
  syncPlugins();

  const marketplaces: Array<{ name: string; source: string; entries: MktEntry[] }> = [{ name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official', entries: OFFICIAL }];
  if (!FRESH) marketplaces.push({ name: 'superpowers-marketplace', source: 'obra/superpowers-marketplace', entries: SUPERPOWERS_MKT });

  const trusted = new Set<string>(FRESH ? [] : ['/home/kai/code/conclave', '/home/kai/uni/os/a3']);

  /** Live server state by name (status overrides; tools come from TOOLS). */
  const live = new Map<string, { status: McpStatus['status']; error?: string }>();
  if (!FRESH) live.set('playwright', { status: 'failed', error: 'Executable not found in $PATH: "npx"' });

  const runs: HookRunDto[] = FRESH ? [] : seedRuns();

  // ----- helpers -------------------------------------------------------------

  function installed(p: PluginDetailDto): InstalledPlugin {
    return { name: p.name, dir: p.dir, manifest: p.manifest, enabled: p.enabled, source: p.source, installedAt: p.installedAt, hooksEnabled: p.hooksEnabled !== false };
  }

  function trustInfo(cwd: string): ProjectTrustInfo {
    const f = projectFiles(cwd);
    const p = expand(cwd);
    const files: string[] = [];
    if (handlerCount(f.claude?.hooks) || f.claude?.allow?.length) files.push(`${p}/.claude/settings.json`);
    if (handlerCount(f.conclave?.hooks) || f.conclave?.allow?.length) files.push(`${p}/.conclave/settings.json`);
    if (handlerCount(f.conclaveLocal?.hooks)) files.push(`${p}/.conclave/settings.local.json`);
    if (f.mcp) files.push(`${p}/.mcp.json`);
    const covered = [...trusted].some((t) => p === t || p.startsWith(t + '/'));
    return {
      cwd,
      trusted: covered,
      hooks: handlerCount(f.claude?.hooks) + handlerCount(f.conclave?.hooks) + handlerCount(f.conclaveLocal?.hooks),
      allow: (f.claude?.allow?.length ?? 0) + (f.conclave?.allow?.length ?? 0),
      mcpServers: f.mcp ?? 0,
      files,
    };
  }

  interface Group extends HookGroupDto {
    event: HookEvent;
  }

  /** About how many tokens a handler added per session in recent sessions, by its run label (the hub prices it from traces). */
  const TOKENS: Record<string, number> = FRESH
    ? {}
    : {
        '~/.conclave/hooks/session-context.sh': 22,
        'mcp basic-memory search_notes': 34,
        [`${pluginDir('superpowers')}/hooks/session-start.sh`]: 1240,
      };
  const labelOf = (h: Handler) => (h.type === 'prompt' ? (h.prompt ?? '').slice(0, 200) : h.type === 'mcp_tool' ? `mcp ${h.server} ${h.tool}` : (h.command ?? ''));

  function groupsFor(cwd?: string): Group[] {
    const out: Group[] = [];
    const push = (source: HookOriginDto, hooks: HooksConfig | undefined, extra: { path?: string; plugin?: string; active?: boolean; pluginRoot?: string }) => {
      for (const [event, list] of Object.entries(hooks ?? {}) as Array<[HookEvent, HookMatcher[]]>) {
        (list ?? []).forEach((g, index) => {
          out.push({
            event,
            ...(g.matcher ? { matcher: g.matcher } : {}),
            source,
            ...(extra.path ? { path: extra.path } : {}),
            ...(extra.plugin ? { plugin: extra.plugin } : {}),
            index,
            active: extra.active ?? true,
            editable: source === 'config' || (source === 'project' && !extra.path?.endsWith('settings.local.json')),
            hooks: g.hooks.map((h) => {
              const x = { ...(h as Handler) };
              delete (x as Record<string, unknown>).pluginData;
              const tokens = TOKENS[labelOf(x)];
              if (tokens) x.tokensPerSession = tokens;
              return x;
            }),
          });
        });
      }
    };
    push('claude-user', FRESH ? undefined : CLAUDE_USER_HOOKS, { path: CLAUDE_USER });
    push('config', cfg.hooks, { path: CONFIG_PATH });
    for (const p of plugins.filter((x) => x.enabled && x.hooksEnabled !== false)) push('plugin', p.hooks, { plugin: p.name });
    if (cwd) {
      const f = projectFiles(cwd);
      const t = trustInfo(cwd).trusted;
      const base = expand(cwd);
      push('claude-project', f.claude?.hooks, { path: `${base}/.claude/settings.json`, active: t });
      push('project', f.conclave?.hooks, { path: `${base}/.conclave/settings.json`, active: t });
      push('project', f.conclaveLocal?.hooks, { path: `${base}/.conclave/settings.local.json`, active: t });
    }
    return sortGroups(out);
  }

  /** Order per event like the hub: claude user, config, plugins, project files (settings.json before settings.local.json). */
  function sortGroups(list: Group[]): Group[] {
    const rank = (g: Group) => ({ 'claude-user': 0, config: 1, plugin: 2, 'claude-project': 3, project: 4 })[g.source] + (g.path?.endsWith('settings.local.json') ? 0.5 : 0);
    return list.sort((a, b) => EVENT_NAMES.indexOf(a.event) - EVENT_NAMES.indexOf(b.event) || rank(a) - rank(b));
  }

  function seedRuns(): HookRunDto[] {
    const guard = '~/.conclave/hooks/guard-push.sh';
    const biome = 'bunx biome format --write "$CLAUDE_FILE_PATHS"';
    const hk = (s: string) => `python3 ${pluginDir('hookify')}/hooks/${s}`;
    const r = (event: HookEvent, label: string, at: number, result: string, extra: Partial<HookRunDto> = {}): HookRunDto => ({ event, type: 'command', label, durationMs: 40, result, exitCode: 0, stdout: '', stderr: '', at, sessionId: 's_auth', ...extra });
    return [
      r('SessionStart', '~/.conclave/hooks/session-context.sh', ago(38 * MIN), 'context', { durationMs: 212, contextChars: 88, stdout: 'Branch: auth-jose, 3 files changed. Open task: Move auth middleware to jose.\n' }),
      r('SessionStart', 'mcp basic-memory search_notes', ago(38 * MIN), 'context', { durationMs: 143, contextChars: 136, exitCode: undefined, stdout: '- madx runs the hub in an LXC on pve\n- Deploys: make release, then docker compose up -d on madx' }),
      r('SessionStart', `${pluginDir('superpowers')}/hooks/session-start.sh`, ago(38 * MIN), 'context', { plugin: 'superpowers', durationMs: 31, contextChars: 4960, stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You have superpowers. Read the using-superpowers skill before you start."}}\n' }),
      r('SessionStart', '~/.conclave/hooks/session-context.sh', ago(31 * MIN), 'context', { sessionId: 's_os', durationMs: 188, stdout: 'Branch: main, clean. Open task: OS assignment 3: MLFQ scheduler.\n' }),
      r('UserPromptSubmit', 'python3 ~/.claude/hooks/redact_secrets.py', ago(37 * MIN), 'noop', { durationMs: 58 }),
      r('UserPromptSubmit', hk('userpromptsubmit.py'), ago(37 * MIN), 'noop', { plugin: 'hookify', durationMs: 44, stdout: '{}\n' }),
      r('PreToolUse', guard, ago(36 * MIN), 'noop', { durationMs: 9 }),
      r('PreToolUse', hk('pretooluse.py'), ago(36 * MIN), 'noop', { plugin: 'hookify', durationMs: 47, stdout: '{}\n' }),
      r('PreToolUse', guard, ago(22 * MIN), 'noop', { durationMs: 8 }),
      r('PreToolUse', guard, ago(14 * MIN), 'block', { durationMs: 11, exitCode: 2, stderr: 'Pushing to main is blocked. Push a branch and open a PR instead.\n' }),
      r('PreToolUse', hk('pretooluse.py'), ago(14 * MIN), 'noop', { plugin: 'hookify', durationMs: 51, stdout: '{}\n' }),
      r('PreToolUse', guard, ago(6 * MIN), 'noop', { sessionId: 's_os', durationMs: 7 }),
      r('PostToolUse', biome, ago(33 * MIN), 'noop', { durationMs: 412, stdout: 'Formatted 1 file in 4ms. Fixed 1 file.\n' }),
      r('PostToolUse', hk('posttooluse.py'), ago(33 * MIN), 'noop', { plugin: 'hookify', durationMs: 39, stdout: '{}\n' }),
      r('PostToolUse', biome, ago(19 * MIN), 'error', { durationMs: 388, exitCode: 1, stdout: '', stderr: 'src/server/auth.ts:41:3 parse  Expected a semicolon or an implicit semicolon after a statement, but found none\n\nFormatted 0 files in 3ms.\n' }),
      r('PostToolUse', biome, ago(9 * MIN), 'noop', { durationMs: 401, stdout: 'Formatted 2 files in 5ms. Fixed 2 files.\n' }),
      r('PostToolUse', '~/.conclave/hooks/log-github.sh', ago(9 * MIN), 'error', { durationMs: 6, exitCode: 127, stdout: '', stderr: 'bash: line 1: ~/.conclave/hooks/log-github.sh: No such file or directory\n', note: 'A program the hook calls is not on PATH on the hub.' }),
      r('Notification', 'notify-send Conclave "$(jq -r .message)"', ago(2 * MIN), 'async', { sessionId: 's_backup', durationMs: 3, exitCode: undefined }),
      r('Stop', STOP_PROMPT, ago(28 * MIN), 'noop', { type: 'prompt', durationMs: 1840, exitCode: undefined, stdout: '{"ok":true}' }),
      r('Stop', hk('stop.py'), ago(28 * MIN), 'noop', { plugin: 'hookify', durationMs: 42, stdout: '{}\n' }),
      r('Stop', STOP_PROMPT, ago(11 * MIN), 'block', { type: 'prompt', durationMs: 2210, exitCode: undefined, stdout: '{"ok":false,"reason":"You said the tests pass, but bun test did not run in this turn. Run it and report the result."}' }),
      r('Stop', hk('stop.py'), ago(11 * MIN), 'noop', { plugin: 'hookify', durationMs: 40, stdout: '{}\n' }),
      r('SubagentStop', hk('stop.py'), ago(34 * MIN), 'skipped', { plugin: 'hookify', durationMs: 0, sessionId: 's_explore', exitCode: undefined }),
    ].sort((a, b) => a.at - b.at);
  }

  function matches(matcher: string | undefined, value: string | undefined, matcherValue: string | null) {
    if (matcherValue === null || !matcher || matcher === '*') return true;
    if (value === undefined) return false;
    try {
      return new RegExp(`^(?:${matcher})$`).test(value);
    } catch {
      return matcher === value;
    }
  }

  /** What a handler does in a test run. Plausible output for the scripts in this mock. */
  function simulate(event: HookEvent, h: Handler, input: Record<string, unknown>, plugin?: string): HookTraceDto {
    const label = h.type === 'prompt' ? (h.prompt ?? '') : h.type === 'mcp_tool' ? `mcp ${h.server ?? '?'} ${h.tool ?? '?'}` : (h.command ?? '');
    const base = { event, type: h.type === 'mcp_tool' ? 'command' : h.type, label, ...(plugin ? { plugin } : {}), ...(h.recipe ? { recipe: h.recipe } : {}) } as const;
    const text = JSON.stringify(input);
    if (h.async) return { ...base, durationMs: 2, result: 'async' };
    if (h.type === 'mcp_tool') {
      if (h.tool && !/^(search|get|list|read|fetch|find|recent|build_context)/.test(h.tool) && !h.allowWrite) return { ...base, durationMs: 1, result: 'skipped', note: `${h.server} ${h.tool} is not marked read only` };
      const out = h.server === 'basic-memory' ? '- madx runs the hub in an LXC on pve\n- Deploys: make release, then docker compose up -d on madx' : 'ok';
      return { ...base, durationMs: 140, stdout: out, result: event === 'SessionStart' || event === 'UserPromptSubmit' ? 'context' : 'noop', ...(event === 'SessionStart' || event === 'UserPromptSubmit' ? { contextChars: out.length } : {}) };
    }
    if (h.type === 'prompt') {
      const msg = String(input.last_assistant_message ?? '');
      if (event === 'Stop' && /tests? pass/i.test(msg)) return { ...base, durationMs: 1930, result: 'block', stdout: '{"ok":false,"reason":"You said the tests pass, but bun test did not run in this turn. Run it and report the result."}' };
      return { ...base, durationMs: 1610, result: 'noop', stdout: '{"ok":true}' };
    }
    const c = h.command ?? '';
    const rec = /\/hooks\/recipes\/([a-z0-9-]+)\.sh/.exec(c)?.[1];
    if (rec) {
      // a recipe: answer like its bundled test case for the same input, when there is one
      const command = String((input.tool_input as { command?: string } | undefined)?.command ?? '');
      if (rec === 'git-work-saver') {
        const hit = /git\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s+)?\.|restore\s+\.|stash\s+(drop|clear)|branch\s+-D)/.exec(command);
        if (/git\s+push\b.*\s(--force|-f)(\s|$)/.test(command)) return { ...base, durationMs: 14, exitCode: 2, stdout: '', stderr: `Refused: '${command}' rewrites shared history. Use --force-with-lease, or ask the user to run it.\n`, result: 'block' };
        if (hit) return { ...base, durationMs: 16, exitCode: 2, stdout: '', stderr: `Refused: '${hit[0]}' would discard uncommitted changes. Commit or 'git stash push' first, or ask the user.\n`, result: 'block' };
        return { ...base, durationMs: 11, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
      }
      return { ...base, durationMs: 12, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
    }
    if (c.includes('guard-push')) {
      const command = String((input.tool_input as { command?: string } | undefined)?.command ?? '');
      if (/git\s+push\b/.test(command) && /\b(main|master)\b/.test(command)) return { ...base, durationMs: 11, exitCode: 2, stdout: '', stderr: 'Pushing to main is blocked. Push a branch and open a PR instead.\n', result: 'block' };
      return { ...base, durationMs: 8, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
    }
    if (c.includes('session-context')) return { ...base, durationMs: 204, exitCode: 0, stdout: 'Branch: auth-jose, 3 files changed. Open task: Move auth middleware to jose.\n', stderr: '', result: 'context' };
    if (c.includes('session-start.sh') && plugin === 'superpowers')
      return { ...base, durationMs: 29, exitCode: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You have superpowers. Read the using-superpowers skill before you start."}}\n', stderr: '', result: 'context' };
    if (c.includes('biome format')) return { ...base, durationMs: 396, exitCode: 0, stdout: 'Formatted 1 file in 4ms. Fixed 1 file.\n', stderr: '', result: 'noop' };
    if (plugin === 'hookify') {
      if (event === 'PreToolUse' && /rm\s+-rf/.test(text))
        return { ...base, durationMs: 52, exitCode: 0, stdout: '{"systemMessage":"hookify rule block-rm-rf: rm -rf is blocked in this project.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"hookify rule block-rm-rf: rm -rf is blocked in this project."}}\n', stderr: '', result: 'deny' };
      return { ...base, durationMs: 46, exitCode: 0, stdout: '{}\n', stderr: '', result: 'noop' };
    }
    if (c.includes('redact_secrets')) return { ...base, durationMs: 61, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
    if (c.includes('stop-hook.sh')) return { ...base, durationMs: 18, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
    if (c.includes('typecheck') || c.includes('lint')) return { ...base, durationMs: 3120, exitCode: 0, stdout: '$ tsc -b --noEmit\n', stderr: '', result: 'noop' };
    if (c.includes('check_cmd.py')) return { ...base, durationMs: 72, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
    if (/^\s*sleep\s+\d+/.test(c) && h.timeout && h.timeout < 5) return { ...base, durationMs: h.timeout * 1000, timedOut: true, result: 'timeout', exitCode: undefined, stdout: '', stderr: '' };
    if (/^echo\s/.test(c)) return { ...base, durationMs: 3, exitCode: 0, stdout: c.replace(/^echo\s+/, '').replace(/^["']|["']$/g, '') + '\n', stderr: '', result: event === 'SessionStart' || event === 'UserPromptSubmit' ? 'context' : 'noop' };
    if (/^exit\s+2/.test(c) || /\bexit 2\b/.test(c)) return { ...base, durationMs: 4, exitCode: 2, stdout: '', stderr: 'Blocked by test hook.\n', result: 'block' };
    return { ...base, durationMs: 27, exitCode: 0, stdout: '', stderr: '', result: 'noop' };
  }

  /** A handler's `if` permission rule, like Bash(git push *): the hub leaves the handler out when it does not match. */
  function ifMatches(rule: string | undefined, input: Record<string, unknown>): boolean {
    if (!rule) return true;
    const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim());
    if (!m) return true;
    if (m[1] !== input.tool_name) return false;
    if (m[2] === undefined) return true;
    const ti = (input.tool_input ?? {}) as Record<string, unknown>;
    const value = String(ti.command ?? ti.file_path ?? ti.url ?? ti.pattern ?? '');
    const re = new RegExp('^' + m[2].split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(value);
  }

  function contextOf(t: HookTraceDto): string | undefined {
    const out = (t.stdout ?? '').trim();
    if (!out) return undefined;
    try {
      const j = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } };
      return j.hookSpecificOutput?.additionalContext;
    } catch {
      return out;
    }
  }

  function describe(event: HookEvent, r: Omit<HookTestResult, 'modelWouldSee'>): string {
    const reason = r.reason ?? 'no reason given';
    const ctxText = r.additionalContext.length ? ` Added to the model's context: ${r.additionalContext.join(' | ')}` : '';
    switch (event) {
      case 'PreToolUse':
        if (r.blocked || r.permissionDecision === 'deny') return `Blocked. The model would see: Blocked by hook: ${reason}`;
        if (r.permissionDecision === 'ask') return `Asks you to approve the call: ${reason}`;
        if (r.permissionDecision === 'allow') return 'Allowed without a prompt.';
        return `No change; the normal permission check decides.${ctxText}`;
      case 'PermissionRequest':
        if (r.blocked || r.permissionDecision === 'deny') return `Denied for you. The model would see: Permission denied by hook: ${reason}`;
        if (r.permissionDecision === 'allow') return 'Approved for you; no prompt is shown.';
        return 'No decision; you would be asked as usual.';
      case 'UserPromptSubmit':
        if (r.blocked) return `Prompt blocked. You would see: Prompt blocked by hook: ${reason}`;
        return ctxText ? ctxText.trim() : 'No change.';
      case 'Stop':
      case 'SubagentStop':
        if (r.blocked && r.reason) return `The agent would keep going with: ${event} hook feedback:\n${r.reason}`;
        return 'The agent would stop as usual.';
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return r.additionalContext.length ? `Appended to the tool result: ${r.additionalContext.join(' | ')}` : 'No change.';
      case 'PreCompact':
        if (r.blocked) return `Compaction is skipped: ${reason}`;
        return ctxText ? `Compaction keeps these details: ${r.additionalContext.join(' | ')}` : 'No change.';
      default:
        return ctxText ? ctxText.trim() : 'Side effects only; nothing reaches the model.';
    }
  }

  function defaultMatcherValue(event: HookEvent, input: Record<string, unknown>): string | undefined {
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
    if (/ToolUse|PermissionRequest/.test(event)) return s('tool_name');
    if (event === 'SessionStart') return s('source');
    if (event === 'SessionEnd') return s('reason');
    if (event === 'PreCompact') return s('trigger');
    if (event === 'SubagentStart' || event === 'SubagentStop') return s('agent_type');
    if (event === 'Notification') return s('notification_type');
    return undefined;
  }

  function validateHooks(hooks: unknown): HooksConfig {
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) fail(400, 'hooks must be an object keyed by event');
    for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
      if (!EVENT_NAMES.includes(event as HookEvent)) fail(400, `unknown hook event ${event}`);
      if (!Array.isArray(list)) fail(400, `hooks.${event} must be a list of groups`);
      (list as unknown[]).forEach((g, i) => {
        const where = `hooks.${event}[${i}]`;
        const hs = (g as { hooks?: unknown }).hooks;
        if (!Array.isArray(hs)) fail(400, `${where} needs a hooks list`);
        (hs as Array<Record<string, unknown>>).forEach((h, j) => {
          const hw = `${where}.hooks[${j}]`;
          if (h.type === 'command' && (typeof h.command !== 'string' || !h.command.trim())) fail(400, `${hw}.command is required`);
          else if (h.type === 'prompt' && (typeof h.prompt !== 'string' || !h.prompt.trim())) fail(400, `${hw}.prompt is required`);
          else if (h.type === 'mcp_tool' && (typeof h.server !== 'string' || typeof h.tool !== 'string')) fail(400, `${hw} needs server and tool`);
          else if (h.type !== 'command' && h.type !== 'prompt' && h.type !== 'mcp_tool') fail(400, `${hw}.type must be command, prompt or mcp_tool`);
          if (h.timeout !== undefined && (typeof h.timeout !== 'number' || h.timeout <= 0)) fail(400, `${hw}.timeout must be a positive number of seconds`);
        });
      });
    }
    return hooks as HooksConfig;
  }

  // per-project .conclave/settings.json hooks written through saveHooks
  const projectHooks = new Map<string, HooksConfig>();
  const projectFilesWithEdits = (cwd: string): ProjectFiles => {
    const f = projectFiles(cwd);
    const edited = projectHooks.get(expand(cwd));
    return edited ? { ...f, conclave: { ...f.conclave, hooks: edited } } : f;
  };

  // ----- lint (the hub's hook-lint.ts, for the cases the seed shows) --------

  function mockLint(raw: unknown, path?: string): HookLintIssue[] {
    const out: HookLintIssue[] = [];
    if (!raw || typeof raw !== 'object') return out;
    const src = raw as Record<string, Array<Record<string, unknown>>>;
    const fixWith = (f: (c: Record<string, Array<Record<string, unknown>>>) => void) => {
      const c = structuredClone(src);
      f(c);
      return c as unknown as HooksConfig;
    };
    for (const [ev, list] of Object.entries(src)) {
      const event = ev as HookEvent;
      if (!Array.isArray(list)) continue;
      list.forEach((g, gi) => {
        const at = { event, group: gi, ...(path ? { path } : {}) };
        if (!Array.isArray(g.hooks)) {
          if (typeof g.command === 'string' || typeof g.prompt === 'string')
            out.push({
              ...at,
              level: 'error',
              text: `Group ${gi + 1} of ${event} is a bare handler with no "hooks" list, so it loads as nothing (in Claude Code too). Wrap it: {"matcher": ..., "hooks": [{"type": "command", "command": ...}]}.`,
              fix: fixWith((c) => {
                const { matcher, ...h } = c[ev][gi];
                c[ev][gi] = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', ...h }] };
              }),
            });
          return;
        }
        const m = typeof g.matcher === 'string' ? g.matcher : '';
        const bare = /^mcp__([A-Za-z0-9_-]+?)(?:__)?$/.exec(m);
        if (bare && !bare[1].includes('__'))
          out.push({ ...at, level: 'warn', text: `Matcher "${m}" is an exact tool name, so it matches no MCP tool. Use "mcp__${bare[1]}__.*" for all of that server's tools.`, fix: fixWith((c) => void (c[ev][gi].matcher = `mcp__${bare[1]}__.*`)) });
        (g.hooks as Array<Record<string, unknown>>).forEach((h, hi) => {
          const t = h.timeout;
          if (typeof t === 'number' && t >= 1000)
            out.push({
              ...at,
              handler: hi,
              level: 'warn',
              text: `Timeout ${t} is in seconds here (${Math.round(t / 60)} minutes). It looks like milliseconds; did you mean ${Math.max(1, Math.round(t / 1000))}?`,
              fix: fixWith((c) => void ((c[ev][gi].hooks as Array<Record<string, unknown>>)[hi].timeout = Math.max(1, Math.round(t / 1000)))),
            });
          if (h.type === 'mcp_tool' && typeof h.server === 'string' && !cfg.mcpServers?.[h.server]) out.push({ ...at, handler: hi, level: 'warn', text: `The mcp_tool handler calls server ${h.server}, which is not set up on this hub.` });
        });
      });
    }
    return out;
  }

  function wrapFlat(raw: HooksConfig): HooksConfig {
    const out = structuredClone(raw) as unknown as Record<string, Array<Record<string, unknown>>>;
    for (const list of Object.values(out))
      if (Array.isArray(list))
        list.forEach((g, i) => {
          if (!Array.isArray(g.hooks) && (typeof g.command === 'string' || typeof g.prompt === 'string')) {
            const { matcher, ...h } = g;
            list[i] = { ...(matcher ? { matcher } : {}), hooks: [{ type: h.prompt ? 'prompt' : 'command', ...h }] };
          }
        });
    return out as unknown as HooksConfig;
  }

  // ----- built-in hooks (core/engine/builtin-hooks.ts) ------------------------

  const builtins: BuiltinHookDto[] = [
    {
      id: 'memory-recall',
      event: 'UserPromptSubmit',
      label: 'Memory recall',
      description: 'Before each message reaches the model, finds related memories and adds them as a note the model can see. Every injection is listed in the run log with its size.',
      enabled: true,
      canDisable: true,
      budgetChars: 4000,
      setting: 'memory.autoInject',
      ...(FRESH ? {} : { tokensPerSession: 410, lastRun: { event: 'UserPromptSubmit', type: 'function', label: 'memory-recall', durationMs: 38, result: 'context', contextChars: 612, stdout: '4 memories', at: ago(37 * MIN), sessionId: 's_auth' } as HookRunDto }),
    },
    {
      id: 'memory-extract',
      event: 'Stop',
      label: 'Memory extraction',
      description: 'When a session goes idle, a small model reads it and saves durable facts and procedures as memories.',
      enabled: true,
      canDisable: true,
      setting: 'memory.autoExtract',
    },
    {
      id: 'compaction',
      event: 'PreCompact',
      label: 'Compaction',
      description: 'When the context is nearly full, older messages are summarized so the session keeps going. PreCompact hooks run first and can add what the summary must keep.',
      enabled: true,
      canDisable: false,
      setting: 'context.compactAt',
    },
    {
      id: 'file-recall',
      event: 'PreToolUse',
      label: 'File recall',
      description: 'When the agent reads a file, adds memories tagged with that path or that mention it, and memories tagged repo:<name> once per session. Off by default.',
      enabled: false,
      canDisable: true,
      budgetChars: 1500,
    },
  ];

  on('GET', '/api/hooks/builtin', async () => {
    await sleep(140);
    return builtins;
  });

  on('PATCH', '/api/hooks/builtin/:id', ({ params, body }) => {
    const b = builtins.find((x) => x.id === params[0]);
    if (!b) fail(404, `unknown built-in hook ${params[0]}`);
    if (body?.enabled === false && !b!.canDisable) fail(400, `${b!.label} cannot be turned off: long sessions would no longer fit the model. Raise context.compactAt instead.`);
    if (body?.budgetChars !== undefined && (typeof body.budgetChars !== 'number' || body.budgetChars < 200 || body.budgetChars > 50000)) fail(400, 'budgetChars must be a number from 200 to 50000');
    if (typeof body?.enabled === 'boolean') b!.enabled = body.enabled;
    if (typeof body?.budgetChars === 'number') b!.budgetChars = body.budgetChars;
    changed();
    return b;
  });

  on('POST', '/api/hooks/lint', ({ body }) => {
    if (body?.hooks === undefined) fail(400, 'hooks is required');
    return mockLint(body.hooks);
  });

  // ----- hooks ---------------------------------------------------------------

  on('GET', '/api/hooks', ({ query }) => {
    const cwd = query.get('cwd') || undefined;
    const groups = withEdits(cwd);
    const events: HookEventInfo[] = EVENTS.map(([event, gloss, matcherValue]) => ({
      event,
      gloss,
      matcherValue,
      fires: true,
      groups: groups.filter((g) => g.event === event).map(({ event: _e, ...g }) => g),
      last: runs.filter((r) => r.event === event).slice(-10),
    }));
    const lint = [...mockLint(cfg.hooks, CONFIG_PATH), ...(FRESH ? [] : mockLint(CLAUDE_USER_HOOKS, CLAUDE_USER))];
    const out: HooksOverview = { events, ...(cwd ? { trust: trustInfoEdited(cwd) } : {}), ...(lint.length ? { lint } : {}) };
    return out;
  });

  function withEdits(cwd?: string): Group[] {
    const list = groupsFor(cwd);
    if (!cwd) return list;
    const edited = projectHooks.get(expand(cwd));
    if (!edited) return list;
    const t = trustInfoEdited(cwd).trusted;
    const path = `${expand(cwd)}/.conclave/settings.json`;
    const rest = list.filter((g) => g.source !== 'project' || g.path !== path);
    for (const [event, gl] of Object.entries(edited) as Array<[HookEvent, HookMatcher[]]>)
      (gl ?? []).forEach((g, index) => rest.push({ event, ...(g.matcher ? { matcher: g.matcher } : {}), source: 'project', path, index, active: t, editable: true, hooks: g.hooks as Handler[] }));
    return sortGroups(rest);
  }

  function trustInfoEdited(cwd: string): ProjectTrustInfo {
    const info = trustInfo(cwd);
    const edited = projectHooks.get(expand(cwd));
    if (!edited) return info;
    const f = projectFilesWithEdits(cwd);
    const hooks = handlerCount(f.claude?.hooks) + handlerCount(f.conclave?.hooks) + handlerCount(f.conclaveLocal?.hooks);
    const path = `${expand(cwd)}/.conclave/settings.json`;
    const files = info.files.filter((x) => x !== path);
    if (handlerCount(edited)) files.splice(f.claude ? 1 : 0, 0, path);
    return { ...info, hooks, files };
  }

  on('POST', '/api/hooks/test', async ({ body }) => {
    const t = body as HookTestInput;
    if (!t?.event || !EVENT_NAMES.includes(t.event)) fail(400, `event must be one of ${EVENT_NAMES.join(', ')}`);
    if (t.input !== undefined && (typeof t.input !== 'object' || t.input === null || Array.isArray(t.input))) fail(400, 'input must be an object');
    const input = (t.input ?? {}) as Record<string, unknown>;
    const mv = t.matcherValue ?? defaultMatcherValue(t.event, input);
    const info = EVENTS.find((e) => e[0] === t.event)!;
    const groups = withEdits(t.cwd).filter(
      (g) =>
        g.event === t.event &&
        g.active &&
        (!t.only || ((t.only.source === undefined || t.only.source === g.source) && (t.only.plugin === undefined || t.only.plugin === g.plugin) && (t.only.index === undefined || t.only.index === g.index) && (t.only.path === undefined || t.only.path === g.path))) &&
        matches(g.matcher, mv, info[2]),
    );
    const trace: HookTraceDto[] = [];
    for (const g of groups) for (const h of g.hooks) if (ifMatches(h.if, input)) trace.push(simulate(t.event, h, input, g.plugin));
    await sleep(Math.min(2400, 120 + trace.reduce((n, x) => n + x.durationMs, 0)));
    const block = trace.find((x) => x.result === 'block');
    const deny = trace.find((x) => x.result === 'deny');
    let reason: string | undefined;
    if (block) {
      if (block.type === 'prompt') reason = (JSON.parse(block.stdout ?? '{}') as { reason?: string }).reason;
      else reason = (block.stderr ?? '').trim() || undefined;
    } else if (deny) reason = (JSON.parse(deny.stdout ?? '{}') as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason;
    const additionalContext = trace.filter((x) => x.result === 'context').map(contextOf).filter((x): x is string => !!x);
    const systemMessages = trace.map((x) => {
      try {
        return (JSON.parse(x.stdout ?? '') as { systemMessage?: string }).systemMessage;
      } catch {
        return undefined;
      }
    }).filter((x): x is string => !!x);
    const res: Omit<HookTestResult, 'modelWouldSee'> = {
      blocked: !!block,
      ...(reason ? { reason } : {}),
      ...(deny ? { permissionDecision: 'deny' as const } : {}),
      additionalContext,
      systemMessages,
      trace,
    };
    for (const x of trace) runs.push({ ...x, at: Date.now(), sessionId: 'test' });
    return { ...res, modelWouldSee: describe(t.event, res) } satisfies HookTestResult;
  });

  on('PUT', '/api/hooks', ({ body }) => {
    if (body?.scope !== 'user' && body?.scope !== 'project') fail(400, 'scope must be user or project');
    if (!body.hooks || typeof body.hooks !== 'object') fail(400, 'hooks is required');
    const hooks = structuredClone(validateHooks(wrapFlat(body.hooks)));
    for (const k of Object.keys(hooks) as HookEvent[]) if (!hooks[k]?.length) delete hooks[k];
    if (body.scope === 'user') cfg.hooks = hooks;
    else {
      if (!body.cwd) fail(400, 'cwd is required for project hooks');
      projectHooks.set(expand(body.cwd), hooks);
    }
    changed();
    const lint = mockLint(hooks);
    return { ok: true, ...(lint.length ? { lint } : {}) };
  });

  on('POST', '/api/hooks/import', async ({ body }) => {
    if (body?.from !== 'gemini' && body?.from !== 'codex') fail(400, 'from must be gemini or codex');
    await sleep(250);
    const empty: HookImportResult = { hooks: {}, skipped: [], notes: [] };
    if (FRESH) return empty;
    if (body.from === 'gemini')
      return {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.gemini/hooks/block-secrets.sh', timeout: 5 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'notify-send "Gemini finished"', timeout: 2 }] }],
        },
        skipped: ['BeforeModel', 'BeforeToolSelection'],
        notes: [
          'Gemini blocks on any non-zero exit other than 1; Conclave and Claude Code block only on exit 2. Check scripts that exit 1 or 3.',
          'Gemini hook output fields llm_request, llm_response and toolConfig have no Conclave equivalent.',
        ],
      } satisfies HookImportResult;
    return {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.codex/hooks/deny-prod-ssh.sh', timeout: 10 }] }],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'cat ~/.codex/context/homelab.md' }] }],
      },
      skipped: [],
      notes: ['Codex treats a hyphen in a matcher as a regex; Conclave matches hyphenated names exactly, like Claude Code.'],
    } satisfies HookImportResult;
  });

  // ----- trust ---------------------------------------------------------------

  on('GET', '/api/trust', ({ query }) => {
    const cwd = query.get('cwd');
    if (!cwd) fail(400, 'cwd is required');
    return trustInfoEdited(cwd!);
  });

  on('POST', '/api/trust', ({ body }) => {
    if (typeof body?.cwd !== 'string' || !body.cwd) fail(400, 'cwd is required');
    if (typeof body.trusted !== 'boolean') fail(400, 'trusted must be a boolean');
    const p = expand(body.cwd);
    if (body.trusted) trusted.add(p);
    else for (const t of [...trusted]) if (p === t || p.startsWith(t + '/')) trusted.delete(t);
    changed();
    return trustInfoEdited(body.cwd);
  });

  // ----- plugins -------------------------------------------------------------

  const findPlugin = (name: string) => plugins.find((p) => p.name === name);

  on('GET', '/api/plugins', () => plugins.map(installed));

  on('GET', '/api/plugins/:name', ({ params }) => {
    const p = findPlugin(params[0]);
    if (!p) fail(404, `unknown plugin ${params[0]}`);
    return p;
  });

  on('POST', '/api/plugins', async ({ body }) => {
    const source = typeof body?.source === 'string' ? body.source.trim() : '';
    if (!source) fail(400, 'source is required');
    await sleep(1100);
    const at = /^([^@/\s][^@\s]*)@([A-Za-z0-9._-]+)$/.exec(source);
    let name: string;
    let marketplace: string | undefined;
    if (at) {
      [, name, marketplace] = at;
      const mk = marketplaces.find((m) => m.name === marketplace);
      if (!mk) fail(400, `marketplace not added: ${marketplace}`);
      if (!mk!.entries.some((e) => e.name === name)) fail(400, `plugin ${name} not found in marketplace ${marketplace}`);
    } else {
      name = source.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || 'plugin';
      if (source.startsWith('/') || source.startsWith('~')) fail(400, `local plugin path not found: ${source}`);
    }
    const existing = findPlugin(name);
    const detail = buildDetail(name, marketplace, { enabled: existing?.enabled ?? true, installedAt: Date.now(), source });
    if (name === 'superpowers') detail.manifest.version = '4.1.1';
    if (existing) plugins.splice(plugins.indexOf(existing), 1, detail);
    else plugins.push(detail);
    syncPlugins();
    changed();
    return installed(detail);
  });

  on('PATCH', '/api/plugins/:name', ({ params, body }) => {
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'enabled must be a boolean');
    if (body?.hooks !== undefined && typeof body.hooks !== 'boolean') fail(400, 'hooks must be a boolean');
    if (body?.enabled === undefined && body?.hooks === undefined) fail(400, 'send enabled or hooks');
    const p = findPlugin(params[0]);
    if (!p) fail(404, 'unknown plugin');
    if (typeof body.enabled === 'boolean') p!.enabled = body.enabled;
    if (typeof body.hooks === 'boolean') p!.hooksEnabled = body.hooks;
    syncPlugins();
    changed();
    return { ok: true };
  });

  on('DELETE', '/api/plugins/:name', ({ params }) => {
    const p = findPlugin(params[0]);
    if (!p) fail(404, 'unknown plugin');
    plugins.splice(plugins.indexOf(p!), 1);
    syncPlugins();
    changed();
    return { ok: true };
  });

  on('POST', '/api/plugins/:name/update', async ({ params }) => {
    const p = findPlugin(params[0]);
    if (!p) fail(404, `unknown plugin ${params[0]}`);
    await sleep(1400);
    if (p!.name === 'context7') fail(502, `update of context7 from ${p!.source} failed: git fetch failed: Could not resolve host: github.com`);
    if (p!.name === 'superpowers') p!.manifest = { ...p!.manifest, version: '4.1.1' };
    changed();
    return installed(p!);
  });

  // ----- marketplace ---------------------------------------------------------

  const entries = (): Array<MktEntry & { marketplace: string }> => marketplaces.flatMap((m) => m.entries.map((e) => ({ ...e, marketplace: m.name })));

  on('GET', '/api/marketplace', () =>
    entries().map(
      (e): MarketplaceEntry => ({
        name: e.name,
        ...(e.description ? { description: e.description } : {}),
        source: e.sourceKind === 'path' ? `./plugins/${e.name}` : { source: e.sourceKind, url: `https://github.com/${e.name}/${e.name}.git` },
        ...(e.version ? { version: e.version } : {}),
        ...(e.category ? { category: e.category } : {}),
        marketplace: e.marketplace,
      }),
    ),
  );

  on('GET', '/api/marketplace/search', async ({ query }) => {
    await sleep(120);
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const category = query.get('category') || undefined;
    const marketplace = query.get('marketplace') || undefined;
    const results: MarketplaceSearchItem[] = entries()
      .filter((e) => !marketplace || e.marketplace === marketplace)
      .filter((e) => !category || (e.category ?? '').toLowerCase() === category.toLowerCase())
      .filter((e) => !q || [e.name, e.description ?? '', e.category ?? ''].some((s) => s.toLowerCase().includes(q)))
      .map((e) => {
        const p = findPlugin(e.name);
        return {
          name: e.name,
          ...(e.description ? { description: e.description } : {}),
          ...(e.category ? { category: e.category } : {}),
          ...(e.version ? { version: e.version } : {}),
          marketplace: e.marketplace,
          sourceKind: e.sourceKind,
          installed: !!p,
          enabled: !!p?.enabled,
          install: `${e.name}@${e.marketplace}`,
        };
      });
    return { marketplaces: marketplaces.map((m) => ({ name: m.name, plugins: m.entries.length })), results };
  });

  on('POST', '/api/marketplace', async ({ body }) => {
    const source = typeof body?.source === 'string' ? body.source.trim() : '';
    if (!source) fail(400, 'source is required');
    await sleep(1200);
    const key = source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    const known = KNOWN_MARKETPLACES[key];
    if (known) {
      if (!marketplaces.some((m) => m.name === known.name)) marketplaces.push({ name: known.name, source, entries: known.entries });
      return { ok: true };
    }
    if (marketplaces.some((m) => m.source === key)) return { ok: true };
    if (source.startsWith('/') || source.startsWith('~')) fail(400, `no marketplace.json in ${source}. Point at a folder with .claude-plugin/marketplace.json.`);
    fail(400, `git clone failed: Cloning into '/root/.conclave/plugins/.marketplaces/${key.replace(/[^\w.-]+/g, '-')}'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled`);
  });

  // ----- MCP -----------------------------------------------------------------

  interface Server {
    name: string;
    config: McpServerConfig;
    origin: 'config' | 'plugin';
    plugin?: string;
  }

  function servers(): Server[] {
    const out: Server[] = Object.entries(cfg.mcpServers ?? {}).map(([name, config]) => ({ name, config, origin: 'config' as const }));
    for (const p of plugins.filter((x) => x.enabled)) for (const [name, config] of Object.entries(p.mcpServers)) out.push({ name, config, origin: 'plugin', plugin: p.name });
    return out;
  }

  const findServer = (name: string) => servers().find((s) => s.name === name);
  const transportOf = (c: McpServerConfig): 'stdio' | 'http' | 'sse' => (c.url ? (c.type === 'sse' ? 'sse' : 'http') : 'stdio');

  function statusOf(s: Server): McpStatus {
    const t = transportOf(s.config);
    const l = live.get(s.name);
    const off = s.config.enabled === false;
    const status: McpStatus['status'] = off ? 'disabled' : (l?.status ?? 'connected');
    const count = status === 'connected' ? (TOOLS[s.name]?.length ?? 3) : 0;
    return {
      name: s.name,
      status,
      tools: count,
      ...(status === 'failed' && l?.error ? { error: l.error } : {}),
      source: t,
      origin: s.origin,
      ...(s.plugin ? { plugin: s.plugin } : {}),
      transport: t,
      enabled: status !== 'disabled',
    };
  }

  function requireServer(name: string): Server {
    const s = findServer(name);
    if (!s) fail(404, `unknown mcp server ${name}`);
    return s!;
  }

  function validateServer(c: unknown): McpServerConfig {
    if (!c || typeof c !== 'object' || Array.isArray(c)) fail(400, 'config must be an object');
    const x = c as McpServerConfig;
    if (!x.command && !x.url) fail(400, 'config needs a command (stdio) or a url (http, sse)');
    if (x.url) {
      try {
        const u = new URL(x.url.replace(/\$\{[^}]+\}/g, 'x'));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      } catch {
        fail(400, 'config.url must be an http(s) URL');
      }
    }
    if (x.args !== undefined && (!Array.isArray(x.args) || x.args.some((a) => typeof a !== 'string'))) fail(400, 'config.args must be a list of strings');
    return x;
  }

  /** A new or edited server connects after a moment; unknown commands fail like on the hub. */
  function connectLater(name: string, c: McpServerConfig) {
    if (c.enabled === false) {
      live.delete(name);
      return;
    }
    live.set(name, { status: 'connecting' });
    const missing = c.command && !['uvx', 'bunx', 'docker', 'pve-mcp', 'python3', 'node', 'basic-memory'].includes(c.command) && !c.command.startsWith('/');
    setTimeout(() => {
      if (missing) live.set(name, { status: 'failed', error: `Executable not found in $PATH: "${c.command}"` });
      else live.delete(name);
      changed();
    }, 1600);
  }

  on('GET', '/api/mcp', () => servers().map(statusOf));

  on('POST', '/api/mcp', ({ body }) => {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name) fail(400, 'name is required');
    if (body.scope !== undefined && body.scope !== 'user') fail(400, 'only scope "user" is supported; Conclave does not start servers from a project .mcp.json yet');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(400, 'name must be 1-64 letters, digits, _ or -');
    if (findServer(name)) fail(409, `an mcp server named ${name} already exists`);
    const c = validateServer(body.config);
    cfg.mcpServers = { ...cfg.mcpServers, [name]: c };
    connectLater(name, c);
    changed();
    return statusOf(findServer(name)!);
  });

  on('POST', '/api/mcp/import', ({ body }) => {
    const from = body?.from as McpImportFormat;
    if (!['claude', 'codex', 'opencode', 'gemini'].includes(from)) fail(400, 'from must be claude, codex, opencode or gemini');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) fail(400, 'text is required');
    try {
      return importServers(from, text);
    } catch (e) {
      fail(400, `could not read the ${from} config: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  on('PATCH', '/api/mcp/:name', ({ params, body }) => {
    const s = requireServer(params[0]);
    if (s.origin === 'plugin') fail(400, `${s.name} comes from a plugin; enable or disable the plugin instead`);
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'enabled must be a boolean');
    const base = body?.config !== undefined ? validateServer(body.config) : s.config;
    const next: McpServerConfig = { ...base, ...(body?.enabled !== undefined ? { enabled: body.enabled } : {}) };
    if (next.enabled === true) delete next.enabled;
    cfg.mcpServers = { ...cfg.mcpServers, [s.name]: next };
    if (body?.config !== undefined || body?.enabled === true) connectLater(s.name, next);
    changed();
    return statusOf(findServer(s.name)!);
  });

  on('DELETE', '/api/mcp/:name', ({ params }) => {
    const s = findServer(params[0]);
    if (!s) fail(404, `unknown mcp server ${params[0]}`);
    if (s!.origin === 'plugin') fail(400, `${s!.name} comes from a plugin; remove the plugin instead`);
    const next = { ...cfg.mcpServers };
    delete next[s!.name];
    cfg.mcpServers = next;
    live.delete(s!.name);
    changed();
    return { ok: true };
  });

  on('POST', '/api/mcp/:name/restart', async ({ params }) => {
    const s = requireServer(params[0]);
    await sleep(900);
    const l = live.get(s.name);
    if (l?.status === 'connecting') live.delete(s.name);
    return statusOf(s);
  });

  on('POST', '/api/mcp/:name/test', async ({ params }) => {
    const s = requireServer(params[0]);
    if (s.config.enabled === false) fail(409, `mcp server ${s.name} is disabled`);
    const st = statusOf(s);
    if (st.status === 'failed') {
      await sleep(80);
      return { ok: false, ms: 6, tools: 0, error: live.get(s.name)?.error ?? 'Process exited with code 1' } satisfies McpTestResult;
    }
    const ms = s.config.url ? 380 + Math.round(Math.random() * 300) : 900 + Math.round(Math.random() * 700);
    await sleep(Math.min(ms, 1400));
    return { ok: true, ms, tools: st.tools || (TOOLS[s.name]?.length ?? 3) } satisfies McpTestResult;
  });

  on('GET', '/api/mcp/:name/tools', async ({ params }) => {
    const s = requireServer(params[0]);
    if (s.config.enabled === false) fail(409, `mcp server ${s.name} is disabled`);
    const st = statusOf(s);
    if (st.status === 'failed') fail(502, `could not reach ${s.name}: ${live.get(s.name)?.error ?? 'Process exited with code 1'}`);
    await sleep(200);
    return tools(s.name, TOOLS[s.name] ?? [['ping', 'Check that the server answers.', true]]);
  });

  on('POST', '/api/mcp/:name/call', async ({ params, body }) => {
    const s = requireServer(params[0]);
    if (s.config.enabled === false) fail(409, `mcp server ${s.name} is disabled`);
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    if (!tool) fail(400, 'tool is required');
    const args = (body.args ?? {}) as Record<string, unknown>;
    const spec = (TOOLS[s.name] ?? []).find((t) => t[0] === tool);
    if (!spec) return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true } satisfies McpCallResult;
    const missing = (spec[4] ?? []).filter((k) => args[k] === undefined || args[k] === '');
    await sleep(350);
    if (missing.length) return { content: [{ type: 'text', text: `Invalid arguments for ${tool}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required` }], isError: true } satisfies McpCallResult;
    return { content: [{ type: 'text', text: callText(s.name, tool, args) }] } satisfies McpCallResult;
  });

  on('GET', '/api/mcp/:name/connect', ({ params }) => {
    const s = requireServer(params[0]);
    return connectPlan(s.name, s.config);
  });

  on('POST', '/api/mcp/:name/connect', async ({ params, body }) => {
    const s = requireServer(params[0]);
    const clis = body?.clis as CliName[] | undefined;
    if (!Array.isArray(clis) || !clis.length) fail(400, 'clis must list some of claude, codex, opencode, gemini');
    const id = typeof body.device === 'string' && body.device ? body.device : 'local';
    const dev = db.devices.get(id);
    if (!dev) fail(404, `unknown device ${id}`);
    if (!dev!.online) fail(409, `device ${dev!.name} is offline`);
    const steps = connectPlan(s.name, s.config);
    const out: McpConnectRunResult[] = [];
    for (const cli of clis!) {
      const step = steps.find((x) => x.cli === cli);
      if (!step?.command) {
        out.push({ cli, exitCode: null, stdout: '', stderr: '', skipped: `no command for ${cli}; add the snippet to ${step?.file ?? 'its config file'}` });
        continue;
      }
      if (!dev!.info?.clis?.[cli]) {
        out.push({ cli, command: step.command, exitCode: null, stdout: '', stderr: '', skipped: `${cli} is not installed on ${dev!.name}` });
        continue;
      }
      await sleep(500);
      out.push({ cli, command: step.command, ...runText(cli, s.name, transportOf(s.config)) });
    }
    return out;
  });

  function runText(cli: CliName, name: string, t: string): Omit<McpConnectRunResult, 'cli' | 'command'> {
    if (cli === 'claude') return { exitCode: 0, stdout: `Added ${t} MCP server ${name} to user config\n`, stderr: '' };
    if (cli === 'codex') return { exitCode: 0, stdout: `Added global MCP server '${name}'.\n`, stderr: '' };
    return { exitCode: 0, stdout: `MCP server "${name}" added to user settings. (${t})\n`, stderr: '' };
  }

  function callText(server: string, tool: string, args: Record<string, unknown>): string {
    if (server === 'basic-memory' && tool === 'search_notes')
      return JSON.stringify(
        {
          results: [
            { title: 'PBS retention policy', permalink: 'homelab/pbs-retention-policy', type: 'entity', score: 0.91, content: 'keep-daily 7, keep-weekly 4, keep-monthly 6 on the tank datastore' },
            { title: 'Caddy reverse proxy', permalink: 'homelab/caddy-reverse-proxy', type: 'entity', score: 0.62, content: 'Caddy on ct/101 terminates TLS for *.lab.kai.dev' },
          ],
          current_page: 1,
          page_size: 10,
          query: args.query,
        },
        null,
        2,
      );
    if (server === 'basic-memory' && tool === 'recent_activity') return 'Recent activity (7d):\n- homelab/pbs-retention-policy (edited 2h ago)\n- uni/os-a3-mlfq-notes (created yesterday)\n- conclave/extensions-ui (edited 3d ago)';
    if (server === 'basic-memory' && tool === 'list_memory_projects') return 'Projects:\n- main (default) /srv/notes';
    if (server === 'proxmox' && tool === 'list_guests')
      return JSON.stringify(
        [
          { vmid: 101, name: 'caddy', type: 'lxc', status: 'running', mem: '212 MiB / 512 MiB' },
          { vmid: 103, name: 'vaultwarden', type: 'lxc', status: 'running', mem: '96 MiB / 512 MiB' },
          { vmid: 104, name: 'immich', type: 'lxc', status: 'running', mem: '3.1 GiB / 6 GiB' },
          { vmid: 110, name: 'madx', type: 'lxc', status: 'running', mem: '1.4 GiB / 4 GiB' },
          { vmid: 200, name: 'home-assistant', type: 'qemu', status: 'running', mem: '1.8 GiB / 4 GiB' },
          { vmid: 210, name: 'kali-vm', type: 'qemu', status: 'running', mem: '3.6 GiB / 8 GiB' },
        ],
        null,
        2,
      );
    if (server === 'proxmox' && tool === 'node_status') return JSON.stringify({ node: args.node ?? 'pve', cpu: '7%', memory: '41.2 GiB / 64 GiB', uptime: '23d 4h', kernel: '6.14.11-2-pve' }, null, 2);
    if (server === 'proxmox' && tool === 'snapshot') return `Created snapshot ${String(args.name)} for ${String(args.vmid)}. Task UPID:pve:0003A1F2:snapshot done in 2.1s.`;
    if (server === 'github' && tool === 'get_me') return JSON.stringify({ login: 'kai-dev', name: 'Kai', public_repos: 23, two_factor_authentication: true }, null, 2);
    if (server === 'plugin_context7_context7' && tool === 'resolve-library-id') return `Found 2 libraries for "${String(args.libraryName)}":\n- /honojs/hono (trust 9.6, 1240 snippets)\n- /honojs/website (trust 8.1, 610 snippets)`;
    return `Done. ${tool} ran with ${JSON.stringify(args)}.`;
  }
}

// ---------------------------------------------------------------------------
// MCP config conversion (a small copy of the hub's compat code)
// ---------------------------------------------------------------------------

const SECRET_NOTE = 'Other CLIs cannot read Conclave secrets: replace ${secret:...} with the value or an environment variable before running this.';

function sh(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function toClaude(c: McpServerConfig): Record<string, unknown> {
  if (c.url) return { type: c.type === 'sse' ? 'sse' : 'http', url: c.url, ...(c.headers ? { headers: c.headers } : {}) };
  return { type: 'stdio', command: c.command, args: c.args ?? [], ...(c.env ? { env: c.env } : {}) };
}

function tomlStr(s: string) {
  return JSON.stringify(s);
}

function toCodexToml(name: string, c: McpServerConfig): string {
  const lines = [`[mcp_servers.${name}]`];
  if (c.url) lines.push(`url = ${tomlStr(c.url)}`);
  else {
    lines.push(`command = ${tomlStr(c.command ?? '')}`);
    if (c.args?.length) lines.push(`args = [${c.args.map(tomlStr).join(', ')}]`);
  }
  const env = c.url ? undefined : c.env;
  if (env && Object.keys(env).length) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(env)) lines.push(`${k} = ${tomlStr(v)}`);
  }
  if (c.url && c.headers && Object.keys(c.headers).length) {
    lines.push('', `[mcp_servers.${name}.http_headers]`);
    for (const [k, v] of Object.entries(c.headers)) lines.push(`${k} = ${tomlStr(v)}`);
  }
  return lines.join('\n') + '\n';
}

function connectPlan(name: string, c: McpServerConfig): McpConnectStepDto[] {
  const claude = toClaude(c);
  const steps: McpConnectStepDto[] = [{ cli: 'claude', command: `claude mcp add-json -s user ${sh(name)} ${sh(JSON.stringify(claude))}`, file: '~/.claude.json (mcpServers)', snippet: JSON.stringify({ mcpServers: { [name]: claude } }, null, 2) }];
  let codexCmd: string | undefined;
  if (c.command) {
    const envs = Object.entries(c.env ?? {})
      .filter(([, v]) => !v.includes('${'))
      .map(([k, v]) => `--env ${sh(`${k}=${v}`)}`);
    codexCmd = ['codex mcp add', sh(name), ...envs, '--', sh(c.command), ...(c.args ?? []).map(sh)].join(' ');
  } else if (c.url) codexCmd = ['codex mcp add', sh(name), '--url', sh(c.url)].join(' ');
  steps.push({ cli: 'codex', command: codexCmd, file: '~/.codex/config.toml', snippet: toCodexToml(name, c) });
  const oc = c.url ? { type: 'remote', url: c.url, ...(c.headers ? { headers: c.headers } : {}), enabled: true } : { type: 'local', command: [c.command, ...(c.args ?? [])], ...(c.env ? { environment: c.env } : {}), enabled: true };
  steps.push({ cli: 'opencode', file: '~/.config/opencode/opencode.json (mcp)', snippet: JSON.stringify({ mcp: { [name]: oc } }, null, 2), note: 'OpenCode exposes the tools as <server>_<tool>.' });
  const gem = c.url ? { httpUrl: c.url, ...(c.headers ? { headers: c.headers } : {}) } : { command: c.command, args: c.args ?? [], ...(c.env ? { env: c.env } : {}) };
  const gemCmd = c.command
    ? ['gemini mcp add -s user', ...Object.entries(c.env ?? {}).map(([k, v]) => `-e ${sh(`${k}=${v}`)}`), sh(name), sh(c.command), ...(c.args ?? []).map(sh)].join(' ')
    : ['gemini mcp add -s user -t', c.type === 'sse' ? 'sse' : 'http', ...Object.entries(c.headers ?? {}).map(([k, v]) => `-H ${sh(`${k}: ${v}`)}`), sh(name), sh(c.url ?? '')].join(' ');
  steps.push({ cli: 'gemini', command: gemCmd, file: '~/.gemini/settings.json (mcpServers)', snippet: JSON.stringify({ mcpServers: { [name]: gem } }, null, 2), note: 'Gemini turns off every MCP server in a folder it does not trust. Trust the folder or set GEMINI_CLI_TRUST_WORKSPACE=true.' });
  return steps.map((s) => (`${s.command ?? ''}\n${s.snippet}`.includes('${secret:') ? { ...s, note: s.note ? `${s.note} ${SECRET_NOTE}` : SECRET_NOTE } : s));
}

function fromClaudeLike(map: Record<string, Record<string, unknown>> | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, v] of Object.entries(map ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const url = (v.url ?? v.httpUrl ?? v.serverUrl) as string | undefined;
    if (url) out[name] = { type: v.type === 'sse' ? 'sse' : 'http', url, ...(v.headers ? { headers: v.headers as Record<string, string> } : {}) };
    else if (typeof v.command === 'string') out[name] = { command: v.command, ...(Array.isArray(v.args) ? { args: v.args as string[] } : {}), ...(v.env ? { env: v.env as Record<string, string> } : {}) };
  }
  return out;
}

function parseJsonText(text: string): Record<string, unknown> {
  const j = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as unknown;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('expected a JSON object');
  return j as Record<string, unknown>;
}

/** Enough TOML for [mcp_servers.x] tables with strings, string arrays and env subtables. */
function parseCodexToml(text: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  let cur: { name: string; sub?: string } | null = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const head = /^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.([a-z_]+))?\]$/.exec(line);
    if (head) {
      cur = { name: head[1], sub: head[2] };
      out[head[1]] ??= {};
      return;
    }
    if (line.startsWith('[')) {
      cur = null;
      return;
    }
    if (!cur) return;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`line ${i + 1}: expected key = value`);
    let value: unknown;
    try {
      value = JSON.parse(kv[2].replace(/'/g, '"'));
    } catch {
      throw new Error(`line ${i + 1}: cannot read the value of ${kv[1]}`);
    }
    const c = out[(cur as { name: string }).name];
    const sub = (cur as { sub?: string }).sub;
    if (sub === 'env') c.env = { ...c.env, [kv[1]]: String(value) };
    else if (sub === 'http_headers') c.headers = { ...c.headers, [kv[1]]: String(value) };
    else if (kv[1] === 'command') c.command = String(value);
    else if (kv[1] === 'args') c.args = (value as unknown[]).map(String);
    else if (kv[1] === 'url') {
      c.url = String(value);
      c.type = 'http';
    } else if (kv[1] === 'bearer_token_env_var') c.headers = { ...c.headers, Authorization: `Bearer \${env:${String(value)}}` };
  });
  if (!Object.keys(out).length) throw new Error('no [mcp_servers.<name>] tables found');
  return out;
}

function importServers(from: McpImportFormat, text: string): Record<string, McpServerConfig> {
  if (from === 'codex') return parseCodexToml(text);
  const j = parseJsonText(text);
  if (from === 'opencode') {
    const out: Record<string, McpServerConfig> = {};
    for (const [name, v] of Object.entries((j.mcp ?? j) as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== 'object') continue;
      if (v.type === 'remote' && typeof v.url === 'string') out[name] = { type: 'http', url: v.url, ...(v.headers ? { headers: v.headers as Record<string, string> } : {}) };
      else if (Array.isArray(v.command)) {
        const [command, ...args] = v.command as string[];
        out[name] = { command, ...(args.length ? { args } : {}), ...(v.environment ? { env: v.environment as Record<string, string> } : {}), ...(v.enabled === false ? { enabled: false } : {}) };
      }
    }
    return out;
  }
  return fromClaudeLike((j.mcpServers ?? j) as Record<string, Record<string, unknown>>);
}

