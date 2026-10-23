/**
 * A stand-in for GitHub (docs/DESIGN.md 30): local bare repositories plus a
 * small REST API. Tests, the demo hub and the real run use it; nothing here
 * reaches the real GitHub.
 *
 *   <url>/api/...           the REST calls repo sessions make (apiUrl)
 *   <url>/git/<o>/<r>.git    git over smart HTTP with git http-backend, Basic auth (gitUrl)
 *   file://<root>            the same bare repositories without a server (gitUrl)
 *
 * Every request is logged with its Authorization header, so a test can check
 * where the token went. merge(), close() and setChecks() move a pull request
 * along as a person on github.com would.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  createdAt: number;
  /** Who opened it; the token's user when left out. */
  author?: string;
}

export interface FakeCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
}

interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  description?: string;
  bare: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  auth?: string;
  body?: string;
}

const GIT = 'git -c user.email=fake@github.test -c user.name=Fake -c init.defaultBranch=main -c commit.gpgsign=false';

function run(cmd: string, cwd: string): string {
  const p = Bun.spawnSync(['bash', '-c', cmd], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd } });
  if (p.exitCode !== 0) throw new Error(`${cmd}\n${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class FakeGithub {
  readonly root: string;
  readonly requests: FakeRequest[] = [];
  readonly pulls: FakePull[] = [];
  /** Check runs per commit; "*" applies to any commit without its own. */
  readonly checks = new Map<string, FakeCheck[]>();
  private repos = new Map<string, FakeRepo>();
  private server?: ReturnType<typeof Bun.serve>;
  private own: boolean;

  constructor(
    readonly token: string,
    readonly user = { login: 'sam-rivera', name: 'Sam Rivera' },
    root?: string,
  ) {
    this.own = !root;
    this.root = root ?? mkdtempSync(join(tmpdir(), 'conclave-fake-github-'));
  }

  get url(): string {
    if (!this.server) throw new Error('call start() first');
    return `http://127.0.0.1:${this.server.port}`;
  }
  get apiUrl(): string {
    return `${this.url}/api`;
  }
  get httpGitUrl(): string {
    return `${this.url}/git`;
  }
  get fileGitUrl(): string {
    return `file://${this.root}`;
  }

  /** A bare repository at <root>/<owner>/<name>.git with a README and src/app.ts on its default branch. */
  addRepo(owner: string, name: string, opts: { private?: boolean; defaultBranch?: string; canPush?: boolean; description?: string; files?: Record<string, string> } = {}): string {
    const bare = join(this.root, owner, `${name}.git`);
    const branch = opts.defaultBranch ?? 'main';
    mkdirSync(join(this.root, owner), { recursive: true });
    run(`git init -q --bare -b ${shq(branch)} ${shq(bare)}`, this.root);
    const work = mkdtempSync(join(tmpdir(), 'conclave-fake-seed-'));
    try {
      const files = opts.files ?? { 'README.md': `# ${name}\n`, 'src/app.ts': 'export const answer = 41;\n' };
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(work, f, '..'), { recursive: true });
        writeFileSync(join(work, f), text);
      }
      run(`${GIT} init -q -b ${shq(branch)} . && ${GIT} add -A && ${GIT} commit -qm 'First commit' && git push -q ${shq(bare)} ${shq(branch)}`, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    this.repos.set(`${owner}/${name}`.toLowerCase(), { owner, name, private: !!opts.private, defaultBranch: branch, canPush: opts.canPush ?? true, description: opts.description, bare });
    return bare;
  }

  bare(full: string): string {
    const r = this.repos.get(full.toLowerCase());
    if (!r) throw new Error(`no fake repo ${full}`);
    return r.bare;
  }

  /** A new commit on a branch of the bare repository, as someone else pushing to GitHub. Returns its sha. */
  commit(full: string, branch: string, file: string, text: string): string {
    const bare = this.bare(full);
    const work = mkdtempSync(join(tmpdir(), 'conclave-fake-commit-'));
    try {
      run(`git clone -q -b ${shq(branch)} ${shq(bare)} .`, work);
      mkdirSync(join(work, file, '..'), { recursive: true });
      writeFileSync(join(work, file), text);
      run(`${GIT} add -A && ${GIT} commit -qm ${shq(`Change ${file}`)} && git push -q origin ${shq(branch)}`, work);
      return run('git rev-parse HEAD', work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** The commit a branch points at in the bare repository, or undefined. */
  branchSha(full: string, branch: string): string | undefined {
    try {
      return run(`git --git-dir=${shq(this.bare(full))} rev-parse --verify -q ${shq(`refs/heads/${branch}`)}`, this.root) || undefined;
    } catch {
      return undefined;
    }
  }

  branches(full: string): Array<{ name: string; sha: string }> {
    const out = run(`git --git-dir=${shq(this.bare(full))} for-each-ref refs/heads --format='%(refname:short) %(objectname)'`, this.root);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(' ');
        return { name, sha };
      });
  }

  merge(n: number): void {
    const p = this.pulls.find((x) => x.number === n);
    if (!p) throw new Error(`no pull #${n}`);
    p.state = 'closed';
    p.merged = true;
  }

  close(n: number): void {
    const p = this.pulls.find((x) => x.number === n);
    if (!p) throw new Error(`no pull #${n}`);
    p.state = 'closed';
  }

  setChecks(sha: string, runs: FakeCheck[]): void {
    this.checks.set(sha, runs);
  }

  /** Every place the token showed up in a request, other than a correct Authorization header. */
  tokenOutsideAuth(): FakeRequest[] {
    return this.requests.filter((r) => r.path.includes(this.token) || (r.body ?? '').includes(this.token));
  }

  start(): this {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
    if (this.own) rmSync(this.root, { recursive: true, force: true });
  }

  // ----- HTTP ------------------------------------------------------------------

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get('authorization') ?? undefined;
    if (url.pathname.startsWith('/git/')) {
      this.requests.push({ method: req.method, path: url.pathname + url.search, auth });
      return this.git(req, url, auth);
    }
    const body = req.method === 'GET' ? undefined : await req.text();
    this.requests.push({ method: req.method, path: url.pathname + url.search, auth, body });
    // a person on github.com, for scripts in another process: merge or close a pull request, set its checks
    let c: RegExpExecArray | null;
    if (req.method === 'POST' && (c = /^\/__fake\/(merge|close)\/(\d+)$/.exec(url.pathname))) {
      if (c[1] === 'merge') this.merge(Number(c[2]));
      else this.close(Number(c[2]));
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__fake/checks') {
      const input = JSON.parse(body || '{}') as { sha?: string; runs?: FakeCheck[] };
      this.setChecks(input.sha ?? '*', input.runs ?? []);
      return json(200, { ok: true });
    }
    if (!url.pathname.startsWith('/api/')) return json(404, { message: 'Not Found' });
    if (auth !== `Bearer ${this.token}` && auth !== `token ${this.token}`) return json(401, { message: 'Bad credentials' });
    const path = url.pathname.slice(4);
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && path === '/user') return json(200, { login: this.user.login, name: this.user.name, avatar_url: `https://avatars.example/${this.user.login}` });
    if (req.method === 'GET' && path === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Number(url.searchParams.get('per_page') ?? '30');
      const list = [...this.repos.values()].map((r) => this.repoJson(r));
      return json(200, list.slice((page - 1) * per, page * per));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      return r ? json(200, this.repoJson(r)) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(path)) && req.method === 'GET') {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r) return json(404, { message: 'Not Found' });
      return json(200, this.branches(`${r.owner}/${r.name}`).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path))) {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r) return json(404, { message: 'Not Found' });
      const full = `${r.owner}/${r.name}`;
      if (req.method === 'GET') {
        const head = url.searchParams.get('head');
        const state = url.searchParams.get('state') ?? 'open';
        const list = this.pulls
          .filter((p) => !head || `${r.owner}:${p.head}` === head)
          .filter((p) => state === 'all' || p.state === state)
          .sort((a, b) => b.number - a.number)
          .map((p) => this.pullJson(full, p));
        return json(200, list);
      }
      if (req.method === 'POST') {
        const input = JSON.parse(body || '{}') as { title?: string; body?: string; head?: string; base?: string; draft?: boolean };
        if (!input.title || !input.head || !input.base) return json(422, { message: 'Validation Failed', errors: [{ message: 'title, head and base are required' }] });
        if (!this.branchSha(full, input.head)) return json(422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] });
        if (!this.branchSha(full, input.base)) return json(422, { message: 'Validation Failed', errors: [{ field: 'base', code: 'invalid' }] });
        if (this.pulls.some((p) => p.head === input.head && p.state === 'open')) return json(422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${r.owner}:${input.head}.` }] });
        const p: FakePull = { number: this.pulls.length + 1, title: input.title, body: input.body ?? '', head: input.head, base: input.base, state: 'open', merged: false, draft: !!input.draft, createdAt: Date.now() };
        this.pulls.push(p);
        return json(201, this.pullJson(full, p));
      }
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path)) && req.method === 'GET') {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      const p = this.pulls.find((x) => x.number === Number(m![3]));
      return r && p ? json(200, this.pullJson(`${r.owner}/${r.name}`, p)) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/check-runs$/.exec(path)) && req.method === 'GET') {
      const runs = this.checks.get(m[3]) ?? this.checks.get('*') ?? [];
      return json(200, { total_count: runs.length, check_runs: runs.map((c, i) => ({ id: i + 1, name: c.name, status: c.status, conclusion: c.conclusion ?? null, html_url: `https://github.test/checks/${i + 1}` })) });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/status$/.exec(path)) && req.method === 'GET') {
      return json(200, { state: 'pending', statuses: [] });
    }
    return json(404, { message: 'Not Found' });
  }

  private repoJson(r: FakeRepo): Record<string, unknown> {
    return {
      full_name: `${r.owner}/${r.name}`,
      name: r.name,
      owner: { login: r.owner },
      private: r.private,
      default_branch: r.defaultBranch,
      description: r.description ?? null,
      pushed_at: new Date().toISOString(),
      html_url: `https://github.com/${r.owner}/${r.name}`,
      clone_url: `https://github.com/${r.owner}/${r.name}.git`,
      permissions: { admin: false, maintain: false, push: r.canPush, pull: true },
    };
  }

  private pullJson(full: string, p: FakePull): Record<string, unknown> {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      merged: p.merged,
      merged_at: p.merged ? new Date().toISOString() : null,
      draft: p.draft,
      html_url: `https://github.com/${full}/pull/${p.number}`,
      head: { ref: p.head, sha: this.branchSha(full, p.head) ?? null },
      base: { ref: p.base },
      user: { login: p.author ?? this.user.login },
      updated_at: new Date(p.createdAt).toISOString(),
    };
  }

  /** git http-backend behind Basic auth: user x-access-token, password the token. */
  private async git(req: Request, url: URL, auth: string | undefined): Promise<Response> {
    const want = `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    if (auth !== want) return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake github"' } });
    const body = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined;
    const proc = Bun.spawn(['git', 'http-backend'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        PATH_INFO: url.pathname.slice('/git'.length),
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers.get('content-type') ?? '',
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
        HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
        GIT_PROTOCOL: req.headers.get('git-protocol') ?? '',
      },
      stdin: body ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    let i = 0;
    while (i < out.length - 3 && !(out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10)) i++;
    const head = new TextDecoder().decode(out.slice(0, i));
    const headers = new Headers();
    let status = 200;
    for (const line of head.split('\r\n')) {
      const k = line.indexOf(':');
      if (k < 0) continue;
      const name = line.slice(0, k).trim();
      const value = line.slice(k + 1).trim();
      if (name.toLowerCase() === 'status') status = parseInt(value, 10);
      else headers.append(name, value);
    }
    return new Response(out.slice(i + 4), { status, headers });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
