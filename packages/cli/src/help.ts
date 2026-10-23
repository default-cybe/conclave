import { out as p } from './ansi';

export interface CommandHelp {
  usage: string;
  summary: string;
  details?: string[];
  flags?: Array<[string, string]>;
  examples?: string[];
}

const HUB_FLAGS: Array<[string, string]> = [
  ['--hub URL', 'Hub to talk to (else CONCLAVE_HUB, client.json, local hub)'],
  ['--token TOKEN', 'Bearer token (else CONCLAVE_TOKEN or saved login)'],
];

const SESSION_FLAGS: Array<[string, string]> = [
  ['-a, --agent NAME', 'Agent profile'],
  ['-m, --model REF', 'Model as provider/model'],
  ['--mode MODE', 'agent, chat, plan, jury, debate or loop'],
  ['--permission-mode M', 'default, acceptEdits, plan or bypass'],
  ['-d, --device ID', 'Device that runs tools (default: local)'],
  ['--cwd DIR', 'Working directory (default: current)'],
];

export const HELP: Record<string, CommandHelp> = {
  chat: {
    usage: 'conclave [chat] [prompt]',
    summary: 'Interactive chat in the terminal (the default command)',
    flags: [
      ...SESSION_FLAGS,
      ['-r, --resume ID', 'Resume a session'],
      ['-c, --continue', 'Resume the last session for this directory'],
      ...HUB_FLAGS,
    ],
    details: ['Starts the local hub in the background when it is not running.', 'Type /help inside the chat for commands and keys.'],
  },
  run: {
    usage: 'conclave run <prompt> [flags]',
    summary: 'One-shot headless run: streams the answer to stdout',
    flags: [
      ...SESSION_FLAGS,
      ['--json', 'Print events as JSON lines'],
      ['-y, --yes', 'Allow tool approvals (default: deny them)'],
      ['-t, --timeout DUR', 'Give up after e.g. 90s, 10m (exit 1)'],
      ...HUB_FLAGS,
    ],
    details: ['Assistant text goes to stdout, tool lines to stderr. Exit code 0 on success, 1 on error.', 'Reads the prompt from stdin when it is "-" or missing and stdin is piped.'],
    examples: ['conclave run "summarize README.md"', 'git diff | conclave run "review this diff" -m openai/gpt-5.5'],
  },
  serve: {
    usage: 'conclave serve [--host H] [--port P] [--detach]',
    summary: 'Start the hub in this process',
    flags: [
      ['--host HOST', 'Listen only here, e.g. 127.0.0.1 (default: every interface, answering this network)'],
      ['--port PORT', 'Port (default 7717)'],
      ['--detach', 'Run in the background, logs in ~/.conclave/logs/hub.log'],
    ],
    details: ['Phones on the same Wi-Fi can pair right away. For anywhere else: conclave remote quick.'],
  },
  remote: {
    usage: 'conclave remote [quick|new|url URL|tailscale [URL]|stable|off|lan on|off]',
    summary: 'How phones and computers reach the hub from anywhere',
    details: [
      'quick      a Cloudflare tunnel the hub downloads and runs itself. No account. The address changes when the hub restarts.',
      'stable     a fixed name on your Cloudflare domain: --cf-token TOKEN --zone example.com [--name conclave]. The token needs Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit.',
      'tailscale  your tailnet: run `tailscale serve --bg 7717` on the hub first',
      'url        your own reverse proxy or domain',
      'off        no outside address; the same network still works (lan off: only this computer)',
      'Everything but the web app files needs a token, a key, a pairing code or a signed link. Wrong tokens and codes are rate limited and go in the audit log.',
    ],
    flags: [['--cf-token T', 'Cloudflare API token (stable)'], ['--zone NAME', 'Cloudflare domain (stable)'], ['--name LABEL', 'Name in front of the domain (stable, default conclave)'], ...HUB_FLAGS],
    examples: ['conclave remote quick', 'conclave remote url https://hub.example.com', 'docker compose exec hub conclave remote quick'],
  },
  friends: {
    usage: 'conclave friends [add <hub-address> [--email E] | invite [--lan] | accept <link|name> | verify <name> | send-note <name> <text> | inbox [name] | shares ... | rm <name> | by-address on|off]',
    summary: "Friends: other owners' hubs that send you signed, sealed messages",
    details: [
      "add        their hub's address: your hub checks the key there and sends a request that waits in their Inbox. With --email,",
      '           an invite you can mail them comes back when the request cannot go. Compare the safety code before you trust them.',
      'invite     a link and QR code one friend can use for 24 hours. It carries your outside addresses only (--lan adds this network).',
      "accept     with a link: checks the friend's hub key, then sends a request. With a name: accepts a request.",
      'verify     after you compared the safety code with your friend (in person, or on a call).',
      'send-note  a plain text note. A hub that cannot be reached gets it later: the outbox tries for 7 days, and their hub can fetch it.',
      'inbox      notes friends sent. Nothing a friend sends runs anything here.',
      'shares     chats and sessions friends sent you, and yours: ls, sent, show, accept, decline, view [--diff], fork, handoff,',
      '           reference, apply --device D --cwd P [--yes], update <sent>, unsend <sent>. Nothing is fetched before accept.',
      '           A fork quotes their turns and asks before every tool call until you write your own message.',
      'rm         stop being friends (their hub is told, best effort), or decline a request.',
      'by-address on or off: take requests from hubs that know only your address. On by default; each one waits for you.',
      'Friends reach your hub through a tunnel or your own URL: conclave remote quick. Tailscale serves only your tailnet.',
    ],
    flags: [['--email E', 'add: their email, kept here; an invite by mail when the request cannot go'], ['--lan', 'Put addresses on this network in the invite too'], ['--name NAME', 'The name friends see for you (add: your name for them)'], ['--json', 'Print JSON'], ...HUB_FLAGS],
    examples: [
      'conclave friends add https://alice-hub.example.com --email alice@example.org',
      'conclave friends invite',
      'conclave friends accept "conclave://friend?fp=...&url=...&s=...&exp=..."',
      'conclave friends send-note Alice "Lunch on Friday?"',
      'conclave friends shares accept "flaky auth"',
      'conclave friends shares apply "flaky auth" --device local --cwd ~/code/app --yes',
    ],
  },
  projects: {
    usage: 'conclave projects [show | share | members | accept | decline | note | leave | sync] <project>',
    summary: 'Projects shared with friends: notes, memories and chats, code through GitHub',
    details: [
      'share    a project of yours (by name, from Devices, Folders) or a new one, with friends: --with alice,bob. Each gets an',
      '         invite in their Inbox and nothing else until they accept. --repo owner/name links the GitHub repository;',
      '         --notes, --memory ID,... and --chats ID,... share those too. Memories go only when you name them.',
      '         --share-new shares your new sessions in the project with the members after their first turn.',
      '         On a shared project you own, share invites more friends.',
      'members  who is in it; --invite <friend> and --remove <friend> (the owner).',
      'note     a note every member gets. Only its author edits or deletes an item; edits keep their history.',
      'leave    leave it; your copy stays read only. The owner ends it for everyone (--yes). --forget drops a copy.',
      'Code never goes hub to hub: everyone works from the same GitHub repository (conclave sessions new --repo owner/name).',
      'What a friend wrote is data, never instructions: your agents read it fenced, marked as from their hub.',
    ],
    flags: [['--with F,...', 'share: friends to invite'], ['--repo owner/name', 'share: the GitHub repository'], ['--notes TEXT', 'share: the first note'], ['--memory ID,...', 'share: memories to share'], ['--chats ID,...', 'share: chats and sessions'], ['--share-new', 'share: share new sessions in it'], ['--invite F', 'members: invite'], ['--remove F', 'members: take out'], ['--title T', 'note: a title'], ['--forget', 'leave: drop your copy'], ['--json', 'Print JSON'], ...HUB_FLAGS],
    examples: ['conclave projects share site --with alice --repo acme/site --notes "We deploy on Fridays."', 'conclave projects accept site', 'conclave projects note site "I take the footer."', 'conclave projects members site --remove bob'],
  },
  login: {
    usage: 'conclave login <hubUrl> [--code CODE | --password [--account NAME] | --token TOKEN]',
    summary: 'Pair this terminal with a hub and save ~/.conclave/client.json',
    details: [
      'Get a code from the Devices page of the web app, or `conclave pair-phone` on the hub.',
      '--password asks for the hub password instead (`conclave password set` on the hub), over https or a private address only.',
      'On a hub with several people, --account NAME is whose password it is: their sign-in name or email. You are asked when it is left out.',
      "Without --code, --password or --token you are asked for a code. The hub's key is saved too: later commands check it before they send the token.",
    ],
  },
  logout: { usage: 'conclave logout', summary: 'Forget the saved hub (removes client.json)' },
  daemon: {
    usage:
      'conclave daemon [--hub URL] [--name NAME] [--log FILE]\nconclave daemon pair <hubUrl> <code> [--name NAME]\nconclave daemon pair <hubUrl> --app-token-stdin [--name NAME] [--json]\nconclave daemon install [--start] [--login-path] [--dry-run]\nconclave daemon uninstall [--dry-run]\nconclave daemon status [--json]\nconclave daemon unpair [--json]',
    summary: 'Run this machine as a device for a hub (files, shells, harnesses)',
    details: [
      'pair       register this machine with a device pairing code, saves ~/.conclave/device.json',
      'install    a user service that runs the daemon at login: a systemd user unit (Linux), a LaunchAgent (macOS) or a Run key (Windows), with your PATH',
      'uninstall  stop the service and remove it',
      'status     paired or not, the service, and whether it runs',
      'unpair     the hub removes this machine, then the pairing here is forgotten',
      'The desktop app runs its own copy of conclave with these commands when you turn on "Let the hub use this computer".',
    ],
    flags: [
      ['--start', 'install: also start it now, or restart it so a new binary is used'],
      ['--login-path', "install: use your login shell's PATH (for apps started from a menu)"],
      ['--dry-run', 'install, uninstall: print the unit and the commands, change nothing'],
      ['--log FILE', 'run: write status lines to FILE instead of the terminal'],
      ['--app-token-stdin', 'pair: with the token of an app that is paired already, read from stdin (no code)'],
      ['--json', 'pair, status, unpair: machine readable output'],
    ],
    examples: ['conclave daemon pair https://hub.example.com ABCD-EFGH', 'conclave daemon install --start', 'conclave daemon install --dry-run'],
  },
  sessions: {
    usage:
      'conclave sessions [ls | show <id> | rm <id> | export <id> | send <id> --to <friend>]\nconclave sessions new --repo owner/name [--base main] [--device x] [task]\nconclave sessions push|pr|cleanup|repo <id>',
    summary: 'List, show, start, delete, export or send sessions',
    details: [
      'new      with --repo: a repo session in a fresh worktree of a GitHub repository on its own conclave/ branch',
      '         (conclave github login first). Without --repo: a session in --cwd.',
      'push     push the branch to GitHub. --message M commits what is not committed yet first. Never with force,',
      '         never to the default branch.',
      'pr       open a pull request with a title and body drafted from the session (--title, --body to change them).',
      'cleanup  after the merge or close: remove the worktree. The branch stays on GitHub. --force for any time.',
      'repo     the repository, branch, pull request and checks.',
      'send  to friends (conclave friends): the hub sanitizes it, signs it and seals it for each friend. Their hub fetches it',
      '      only when they accept. --dry-run shows what goes and what was taken out, each find with an id for --keep.',
      '      A session sends its diff (relative paths, no untracked or credential files) unless --code none; --code bundle',
      '      sends a bundle of its branch instead.',
    ],
    flags: [
      ['--limit N', 'How many to list (default 30)'],
      ['--all', 'Include archived sessions'],
      ['--format md|json', 'Export format (default md)'],
      ['--thinking', 'Export: keep the thinking text'],
      ['--raw', 'Export: the stored rows, reminders and recalled memories included, for backups (owner token only)'],
      ['-o, --out FILE', 'Write the export to a file'],
      ['--to FRIEND[,FRIEND]', 'Send: who gets it (a name, or the start of a key)'],
      ['--title T, --note N', 'Send: the title and a note they see'],
      ['--upto MSG', 'Send: stop after this message id'],
      ['--code none|diff|bundle', 'Send: the code that goes (a session: diff; a chat: none)'],
      ['--tool-output full|summary|none', 'Send: tool results as they are, their first lines, or left out'],
      ['--no-attachments', 'Send: leave images and documents out'],
      ['--keep ID[,ID]', 'Send: values the sanitizer found that go anyway (ids from --dry-run)'],
      ['--dry-run [--show]', 'Send: the review only; --show prints the finds in full'],
      ['--repo OWNER/NAME', 'New: the GitHub repository'],
      ['--base BRANCH', 'New: the branch to start from (default: the default branch)'],
      ['--message M', 'Push: commit uncommitted files with this message first'],
      ['--title T, --body B, --draft', 'Pr: the title and body (default: drafted from the session), as a draft'],
      ['--yes', 'Pr: open it without asking'],
      ['--force', 'Cleanup: also before the merge, and with uncommitted files'],
      ['--json', 'Machine readable output'],
    ],
    examples: ['conclave sessions new --repo acme/widgets "Fix the login redirect"', 'conclave sessions pr ses_123 --yes', 'conclave sessions cleanup ses_123'],
  },
  github: {
    usage: 'conclave github [login | status | repos [words] | logout]',
    summary: 'Connect the hub to GitHub for repo sessions',
    details: [
      'login   give the hub a fine-grained token: Contents read and write, Pull requests read and write, Metadata read.',
      '        It is asked for (hidden) or read from stdin, checked with GitHub, and kept as the hub secret "github".',
      '        Only the hub uses it, for its own git and API calls; sessions never see it.',
      'status  who the token is. repos: what it can see.',
    ],
    flags: [['--refresh', 'Repos: ask GitHub again'], ['--json', 'Machine readable output'], ...HUB_FLAGS],
    examples: ['conclave github login', 'echo "$TOKEN" | conclave github login', 'conclave github repos widgets'],
  },
  models: { usage: 'conclave models [--json]', summary: 'List providers and models the hub knows' },
  agents: { usage: 'conclave agents [--json]', summary: 'List agent profiles' },
  usage: { usage: 'conclave usage [--days N] [--json]', summary: 'Token and cost usage (default 7 days)' },
  limits: { usage: 'conclave limits [--json]', summary: 'Rate limit and subscription windows' },
  routines: { usage: 'conclave routines [ls | run <id>]', summary: 'List or trigger routines' },
  memory: { usage: 'conclave memory [ls | search <query> | add <text>]', summary: 'Browse and add memories' },
  tasks: { usage: 'conclave tasks [ls | add <title>]', summary: 'List or add tasks' },
  import: {
    usage: 'conclave import [claude-code|codex] [id]',
    summary: 'Import Claude Code or Codex sessions',
    details: ['Without an id, lists sessions found on the device.'],
    flags: [['-d, --device ID', 'Device to read from (default local)']],
  },
  'pair-phone': { usage: 'conclave pair-phone', summary: 'Show a QR code to pair the phone app' },
  web: { usage: 'conclave web [--no-open]', summary: 'Open the web app logged in' },
  config: {
    usage: 'conclave config [get <path> | set <path> <json> | edit | path]',
    summary: 'Read or change the hub config',
    details: ['Paths use dots: server.port, modes.reviewer, providers.zai.models', 'set parses the value as JSON, falling back to a plain string.'],
    examples: ['conclave config get defaultModel', 'conclave config set modes.reviewer \'"openai/gpt-5.5"\'', 'conclave config set server.port 7800'],
  },
  password: {
    usage: 'conclave password [status | set | clear]',
    summary: 'Set or remove the hub password, a backup to pairing codes',
    details: [
      'set    asks twice, without echo; 12 characters or more',
      'clear  turns logging in with a password off',
      'Only the owner token can change it. Wrong passwords count like wrong pairing codes: ten from one address block it.',
    ],
    flags: HUB_FLAGS,
  },
  people: {
    usage:
      'conclave people [list]\nconclave people add NAME [--email E] [--password] [--providers anthropic:5,openai]\nconclave people access NAME --providers LIST\nconclave people passwd NAME\nconclave people invite NAME\nconclave people workspace NAME\nconclave people remove NAME [--yes]',
    summary: 'People on this hub: their own chats, memory, keys and devices (owner only)',
    details: [
      'add       makes an invite link (works once, for 7 days), or asks for a password with --password',
      '--providers says which of the hub\'s keys they may use, with a monthly budget in USD after the colon; none takes it away',
      'passwd    sets a new password and signs their apps out',
      'workspace prints commands for a device of theirs on this computer, under its own user or in a container',
      'remove    deletes them and everything that is theirs',
      'They sign in with: conclave login <hub> --password --account NAME (or their email)',
    ],
    flags: HUB_FLAGS,
    examples: ['conclave people add sam --providers anthropic:10', 'conclave people access sam --providers anthropic:20,openai:5', 'conclave people remove sam --yes'],
  },
  secret: {
    usage: 'conclave secret <provider> [--value KEY | --delete]',
    summary: 'Store a provider API key on the hub (typed without echo). google-maps is the Google Maps key',
    examples: ['conclave secret anthropic', 'conclave secret zai --delete', 'conclave secret google-maps --value AIza...'],
  },
  doctor: { usage: 'conclave doctor', summary: 'Check the install: tools, harnesses, hub, keys, web assets' },
  logs: {
    usage: 'conclave logs [tail [-f] | errors | export | debug <hours|off>]',
    summary: "The hub's log files: tail them, group errors, export a zip for a developer",
    details: [
      'Files: ~/.conclave/logs/hub-YYYY-MM-DD.jsonl, one JSON line per event, kept 28 days and 500 MB (logs.keepDays, logs.maxMB).',
      'tail    the last lines; -f keeps following. --level warn, --component session, --lines N, --json',
      'errors  errors and warnings of the last --days (7), grouped by message',
      'export  a zip with the files, summary.md and the settings without secrets (--days 1, 7 or 28, -o FILE)',
      'debug   debug lines for a number of hours, or off',
      'With the hub on this machine stopped, tail, errors and export read the files directly.',
    ],
    flags: [['--days N', 'errors and export: how many days back (1 to 28)'], ['-o, --out FILE', 'export: where to save the zip'], ['--json', 'Machine readable output'], ...HUB_FLAGS],
    examples: ['conclave logs tail -f --level warn', 'conclave logs errors --days 7', 'conclave logs export --days 7 -o logs.zip'],
  },
  mcp: {
    usage: 'conclave mcp\n       conclave mcp snippets [--json]',
    summary: 'Serve Conclave memory, sessions, tasks and routines to other tools over MCP (stdio)',
    details: [
      'Claude Code, Codex, OpenCode and Gemini CLI start it as a stdio MCP server. It forwards to',
      "the hub's /mcp endpoint with this machine's saved login (conclave login), so every tool shares",
      'one memory. Tools: memory_search, memory_save, memory_forget, memory_recent, sessions_search,',
      'tasks_list, routines_list.',
      'snippets  print the config to add Conclave to each CLI, over HTTP or stdio',
    ],
    flags: HUB_FLAGS,
    examples: ['claude mcp add --scope user conclave -- conclave mcp', 'codex mcp add conclave -- conclave mcp', 'conclave mcp snippets'],
  },
  update: {
    usage: 'conclave update [--json]',
    summary: 'This version, how this install updates, and the newest release',
    details: [
      'The hub updates from Settings, About in the web app: Update now, or Install updates automatically at night.',
      'Docker, a source checkout and a binary no service runs print the command that updates them instead.',
      'Devices update their daemons from the Devices page. docs/INSTALL.md, Updates, has each platform.',
    ],
    flags: [['--json', 'Machine readable output']],
  },
  'system-helper': {
    usage: 'conclave system-helper install [--user NAME] [--dry-run]\nconclave system-helper remove\nconclave system-helper status\nconclave system-helper run browser-deps',
    summary: 'The root helper: lets the hub install the system packages it needs',
    details: [
      'install, as root on the hub\'s machine, once. In a Proxmox container: inside the container, not on the host',
      '(from the host shell: pct exec <CTID> -- conclave system-helper install).',
      'It writes /usr/local/libexec/conclave-root-helper (root, 0755) and /etc/sudoers.d/conclave (0440, checked',
      'with visudo), which lets the hub\'s user run that helper with its fixed actions, and nothing else, without a',
      'password. Its one action, browser-deps, installs the libraries and fonts the browser needs with apt-get.',
      'The hub\'s user comes from its service, else a running conclave serve, else the conclave user.',
      'remove takes both files out again. run browser-deps does it once now, as root, without installing anything.',
    ],
    flags: [
      ['--user NAME', 'The account the hub runs as, when it cannot be found'],
      ['--dry-run', 'Print the two files instead of writing them'],
    ],
    examples: ['conclave system-helper install', 'sudo /usr/local/libexec/conclave-root-helper browser-deps   (as the hub\'s user, after install)'],
  },
  version: { usage: 'conclave --version', summary: 'Print the version' },
  help: { usage: 'conclave help [command]', summary: 'Show help' },
};

