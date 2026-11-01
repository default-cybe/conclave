/**
 * Mock routes. Extensions catalog: overview, inventory, sources, tools and the
 * permission check, skills, commands, sync to CLIs.
 *
 * The world: hub madx runs as root (home /root). Claude Code, Codex and
 * OpenCode are installed on it, Gemini CLI is not. Plugins hookify,
 * superpowers, ralph-loop and security-review add skills and commands. A
 * project folder whose path contains "conclave" has its own .claude/ and
 * .conclave/ files and is not trusted yet.
 *
 * MCP status, hooks, plugins and project trust belong to other mock modules;
 * this one reads them through mockFetch at request time so every tab agrees.
 */
import type {
  CliName,
  ExtensionProblem,
  ExtensionSourceId,
  ExtensionSourceInfo,
  ExtensionsOverview,
  HookGroupDto,
  PluginDetailDto,
  HooksOverview,
  InventoryItemDto,
  McpStatus,
  ProjectTrustInfo,
  ToolCheckResult,
  ToolDetail,
  ToolPermissionInfo,
} from '@conclave/core/client';
import type { AgentDef, CommandDef, InstalledPlugin, SkillDef } from '@conclave/core/extensions/types';
import type { HookEvent, HooksConfig } from '@conclave/core/config/schema';
import type { PermissionMode } from '@conclave/core/types';
import * as D from './data';
import type { MockCtx } from './index';
import { mockMcpToolList } from './ext-runtime';

const HOME = '/root';
const CH = `${HOME}/.conclave`;
const CLAUDE_SETTINGS = `${HOME}/.claude/settings.json`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type BuiltinTool = { name: string; description: string; readOnly: boolean; group: string; optIn?: boolean };

const BUILTIN: BuiltinTool[] = [
  { name: 'Read', group: 'file', readOnly: true, description: 'Read a file from the session device. Returns numbered lines; images and PDFs come back as attachments.' },
  { name: 'Write', group: 'file', readOnly: false, description: 'Write a whole file, creating folders as needed. Read the file first when it already exists.' },
  { name: 'Edit', group: 'file', readOnly: false, description: 'Replace one exact string in a file. Fails when the string is missing or not unique.' },
  { name: 'MultiEdit', group: 'file', readOnly: false, description: 'Several exact replacements in one file, applied in order as one change.' },
  { name: 'Glob', group: 'file', readOnly: true, description: 'Find files by glob pattern, newest first.' },
  { name: 'Grep', group: 'file', readOnly: true, description: 'Search file contents with ripgrep. Supports regex, globs and context lines.' },
  { name: 'LS', group: 'file', readOnly: true, description: 'List a folder, with sizes and types.' },
  { name: 'NotebookEdit', group: 'file', readOnly: false, description: 'Replace, insert or delete one cell in a Jupyter notebook.' },
  { name: 'ReadToolOutput', group: 'file', readOnly: true, description: 'Read the full output of an earlier tool call that was cut short in the transcript.' },
  { name: 'RepoMap', group: 'file', readOnly: true, description: 'A compact map of a repository: folders, files and their top-level symbols.' },
  { name: 'Bash', group: 'shell', readOnly: false, description: 'Run a shell command on the session device. Long commands can run in the background.' },
  { name: 'BashOutput', group: 'shell', readOnly: true, description: 'Read new output from a background shell.' },
  { name: 'KillShell', group: 'shell', readOnly: true, description: 'Stop a background shell.' },
  { name: 'WebFetch', group: 'web', readOnly: true, description: 'Fetch a URL and return it as markdown. Follows redirects on the same host.' },
  { name: 'WebSearch', group: 'web', readOnly: true, description: 'Search the web and return titles, links and snippets.' },
  { name: 'Task', group: 'agents', readOnly: true, description: 'Launch a subagent to handle a task on its own, with its own context window and tools.' },
  { name: 'TodoWrite', group: 'agents', readOnly: true, description: 'Keep the todo list for multi-step work. Shown to the owner as the plan.' },
  { name: 'AskUserQuestion', group: 'agents', readOnly: true, description: 'Ask the owner to choose between options. The turn waits for the answer.' },
  { name: 'EnterPlanMode', group: 'agents', readOnly: true, description: 'Switch to plan mode: read and think, change nothing.' },
  { name: 'ExitPlanMode', group: 'agents', readOnly: false, description: 'Present the plan for approval and leave plan mode.' },
  { name: 'Skill', group: 'agents', readOnly: true, description: 'Load a skill by name. Its instructions join the context.' },
  { name: 'Consult', group: 'agents', readOnly: true, description: 'Ask another model for a second opinion on a question or a diff.' },
  { name: 'MemorySearch', group: 'memory', readOnly: true, description: 'Search memory for facts about the owner, their machines and past work.' },
  { name: 'MemorySave', group: 'memory', readOnly: false, description: 'Save a fact, procedure or profile note to memory.' },
  { name: 'MemoryForget', group: 'memory', readOnly: false, description: 'Remove a memory that is wrong or out of date.' },
  { name: 'Notify', group: 'other', readOnly: true, description: 'Send the owner a push notification.' },
  { name: 'ScheduleRoutine', group: 'other', readOnly: false, description: 'Create or change a routine that runs on a schedule.' },
  { name: 'browser_navigate', group: 'browser', readOnly: false, optIn: true, description: 'Open a URL in the hub browser.' },
  { name: 'browser_snapshot', group: 'browser', readOnly: true, optIn: true, description: 'Read the page as an accessibility tree with element refs.' },
  { name: 'browser_click', group: 'browser', readOnly: false, optIn: true, description: 'Click an element by its ref from the last snapshot.' },
  { name: 'browser_type', group: 'browser', readOnly: false, optIn: true, description: 'Type text into a field.' },
  { name: 'browser_screenshot', group: 'browser', readOnly: true, optIn: true, description: 'Take a screenshot of the page.' },
];

const MCP_TOOLS: Record<string, Array<[string, string]>> = {
  github: [
    ['add_issue_comment', 'Add a comment to an issue'],
    ['add_pull_request_review_comment', 'Comment on a line in a pull request'],
    ['create_branch', 'Create a branch from another branch'],
    ['create_issue', 'Open a new issue in a repository'],
    ['create_or_update_file', 'Create or update one file in a repository'],
    ['create_pull_request', 'Open a pull request'],
    ['create_pull_request_review', 'Submit a review on a pull request'],
    ['create_repository', 'Create a repository in your account'],
    ['delete_file', 'Delete a file from a repository'],
    ['fork_repository', 'Fork a repository to your account'],
    ['get_code_scanning_alert', 'Get one code scanning alert'],
    ['get_commit', 'Get a commit with its diff'],
    ['get_file_contents', 'Get a file or folder from a repository'],
    ['get_issue', 'Get an issue with its labels and state'],
    ['get_issue_comments', 'Get the comments on an issue'],
    ['get_latest_release', 'Get the latest release of a repository'],
    ['get_me', 'Get the signed in user'],
    ['get_pull_request', 'Get a pull request'],
    ['get_pull_request_comments', 'Get review comments on a pull request'],
    ['get_pull_request_files', 'List the files changed in a pull request'],
    ['get_pull_request_reviews', 'Get the reviews of a pull request'],
    ['get_pull_request_status', 'Get the combined check status of a pull request'],
    ['list_branches', 'List branches'],
    ['list_code_scanning_alerts', 'List code scanning alerts'],
    ['list_commits', 'List commits on a branch'],
    ['list_issues', 'List issues with filters'],
    ['list_notifications', 'List your notifications'],
    ['list_pull_requests', 'List pull requests with filters'],
    ['list_releases', 'List releases'],
    ['list_tags', 'List tags'],
    ['merge_pull_request', 'Merge a pull request'],
    ['push_files', 'Push several files in one commit'],
    ['request_copilot_review', 'Ask Copilot to review a pull request'],
    ['search_code', 'Search code across GitHub'],
    ['search_issues', 'Search issues'],
    ['search_pull_requests', 'Search pull requests'],
    ['search_repositories', 'Search repositories'],
    ['search_users', 'Search users'],
    ['update_issue', 'Edit an issue: title, body, labels, state'],
    ['update_pull_request', 'Edit a pull request'],
    ['update_pull_request_branch', 'Update a pull request branch from its base'],
  ],
  proxmox: [
    ['list_nodes', 'List the nodes in the cluster'],
    ['node_status', 'CPU, memory and uptime of a node'],
    ['list_guests', 'List VMs and LXC containers with their state'],
    ['guest_status', 'State and resource use of one guest'],
    ['start_guest', 'Start a VM or container'],
    ['stop_guest', 'Stop a VM or container'],
    ['reboot_guest', 'Reboot a VM or container'],
    ['snapshot', 'Snapshot a guest'],
    ['list_snapshots', 'List the snapshots of a guest'],
    ['rollback_snapshot', 'Roll a guest back to a snapshot'],
    ['list_storage', 'List storage pools and their use'],
    ['backup_guest', 'Start a backup of a guest to PBS'],
  ],
  'basic-memory': [
    ['write_note', 'Create or replace a note in the knowledge base'],
    ['read_note', 'Read a note by title or permalink'],
    ['search_notes', 'Full text search across notes'],
    ['recent_activity', 'Notes changed recently'],
    ['build_context', 'Follow links from a note to build context'],
    ['edit_note', 'Append, prepend or replace a section of a note'],
    ['delete_note', 'Delete a note'],
    ['list_directory', 'List folders and notes'],
  ],
};

