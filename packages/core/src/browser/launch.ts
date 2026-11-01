/**
 * launch.json for the Preview pane (preview.ts): the dev servers a project
 * declares, in the format of Claude Code desktop's .claude/launch.json.
 * .conclave/launch.json wins over .claude/launch.json. The file is code from
 * the repo: preview_start runs it under the same approval as Bash.
 *
 *   { "version": "0.0.1", "configurations": [
 *     { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 } ] }
 */

export const LAUNCH_FILES = ['.conclave/launch.json', '.claude/launch.json'];

export interface LaunchConfig {
  name: string;
  /** The program to run; with no program, url names a server that already runs. */
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  /** Relative to the session folder. */
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
  /** Pick a free port and hand it over as PORT and --port/-p: on when port is not set, true forces it, false never. */
  autoPort?: boolean;
  /** A server that already runs: http://localhost:<port>/path only. */
  url?: string;
}

/** What preview.ts starts: a program (or none) and the device port it waits for. */
export interface LaunchPlan {
  name: string;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  port: number;
  path: string;
  /** The port came from launch.json, not from the free-port probe: it must be free before the command runs. */
  fixed?: boolean;
}

const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * What a configuration runs, as one line: the command with its arguments, or
 * the url it attaches to. The approval card shows it, Bash rules judge it, and
 * preview_start must name it (so a changed launch.json is never run unseen).
 */
export function launchLine(c: LaunchConfig): string {
  if (!c.runtimeExecutable) return c.url ?? '';
  // env goes first, as a shell writes it: NODE_OPTIONS and the like change what runs
  const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`);
  // the folder too: the same program in another directory runs other code
  const cd = c.cwd ? `cd ${quote(c.cwd)} && ` : '';
  return cd + [...env, ...[c.runtimeExecutable, ...(c.runtimeArgs ?? [])].map(quote)].join(' ');
}

/** True when the plan needs a free port from the device. */
export function wantsFreePort(c: LaunchConfig): boolean {
  return !!c.runtimeExecutable && c.autoPort !== false && (c.autoPort === true || c.port === undefined);
}

/** JSON with // and block comments and trailing commas, as VS Code writes it. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function validPort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : undefined;
}

/** The configurations of a launch.json; a bad entry is a line in problems, not a crash. */
export function parseLaunch(text: string): { configs: LaunchConfig[]; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch (err) {
    return { configs: [], problems: [`launch.json is not valid JSON: ${(err as Error).message}`] };
  }
  const list = (doc as { configurations?: unknown })?.configurations;
  if (!Array.isArray(list)) return { configs: [], problems: ['launch.json has no "configurations" list.'] };
  const configs: LaunchConfig[] = [];
  list.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = str(r.name) ?? `config ${i + 1}`;
    const runtimeExecutable = str(r.runtimeExecutable);
    const url = str(r.url);
    if (!runtimeExecutable && !url) return void problems.push(`"${name}" has neither runtimeExecutable nor url.`);
    if (r.port !== undefined && !validPort(r.port)) return void problems.push(`"${name}": port must be a whole number from 1024 to 65535.`);
    const args = Array.isArray(r.runtimeArgs) ? r.runtimeArgs.filter((a): a is string => typeof a === 'string') : [];
    const env = r.env && typeof r.env === 'object' ? Object.fromEntries(Object.entries(r.env as Record<string, unknown>).filter(([k, v]) => typeof v === 'string' && /^[A-Za-z_]\w*$/.test(k))) as Record<string, string> : undefined;
    configs.push({
      name,
      ...(runtimeExecutable ? { runtimeExecutable, runtimeArgs: args } : {}),
      ...(str(r.cwd) ? { cwd: r.cwd as string } : {}),
      ...(env ? { env } : {}),
      ...(validPort(r.port) ? { port: r.port as number } : {}),
      ...(typeof r.autoPort === 'boolean' ? { autoPort: r.autoPort } : {}),
      ...(url ? { url } : {}),
    });
  });
  return { configs, problems };
}

/** The local address of a server that already runs: localhost, 127.0.0.1 or [::1] only. */
export function localUrl(url: string): { port: number; path: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error(`The preview attaches only to http://localhost:<port> on the session's device, not ${u.origin}.`);
  const port = validPort(Number(u.port));
  if (!port) throw new Error(`${u.origin} needs a port from 1024 to 65535.`);
  return { port, path: `${u.pathname}${u.search}` };
}

/** Put port into --port N, --port=N, -p N and -pN in args. */
export function withPort(args: string[], port: number): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if ((a === '--port' || a === '-p') && i + 1 < out.length) out[++i] = String(port);
    else if (a.startsWith('--port=')) out[i] = `--port=${port}`;
    else if (/^-p\d+$/.test(a)) out[i] = `-p${port}`;
  }
  return out;
}

/**
 * The plan for one configuration. `freePort` is the port preview.ts found
 * when wantsFreePort; otherwise the configured port is used as it is
 * (Vite's `npm run dev` with port 5173 reads neither PORT nor a --port it lacks).
 */
export function planLaunch(c: LaunchConfig, freePort?: number): LaunchPlan {
  if (!c.runtimeExecutable) {
    const { port, path } = localUrl(c.url!);
    return { name: c.name, args: [], env: {}, port, path };
  }
  const auto = wantsFreePort(c);
  const port = auto ? freePort : c.port;
  if (!port) throw new Error(`"${c.name}" needs a port: set "port" or leave autoPort on.`);
  const path = c.url ? localUrl(c.url).path : '/';
  return {
    name: c.name,
    command: c.runtimeExecutable,
    args: auto ? withPort(c.runtimeArgs ?? [], port) : (c.runtimeArgs ?? []),
    ...(c.cwd ? { cwd: c.cwd } : {}),
    env: { ...(c.env ?? {}), ...(auto ? { PORT: String(port) } : {}) },
    port,
    path,
    ...(auto ? {} : { fixed: true }),
  };
}

/** The configuration to start: by name, else the only or first one. */
export function chooseConfig(configs: LaunchConfig[], name?: string): LaunchConfig {
  if (!configs.length) throw new Error('launch.json has no usable configuration.');
  if (!name) return configs[0];
  const hit = configs.find((c) => c.name === name);
  if (!hit) throw new Error(`No configuration named "${name}" in launch.json. Names: ${configs.map((c) => c.name).join(', ')}.`);
  return hit;
}
