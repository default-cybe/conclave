/**
 * Pick a folder like in Codex: one menu for the composer's folder chip and
 * Home's Where picker (Where.tsx) and the phone's place sheet. Top to
 * bottom: Search folders…, No folder, Recent (the project's or folder's name
 * over its muted path), Open folder…, then "On <device>" to switch the
 * device. A typed path lists matching folders on the device and is checked
 * as before (folderCheck.tsx). Open folder… opens FolderBrowser over
 * GET /api/devices/:device/files: breadcrumbs, Up, folders only, Show hidden,
 * Home, Desktop and Documents, New folder (POST /api/devices/:device/folder)
 * and Select this folder. A folder that is no project yet can be added as
 * one in place (POST /api/projects).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, FolderOpen, Search } from 'lucide-react';
import type { FileEntryDto, ProjectDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox, Input } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { StateWord } from '@/components/ui/List';
import { LoadingRows } from '@/components/ui/EmptyState';
import { FolderCheckNote, useFolderCheck, useMissingFolders } from '@/features/chat/folderCheck';
import { tildePath } from '@/features/chat/FolderChooser';
import { placeName } from './start';
import { computerList } from './Where';

const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const base = (p: string) => trim(p).split(/[\\/]/).pop() || p;
/** ~ and ~/x to the device's home. */
export const expandHome = (p: string, home?: string) => (home && (p === '~' || p.startsWith('~/')) ? `${trim(home)}${p.slice(1)}` : p);

export interface FolderRow {
  path: string;
  name: string;
  /** The muted second line: the path, when the name alone is ambiguous or the path says more. */
  detail?: string;
  projectId?: string;
}

/** The account's project a folder on the device is (or is inside), with the part below it. */
export function projectOf(projects: ProjectDto[], device: string, abs: string): { project: ProjectDto; rel: string } | undefined {
  for (const p of projects)
    for (const l of p.locations)
      if (l.device === device && (abs === trim(l.path) || abs.startsWith(`${trim(l.path)}/`))) return { project: p, rel: abs.slice(trim(l.path).length + 1) };
  return undefined;
}

/** Give each row its second line: shown when two rows share a name, or when the path is more than ~/<name>. */
export function withDetails(rows: Omit<FolderRow, 'detail'>[], home?: string): FolderRow[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name.toLowerCase(), (count.get(r.name.toLowerCase()) ?? 0) + 1);
  return rows.map((r) => {
    const shown = tildePath(r.path, home);
    const plain = shown === r.name || shown === `~/${r.name}`;
    return (count.get(r.name.toLowerCase()) ?? 0) > 1 || !plain ? { ...r, detail: shown } : r;
  });
}

/**
 * Recent: the folders of recent Code sessions on the device, newest first,
 * each once, at most `max`. The home folder and repository worktrees are
 * left out. A folder of a project reads by the project's name.
 */
export function recentFolders(sessions: Session[], projects: ProjectDto[], device: string, home?: string, max = 8): FolderRow[] {
  const seen = new Set<string>();
  const rows: Omit<FolderRow, 'detail'>[] = [];
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (rows.length >= max) break;
    if (s.device !== device || s.kind === 'chat' || !s.cwd || s.cwd === '~' || (s.meta as { repo?: unknown } | undefined)?.repo) continue;
    const abs = trim(expandHome(s.cwd, home));
    if (abs === trim(home ?? '') || seen.has(abs)) continue;
    seen.add(abs);
    const hit = projectOf(projects, device, abs);
    rows.push({ path: s.cwd, name: hit ? (hit.rel ? `${hit.project.name}/${hit.rel}` : hit.project.name) : base(abs), ...(hit ? { projectId: hit.project.id } : {}) });
  }
  return withDetails(rows, home);
}

/** The projects with a folder on the device, as rows (for search). */
export function projectFolders(projects: ProjectDto[], device: string, home?: string): Omit<FolderRow, 'detail'>[] {
  return projects.flatMap((p) => p.locations.filter((l) => l.device === device).map((l) => ({ path: tildePath(l.path, home), name: p.name, projectId: p.id })));
}