const isReadOnlyMcp = (tool: string) => /^(get|list|search|read|recent|build)_/.test(tool) || tool === 'guest_status' || tool === 'node_status';
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const UNTRUSTED_DENY = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'MemorySave', 'MemoryForget', 'ScheduleRoutine'];

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|vd)/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+0?777\s+\/(\s|$)/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  />\s*\/dev\/(sd|nvme|hd|vd)[a-z]/,
  /\bgit\s+push\s+.*--force\b.*\b(main|master)\b/,
];

// ---------------------------------------------------------------------------
// Skills and commands on disk
// ---------------------------------------------------------------------------

interface Entry<T> {
  def: T;
  scope: string;
  /** Present only when a project folder whose path contains this word is picked. */
  project?: boolean;
  /** compat key that must be on. */
  compat?: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'shared';
  /** Markdown file on disk, frontmatter included. */
  file: string;
}

const pluginDir = (p: string) => `${CH}/plugins/${p}`;

function skill(name: string, description: string, source: ExtensionSourceId, dir: string, body: string, extra: Partial<SkillDef> = {}): { def: SkillDef; file: string } {
  const fm = [`name: ${name.split(':').pop()}`, `description: ${description}`];
  if (extra.allowedTools?.length) fm.push(`allowed-tools: ${extra.allowedTools.join(', ')}`);
  return { def: { name, description, dir, path: `${dir}/SKILL.md`, source, ...extra }, file: `---\n${fm.join('\n')}\n---\n\n${body}\n` };
}

