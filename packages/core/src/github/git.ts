/**
 * Git for repo sessions (docs/DESIGN.md 30), run on the session's device
 * through its Machine.
 *
 * Commands that reach GitHub (clone, fetch, push) get the token on stdin,
 * for that one command, and never in an argument, a variable, a file or a
 * URL. The script moves stdin to fd 3, and a credential helper given with
 * `git -c` reads one line from fd 3 when git asks for the password of the
 * expected host. The agent's shell is another process tree and never sees
 * it. On a paired device the daemon writes the same stdin to the command.
 *
 * Fetch and push run in a fresh bare repository in a temp folder that
 * borrows the clone's object store (GIT_OBJECT_DIRECTORY), with no system
 * or global config. The clone's own config, which the agent can write, is
 * never read by a command that holds the token: an `url.insteadOf`, a
 * credential helper, a proxy or a hook planted there cannot see it. Hooks
 * are off, redirects are not followed, and only the configured scheme is
 * allowed.
 */
import { posix } from 'node:path';
import type { Machine } from '../machine/types';

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A branch name the hub makes or accepts: no spaces, no "..", no leading dash, no @{, no .lock end. */
export function validBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && !name.includes('..') && !name.includes('//') && !name.includes('/.');
}

/**
 * The last line of every commit message Conclave writes. The person stays the
 * only author: no Co-authored-by for an AI, which GitHub would count as a
 * contributor; Committed-by is not a trailer GitHub reads.
 */
export function committedBy(model?: string): string {
  return model?.trim() ? `Committed-by: Conclave (${model.trim()})` : 'Committed-by: Conclave';
}

/** The message with the Committed-by trailer at its end, once. */
export function withCommittedBy(message: string, model?: string): string {
  const msg = message.trim();
  if (/^Committed-by: Conclave\b/im.test(msg)) return msg;
  const lines = msg.split('\n');
  // a message that already ends in trailers ("Key: value" lines after a blank line) gets the line in that block
  const tail = lines.slice(lines.lastIndexOf('') + 1);
  const inBlock = lines.length > 1 && lines.includes('') && tail.every((l) => /^[A-Za-z0-9-]+: \S/.test(l));
  return `${msg}${inBlock ? '\n' : '\n\n'}${committedBy(model)}`;
}

export function validSha(sha: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha);
}

/** Where a repository is fetched from and pushed to. */
export interface Remote {
  url: string;
  scheme: string;
  /** host[:port] as git names it to a credential helper. */
  host: string;
}