const ORDER = [
  'chat',
  'run',
  'serve',
  'login',
  'logout',
  'daemon',
  'remote',
  'friends',
  'projects',
  'sessions',
  'github',
  'models',
  'agents',
  'usage',
  'limits',
  'routines',
  'memory',
  'tasks',
  'import',
  'pair-phone',
  'web',
  'config',
  'secret',
  'password',
  'people',
  'doctor',
  'logs',
  'mcp',
  'update',
  'system-helper',
  'help',
];

export function mainHelp(version: string): string {
  const lines = [
    `${p.bold(p.fg('#C792EA')('◆ conclave'))} ${p.dim('v' + version)}  personal multi-model agent harness`,
    '',
    p.bold('Usage'),
    '  conclave [command] [args] [flags]',
    '',
    p.bold('Commands'),
  ];
  const w = Math.max(...ORDER.map((c) => c.length)) + 2;
  for (const c of ORDER) lines.push(`  ${c.padEnd(w)}${p.dim(HELP[c].summary)}`);
  lines.push('', p.bold('Global flags'));
  for (const [f, d] of [...HUB_FLAGS, ['-h, --help', 'Help for a command'], ['-v, --version', 'Print the version']]) lines.push(`  ${f.padEnd(22)}${p.dim(d)}`);
  lines.push('', p.dim('Run `conclave help <command>` for details.'));
  return lines.join('\n');
}

export function commandHelp(name: string): string | undefined {
  const h = HELP[name];
  if (!h) return undefined;
  const lines = [p.bold(h.summary), '', p.bold('Usage'), '  ' + h.usage.replace(/\n/g, '\n  ')];
  if (h.details?.length) lines.push('', ...h.details.map((d) => '  ' + d));
  if (h.flags?.length) {
    lines.push('', p.bold('Flags'));
    const w = Math.max(...h.flags.map(([f]) => f.length)) + 2;
    for (const [f, d] of h.flags) lines.push(`  ${f.padEnd(w)}${p.dim(d)}`);
  }
  if (h.examples?.length) lines.push('', p.bold('Examples'), ...h.examples.map((e) => '  ' + e));
  return lines.join('\n');
}