/** Rows whose name or path holds every word of the query, in any case. */
export function filterFolders<T extends { name: string; path: string }>(rows: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w) || r.path.toLowerCase().includes(w)));
}

/** "~/code", "/srv", "./x", "C:\\Users" or anything with a slash: a path to look up on the device. */
export const looksLikePath = (q: string) => /^(~|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(q.trim()) || /[\\/]/.test(q.trim());

/** Folders on the device that a typed path starts: "~/co" lists ~/code and ~/courses. */
function usePathMatches(device: string, q: string, home?: string): string[] {
  const [hits, setHits] = useState<{ key: string; list: string[] }>();
  const t = q.trim();
  const on = looksLikePath(t);
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  const parent = cut < 0 ? '~' : cut === 0 ? '/' : t.slice(0, cut);
  const prefix = cut < 0 ? (t === '~' ? '' : t) : t.slice(cut + 1);
  const key = `${device}\n${parent}`;
  useEffect(() => {
    if (!on) return;
    let live = true;
    const timer = setTimeout(() => {
      api()
        .browse(device, expandHome(parent, home))
        .then((list) => live && setHits({ key, list: list.filter((e) => e.type === 'dir' || e.type === 'symlink').map((e) => e.name) }))
        .catch(() => live && setHits({ key, list: [] }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [on, device, parent, home, key]);
  if (!on || hits?.key !== key) return [];
  const sep = parent.endsWith('/') ? '' : '/';
  return hits.list
    .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && (prefix.startsWith('.') || !n.startsWith('.')))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8)
    .map((n) => `${parent}${sep}${n}`);
}

interface Item {
  key: string;
  run: () => void;
}

const ROW = 'flex w-full items-center gap-2 rounded-[var(--r-1)] px-2 text-left text-[13px] phone:text-[15px]';

/**
 * The folder menu. `cwd` undefined or "~" is No folder. onPick gets a path
 * ("~" for No folder); onOpenFolder asks for the browser; onDevice adds the
 * "On <device>" row while there is more than one place to run.
 */
export function FolderMenu({ device, cwd, onPick, onOpenFolder, onDevice, onClose }: { device: string; cwd?: string; onPick: (path: string) => void; onOpenFolder: () => void; onDevice?: (id: string) => void; onClose?: () => void }) {
  const sessions = useHub((s) => s.sessions);
  const projectMap = useHub((s) => s.projects);
  const devices = useHub((s) => s.devices);
  const d = devices[device];
  const home = d?.info?.home;
  const projects = useMemo(() => Object.values(projectMap), [projectMap]);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const listId = useId();
  const recent = useMemo(() => recentFolders(Object.values(sessions), projects, device, home), [sessions, projects, device, home]);
  const searching = q.trim().length > 0;
  const typedPath = looksLikePath(q) ? q.trim() : '';
  const matches = usePathMatches(device, typedPath, home);
  const found = useMemo(() => {
    if (!searching || typedPath) return recent;
    const extra = projectFolders(projects, device, home).filter((p) => !recent.some((r) => trim(expandHome(r.path, home)) === trim(expandHome(p.path, home))));
    return withDetails(filterFolders([...recent, ...extra], q), home);
  }, [searching, typedPath, recent, projects, device, home, q]);
  // a recent folder that is gone is marked, not offered; a typed path is asked of the device (folderCheck.tsx)
  const gone = useMissingFolders(device, recent.map((r) => r.path));
  const check = useFolderCheck(device, typedPath);
  const member = useHub((s) => s.me?.role === 'member');
  // a member's code never runs on the hub (moveTarget), so the hub is not offered to them
  const list = computerList(devices).filter((x) => !member || x.id !== 'local');
  const many = !!onDevice && list.length > 1;
  const none = !cwd || cwd === '~';
  const current = cwd ? trim(expandHome(cwd, home)) : '';

  const items: Item[] = [];
  if (typedPath) items.push({ key: `typed:${typedPath}`, run: () => check.ready && onPick(typedPath) });
  for (const m of matches) if (m !== typedPath) items.push({ key: `match:${m}`, run: () => onPick(m) });
  if (!searching) items.push({ key: 'none', run: () => onPick('~') });
  for (const r of found) items.push({ key: `row:${r.path}`, run: () => !gone.has(r.path) && onPick(r.path) });
  items.push({ key: 'open', run: onOpenFolder });
  if (many) {
    items.push({ key: 'device', run: () => setDevicesOpen((o) => !o) });
    if (devicesOpen) for (const dev of list) items.push({ key: `dev:${dev.id}`, run: () => (dev.id !== device && onDevice!(dev.id), setDevicesOpen(false)) });
  }
  const at = Math.min(active, items.length - 1);
  const idx = (key: string) => items.findIndex((i) => i.key === key);
  useEffect(() => setActive(0), [q]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (Math.min(a, items.length - 1) + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[at]?.run();
    } else if (e.key === 'Tab' && !e.shiftKey && items[at]?.key.startsWith('match:')) {
      // Tab fills the field with the folder, to go on typing below it
      e.preventDefault();
      setQ(`${items[at].key.slice(6)}/`);
    } else if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const rowProps = (key: string) => {
    const i = idx(key);
    return { id: `${listId}-${i}`, role: 'option' as const, 'aria-selected': i === at, 'data-active': i === at || undefined, onMouseMove: () => i !== at && setActive(i) };
  };
  const hl = (key: string) => idx(key) === at && 'bg-hover';

  return (
    <div className="flex min-h-0 flex-col" data-folder-menu>
      <div className="p-1.5 pb-1">
        <Input
          autoFocus
          size="sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search folders…"
          aria-label="Search folders"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={`${listId}-${at}`}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          prefix={<Search className="size-3.5 text-fg-3" strokeWidth={1.75} aria-hidden />}
        />
        {typedPath && <FolderCheckNote check={check} className="mt-1.5 px-1" />}
      </div>
      <div id={listId} role="listbox" aria-label="Folders" className="flex min-h-0 flex-col overflow-y-auto px-1 pb-1">
        {typedPath && (
          <button type="button" {...rowProps(`typed:${typedPath}`)} onClick={() => check.ready && onPick(typedPath)} aria-disabled={!check.ready || undefined} className={cn(ROW, 'min-h-[30px] phone:min-h-11', hl(`typed:${typedPath}`), check.ready ? 'text-fg' : 'text-fg-3')}>
            <span className="text-fg-3">Use</span>
            <span className="mono min-w-0 flex-1 truncate text-[12.5px] phone:text-[14px]">{typedPath}</span>
          </button>
        )}
        {matches
          .filter((m) => m !== typedPath)
          .map((m) => (
            <button key={m} type="button" {...rowProps(`match:${m}`)} onClick={() => onPick(m)} className={cn(ROW, 'mono min-h-[30px] text-[12.5px] text-fg-2 phone:min-h-11 phone:text-[14px]', hl(`match:${m}`))}>
              <span className="min-w-0 flex-1 truncate">{m}</span>
            </button>
          ))}
        {!searching && (
          <button type="button" {...rowProps('none')} onClick={() => onPick('~')} className={cn(ROW, 'min-h-[30px] phone:min-h-11', hl('none'), none ? 'text-fg' : 'text-fg-2')}>
            <span className="min-w-0 flex-1">No folder</span>
            {none && <Check className="size-3.5 text-fg-2" aria-label="selected" />}
          </button>
        )}
        {found.length > 0 && (
          <div role="group" aria-label="Recent folders" className="flex flex-col">
            <div role="presentation" className="px-2 pt-2 pb-0.5 text-[12px] text-fg-3 phone:text-[13px]">
              {searching && !typedPath ? 'Folders' : 'Recent'}
            </div>
            {found.map((r) => {
              const missing = gone.has(r.path);
              const on = current && trim(expandHome(r.path, home)) === current;
              return (
                <button key={r.path} type="button" {...rowProps(`row:${r.path}`)} aria-disabled={missing || undefined} title={r.path} onClick={() => !missing && onPick(r.path)} className={cn(ROW, 'min-h-[30px] py-1 phone:min-h-11', hl(`row:${r.path}`), missing ? 'cursor-default text-fg-3' : on ? 'text-fg' : 'text-fg-2')}>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate', !missing && 'text-fg')}>{r.name}</span>
                    {r.detail && <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{r.detail}</span>}
                  </span>
                  {missing ? <StateWord tone="warn">missing</StateWord> : on && <Check className="size-3.5 text-fg-2" aria-label="selected" />}
                </button>
              );
            })}
          </div>
        )}
        {searching && !typedPath && !found.length && <p className="m-0 px-2 py-2 text-[12.5px] text-fg-3 phone:text-[14px]">No folder matches. Type a path, like ~/code.</p>}
      </div>
      <div className="border-t border-rule p-1">
        <button type="button" {...rowProps('open')} onClick={onOpenFolder} className={cn(ROW, 'min-h-[30px] text-fg-2 phone:min-h-11', hl('open'))}>
          <FolderOpen className="size-3.5 text-fg-3" strokeWidth={1.75} aria-hidden />
          <span className="flex-1">Open folder…</span>
        </button>
      </div>
      {many && (
        <div className="border-t border-rule p-1">
          <button type="button" {...rowProps('device')} aria-expanded={devicesOpen} onClick={() => setDevicesOpen((o) => !o)} className={cn(ROW, 'min-h-[28px] text-[12.5px] text-fg-3 phone:min-h-11 phone:text-[14px]', hl('device'))}>
            <span className="min-w-0 flex-1 truncate">
              On <span className="text-fg-2">{placeName(d, device)}</span>
            </span>
            <ChevronRight className={cn('size-3.5 transition-transform', devicesOpen && 'rotate-90')} aria-hidden />
          </button>
          {devicesOpen &&
            list.map((dev) => (
              <button key={dev.id} type="button" {...rowProps(`dev:${dev.id}`)} onClick={() => (dev.id !== device && onDevice!(dev.id), setDevicesOpen(false))} className={cn(ROW, 'min-h-[28px] pl-4 phone:min-h-11', hl(`dev:${dev.id}`), dev.online ? (dev.id === device ? 'text-fg' : 'text-fg-2') : 'text-fg-3')}>
                <span className="min-w-0 flex-1 truncate">{placeName(dev)}</span>
                {!dev.online && <span className="text-[12px]">offline</span>}
                {dev.id === device && <Check className="size-3.5" aria-label="selected" />}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open folder…: the folder browser
// ---------------------------------------------------------------------------

/** The breadcrumb parts of an absolute path: "/" or "C:" first, then each folder with its own path. */
export function crumbs(path: string): { name: string; path: string }[] {
  const win = /^[A-Za-z]:/.test(path);
  const parts = path.split(/[\\/]/).filter(Boolean);
  const out: { name: string; path: string }[] = win ? [] : [{ name: '/', path: '/' }];
  let at = '';
  for (const [i, p] of parts.entries()) {
    at = win && i === 0 ? `${p}/` : at === '' || at.endsWith('/') ? `${at || '/'}${p}` : `${at}/${p}`;
    out.push({ name: p, path: at });
  }
  return out;
}

/** The folder above, or undefined at the top. */
export function parentPath(path: string): string | undefined {
  const c = crumbs(path);
  return c.length > 1 ? c[c.length - 2].path : undefined;
}

/** A name New folder takes: one folder, not "." or "..", no slash. */
export const folderNameOk = (n: string) => !!n.trim() && !/[\\/\u0000]/.test(n) && n.trim() !== '.' && n.trim() !== '..';

const joinPath = (dir: string, name: string) => `${trim(dir)}${dir.endsWith('/') ? '' : '/'}${name}`;

/**
 * The folder browser. Desktop: a dialog; phones: a tall sheet. Typing a path
 * in the bar and Go still works, checked as before.
 */
export function FolderBrowser({ open, device, start, onSelect, onClose }: { open: boolean; device: string; start?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const d = useHub((s) => s.devices[device]);
  const home = d?.info?.home;
  const startAt = expandHome(start && start !== '~' ? start : (home ?? '/'), home);
  const [path, setPath] = useState(startAt);
  const [typed, setTyped] = useState(tildePath(startAt, home));
  const [entries, setEntries] = useState<FileEntryDto[]>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [made, setMade] = useState(0);
  const [newName, setNewName] = useState<string>();
  const [adding, setAdding] = useState<string>();
  const [busy, setBusy] = useState(false);
  const there = useFolderCheck(device, path, () => setMade((n) => n + 1));
  const projectMap = useHub((s) => s.projects);
  const project = projectOf(Object.values(projectMap), device, trim(path));

  useEffect(() => {
    if (!open) return;
    setPath(startAt);
    setNewName(undefined);
    setAdding(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setEntries(undefined);
    setError(undefined);
    setTyped(tildePath(path, home));
    api()
      .browse(device, path)
      .then((list) => live && setEntries(list.filter((e) => e.type === 'dir' || e.type === 'symlink').sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, device, path, home, made]);

  const shown = entries?.filter((e) => hidden || !e.name.startsWith('.'));
  const up = parentPath(path);
  const jumps = home
    ? [
        { name: 'Home', path: home },
        { name: 'Desktop', path: joinPath(home, 'Desktop') },
        { name: 'Documents', path: joinPath(home, 'Documents') },
      ]
    : [];
  for (const r of d?.roots ?? []) {
    const p = expandHome(r, home);
    if (!jumps.some((j) => trim(j.path) === trim(p))) jumps.push({ name: tildePath(p, home), path: p });
  }

  const makeFolder = async () => {
    if (newName === undefined || !folderNameOk(newName)) return;
    const at = joinPath(path, newName.trim());
    const r = await attempt(() => api().makeFolder(device, at));
    if (r?.exists) {
      setNewName(undefined);
      setPath(r.path);
    }
  };
  const select = async () => {
    if (adding !== undefined) {
      setBusy(true);
      const p = await attempt(() => api().addProject(device, path, adding.trim()));
      setBusy(false);
      if (!p) return;
      useHub.setState((s) => ({ projects: { ...s.projects, [p.id]: p } }));
      toast({ title: `${p.name} is a project now`, level: 'success' });
    }
    onSelect(tildePath(path, home));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Open folder on ${d?.name ?? device}`}
      width={600}
      className="phone:h-[92dvh] phone:max-h-[92dvh]"
      bodyClassName="flex flex-col pb-3"
      footerRule
      footer={
        <>
          {!project && adding === undefined && (
            <Button variant="quiet" className="mr-auto phone:mr-0" disabled={!there.ready} onClick={() => setAdding(base(path))}>
              Add as project
            </Button>
          )}
          {adding !== undefined && (
            <div className="mr-auto flex min-w-0 items-center gap-1.5 phone:w-full" data-add-project>
              <Input size="sm" aria-label="Project name" value={adding} onChange={(e) => setAdding(e.target.value)} className="w-[180px] phone:flex-1" />
              <Button variant="quiet" size="sm" onClick={() => setAdding(undefined)}>
                Not now
              </Button>
            </div>
          )}
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" busy={busy ? 'Adding' : false} disabled={!there.ready || (adding !== undefined && !adding.trim())} onClick={() => void select()}>
            {adding !== undefined ? 'Add and select' : 'Select this folder'}
          </Button>
        </>
      }
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const t = typed.trim();
          if (t) setPath(expandHome(t, home));
        }}
      >
        <IconButton label="Up one folder" size="md" variant="quiet" disabled={!up} onClick={() => up && setPath(up)}>
          <ChevronLeft />
        </IconButton>
        <Input mono size="sm" aria-label="Folder path" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 flex-1" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <Button type="submit" variant="outline" size="md">
          Go
        </Button>
      </form>
      <FolderCheckNote check={there} className="mt-2" />
      <nav aria-label="Path" className="mt-2 flex flex-wrap items-center gap-x-0.5 text-[12.5px] phone:text-[14px]">
        {crumbs(path).map((c, i, all) => (
          <span key={c.path} className="flex items-center">
            {i > 1 && <span className="px-0.5 text-fg-3">/</span>}
            <button type="button" aria-current={i === all.length - 1 ? 'location' : undefined} onClick={() => setPath(c.path)} className={cn('rounded-[var(--r-1)] px-1 py-0.5 hov:bg-hover', i === all.length - 1 ? 'text-fg' : 'text-fg-3')}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      {jumps.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Go to">
          {jumps.map((j) => (
            <button key={j.path} type="button" onClick={() => setPath(j.path)} className={cn('rounded-[var(--r-1)] px-1.5 py-0.5 text-[12px] hov:bg-hover phone:py-1.5 phone:text-[13px]', trim(j.path) === trim(path) ? 'text-fg' : 'text-fg-2')}>
              {j.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 min-h-[140px] flex-1 overflow-y-auto border-t border-rule phone:min-h-0" role="listbox" aria-label="Folders">
        {there.state === 'missing' ? null : error ? (
          <p className="py-3 text-[13px] text-fault">{error}</p>
        ) : !shown ? (
          <LoadingRows loading rows={4} />
        ) : shown.length ? (
          shown.map((e) => (
            <button key={e.path} type="button" role="option" aria-selected={false} onClick={() => setPath(e.path)} className="flex w-full items-center gap-2 py-1.5 text-left text-[13px] text-fg-2 hov:bg-hover hov:text-fg phone:py-2.5 phone:text-[15px]">
              <FolderOpen className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              <ChevronRight className="size-3.5 text-fg-3" aria-hidden />
            </button>
          ))
        ) : (
          <p className="py-3 text-[13px] text-fg-3">No folders in here.</p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {newName === undefined ? (
          <Button variant="outline" size="sm" disabled={there.state !== 'ok'} onClick={() => setNewName('')}>
            New folder
          </Button>
        ) : (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void makeFolder();
            }}
          >
            <Input size="sm" autoFocus aria-label="New folder name" placeholder="Folder name" value={newName} invalid={!!newName && !folderNameOk(newName)} onChange={(e) => setNewName(e.target.value)} className="min-w-0 flex-1" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <Button type="submit" size="sm" variant="outline" disabled={!folderNameOk(newName)}>
              Create
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setNewName(undefined)}>
              Cancel
            </Button>
          </form>
        )}
        <span className="ml-auto">
          <Checkbox checked={hidden} onChange={setHidden} label="Show hidden" />
        </span>
      </div>
      {project && <p className="mt-2 text-[12.5px] text-fg-3 phone:text-[13px]">In project {project.project.name}.</p>}
    </Dialog>
  );
}

/** The menu's way to the browser: state for the browser, and the browser to render beside the menu. */
export function useOpenFolder(device: string, cwd: string | undefined, onSelect: (path: string) => void): { open: () => void; browser: ReactNode } {
  const [open, setOpen] = useState(false);
  const started = useRef(cwd);
  if (!open) started.current = cwd;
  return {
    open: () => setOpen(true),
    browser: (
      <FolderBrowser
        open={open}
        device={device}
        start={started.current}
        onClose={() => setOpen(false)}
        onSelect={(p) => {
          setOpen(false);
          onSelect(p);
        }}
      />
    ),
  };
}
