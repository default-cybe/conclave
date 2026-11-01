/**
 * Mock routes for folders across devices (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12):
 * moving a session, its location for the banner, identifying a folder,
 * projects with their locations, and each device's folders, path pairs,
 * suggestions and Syncthing line.
 *
 * The busy hub has the portfolio site in ~/code on arch-desktop and in
 * ~/Developer on the MacBook (one Syncthing folder), a session on the
 * offline MacBook that can run on arch-desktop instead, and a session on
 * kali-vm whose folder is not there. A first-run hub has none of it.
 */
import type { Message, Session } from '@conclave/core/types';
import type {
  DeviceFoldersDto,
  FolderCandidate,
  Freshness,
  IdentifyResult,
  LocationVia,
  MappingSuggestion,
  MatchLevel,
  MoveInput,
  MoveResult,
  PathPrefixDto,
  ProjectDto,
  ProjectLocationDto,
  SessionLocationDto,
  SyncthingFolderDto,
} from '@conclave/core/client';
import type { MockCtx } from './index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const VIA_WORDS: Record<LocationVia, string> = {
  origin: 'where it started',
  'same-path': 'same path',
  pinned: 'pinned folder',
  syncthing: 'Syncthing',
  prefix: 'learned path pair',
  search: 'found by search',
  chosen: 'chosen folder',
};