export function remoteFor(gitUrl: string, owner: string, name: string): Remote {
  const base = gitUrl.replace(/\/+$/, '');
  const url = `${base}/${owner}/${name}.git`;
  if (/[\s'"\\]/.test(url)) throw new Error(`not a usable git address: ${url}`);
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(url);
  if (!m) throw new Error(`not a usable git address: ${url}`);
  const scheme = m[1].toLowerCase();
  // a user or password in the address would be stored by clone: refuse it
  if (m[2].includes('@')) throw new Error('github.gitUrl must not carry a user or password');
  return { url, scheme, host: m[2].toLowerCase() };
}

/** Variables that could point git elsewhere, print what it sends, or run a program. */
const UNSET = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_PROXY_COMMAND',
  'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_TRACE_CURL_NO_DATA', 'GIT_TRACE_PACKET', 'GIT_TRACE_PACK_ACCESS', 'GIT_TRACE_PACKFILE', 'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP', 'GIT_TRACE_SHALLOW', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_CURL_VERBOSE', 'GIT_TEMPLATE_DIR', 'GIT_SSL_NO_VERIFY',
  'GIT_REFLOG_ACTION', 'GIT_EXTERNAL_DIFF',
];

/**
 * The `-c` options of a command that holds the token. The first empty
 * credential.helper drops any helper named before it; ours answers only
 * `get` for the expected host, with the one line on fd 3.
 */
export function secureConfig(remote: Remote): string {
  const helper = `!f() { [ "$1" = get ] || exit 0; ok=; while IFS= read -r l; do [ -z "$l" ] && break; [ "$l" = "host=${remote.host}" ] && ok=1; done; [ -n "$ok" ] || exit 0; IFS= read -r p <&3 || [ -n "$p" ] || exit 0; printf 'username=x-access-token\\npassword=%s\\n' "$p"; }; f`;
  return [
    '-c credential.helper=',
    `-c ${shq(`credential.helper=${helper}`)}`,
    '-c credential.useHttpPath=false',
    '-c core.hooksPath=/dev/null',
    '-c core.fsmonitor=false',
    '-c http.followRedirects=false',
    '-c gc.auto=0',
    '-c maintenance.auto=false',
    '-c protocol.allow=never',
    `-c protocol.${remote.scheme}.allow=always`,
  ].join(' ');
}

const PRELUDE = [
  // stdin carries the token: it moves to fd 3 and every command gets /dev/null
  'exec 3<&0 </dev/null',
  `unset ${UNSET.join(' ')}`,
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false GIT_TRACE_REDACT=1 LC_ALL=C',
];

/** A fresh bare repository in a temp folder, removed when the script ends. */
const TRANSPORT = [
  'T=$(mktemp -d "${TMPDIR:-/tmp}/conclave-git.XXXXXX") || exit 90',
  'trap \'rm -rf "$T"\' EXIT',
  'git init -q --bare --template= "$T/r" || exit 91',
  'export GIT_DIR="$T/r"',
];

/** Clone into dest (which must not exist yet), without a checkout. */
export function cloneScript(remote: Remote, dest: string): string {
  return [...PRELUDE, `mkdir -p ${shq(posix.dirname(dest))} || exit 92`, `git ${secureConfig(remote)} clone -q --no-checkout --no-tags ${shq(remote.url)} ${shq(dest)}`].join('\n');
}

/**
 * Fetch one branch into the clone's object store and print its commit.
 * haves are commits the clone has, so only new objects come.
 */
export function fetchScript(remote: Remote, objects: string, branch: string, haves: string[]): string {
  return [
    ...PRELUDE,
    ...TRANSPORT,
    `export GIT_OBJECT_DIRECTORY=${shq(objects)}`,
    ...haves.filter(validSha).slice(0, 32).map((sha, i) => `git update-ref refs/have/${i} ${sha} 2>/dev/null`),
    `git ${secureConfig(remote)} fetch -q --no-tags ${shq(remote.url)} ${shq(`+refs/heads/${branch}:refs/heads/fetched`)} || exit 93`,
    'git rev-parse refs/heads/fetched',
  ].join('\n');
}

/** Push one commit to a branch, never with force: the refspec has no "+" and there is no --force. */
export function pushScript(remote: Remote, objects: string, sha: string, branch: string): string {
  return [
    ...PRELUDE,
    ...TRANSPORT,
    `export GIT_OBJECT_DIRECTORY=${shq(objects)}`,
    `git update-ref refs/heads/out ${sha} || exit 94`,
    `git ${secureConfig(remote)} push --porcelain ${shq(remote.url)} ${shq(`refs/heads/out:refs/heads/${branch}`)}`,
  ].join('\n');
}

export interface GitResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
}

/** Take the token out of any text that leaves this module. */
export function scrub(text: string, token: string | undefined): string {
  if (!token || token.length < 4) return text;
  return text.split(token).join('***');
}

/** Run a script that holds the token on the device: the token goes to stdin, nowhere else. */
export async function withToken(machine: Machine, script: string, token: string, opts: { cwd: string; timeoutMs: number }): Promise<GitResult> {
  const r = await machine.exec(script, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, stdin: `${token}\n`, maxOutputBytes: 1_000_000 });
  return { ok: r.exitCode === 0, code: r.exitCode, out: scrub(r.stdout, token).trim(), err: scrub(r.stderr, token).trim() };
}

/** A git command without the token, in a folder on the device. Hooks are off. */
export async function git(machine: Machine, cwd: string, args: string, timeoutMs = 60_000): Promise<GitResult> {
  const r = await machine.exec(`git -c core.hooksPath=/dev/null ${args}`, { cwd, timeoutMs, maxOutputBytes: 2_000_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.exitCode === 0, code: r.exitCode, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** The last lines of git's error output, for a message. */
export function gitError(r: GitResult): string {
  const text = (r.err || r.out).split('\n').filter((l) => l.trim() && !/^hint:/.test(l)).slice(-3).join(' ');
  return text || `git exited with ${r.code}`;
}

/** Parse `git push --porcelain`: the flag of our ref and its summary. */
export function pushOutcome(out: string): { flag?: string; summary: string } {
  for (const line of out.split('\n')) {
    const m = /^([ +\-*=!])\t[^\t]*\t(.*)$/.exec(line);
    if (m) return { flag: m[1], summary: m[2] };
  }
  return { summary: '' };
}