function skillEntries(cwd: string | undefined): Array<Entry<SkillDef>> {
  const p = cwd ?? '';
  const sp = (name: string) => `${pluginDir('superpowers')}/skills/${name}`;
  const list: Array<Entry<SkillDef> & { plugin?: string }> = [];
  const add = (s: { def: SkillDef; file: string }, scope: string, more: Partial<Entry<SkillDef>> = {}) => list.push({ def: s.def, file: s.file, scope, ...more });

  add(
    skill(
      'superpowers:brainstorming',
      'Use before any creative work: new features, components or changes in behavior. Turns a rough idea into a design through questions, one at a time.',
      'plugin',
      sp('brainstorming'),
      `# Brainstorming ideas into designs\n\nHelp turn an idea into a design and a spec through natural back and forth.\n\n## The process\n\n1. **Understand the context.** Read the relevant files, docs and recent commits first.\n2. **Ask questions one at a time.** Prefer multiple choice. Only one question per message.\n3. **Explore two or three approaches** with their trade-offs, and say which one you would pick and why.\n4. **Present the design in sections** of 200 to 300 words and check after each one.\n\n## After the design\n\n- Write it to \`docs/plans/YYYY-MM-DD-<topic>-design.md\`.\n- Commit the design document.\n- Ask whether to set up a worktree and write the implementation plan.\n\n## Key principles\n\n- One question at a time\n- YAGNI: remove features the user did not ask for\n- Be flexible: go back and clarify when something does not fit`,
      { plugin: 'superpowers' },
    ),
    'plugins',
  );
  add(
    skill(
      'superpowers:test-driven-development',
      'Use when implementing any feature or bugfix, before writing the code. Write the test first, watch it fail, then write the least code that passes.',
      'plugin',
      sp('test-driven-development'),
      `# Test-driven development\n\nWrite the test first. Watch it fail. Write the least code to pass.\n\n## Red, green, refactor\n\n1. **Red.** Write one failing test that shows the behavior you want.\n2. **Verify red.** Run it and read the failure. It must fail for the reason you expect.\n3. **Green.** Write the simplest code that makes it pass.\n4. **Verify green.** Run the whole suite, not only the new test.\n5. **Refactor.** Clean up with the tests still passing.\n\n## When you are tempted to skip it\n\n| Excuse | Reality |\n| --- | --- |\n| Too simple to test | Simple code breaks too. The test takes 30 seconds. |\n| I will test after | Tests written after pass at once and prove nothing. |\n| Already tested by hand | Manual checks are not repeatable. |`,
      { plugin: 'superpowers' },
    ),
    'plugins',
  );
  add(
    skill(
      'superpowers:systematic-debugging',
      'Use when you hit a bug, a failing test or odd behavior, before proposing a fix. Find the root cause in four phases.',
      'plugin',
      sp('systematic-debugging'),
      `# Systematic debugging\n\nNo fixes without a root cause first.\n\n## Phase 1: investigate\n\n- Read the error message and the stack trace completely.\n- Reproduce it reliably.\n- Check recent changes: \`git log -10 --stat\`.\n\n## Phase 2: compare\n\nFind working code that is similar and list every difference.\n\n## Phase 3: one hypothesis\n\nState it, make the smallest change that tests it, and run it.\n\n## Phase 4: fix\n\nWrite a failing test, fix the cause, verify. After three failed fixes, stop and question the design.`,
      { plugin: 'superpowers' },
    ),
    'plugins',
  );
  add(
    skill('superpowers:writing-plans', 'Use when you have a spec or requirements for a multi-step task, before touching code.', 'plugin', sp('writing-plans'), `# Writing plans\n\nWrite a plan that a skilled engineer with no context could follow.\n\n- Exact file paths\n- Complete code in the plan, not "add validation"\n- Exact commands with the expected output\n- Small tasks of two to five minutes each\n\nSave it to \`docs/plans/YYYY-MM-DD-<feature>.md\`.`, { plugin: 'superpowers' }),
    'plugins',
  );
  add(
    skill('superpowers:verification-before-completion', 'Use before saying work is done, fixed or passing. Run the check and read its output first.', 'plugin', sp('verification-before-completion'), `# Verification before completion\n\nEvidence before claims.\n\n1. Name the command that proves the claim.\n2. Run it, fresh and complete.\n3. Read the full output and the exit code.\n4. Only then say what it shows.`, { plugin: 'superpowers' }),
    'plugins',
  );
  add(
    skill('hookify:writing-rules', 'Use when writing hookify rules: the rule file format, event types, patterns and examples.', 'plugin', `${pluginDir('hookify')}/skills/writing-rules`, `# Writing hookify rules\n\nRules live in \`.claude/hookify.<name>.local.md\` with YAML frontmatter.\n\n\`\`\`markdown\n---\nname: block-force-push\nenabled: true\nevent: bash\npattern: git push .*--force\naction: block\n---\n\nForce pushing is blocked here. Push a new branch instead.\n\`\`\`\n\n## Events\n\n- \`bash\`: before a Bash command\n- \`file\`: before Edit, Write or MultiEdit\n- \`stop\`: when the agent wants to finish\n- \`prompt\`: when you send a message\n\n## Actions\n\n\`warn\` shows the message and lets the call run. \`block\` stops it.`, { plugin: 'hookify', allowedTools: ['Read', 'Write', 'Edit'] }),
    'plugins',
  );
  add(
    skill('security-review:security-review', 'Review a diff for vulnerabilities: injection, auth, secrets, unsafe deserialization. Reports findings with file and line.', 'plugin', `${pluginDir('security-review')}/skills/security-review`, `# Security review\n\nReview the pending changes on this branch for security problems.\n\n## Scope\n\n- Injection: SQL, shell, path traversal, template injection\n- Auth and session handling\n- Secrets in code or logs\n- Unsafe deserialization and SSRF\n\n## Report\n\nList findings most severe first. For each: file and line, what an attacker can do, and the fix. Skip style issues.`, { plugin: 'security-review', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)'] }),
    'plugins',
  );

  // user (~/.conclave/skills)
  add(skill('proxmox-ops', 'Safe Proxmox procedures: snapshot before changes, pct and qm cheat sheet, how to roll back.', 'user', `${CH}/skills/proxmox-ops`, `# Proxmox operations\n\nThe cluster is a single node, \`pve\`, running Proxmox VE 9. Backups go to PBS on \`madx\`.\n\n## Before any change\n\n1. Snapshot the guest: \`pct snapshot <id> pre-change\` or \`qm snapshot <id> pre-change\`.\n2. Say what you will run and wait for a yes.\n\n## Cheat sheet\n\n| Task | Container | VM |\n| --- | --- | --- |\n| List | \`pct list\` | \`qm list\` |\n| Start | \`pct start <id>\` | \`qm start <id>\` |\n| Shell | \`pct enter <id>\` | \`qm terminal <id>\` |\n| Roll back | \`pct rollback <id> <snap>\` | \`qm rollback <id> <snap>\` |\n\n## Never\n\n- \`pct destroy\` or \`qm destroy\` without a fresh backup\n- Changing \`/etc/pve/storage.cfg\` by hand`, { allowedTools: ['Bash(pct:*)', 'Bash(qm:*)', 'Read', 'mcp__proxmox__snapshot'] }), 'user');
  add(skill('ctf-recon', 'Recon checklist for pwn and web challenges: checksec, file, strings, open ports, directories.', 'user', `${CH}/skills/ctf-recon`, `# CTF recon\n\nRun these on \`kali-vm\` only.\n\n## Binaries\n\n- \`file ./chal\` and \`checksec --file=./chal\`\n- \`strings -n 8 ./chal | head -50\`\n- Look for \`gets\`, \`strcpy\` and format strings\n\n## Web\n\n- \`nmap -sV -p- <host>\`\n- \`ffuf -w common.txt -u http://<host>/FUZZ\`\n- Read \`robots.txt\` and the page source`), 'user');
  add(skill('writing-style', 'Plain short sentences. No filler, no marketing words.', 'user', `${CH}/skills/writing-style`, `# Writing style\n\n- Short plain sentences.\n- Say what changed and what to do next.\n- No filler words and no marketing words.\n- Real names in code format: \`PreToolUse\`, \`mcp__github__create_issue\`.`), 'user');

  // Claude Code (~/.claude/skills)
  add(skill('pdf', 'Read, fill and merge PDF files with pypdf and qpdf.', 'claude', `${HOME}/.claude/skills/pdf`, `# PDF\n\n## Read text\n\n\`\`\`python\nfrom pypdf import PdfReader\nreader = PdfReader("file.pdf")\nprint("\\n".join(p.extract_text() for p in reader.pages))\n\`\`\`\n\n## Merge\n\n\`qpdf --empty --pages a.pdf b.pdf -- out.pdf\`\n\n## Fill a form\n\nList the fields with \`reader.get_fields()\` first, then write them with \`PdfWriter.update_page_form_field_values\`.`, { allowedTools: ['Bash(python3:*)', 'Bash(qpdf:*)', 'Read', 'Write'] }), 'claude user', { compat: 'claudeCode' });
  add(skill('writing-style', 'Write like me: short, direct, no fluff.', 'claude', `${HOME}/.claude/skills/writing-style`, `# Writing style\n\nShort and direct. No fluff.`), 'claude user', { compat: 'claudeCode' });

  // shared ~/.agents (a copy Sync wrote earlier)
  add(skill('proxmox-ops', 'Safe Proxmox procedures: snapshot before changes, pct and qm cheat sheet, how to roll back.', 'agents', `${HOME}/.agents/skills/proxmox-ops`, `# Proxmox operations\n\n(A copy written by Conclave sync.)`), '~/.agents', { compat: 'shared' });

  // Codex and OpenCode
  add(skill('homelab-runbook', 'Runbooks for madx and pve: restart services, read logs, check backups.', 'codex', `${HOME}/.codex/skills/homelab-runbook`, `# Homelab runbook\n\n## madx\n\n- Conclave: \`systemctl status conclave\`, logs with \`journalctl -u conclave -n 100\`\n- Caddy: \`systemctl reload caddy\` after editing \`/etc/caddy/Caddyfile\`\n\n## pve\n\n- Backups: \`proxmox-backup-client list --repository madx:store1\``), 'codex user', { compat: 'codex' });
  add(skill('arch-wiki', 'Look up the Arch Wiki before changing system config on arch-desktop.', 'opencode', `${HOME}/.config/opencode/skills/arch-wiki`, `# Arch Wiki first\n\nBefore editing anything under \`/etc\` on arch-desktop, read the matching Arch Wiki page and quote the section you rely on.`), 'opencode user', { compat: 'opencode' });

  // project
  if (p) {
    add(skill('ui-review', 'Check a screen against docs/design/SPEC.md: no pills, no gradients, words for state.', 'claude', `${p}/.claude/skills/ui-review`, `# UI review\n\nOpen \`docs/design/SPEC.md\` and check the screen against section 2, the banned patterns.\n\n- No pills or chips\n- No gradients\n- State is a word in a fixed place\n- Mono only for code and paths`, { allowedTools: ['Read', 'Grep', 'Glob'] }), 'claude project', { project: true, compat: 'claudeCode' });
    add(skill('release', 'Cut a release: bump versions, update the changelog, tag and push.', 'project', `${p}/.conclave/skills/release`, `# Release\n\n1. \`bun run typecheck\` and \`bun test\` must pass.\n2. Bump the version in every \`package.json\`.\n3. Add the changes to \`CHANGELOG.md\`.\n4. Tag \`vX.Y.Z\` and push the tag. Ask before pushing.`, { allowedTools: ['Read', 'Edit', 'Bash(bun:*)', 'Bash(git tag:*)'] }), 'project', { project: true });
  }
  return list;
}

function cmd(name: string, source: ExtensionSourceId, path: string, body: string, extra: Partial<CommandDef> = {}): { def: CommandDef; file: string } {
  const fm: string[] = [];
  if (extra.description) fm.push(`description: ${extra.description}`);
  if (extra.argumentHint) fm.push(`argument-hint: ${extra.argumentHint}`);
  if (extra.allowedTools?.length) fm.push(`allowed-tools: ${extra.allowedTools.join(', ')}`);
  if (extra.model) fm.push(`model: ${extra.model}`);
  return { def: { name, body, source, path, ...extra }, file: fm.length ? `---\n${fm.join('\n')}\n---\n\n${body}\n` : `${body}\n` };
}

function commandEntries(cwd: string | undefined): Array<Entry<CommandDef>> {
  const list: Array<Entry<CommandDef>> = [];
  const add = (c: { def: CommandDef; file: string }, scope: string, more: Partial<Entry<CommandDef>> = {}) => list.push({ def: c.def, file: c.file, scope, ...more });
  const pc = (plugin: string, name: string) => `${pluginDir(plugin)}/commands/${name}.md`;

  // Codex prompts and OpenCode commands (low precedence)
  // the hub names Codex custom prompts prompts:<file>, as Codex does (/prompts:deploy)
  add(cmd('prompts:deploy', 'codex', `${HOME}/.codex/prompts/deploy.md`, 'Deploy $1 to $2.\n\n1. Pull the latest image for $1.\n2. Restart it with `docker compose up -d` on $2.\n3. Check the health endpoint and the last 50 log lines.\n\nNotes from me: $ARGUMENTS', { description: 'Deploy a service to a host and check it came up', argumentHint: 'SERVICE HOST', argStyle: 'numbered' }), 'codex user', { compat: 'codex' });
  add(cmd('test', 'opencode', `${HOME}/.config/opencode/command/test.md`, 'Run the tests in packages/$1 with `bun test`. Focus on: $2\n\nFix failures one at a time and run the suite again after each fix.', { description: 'Run the tests for a package and fix what fails', argumentHint: '<package> [focus]', argStyle: 'opencode' }), 'opencode user', { compat: 'opencode' });

  // Claude Code user commands
  add(cmd('commit', 'claude', `${HOME}/.claude/commands/commit.md`, 'Commit the staged changes with a short message. $ARGUMENTS', { description: 'Commit staged changes' }), 'claude user', { compat: 'claudeCode' });
  add(cmd('explain', 'claude', `${HOME}/.claude/commands/explain.md`, 'Explain $ARGUMENTS as if I am new to this codebase. Start with what it is for, then how it works.\n\nRead @README.md first if it helps.', { description: 'Explain a file or symbol like I am new here', argumentHint: '<path|symbol>' }), 'claude user', { compat: 'claudeCode' });

  // plugins
  add(cmd('hookify:hookify', 'plugin', pc('hookify', 'hookify'), 'Help the user create hookify rules for unwanted behavior.\n\nIf the user named a behavior, write a rule for it: $ARGUMENTS\n\nOtherwise read the conversation and suggest rules for things the user corrected.', { description: 'Create hooks to prevent unwanted behaviors from this conversation or your instructions', argumentHint: 'Optional specific behavior to address', plugin: 'hookify', allowedTools: ['Read', 'Write', 'AskUserQuestion'] }), 'plugins');
  add(cmd('hookify:list', 'plugin', pc('hookify', 'list'), 'List every hookify rule in .claude/ with its event, pattern, action and whether it is on.\n\n!`ls .claude/hookify.*.local.md 2>/dev/null`', { description: 'List all configured hookify rules', plugin: 'hookify' }), 'plugins');
  add(cmd('hookify:configure', 'plugin', pc('hookify', 'configure'), 'Show the hookify rules and ask which to turn on or off. Edit the enabled field in each file.', { description: 'Turn hookify rules on or off', plugin: 'hookify' }), 'plugins');
  add(cmd('hookify:help', 'plugin', pc('hookify', 'help'), 'Explain how hookify works: rule files, events, patterns, warn and block. Show one example rule.', { description: 'Get help with the hookify plugin', plugin: 'hookify' }), 'plugins');
  add(cmd('ralph-loop:ralph-loop', 'plugin', pc('ralph-loop', 'ralph-loop'), '!`"${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" $ARGUMENTS`\n\nWork on the task above. When you try to stop, the same prompt comes back until the completion promise is true.', { description: 'Start a Ralph loop in this session', argumentHint: 'PROMPT [--max-iterations N] [--completion-promise TEXT]', plugin: 'ralph-loop' }), 'plugins');
  add(cmd('ralph-loop:cancel-ralph', 'plugin', pc('ralph-loop', 'cancel-ralph'), '!`rm -f .claude/ralph-loop.local.md && echo cancelled`\n\nTell the user the loop is cancelled.', { description: 'Cancel the active Ralph loop', plugin: 'ralph-loop' }), 'plugins');
  add(cmd('ralph-loop:help', 'plugin', pc('ralph-loop', 'help'), 'Explain the Ralph technique: one prompt, repeated until the work is done, with a completion promise to stop.', { description: 'Explain the Ralph technique and its commands', plugin: 'ralph-loop' }), 'plugins');
  add(cmd('superpowers:brainstorm', 'plugin', pc('superpowers', 'brainstorm'), 'Use the superpowers:brainstorming skill and follow it exactly. Topic: $ARGUMENTS', { description: 'Refine a rough idea into a design through questions', plugin: 'superpowers' }), 'plugins');
  add(cmd('superpowers:write-plan', 'plugin', pc('superpowers', 'write-plan'), 'Use the superpowers:writing-plans skill and follow it exactly.', { description: 'Write a detailed plan with small tasks', plugin: 'superpowers' }), 'plugins');
  add(cmd('superpowers:execute-plan', 'plugin', pc('superpowers', 'execute-plan'), 'Run the plan in batches of three tasks. Stop for review after each batch.', { description: 'Run a plan in batches with review stops', plugin: 'superpowers' }), 'plugins');
  add(cmd('security-review:security-review', 'plugin', pc('security-review', 'security-review'), 'Review the pending changes for vulnerabilities.\n\nGIT STATUS:\n\n!`git status`\n\nDIFF:\n\n!`git diff --merge-base origin/HEAD`\n\nReport findings most severe first with file and line.', { description: 'Review pending changes for vulnerabilities', plugin: 'security-review', allowedTools: ['Bash(git diff:*)', 'Bash(git status:*)', 'Read', 'Grep'] }), 'plugins');

  // user (~/.conclave/commands)
  add(cmd('commit', 'user', `${CH}/commands/commit.md`, 'Staged changes:\n\n!`git diff --staged`\n\nRecent commits, for the style:\n\n!`git log -5 --oneline`\n\nWrite one conventional commit message for these changes and commit them. $ARGUMENTS', { description: 'Write a conventional commit for the staged diff', allowedTools: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git commit:*)'] }), 'user');
  add(cmd('pr', 'user', `${CH}/commands/pr.md`, 'Open a pull request from this branch into $0.\n\nCommits on this branch:\n\n!`git log --oneline origin/main..HEAD`\n\nWrite a title, a short summary and a test plan, then open it with mcp__github__create_pull_request.', { description: 'Open a pull request with a summary', argumentHint: '[base]' }), 'user');
  add(cmd('writeup', 'user', `${CH}/commands/writeup.md`, 'Draft a CTF writeup for $0 from this session: the bug, the exploit and how you got the flag. Keep it short.\n\nExtra notes: $ARGUMENTS', { description: 'Draft a CTF writeup from this session', argumentHint: '<challenge> [notes]' }), 'user');

  if (cwd) {
    add(cmd('fix-issue', 'claude', `${cwd}/.claude/commands/fix-issue.md`, 'Fix GitHub issue #$0. Read it with mcp__github__get_issue, find the cause, write a failing test, then fix it.', { description: 'Fix a GitHub issue with a test first', argumentHint: '<number>' }), 'claude project', { project: true, compat: 'claudeCode' });
    add(cmd('ship', 'project', `${cwd}/.conclave/commands/ship.md`, '!`bun run typecheck`\n\n!`bun test 2>&1 | tail -20`\n\nIf both passed, open a PR titled "$ARGUMENTS". If not, stop and show the failures.', { description: 'Typecheck, test and open a PR for this branch', argumentHint: '<title>' }), 'project', { project: true });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Permission rules from files other than config.json
// ---------------------------------------------------------------------------

interface RuleSrc {
  rule: string;
  list: 'allow' | 'deny' | 'ask';
  source: string;
  active: boolean;
}

const CLAUDE_RULES: Array<Omit<RuleSrc, 'source' | 'active'>> = [
  { rule: 'WebFetch(domain:docs.anthropic.com)', list: 'allow' },
  { rule: 'mcp__basic-memory__search_notes', list: 'allow' },
  { rule: 'mcp__basic-memory__read_note', list: 'allow' },
  { rule: 'mcp__github__merge_pull_request', list: 'ask' },
  { rule: 'mcp__github__delete_file', list: 'deny' },
];

/** Rules in a project's .claude/settings.json, matching the hooks and trust mock. */
function projectRules(cwd: string): Array<Omit<RuleSrc, 'source' | 'active'>> {
  if (/\/code\/conclave\/?$/.test(cwd)) return [{ rule: 'Bash(bun test:*)', list: 'allow' }, { rule: 'Bash(bun run typecheck)', list: 'allow' }, { rule: 'Read(.env)', list: 'deny' }];
  if (/\/code\/scantools\/?$/.test(cwd))
    return [
      { rule: 'Bash(pytest:*)', list: 'allow' },
      { rule: 'Bash(nmap:*)', list: 'allow' },
      { rule: 'WebFetch(domain:nmap.org)', list: 'allow' },
      { rule: 'Bash(nmap -sS:*)', list: 'ask' },
    ];
  return [];
}

const isProject = (cwd: string | undefined) => !!cwd && /conclave/i.test(cwd);

function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Does a Claude Code style rule match this call? Rules with content never match a call without input. */
function ruleMatches(raw: string, tool: string, input: Record<string, unknown>, cwd: string): boolean {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(raw.trim());
  if (!m) return false;
  const [, name, content] = m;
  if (name.startsWith('mcp__') && !name.includes('__', 5)) return tool.startsWith(`${name}__`) && content === undefined;
  if (!globRe(name).test(tool)) return false;
  if (content === undefined) return true;
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return false;
    if (content.endsWith(':*')) return command === content.slice(0, -2) || command.startsWith(`${content.slice(0, -2)} `) || command.startsWith(content.slice(0, -2));
    return globRe(content).test(command);
  }
  if (tool === 'WebFetch' && content.startsWith('domain:')) {
    try {
      return new URL(String(input.url)).hostname === content.slice(7);
    } catch {
      return false;
    }
  }
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '';
  if (!file) return false;
  const abs = file.startsWith('~') ? HOME + file.slice(1) : file.startsWith('/') ? file : `${cwd}/${file}`;
  const pat = content.startsWith('~') ? HOME + content.slice(1) : content.startsWith('/') ? content : `${cwd}/${content.replace(/^\.\//, '')}`;
  return globRe(pat).test(abs);
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Dev switches for checking error and loading states by hand:
 * sessionStorage['conclave.mock.extFail'] = '1' makes these routes fail,
 * sessionStorage['conclave.mock.extSlow'] = '1' makes them take 3 seconds.
 */
function flag(name: string): boolean {
  try {
    return sessionStorage.getItem(name) === '1';
  } catch {
    return false;
  }
}

export function registerExtensionCatalog(ctx: MockCtx) {
  const { db, FRESH } = ctx;
  const on: MockCtx['on'] = (method, path, h) =>
    ctx.on(method, path, async (p) => {
      if (flag('conclave.mock.extSlow')) await ctx.sleep(3000);
      if (flag('conclave.mock.extFail') && !path.startsWith('/api/devices')) ctx.fail(503, 'The hub did not answer in time');
      return h(p);
    });

  // The hub has Claude Code, Codex and OpenCode installed; Gemini CLI is not.
  const hub = db.devices.get('local');
  if (hub?.info) hub.info.clis = { ...hub.info.clis, claude: '2.4.1', codex: '0.98.0', opencode: '1.3.2' };
  // A set up hub reads Codex and OpenCode files too. A first-run hub keeps the defaults.
  if (!FRESH) {
    const cfg = db.config as { compat?: Record<string, boolean> };
    cfg.compat = { claudeCode: true, agentsMd: true, ...cfg.compat, codex: true, opencode: true, gemini: false };
  }

  const compat = () => ({ claudeCode: true, agentsMd: true, codex: false, opencode: false, gemini: false, ...((db.config as { compat?: Record<string, boolean> }).compat ?? {}) });
  const perms = () => {
    const p = (db.config as { permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; mode?: PermissionMode } }).permissions ?? {};
    return { allow: p.allow ?? [], ask: p.ask ?? [], deny: p.deny ?? [], mode: p.mode ?? ('default' as PermissionMode) };
  };

  /** Call a route another mock module serves. Undefined when it does not exist. */
  async function peer<T>(path: string): Promise<T | undefined> {
    try {
      const { mockFetch } = await import('./index');
      const r = await mockFetch(path);
      return r.ok ? ((await r.json()) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async function trustOf(cwd: string): Promise<ProjectTrustInfo> {
    const fromPeer = await peer<ProjectTrustInfo>(`/api/trust?cwd=${encodeURIComponent(cwd)}`);
    if (fromPeer) return fromPeer;
    const proj = isProject(cwd);
    return { cwd, trusted: !proj, hooks: proj ? 2 : 0, allow: proj ? 3 : 0, mcpServers: proj ? 1 : 0, files: proj ? [`${cwd}/.claude/settings.json`, `${cwd}/.mcp.json`] : [] };
  }

  async function pluginsOff(): Promise<Set<string>> {
    const list = (await peer<InstalledPlugin[]>('/api/plugins')) ?? db.plugins;
    return new Set(list.filter((p) => !p.enabled).map((p) => p.name));
  }

  async function mcpList(): Promise<McpStatus[]> {
    if (FRESH) return (await peer<McpStatus[]>('/api/mcp')) ?? [];
    return (await peer<McpStatus[]>('/api/mcp')) ?? D.mcp;
  }

  // ----- inventory ----------------------------------------------------------

  function visible<T>(e: Entry<T>, off: Set<string>, plugin?: string): boolean {
    const c = compat();
    if (e.compat === 'shared' && !(c.codex || c.opencode || c.gemini)) return false;
    if (e.compat && e.compat !== 'shared' && !c[e.compat]) return false;
    if (plugin && off.has(plugin)) return false;
    return true;
  }

  /**
   * Plugin skills and commands. When the plugins mock is there, they are the
   * enabled plugins' own components (so this tab matches the Plugins tab),
   * with the fuller text from this file where the names match.
   */
  async function pluginParts(): Promise<{ skills: Array<Entry<SkillDef>>; commands: Array<Entry<CommandDef>> } | undefined> {
    const list = await peer<InstalledPlugin[]>('/api/plugins');
    if (!list) return undefined;
    const details = await Promise.all(list.filter((p) => p.enabled).map((p) => peer<PluginDetailDto>(`/api/plugins/${encodeURIComponent(p.name)}`)));
    const mineS = new Map(skillEntries(undefined).map((e) => [e.def.name, e]));
    const mineC = new Map(commandEntries(undefined).map((e) => [e.def.name, e]));
    const skills: Array<Entry<SkillDef>> = [];
    const commands: Array<Entry<CommandDef>> = [];
    for (const d of details) {
      if (!d) continue;
      for (const def of d.skills ?? []) {
        const m = mineS.get(def.name);
        const body = m ? m.file.replace(/^---[\s\S]*?---\n\n/, '') : `# ${def.name.split(':').pop()}\n\n${def.description}\n`;
        const s = skill(def.name, def.description, 'plugin', def.dir, body.trimEnd(), { plugin: def.plugin, ...(m?.def.allowedTools ? { allowedTools: m.def.allowedTools } : {}) });
        skills.push({ def: s.def, file: s.file, scope: 'plugins' });
      }
      for (const def of d.commands ?? []) {
        const m = mineC.get(def.name);
        const c = cmd(def.name, 'plugin', def.path ?? `${pluginDir(d.name)}/commands/${def.name.split(':').pop()}.md`, m?.def.body || def.body || `${def.description ?? def.name}.\n\n$ARGUMENTS`, {
          description: def.description,
          ...(def.argumentHint ? { argumentHint: def.argumentHint } : {}),
          plugin: def.plugin,
          ...(m?.def.allowedTools ? { allowedTools: m.def.allowedTools } : {}),
        });
        commands.push({ def: c.def, file: c.file, scope: 'plugins' });
      }
    }
    return { skills, commands };
  }

  async function loaded(cwd: string | undefined) {
    const [off, fromPlugins] = await Promise.all([pluginsOff(), FRESH ? undefined : pluginParts()]);
    if (FRESH) return { skills: [] as Array<Entry<SkillDef>>, commands: [] as Array<Entry<CommandDef>>, off };
    let skills = skillEntries(isProject(cwd) ? cwd : undefined).filter((e) => visible(e, off, e.def.plugin));
    let commands = commandEntries(isProject(cwd) ? cwd : undefined).filter((e) => visible(e, off, e.def.plugin));
    if (fromPlugins) {
      skills = [...skills.filter((e) => e.def.source !== 'plugin'), ...fromPlugins.skills];
      commands = [...commands.filter((e) => e.def.source !== 'plugin'), ...fromPlugins.commands];
    }
    return { skills: byPrecedence(skills), commands: byPrecedence(commands), off };
  }

  /** Low to high, as the hub loads them: ~/.agents, Codex, OpenCode, Gemini, Claude Code user then project, plugins, user, project. */
  function byPrecedence<T extends SkillDef | CommandDef>(list: Array<Entry<T>>): Array<Entry<T>> {
    const rank = (e: Entry<T>) => {
      const r: Record<string, number> = { agents: 1, codex: 2, opencode: 3, gemini: 4, claude: 5, plugin: 6, user: 7, project: 8 };
      return (r[e.def.source] ?? 0) + (e.project && e.def.source !== 'project' ? 0.5 : 0);
    };
    return list.map((e, i) => [e, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
  }

  /** Mark shadowed copies in precedence order (the list is already low to high). */
  function track(items: InventoryItemDto[]): InventoryItemDto[] {
    const last = new Map<string, InventoryItemDto>();
    for (const it of items) {
      const key = `${it.kind}\u0000${it.name}`;
      const prev = last.get(key);
      if (prev) {
        prev.active = false;
        prev.shadowedBy = it.scope;
      }
      last.set(key, it);
    }
    return items;
  }

  function agentItems(cwd: string | undefined, off: Set<string>): InventoryItemDto[] {
    const agents = db.agents as AgentDef[];
    const scopeOf = (a: AgentDef) => (a.source === 'plugin' ? 'plugins' : a.source === 'claude' ? 'claude user' : a.source);
    const order: Record<string, number> = { builtin: 0, agents: 1, codex: 2, opencode: 3, gemini: 4, claude: 5, plugin: 6, user: 7, project: 8 };
    const list: AgentDef[] = [...agents];
    if (!FRESH) {
      // shipped copies that a user or Claude Code file replaces
      list.push({ name: 'researcher', description: 'Web research with sources. Checks facts, versions and prices against primary sources.', prompt: '', source: 'builtin' });
      list.push({ name: 'tutor', description: 'University help: teaches step by step on graded work.', prompt: '', source: 'builtin' });
    }
    return list
      .filter((a) => (a.source === 'project' ? !!cwd : true))
      .filter((a) => (a.source === 'claude' ? compat().claudeCode : true))
      .filter((a) => !(a.source === 'plugin' && a.plugin && off.has(a.plugin)))
      .filter((a) => (FRESH ? a.source === 'builtin' : true))
      .sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9))
      .map((a) => ({
        kind: 'agent' as const,
        name: a.name,
        description: a.description,
        source: a.source,
        ...(a.plugin ? { plugin: a.plugin } : {}),
        ...(a.path ? { path: a.path } : a.source === 'user' ? { path: `${CH}/agents/${a.name}.md` } : a.source === 'project' && cwd ? { path: `${cwd}/.conclave/agents/${a.name}.md` } : {}),
        scope: a.source === 'project' ? 'project' : scopeOf(a),
        active: true,
      }));
  }

  async function inventory(cwd: string | undefined): Promise<InventoryItemDto[]> {
    const { skills, commands, off } = await loaded(cwd);
    const dto = (kind: 'skill' | 'command', e: Entry<SkillDef> | Entry<CommandDef>): InventoryItemDto => ({
      kind,
      name: e.def.name,
      ...(e.def.description ? { description: e.def.description } : {}),
      source: e.def.source,
      ...(e.def.plugin ? { plugin: e.def.plugin } : {}),
      path: e.def.path,
      scope: e.project && e.scope !== 'project' ? `${e.scope}` : e.scope,
      active: true,
    });
    return [...track(agentItems(cwd, off)), ...track(skills.map((e) => dto('skill', e))), ...track(commands.map((e) => dto('command', e)))];
  }

  // ----- tools --------------------------------------------------------------

  function ruleSources(cwd: string | undefined, trusted: boolean): RuleSrc[] {
    const out: RuleSrc[] = [];
    if (compat().claudeCode && !FRESH) for (const r of CLAUDE_RULES) out.push({ ...r, source: CLAUDE_SETTINGS, active: true });
    const p = perms();
    for (const list of ['allow', 'deny', 'ask'] as const) for (const rule of p[list]) out.push({ rule, list, source: 'config', active: true });
    if (cwd) for (const r of projectRules(cwd.replace(/^~(?=\/|$)/, '/home/kai'))) out.push({ ...r, source: `${cwd}/.claude/settings.json`, active: r.list !== 'allow' || trusted });
    return out;
  }

  function decide(tool: BuiltinTool, input: Record<string, unknown>, mode: PermissionMode, rules: RuleSrc[], cwd: string): ToolPermissionInfo & { dangerous: string | false } {
    const active = rules.filter((r) => r.active);
    const hit = (list: RuleSrc['list']) => active.find((r) => r.list === list && ruleMatches(r.rule, tool.name, input, cwd));
    let res: ToolPermissionInfo;
    const deny = hit('deny');
    const ask = hit('ask');
    const allow = hit('allow');
    if (deny) res = { decision: 'deny', reason: `Denied by rule ${deny.rule}`, rule: deny.rule, ruleSource: deny.source };
    else if (mode === 'plan' && !tool.readOnly) res = { decision: 'deny', reason: 'Plan mode is read-only. Present a plan with ExitPlanMode first.', rule: null, ruleSource: null };
    else if (ask) res = { decision: 'ask', reason: `Rule ${ask.rule} requires approval`, rule: ask.rule, ruleSource: ask.source };
    else if (allow) res = { decision: 'allow', reason: `Allowed by rule ${allow.rule}`, rule: allow.rule, ruleSource: allow.source };
    else if (mode === 'bypass') res = { decision: 'allow', reason: 'Bypass mode', rule: null, ruleSource: null };
    else if (tool.readOnly) res = { decision: 'allow', reason: 'Read-only tool', rule: null, ruleSource: null };
    else if (mode === 'acceptEdits' && EDIT_TOOLS.includes(tool.name)) res = { decision: 'allow', reason: 'acceptEdits mode', rule: null, ruleSource: null };
    else res = { decision: 'ask', reason: 'Needs approval', rule: null, ruleSource: null };
    let dangerous: string | false = false;
    if (tool.name === 'Bash' && typeof input.command === 'string' && DANGEROUS.some((re) => re.test(input.command as string))) {
      dangerous = 'Potentially destructive command';
      if (res.decision === 'allow') res = { decision: 'ask', reason: 'Potentially destructive command', rule: null, ruleSource: null };
    }
    if (tool.name === 'ExitPlanMode') res = { decision: 'ask', reason: 'Approve the plan to start working', rule: null, ruleSource: null };
    return { ...res, dangerous };
  }

  function nameMatches(entry: string, tool: string): boolean {
    const base = entry.replace(/\(.*\)$/, '');
    if (base === '*') return true;
    return globRe(base).test(tool);
  }

  function access(t: BuiltinTool, a: AgentDef): { name: string; visible: boolean; why?: string } {
    const server = /^mcp__(.+?)__/.exec(t.name)?.[1];
    if (server && a.mcpServers && !a.mcpServers.includes(server)) return { name: a.name, visible: false, why: 'not in its mcpServers' };
    if (a.untrusted && UNTRUSTED_DENY.includes(t.name)) return { name: a.name, visible: false, why: 'untrusted agent' };
    if (a.disallowedTools?.some((d) => nameMatches(d, t.name))) return { name: a.name, visible: false, why: 'in disallowedTools' };
    if (a.tools?.length && !a.tools.some((x) => nameMatches(x, t.name))) return { name: a.name, visible: false, why: 'not in its tools list' };
    if (t.optIn && !(a.tools ?? []).some((x) => x !== '*' && nameMatches(x, t.name))) return { name: a.name, visible: false, why: 'opt-in tool, name it in the tools list' };
    return { name: a.name, visible: true };
  }

  /** Hook groups that apply, from the hooks mock when it exists, else config.json and two plugin hooks. */
  async function hookGroups(cwd: string | undefined): Promise<Array<{ event: HookEvent; matcher?: string; handlers: number }>> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const fromPeer = await peer<HooksOverview>(`/api/hooks${q}`);
    if (fromPeer?.events) return fromPeer.events.flatMap((e) => e.groups.filter((g: HookGroupDto) => g.active).map((g) => ({ event: e.event, matcher: g.matcher, handlers: g.hooks.length })));
    const out: Array<{ event: HookEvent; matcher?: string; handlers: number }> = [];
    const hooks = ((db.config as { hooks?: HooksConfig }).hooks ?? {}) as HooksConfig;
    for (const [event, groups] of Object.entries(hooks)) for (const g of groups ?? []) out.push({ event: event as HookEvent, matcher: g.matcher, handlers: g.hooks.length });
    if (!FRESH) {
      out.push({ event: 'PreToolUse', handlers: 1 }, { event: 'PostToolUse', handlers: 1 });
      if (compat().claudeCode) out.push({ event: 'PreToolUse', matcher: 'Bash', handlers: 1 });
    }
    return out;
  }

  function hookCounts(groups: Array<{ event: HookEvent; matcher?: string; handlers: number }>, tool: string): Partial<Record<HookEvent, number>> {
    const out: Partial<Record<HookEvent, number>> = {};
    for (const g of groups) {
      if (!['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(g.event)) continue;
      const m = g.matcher?.trim();
      let ok = !m || m === '*';
      if (!ok) {
        try {
          ok = new RegExp(`^(?:${m})$`).test(tool);
        } catch {
          ok = m === tool;
        }
      }
      if (ok) out[g.event] = (out[g.event] ?? 0) + g.handlers;
    }
    return out;
  }

  async function allTools(): Promise<BuiltinTool[]> {
    const status = await mcpList();
    const mcp: BuiltinTool[] = [];
    for (const s of status) {
      if (s.status !== 'connected') continue;
      const listed = mockMcpToolList(s.name);
      if (listed) for (const t of listed) mcp.push({ name: t.fullName, description: t.description ?? '', readOnly: t.readOnly, group: s.name });
      else for (const [tool, description] of MCP_TOOLS[s.name] ?? []) mcp.push({ name: `mcp__${s.name}__${tool}`, description, readOnly: isReadOnlyMcp(tool), group: s.name });
    }
    return [...BUILTIN, ...mcp];
  }

  async function toolsDetail(cwd: string | undefined, agent: string | undefined): Promise<ToolDetail[]> {
    const agents = (db.agents as AgentDef[]).filter((a) => (agent ? a.name === agent : true));
    if (agent && !agents.length) ctx.fail(404, `unknown agent ${agent}`);
    const [trust, groups, tools] = await Promise.all([cwd ? trustOf(cwd) : undefined, hookGroups(cwd), allTools()]);
    const rules = ruleSources(cwd, trust ? trust.trusted : true);
    const mode = agents.length === 1 && agent ? (agents[0].permissionMode ?? perms().mode) : perms().mode;
    return tools.map((t) => {
      const isMcp = t.name.startsWith('mcp__');
      const p = decide(t, {}, mode, rules, cwd ?? HOME);
      return {
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        source: isMcp ? 'mcp' : 'builtin',
        ...(isMcp ? { server: t.group } : {}),
        kind: isMcp ? 'mcp' : 'builtin',
        group: t.group,
        agents: agents.map((a) => access(t, a)),
        permission: { decision: p.decision, reason: p.reason, rule: p.rule ?? null, ruleSource: p.ruleSource ?? null },
        hooks: hookCounts(groups, t.name),
        ...(t.optIn ? { optIn: true } : {}),
      } satisfies ToolDetail;
    });
  }

  // ----- routes -------------------------------------------------------------

  on('GET', '/api/extensions/overview', async ({ query }) => {
    const cwd = query.get('cwd') || undefined;
    const device = query.get('device') || 'local';
    // like the hub: an unknown device is not an error, its CLIs just read as not installed
    const dev = db.devices.get(device);
    const clis = Object.fromEntries((['claude', 'codex', 'opencode', 'gemini'] as CliName[]).map((c) => [c, dev?.info?.clis?.[c] ?? null])) as Record<CliName, string | null>;
    const [status, items, tools, groups, peerPlugins, hooks] = await Promise.all([
      mcpList(),
      inventory(cwd),
      allTools(),
      hookGroups(cwd),
      peer<InstalledPlugin[]>('/api/plugins'),
      peer<HooksOverview>(`/api/hooks${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
    ]);
    const plugins = peerPlugins ?? db.plugins;
    const problems: ExtensionProblem[] = [];
    for (const s of status) if (s.status === 'failed' && s.error) problems.push({ kind: 'mcp', name: s.name, message: s.error });
    if (hooks?.events) {
      for (const e of hooks.events) {
        const bad = new Map<string, { result: string; durationMs: number }>();
        for (const r of e.last ?? []) bad.set(r.label, r);
        for (const [label, r] of bad) {
          if (r.result === 'error') problems.push({ kind: 'hook', event: e.event, name: label.slice(0, 80), message: 'last run failed' });
          if (r.result === 'timeout') problems.push({ kind: 'hook', event: e.event, name: label.slice(0, 80), message: `last run timed out after ${r.durationMs}ms` });
        }
        const n = e.groups.reduce((k, g) => k + g.hooks.length, 0);
        if (!e.fires && n) problems.push({ kind: 'event', event: e.event, message: `${n} ${n === 1 ? 'handler' : 'handlers'} configured, event not fired yet` });
      }
    } else if (!FRESH) {
      problems.push({ kind: 'hook', event: 'PreToolUse', name: 'python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py', message: 'last run timed out after 10000ms' });
    }
    for (const i of items) if (!i.active && i.source !== 'builtin') problems.push({ kind: 'conflict', name: i.name, message: `${i.kind} defined in ${i.scope} is shadowed by ${i.shadowedBy}` });
    let trust: ProjectTrustInfo | undefined;
    if (cwd) {
      trust = await trustOf(cwd);
      if (!trust.trusted && (trust.hooks || trust.allow)) {
        const what = [trust.hooks && `${trust.hooks} ${trust.hooks === 1 ? 'hook' : 'hooks'}`, trust.allow && `${trust.allow} ${trust.allow === 1 ? 'allow rule' : 'allow rules'}`].filter(Boolean).join(' and ');
        problems.push({ kind: 'trust', message: `This folder has ${what} that stay off until you trust it` });
      }
    }
    const mcpTools = tools.filter((t) => t.name.startsWith('mcp__')).length;
    const active = items.filter((i) => i.active);
    const c = compat();
    const out: ExtensionsOverview = {
      counts: {
        tools: tools.length,
        mcpTools,
        agents: active.filter((i) => i.kind === 'agent').length,
        skills: active.filter((i) => i.kind === 'skill').length,
        commands: active.filter((i) => i.kind === 'command').length,
        hookHandlers: groups.reduce((n, g) => n + g.handlers, 0),
        plugins: { installed: plugins.length, enabled: plugins.filter((p) => p.enabled).length },
        mcpServers: { enabled: status.filter((s) => s.status !== 'disabled').length, connected: status.filter((s) => s.status === 'connected').length },
      },
      compat: { claudeCode: !!c.claudeCode, agentsMd: !!c.agentsMd, codex: !!c.codex, opencode: !!c.opencode, gemini: !!c.gemini },
      clis,
      problems,
      ...(trust ? { trust } : {}),
    };
    return out;
  });

  on('GET', '/api/extensions/inventory', async ({ query }) => {
    const kind = query.get('kind') || undefined;
    if (kind && !['agent', 'skill', 'command'].includes(kind)) ctx.fail(400, 'kind must be one of agent, skill, command');
    const items = await inventory(query.get('cwd') || undefined);
    return kind ? items.filter((i) => i.kind === kind) : items;
  });

  on('GET', '/api/extensions/sources', async ({ query }) => {
    const cwd = query.get('cwd') || undefined;
    const items = await inventory(cwd);
    const c = compat();
    const count = (id: ExtensionSourceId) => {
      const of = items.filter((i) => i.source === id);
      return { agents: of.filter((i) => i.kind === 'agent').length, skills: of.filter((i) => i.kind === 'skill').length, commands: of.filter((i) => i.kind === 'command').length };
    };
    const p = (...xs: Array<string | undefined | false>) => xs.filter((x): x is string => !!x);
    const list: ExtensionSourceInfo[] = [
      { id: 'builtin', label: 'Built-in', on: true, toggle: null, paths: [], counts: count('builtin') },
      { id: 'agents', label: 'Shared ~/.agents', on: !!(c.codex || c.opencode || c.gemini), toggle: ['codex', 'opencode', 'gemini'], paths: p(`${HOME}/.agents/skills`, cwd && `${cwd}/.agents/skills`), counts: count('agents') },
      { id: 'codex', label: 'Codex', on: !!c.codex, toggle: 'codex', paths: [`${HOME}/.codex/skills`, `${HOME}/.codex/prompts`, `${HOME}/.codex/agents`], counts: count('codex') },
      { id: 'opencode', label: 'OpenCode', on: !!c.opencode, toggle: 'opencode', paths: p(`${HOME}/.config/opencode`, cwd && `${cwd}/.opencode`), counts: count('opencode') },
      { id: 'gemini', label: 'Gemini CLI', on: !!c.gemini, toggle: 'gemini', paths: p(`${HOME}/.gemini`, cwd && `${cwd}/.gemini`), counts: count('gemini') },
      { id: 'claude', label: 'Claude Code', on: !!c.claudeCode, toggle: 'claudeCode', paths: p(`${HOME}/.claude`, cwd && `${cwd}/.claude`), counts: count('claude') },
      { id: 'plugin', label: 'Plugins', on: true, toggle: null, paths: [`${CH}/plugins`], counts: count('plugin') },
      { id: 'user', label: 'User (~/.conclave)', on: true, toggle: null, paths: [`${CH}/agents`, `${CH}/skills`, `${CH}/commands`], counts: count('user') },
    ];
    if (cwd) list.push({ id: 'project', label: 'Project (.conclave/)', on: true, toggle: null, paths: [`${cwd}/.conclave`], counts: count('project') });
    return list;
  });

  on('GET', '/api/tools', ({ query }) => toolsDetail(query.get('cwd') || undefined, query.get('agent') || undefined));

  on('POST', '/api/tools/check', async ({ body }) => {
    const b = (body ?? {}) as { tool?: unknown; input?: unknown; agent?: unknown; mode?: unknown; cwd?: unknown };
    if (typeof b.tool !== 'string' || !b.tool.trim()) ctx.fail(400, 'tool is required');
    if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) ctx.fail(400, 'input must be an object');
    if (b.mode !== undefined && !['default', 'acceptEdits', 'plan', 'bypass'].includes(String(b.mode))) ctx.fail(400, 'mode must be default, acceptEdits, plan or bypass');
    const tool = (await allTools()).find((t) => t.name === b.tool);
    if (!tool) ctx.fail(404, `unknown tool ${String(b.tool)}`);
    const agent = typeof b.agent === 'string' && b.agent ? (db.agents as AgentDef[]).find((a) => a.name === b.agent) : undefined;
    if (typeof b.agent === 'string' && b.agent && !agent) ctx.fail(404, `unknown agent ${b.agent}`);
    const cwd = typeof b.cwd === 'string' && b.cwd ? b.cwd : undefined;
    const trusted = cwd ? (await trustOf(cwd)).trusted : true;
    const mode = (b.mode as PermissionMode | undefined) ?? agent?.permissionMode ?? perms().mode;
    const input = (b.input ?? {}) as Record<string, unknown>;
    await ctx.sleep(120);
    const p = decide(tool!, input, mode, ruleSources(cwd, trusted), cwd ?? HOME);
    const hooks = hookCounts(await hookGroups(cwd), tool!.name).PreToolUse ?? 0;
    const out: ToolCheckResult = { decision: p.decision, reason: p.reason, rule: p.rule ?? null, ruleSource: p.ruleSource ?? null, dangerous: p.dangerous, hooks };
    return out;
  });

  on('GET', '/api/skills', async () => {
    const { skills } = await loaded(undefined);
    const last = new Map<string, SkillDef>();
    for (const e of skills) last.set(e.def.name, e.def);
    return [...last.values()];
  });

  on('GET', '/api/commands', async () => {
    const { commands } = await loaded(undefined);
    const last = new Map<string, CommandDef>();
    for (const e of commands) last.set(e.def.name, e.def);
    return [...last.values()];
  });

  // SKILL.md and command files, so detail views can show the real text.
  const files = (cwd?: string) => [...skillEntries(cwd), ...commandEntries(cwd)].map((e) => [e.def.path, e.file] as const);
  on('GET', '/api/devices/:id/file', ({ query }) => {
    const path = query.get('path') ?? '';
    if (!path) ctx.fail(400, 'path is required');
    const cwd = /^(.*)\/\.(claude|conclave)\//.exec(path)?.[1];
    const hit = files(cwd && isProject(cwd) ? cwd : undefined).find(([p]) => p === path);
    if (hit) return { content: hit[1], truncated: false };
    if (/\/(SKILL|commands\/[^/]+)\.md$/.test(path) || path.includes('/skills/')) ctx.fail(404, `No such file: ${path}`);
    return { content: `# ${path}\n\nMock file content.\n`, truncated: false };
  });
  on('GET', '/api/devices/:id/files', ({ query }) => {
    const p = (query.get('path') ?? '~').replace(/\/$/, '') || '/';
    const cwd = /^(.*)\/\.(claude|conclave)\//.exec(p)?.[1];
    const entry = skillEntries(isProject(cwd) ? cwd : undefined).find((e) => e.def.dir === p);
    if (entry) {
      const f = (name: string, size: number) => ({ name, path: `${p}/${name}`, type: 'file' as const, size });
      const d = (name: string) => ({ name, path: `${p}/${name}`, type: 'dir' as const });
      const extra = entry.def.name === 'pdf' ? [d('scripts'), f('forms.md', 4_210), f('reference.md', 9_870)] : entry.def.name.endsWith('brainstorming') ? [] : entry.def.name === 'proxmox-ops' ? [d('scripts'), f('rollback.md', 1_840)] : [];
      return [f('SKILL.md', entry.file.length), ...extra];
    }
    // the same shape the default mock gives for other folders
    const dir = (name: string) => ({ name, path: `${p}/${name}`, type: 'dir' as const });
    const file = (name: string, size: number) => ({ name, path: `${p}/${name}`, type: 'file' as const, size });
    if (p === '~' || p.endsWith('/kai')) return [dir('code'), dir('uni'), dir('ctf'), dir('.config'), dir('Downloads'), file('.zshrc', 4_812), file('notes.md', 12_004)];
    if (p.endsWith('code')) return [dir('conclave'), dir('scantools'), dir('dotfiles'), dir('rust-tunnel')];
    if (p.endsWith('conclave')) return [dir('packages'), dir('docs'), file('package.json', 788), file('bun.lock', 120_286), file('README.md', 3_400), file('tsconfig.base.json', 506)];
    return [dir('src'), dir('test'), file('README.md', 2_100), file('package.json', 640)];
  });

  on('POST', '/api/sync-clis', async ({ body }) => {
    const b = (body ?? {}) as { device?: unknown; only?: unknown; dryRun?: unknown };
    const id = typeof b.device === 'string' && b.device ? b.device : 'local';
    const dev = db.devices.get(id);
    if (!dev) ctx.fail(404, 'Device not found');
    if (!dev!.online) ctx.fail(409, `device ${id} is offline`);
    const all: CliName[] = ['claude', 'codex', 'opencode', 'gemini'];
    if (b.only !== undefined && (!Array.isArray(b.only) || b.only.some((x) => !all.includes(x as CliName)))) ctx.fail(400, `only must be a list of ${all.join(', ')}`);
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') ctx.fail(400, 'dryRun must be a boolean');
    const dryRun = b.dryRun === true;
    const clis = dev!.info?.clis ?? {};
    const only = Array.isArray(b.only) && b.only.length ? (b.only as CliName[]) : undefined;
    const want = (c: CliName) => (only ? only.includes(c) : c === 'claude' || c in clis);
    const home = dev!.info?.home ?? HOME;
    const skills = FRESH ? [] : skillEntries(undefined).filter((e) => e.def.source === 'user');
    const agents = (db.agents as AgentDef[]).filter((a) => a.source === 'user' && !FRESH);
    const written: string[] = [];
    const skillFiles = (root: string) => {
      for (const s of skills) written.push(`${root}/${s.def.name}/SKILL.md`, `${root}/${s.def.name}/.conclave-managed`);
    };
    const managed = (dir: string, file: string) => written.push(`${dir}/${file}`, `${dir}/.${file}.conclave-managed`);
    if (want('claude')) {
      skillFiles(`${home}/.claude/skills`);
      for (const a of agents) managed(`${home}/.claude/agents`, `${a.name}.md`);
    }
    if (want('codex') || want('opencode') || want('gemini')) skillFiles(`${home}/.agents/skills`);
    if (want('codex')) for (const a of agents) managed(`${home}/.codex/agents`, `${a.name}.toml`);
    if (want('opencode')) for (const a of agents) managed(`${home}/.config/opencode/agent`, `${a.name}.md`);
    if (want('gemini')) for (const a of agents) managed(`${home}/.gemini/agents`, `${a.name}.md`);
    await ctx.sleep(dryRun ? 200 : 700);
    return { ok: true as const, written, dryRun };
  });
}