function trim(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function base(p: string): string {
  return trim(p).split('/').pop() ?? p;
}

export function registerProjects(ctx: MockCtx) {
  const { on, db, emit, uid, fail, FRESH } = ctx;
  const now = Date.now();
  const home = (device: string) => db.devices.get(device)?.info?.home ?? '~';
  const name = (device: string) => db.devices.get(device)?.name ?? device;
  /** ~/x on a device to its absolute path, and back. */
  const abs = (device: string, p: string) => (p === '~' ? home(device) : p.startsWith('~/') ? `${home(device)}${p.slice(1)}` : trim(p));
  const tilde = (device: string, p: string) => {
    const h = home(device);
    if (!h || h === '~' || h === '/') return p;
    return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
  };

  const projects = new Map<string, ProjectDto>();
  const prefixes = new Map<string, PathPrefixDto>();
  const suggestions = new Map<string, MappingSuggestion>();
  const syncthing: Record<string, { available: boolean; folders: SyncthingFolderDto[]; line: string }> = {};
  /** Sessions whose folder is not on their device, and stale copies. */
  const missing = new Set<string>();
  /** Sessions that went on without the project files (they work in the home folder). */
  const without = new Set<string>();
  const stale = new Map<string, Freshness>();
  const history = new Map<string, SessionLocationDto['history']>();
  const levels = new Map<string, { level: MatchLevel; via: LocationVia; freshness?: Freshness }>();

  const loc = (projectId: string, device: string, path: string, via: LocationVia, ageMs = HOUR, pinned = false): ProjectLocationDto => ({
    projectId,
    device,
    deviceName: name(device),
    path,
    via,
    pinned,
    verifiedAt: now - ageMs,
  });
  const project = (id: string, nm: string, identity: ProjectDto['identity'], locations: ProjectLocationDto[]) => {
    projects.set(id, { id, name: nm, identity, createdAt: now - 40 * DAY, updatedAt: now - HOUR, locations });
  };

  if (!FRESH) {
    project('prj_portfolio', 'portfolio', { gitRoots: ['4be1c0f2a9d7e3c6b8a5f1e0d2c4b7a9e3f6d8c1'], remotes: ['github.com/kai/portfolio'], shallow: false, syncthing: { folderId: 'code-kai', rel: 'portfolio' }, head: '9a41c7e2' }, [
      loc('prj_portfolio', 'arch-desktop', '/home/kai/code/portfolio', 'origin', 20 * MIN),
      loc('prj_portfolio', 'macbook', '/Users/kai/Developer/portfolio', 'syncthing', 9 * HOUR),
    ]);
    project('prj_conclave', 'conclave', { gitRoots: ['c0f1e2d3a4b5968778695a4b3c2d1e0f9a8b7c6d'], remotes: ['github.com/kai/conclave'], shallow: false, head: '1cefd80a' }, [
      loc('prj_conclave', 'arch-desktop', '/home/kai/code/conclave', 'origin', 5 * MIN),
      loc('prj_conclave', 'local', '/srv/conclave/src', 'pinned', 2 * DAY, true),
    ]);
    project('prj_os', 'os', { gitRoots: ['77aa0e21b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4'], remotes: ['gitlab.uni-example.de/os/xv6-riscv'], shallow: true, head: '5e0b2c9d' }, [
      loc('prj_os', 'local', '/root/uni/os', 'origin', 30 * MIN),
      loc('prj_os', 'macbook', '/Users/kai/uni/os', 'prefix', 3 * DAY),
    ]);
    project('prj_scantools', 'scantools', { gitRoots: ['e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0'], remotes: ['github.com/kai/scantools'], shallow: false }, [loc('prj_scantools', 'arch-desktop', '/home/kai/code/scantools', 'origin', 3 * DAY)]);
    project('prj_tunnel', 'rust-tunnel', { gitRoots: ['aa11bb22cc33dd44ee55ff6600112233445566ff'], remotes: ['github.com/kai/rust-tunnel'], shallow: false }, [loc('prj_tunnel', 'arch-desktop', '/home/kai/code/rust-tunnel', 'origin', 6 * DAY)]);

    prefixes.set('pfx_code', { id: 'pfx_code', fromDevice: 'arch-desktop', fromPrefix: '/home/kai/code', toDevice: 'macbook', toPrefix: '/Users/kai/Developer', confirmations: 3, createdAt: now - 30 * DAY });
    prefixes.set('pfx_uni', { id: 'pfx_uni', fromDevice: 'local', fromPrefix: '/root/uni', toDevice: 'macbook', toPrefix: '/Users/kai/uni', confirmations: 1, createdAt: now - 3 * DAY });
    suggestions.set('sg_scantools', {
      id: 'sg_scantools',
      projectId: 'prj_scantools',
      projectName: 'scantools',
      fromDevice: 'arch-desktop',
      fromPath: '/home/kai/code/scantools',
      toDevice: 'macbook',
      toPath: '/Users/kai/Developer/scantools',
      reason: 'From the imported Claude Code session "nmap XML into a report"',
    });
    suggestions.set('sg_tunnel', {
      id: 'sg_tunnel',
      projectId: 'prj_tunnel',
      projectName: 'rust-tunnel',
      fromDevice: 'arch-desktop',
      fromPath: '/home/kai/code/rust-tunnel',
      toDevice: 'kali-vm',
      toPath: '/home/kali/ctf/rust-tunnel',
      reason: 'From the imported Codex session "Retry the tunnel on reset"',
    });
    syncthing['arch-desktop'] = {
      available: true,
      folders: [
        { id: 'code-kai', label: 'code', path: '/home/kai/code', paused: false },
        { id: 'uni-kai', label: 'uni', path: '/home/kai/uni', paused: false },
        { id: 'notes', label: 'notes', path: '/home/kai/notes', paused: false },
      ],
      line: '3 folders, all up to date.',
    };
    syncthing.macbook = {
      available: true,
      folders: [
        { id: 'code-kai', label: 'code', path: '/Users/kai/Developer', paused: false },
        { id: 'uni-kai', label: 'uni', path: '/Users/kai/uni', paused: false },
      ],
      line: '2 folders. Last known while the MacBook was online.',
    };

    // two sessions that need the banner
    const portfolio: Session = {
      id: 's_portfolio',
      title: 'Portfolio: dark mode toggle',
      agent: 'coder',
      model: 'anthropic/claude-sonnet-5-5',
      mode: 'agent',
      permissionMode: 'acceptEdits',
      cwd: '/Users/kai/Developer/portfolio',
      device: 'macbook',
      status: 'idle',
      tags: ['portfolio'],
      pinned: false,
      archived: false,
      projectId: 'prj_portfolio',
      createdAt: now - 26 * HOUR,
      updatedAt: now - 9 * HOUR - 10 * MIN,
      stats: { messages: 4, inputTokens: 88_000, outputTokens: 6_100, cacheReadTokens: 61_000, costUsd: 0.38 },
    };
    const tunnel: Session = {
      id: 's_tunnel',
      title: 'Retry the tunnel on reset',
      agent: 'coder',
      model: 'codex/gpt-5.5',
      mode: 'agent',
      permissionMode: 'default',
      cwd: '/home/kali/code/rust-tunnel',
      device: 'kali-vm',
      status: 'idle',
      tags: ['imported'],
      pinned: false,
      archived: false,
      projectId: 'prj_tunnel',
      createdAt: now - 6 * DAY,
      updatedAt: now - 2 * DAY,
      stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    };
    const text = (t: string) => [{ type: 'text' as const, text: t }];
    const msg = (sessionId: string, seq: number, role: Message['role'], body: string, at: number, extra: Partial<Message> = {}): Message =>
      ({ id: `m_${sessionId}_${seq}`, sessionId, seq, role, kind: 'normal', content: text(body), createdAt: at, ...extra }) as Message;
    db.sessions.set(portfolio.id, portfolio);
    db.messages.set(portfolio.id, [
      msg(portfolio.id, 1, 'user', 'Add a dark mode toggle to the header. Keep the system setting as the default.', now - 26 * HOUR),
      msg(portfolio.id, 2, 'assistant', 'Added `ThemeToggle` in `src/components/Header.tsx`. It reads `prefers-color-scheme` first and stores a choice in `localStorage`. The build passes. Next I would move the colors in `src/styles/site.css` to variables.', now - 26 * HOUR + 4 * MIN, { model: portfolio.model, agent: 'coder' }),
      msg(portfolio.id, 3, 'user', 'Do that next time, I have to go.', now - 9 * HOUR - 12 * MIN),
      msg(portfolio.id, 4, 'assistant', 'Stopped here. The colors move is next.', now - 9 * HOUR - 11 * MIN, { model: portfolio.model, agent: 'coder' }),
    ]);
    db.sessions.set(tunnel.id, tunnel);
    db.messages.set(tunnel.id, [
      msg(tunnel.id, 1, 'user', 'The tunnel drops when the server resets the connection. Retry with backoff.', now - 6 * DAY),
      msg(tunnel.id, 2, 'assistant', 'Imported from Codex. The last turn changed `src/conn.rs` to retry three times with a doubling delay.', now - 6 * DAY + 3 * MIN, { model: tunnel.model, agent: 'coder' }),
    ]);
    missing.add(tunnel.id);

    // conclave on three devices: the MacBook clone, the hub's copy and an imported Claude Code chat, one project (Group by Project)
    projects.get('prj_conclave')!.locations.push(loc('prj_conclave', 'macbook', '/Users/kai/Developer/conclave', 'origin', 2 * HOUR));
    const auth = db.sessions.get('s_auth');
    if (auth) auth.projectId = 'prj_conclave';
    const stats = (messages: number, inputTokens: number, outputTokens: number, costUsd: number) => ({ messages, inputTokens, outputTokens, cacheReadTokens: Math.round(inputTokens * 0.7), costUsd });
    const macConclave: Session = {
      id: 's_mac_conclave',
      title: 'Group the session list by project',
      agent: 'coder',
      model: 'anthropic/claude-opus-5-5',
      mode: 'agent',
      permissionMode: 'acceptEdits',
      cwd: '/Users/kai/Developer/conclave',
      device: 'macbook',
      status: 'idle',
      tags: ['conclave'],
      pinned: false,
      archived: false,
      projectId: 'prj_conclave',
      createdAt: now - 3 * HOUR,
      updatedAt: now - 22 * MIN,
      stats: stats(6, 142_000, 8_800, 1.12),
    };
    const hubConclave: Session = {
      id: 's_hub_conclave',
      title: 'Run the core tests on the hub',
      agent: 'coder',
      model: 'anthropic/claude-sonnet-5-5',
      mode: 'agent',
      permissionMode: 'default',
      cwd: '/srv/conclave/src',
      device: 'local',
      status: 'idle',
      tags: ['conclave'],
      pinned: false,
      archived: false,
      projectId: 'prj_conclave',
      createdAt: now - 5 * HOUR,
      updatedAt: now - 70 * MIN,
      stats: stats(4, 61_000, 2_900, 0.27),
    };
    const ccConclave: Session = {
      id: 's_cc_conclave',
      title: 'Slash menu like Claude Code',
      agent: 'coder',
      model: 'claude-code/default',
      mode: 'agent',
      permissionMode: 'default',
      cwd: '/Users/kai/Developer/conclave',
      device: 'macbook',
      status: 'idle',
      tags: ['imported', 'claude-code'],
      pinned: false,
      archived: false,
      projectId: 'prj_conclave',
      external: { 'claude-code': '7f3c2a10-5b4e-4c8a-9d61-2e8f0b7c4a11' },
      meta: { import: { source: 'claude-code', device: 'macbook', path: '/Users/kai/.claude/projects/-Users-kai-Developer-conclave/7f3c2a10-5b4e-4c8a-9d61-2e8f0b7c4a11.jsonl', id: '7f3c2a10-5b4e-4c8a-9d61-2e8f0b7c4a11', importedAt: now - 2 * HOUR, batchId: 'ib_conclave', createdAt: now - DAY, state: 'current' } },
      createdAt: now - DAY,
      updatedAt: now - 2 * HOUR - 5 * MIN,
      stats: stats(8, 0, 0, 0),
    };
    for (const s of [macConclave, hubConclave, ccConclave]) db.sessions.set(s.id, s);
    db.messages.set(macConclave.id, [
      msg(macConclave.id, 1, 'user', 'In the left list I want a Project grouping: one group for conclave with this chat, the hub one and the imported Claude Code one.', now - 3 * HOUR),
      msg(macConclave.id, 2, 'assistant', 'Added Group by Project to `SessionList.tsx`. Sessions join a group by their project id, or by a known location of a project on their device. Rows say their device. Tests pass.', now - 22 * MIN, { model: macConclave.model, agent: 'coder' }),
    ]);
    db.messages.set(hubConclave.id, [
      msg(hubConclave.id, 1, 'user', 'Run the core tests here on the hub and tell me what fails.', now - 5 * HOUR),
      msg(hubConclave.id, 2, 'assistant', '`bun test packages/core`: 2,265 pass, 0 fail, 11 skipped, in 2 min 54 s.', now - 70 * MIN, { model: hubConclave.model, agent: 'coder' }),
    ]);
    db.messages.set(ccConclave.id, [
      msg(ccConclave.id, 1, 'user', 'The code chat should feel like Claude Code: skills when I press /, and settings for connectors and hooks.', now - DAY),
      msg(ccConclave.id, 2, 'assistant', 'Imported from Claude Code on the MacBook. The last turn sketched the "/" menu: Commands, Skills and Custom, with /mcp and /context as sheets over the session.', now - 2 * HOUR - 5 * MIN, { model: ccConclave.model, agent: 'coder' }),
    ]);
    history.set(portfolio.id, [
      { fromSeq: 0, device: 'arch-desktop', deviceName: 'arch-desktop', root: '/home/kai/code/portfolio', via: 'origin', at: now - 30 * HOUR },
      { fromSeq: 1, device: 'macbook', deviceName: 'macbook', root: '/Users/kai/Developer/portfolio', via: 'syncthing', level: 'exact', at: now - 26 * HOUR },
    ]);
    levels.set(portfolio.id, { level: 'exact', via: 'syncthing' });
  }

  const projectOf = (s: Session): ProjectDto | undefined => {
    if (s.projectId && projects.has(s.projectId)) return projects.get(s.projectId);
    const cwd = abs(s.device, s.cwd);
    for (const p of projects.values()) if (p.locations.some((l) => l.device === s.device && (cwd === l.path || cwd.startsWith(`${l.path}/`)))) return p;
    return undefined;
  };

  const online = (device: string) => db.devices.get(device)?.online === true;

  /** Where the project lives on another online device, for "Run on macbook". */
  const suggestionFor = (s: Session, p: ProjectDto | undefined): SessionLocationDto['suggestion'] => {
    if (!p) return undefined;
    const there = p.locations.find((l) => l.device !== s.device && online(l.device));
    if (!there) return undefined;
    return { device: there.device, deviceName: name(there.device), cwd: there.path, via: p.identity.syncthing ? 'syncthing' : there.via, level: p.identity.syncthing ? 'exact' : 'strong' };
  };

  const location = (s: Session): SessionLocationDto => {
    const p = projectOf(s);
    const lv = levels.get(s.id);
    const out: SessionLocationDto = {
      sessionId: s.id,
      device: s.device,
      deviceName: name(s.device),
      online: online(s.device),
      cwd: s.cwd,
      ...(p ? { projectId: p.id, projectName: p.name } : {}),
      ...(lv ? { level: lv.level, via: lv.via } : {}),
      ...(lv?.freshness ? { freshness: lv.freshness } : {}),
      state: 'ok',
      history: history.get(s.id) ?? [],
      ...(p?.identity.remotes[0] ? { cloneUrl: `git@${p.identity.remotes[0].replace('/', ':')}.git` } : {}),
    };
    if (s.kind === 'chat') return out;
    if (!out.online) {
      const sugg = suggestionFor(s, p);
      const also = sugg ? ` Your folder is also on ${sugg.deviceName} at ${tilde(sugg.device, sugg.cwd)}${sugg.via === 'syncthing' ? ' (Syncthing)' : ''}.` : '';
      return { ...out, state: 'offline', line: `${out.deviceName} is offline.${also}`, ...(sugg ? { suggestion: sugg } : {}) };
    }
    if (missing.has(s.id)) {
      const roots = db.devices.get(s.device)?.roots ?? [];
      // another online device that has the project, as the hub offers it
      const sugg = suggestionFor(s, p);
      const where = sugg ? ` It is on ${sugg.deviceName} at ${tilde(sugg.device, sugg.cwd)}${sugg.via === 'syncthing' ? ' (Syncthing)' : ''}.` : '';
      return { ...out, exists: false, state: 'missing', line: `${tilde(s.device, abs(s.device, s.cwd))} is not on ${out.deviceName}.${where}`, browseFrom: roots[0] ?? '~', ...(sugg ? { suggestion: sugg } : {}) };
    }
    out.exists = true;
    if (without.has(s.id)) {
      const roots = db.devices.get(s.device)?.roots ?? [];
      const sugg = suggestionFor(s, p);
      return { ...out, state: 'missing', line: `${out.deviceName} has no folder for ${p?.name ?? 'this project'} yet. This session works in ${tilde(s.device, abs(s.device, s.cwd))} without the project files.`, browseFrom: roots[0] ?? '~', ...(sugg ? { suggestion: sugg } : {}) };
    }
    const st = stale.get(s.id);
    if (st) return { ...out, freshness: st, state: 'stale', line: st.line };
    if (lv?.level === 'mismatch') return { ...out, state: 'mismatch', line: 'This folder has a different git history from the earlier copy.' };
    return out;
  };

  /** A made-up but stable identity check: the project name matches, a folder with "old" or "fork" is another repository. */
  const judge = (device: string, path: string, p: ProjectDto | undefined, from: string): { level: MatchLevel; line: string } => {
    const n = base(path).toLowerCase();
    if (!p) return { level: 'none', line: 'A plain folder Conclave has not seen before' };
    if (/old|fork|copy/.test(n)) return { level: 'mismatch', line: `A different git repository from the ${from} copy` };
    if (n === p.name.toLowerCase()) {
      const synced = p.identity.syncthing && syncthing[device]?.folders.some((f) => f.id === p.identity.syncthing!.folderId && path.startsWith(f.path));
      return synced ? { level: 'exact', line: `Same Syncthing folder as the ${from} copy` } : { level: 'exact', line: `Same git history and remote as the ${from} copy` };
    }
    if (n.includes(p.name.toLowerCase().slice(0, 4))) return { level: 'weak', line: `Same folder name as the ${from} copy, nothing else to compare` };
    return { level: 'none', line: `Nothing in common with the ${from} copy` };
  };

  const notice = (sessionId: string, text: string) => {
    const list = db.messages.get(sessionId) ?? [];
    const m = { id: uid('m'), sessionId, seq: (list.at(-1)?.seq ?? 0) + 1, role: 'assistant', kind: 'notice', content: [{ type: 'text', text }], createdAt: Date.now() } as Message;
    list.push(m);
    db.messages.set(sessionId, list);
    emit({ type: 'message.created', message: structuredClone(m) });
  };

  const finish = (s: Session, device: string, cwd: string, via: LocationVia, level: MatchLevel, opts: { remember?: boolean; withoutFiles?: boolean; freshness?: Freshness } = {}): MoveResult => {
    const from = { device: s.device, cwd: s.cwd };
    const p = projectOf(s);
    Object.assign(s, { device, cwd, updatedAt: Date.now() });
    if (p && !opts.withoutFiles && (level !== 'mismatch' || opts.remember)) {
      const at = p.locations.find((l) => l.device === device && l.path === cwd);
      if (at) Object.assign(at, { verifiedAt: Date.now(), pinned: at.pinned || !!opts.remember });
      else p.locations.push(loc(p.id, device, cwd, via, 0, !!opts.remember));
      p.updatedAt = Date.now();
      emit({ type: 'project.updated', project: structuredClone(p) });
    }
    const h = history.get(s.id) ?? [{ fromSeq: 0, device: from.device, deviceName: name(from.device), root: abs(from.device, from.cwd), via: 'origin' as const, at: s.createdAt }];
    h.push({ fromSeq: (db.messages.get(s.id)?.at(-1)?.seq ?? 0) + 1, device, deviceName: name(device), root: cwd, via, level, at: Date.now() });
    history.set(s.id, h);
    levels.set(s.id, { level: opts.remember && level === 'mismatch' ? 'strong' : level, via, ...(opts.freshness ? { freshness: opts.freshness } : {}) });
    missing.delete(s.id);
    if (opts.withoutFiles) without.add(s.id);
    else without.delete(s.id);
    if (opts.freshness?.stale) stale.set(s.id, opts.freshness);
    else stale.delete(s.id);
    const line = opts.withoutFiles ? `Moved to ${name(device)} without the project files (${tilde(device, cwd)}).` : `Moved to ${name(device)} at ${tilde(device, cwd)} (${VIA_WORDS[via]}).`;
    emit({ type: 'session.updated', session: structuredClone(s) });
    emit({ type: 'session.moved', sessionId: s.id, from, to: { device, cwd }, via, level });
    notice(s.id, opts.freshness?.stale && opts.freshness.line ? `${line} ${opts.freshness.line}` : line);
    return { resolved: true, cwd, via, level, ...(opts.freshness ? { freshness: opts.freshness } : {}), session: structuredClone(s), line };
  };

  const move = (s: Session, input: MoveInput): MoveResult => {
    const device = input.device || s.device;
    if (!db.devices.has(device)) fail(404, `unknown device ${device}`);
    if (!online(device)) return { resolved: false, reason: 'offline', line: `${name(device)} is offline.`, candidates: [] };
    const p = projectOf(s);
    const fromName = name(s.device);
    if (input.withoutFiles) return finish(s, device, home(device), 'chosen', 'none', { withoutFiles: true });
    if (device === s.device && !input.cwd && !input.clone && !without.has(s.id)) return { resolved: true, cwd: s.cwd, via: 'same-path', level: 'exact', session: structuredClone(s), line: `Already on ${name(device)} at ${tilde(device, abs(device, s.cwd))}.` };
    if (input.clone) {
      const into = abs(device, input.clone.into);
      return finish(s, device, into, 'chosen', 'exact', { remember: true });
    }
    if (input.cwd) {
      const path = abs(device, input.cwd);
      const j = judge(device, path, p, fromName);
      if (j.level === 'mismatch' && !input.allowMismatch) return { resolved: false, reason: 'mismatch', line: `${j.line}.`, candidates: [{ device, path, level: j.level, via: 'chosen', line: j.line }] };
      return finish(s, device, path, 'chosen', j.level, { remember: input.remember });
    }
    // the resolution order: a known location, the Syncthing folder, a learned path pair
    const there = p?.locations.find((l) => l.device === device);
    if (p && there) {
      const via: LocationVia = p.identity.syncthing && syncthing[device]?.folders.some((f) => f.id === p.identity.syncthing!.folderId) ? 'syncthing' : there.pinned ? 'pinned' : there.via;
      const freshness: Freshness | undefined = p.id === 'prj_portfolio' && device === 'arch-desktop' ? { stale: false, behind: 0, ahead: 0, syncState: 'idle', needFiles: 0 } : undefined;
      return finish(s, device, there.path, via, 'exact', { freshness });
    }
    const cwd = abs(s.device, s.cwd);
    for (const pf of prefixes.values()) {
      const pairs: Array<[string, string, string]> = [
        [pf.fromDevice, pf.fromPrefix, pf.toPrefix],
        [pf.toDevice, pf.toPrefix, pf.fromPrefix],
      ];
      for (const [dev, a, b] of pairs) {
        const other = dev === pf.fromDevice ? pf.toDevice : pf.fromDevice;
        if (dev === s.device && other === device && (cwd === a || cwd.startsWith(`${a}/`))) return finish(s, device, b + cwd.slice(a.length), 'prefix', 'strong');
      }
    }
    // nothing matched: candidates for Choose folder
    const roots = db.devices.get(device)?.roots ?? [];
    const guess = `${abs(device, roots.find((r) => /code|Developer/.test(r)) ?? roots[0] ?? '~')}/${base(cwd)}`;
    const candidates: FolderCandidate[] = p ? [{ device, path: guess, level: 'weak', via: 'search', line: `Same folder name as the ${fromName} copy, nothing else to compare` }] : [];
    return {
      resolved: false,
      reason: 'not-found',
      line: `No copy of ${p?.name ?? base(cwd)} was found on ${name(device)}.`,
      candidates,
      ...(p?.identity.remotes[0] ? { cloneUrl: `git@${p.identity.remotes[0].replace('/', ':')}.git` } : {}),
      browseFrom: abs(device, roots[0] ?? '~'),
    };
  };

  const session = (id: string): Session => db.sessions.get(id) ?? fail(404, `unknown session ${id}`);

  on('POST', '/api/sessions/:id/move', ({ params, body }) => move(session(params[0]), body as MoveInput));
  on('GET', '/api/sessions/:id/location', ({ params }) => location(session(params[0])));
  // a new device goes through the same resolution as a move
  on('PATCH', '/api/sessions/:id', ({ params, body }) => {
    const s = db.sessions.get(params[0]);
    if (!s || s.kind === 'chat' || !body?.device || body.device === s.device) return ctx.pass;
    const r = move(s, { device: body.device, ...(body.cwd ? { cwd: body.cwd } : {}) });
    if (!r.resolved) fail(409, r.line);
    return ctx.pass;
  });

  on('POST', '/api/projects/identify', ({ body }) => {
    const device = String(body?.device ?? '');
    if (!online(device)) fail(409, `${name(device)} is offline`);
    const path = abs(device, String(body?.path ?? ''));
    const s = body?.sessionId ? db.sessions.get(body.sessionId) : undefined;
    const p = s ? projectOf(s) : [...projects.values()].find((x) => base(path).toLowerCase() === x.name.toLowerCase());
    // the copy to compare with: the project on another device than the one being browsed
    const other = p?.locations.find((l) => l.device !== device);
    const from = other ? name(other.device) : s && s.device !== device ? name(s.device) : 'earlier';
    const j = judge(device, path, p, from);
    const res: IdentifyResult = {
      device,
      path,
      identity: { path, exists: true, isGit: j.level !== 'none', roots: j.level === 'exact' || j.level === 'strong' ? (p?.identity.gitRoots ?? []) : [], remotes: j.level === 'exact' ? (p?.identity.remotes ?? []) : [], shallow: false, name: base(path) },
      ...(p ? { project: structuredClone(p) } : {}),
      level: j.level,
      line: j.line,
    };
    return res;
  });

  on('GET', '/api/projects', () => [...projects.values()].map((p) => structuredClone(p)));
  on('GET', '/api/projects/:id', ({ params }) => projects.get(params[0]) ?? fail(404, `unknown project ${params[0]}`));
  on('PUT', '/api/projects/:id/locations', ({ params, body }) => {
    const p = projects.get(params[0]) ?? fail(404, `unknown project ${params[0]}`);
    const device = String(body?.device ?? '');
    if (!online(device)) fail(409, `${name(device)} is offline`);
    const path = abs(device, String(body?.path ?? ''));
    const at = p.locations.find((l) => l.device === device && l.path === path);
    if (at) Object.assign(at, { pinned: true, via: 'pinned', verifiedAt: Date.now() });
    else p.locations.push(loc(p.id, device, path, 'pinned', 0, true));
    for (const [id, sg] of suggestions) if (sg.projectId === p.id && sg.toDevice === device) suggestions.delete(id);
    p.updatedAt = Date.now();
    emit({ type: 'project.updated', project: structuredClone(p) });
    return p;
  });
  on('DELETE', '/api/projects/:id/locations', ({ params, query }) => {
    const p = projects.get(params[0]) ?? fail(404, `unknown project ${params[0]}`);
    const i = p.locations.findIndex((l) => l.device === query.get('device') && l.path === query.get('path'));
    if (i < 0) fail(404, `no location ${query.get('path')} on ${query.get('device')}`);
    p.locations.splice(i, 1);
    emit({ type: 'project.updated', project: structuredClone(p) });
    return p;
  });

  on('GET', '/api/devices/:id/folders', ({ params }) => {
    const device = params[0];
    if (!db.devices.has(device)) fail(404, `unknown device ${device}`);
    const locations = [...projects.values()].flatMap((p) => p.locations.filter((l) => l.device === device).map((l) => ({ ...l, deviceName: name(device), projectName: p.name })));
    const st = syncthing[device] ?? (device === 'kali-vm' ? { available: false, folders: [], line: 'This device cannot report Syncthing folders (its daemon is older, or it has never been online).' } : { available: true, folders: [], line: 'No Syncthing folders on this device.' });
    const dto: DeviceFoldersDto = {
      device,
      deviceName: name(device),
      online: online(device),
      locations: locations.sort((a, b) => a.path.localeCompare(b.path)),
      prefixes: [...prefixes.values()].filter((p) => p.fromDevice === device || p.toDevice === device),
      suggestions: [...suggestions.values()].filter((s) => s.toDevice === device),
      syncthing: st,
    };
    return dto;
  });
  on('DELETE', '/api/path-prefixes/:id', ({ params }) => {
    if (!prefixes.delete(params[0])) fail(404, `unknown path pair ${params[0]}`);
    return { ok: true };
  });
}
