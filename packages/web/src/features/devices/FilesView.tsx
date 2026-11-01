/**
 * File browser (spec 11.9, /devices/:id/files?path=): entries of the current
 * folder on the left with a mono breadcrumb, a preview of the chosen file on
 * the right, and "Start a session here". Roots are the top level. Phones show
 * one pane at a time.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import type { FileEntryDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, upsertSession, useHub } from '@/store/store';
import { useIsOwner } from '@/lib/people';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { bytes } from '@/lib/format';
import { langFromPath } from '@/lib/highlight';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Notice } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { SelectedMark } from '@/components/ui/List';

function parent(path: string): string | null {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  if (i < 0) return null;
  if (i === 0) return p === '/' ? null : '/';
  return p.slice(0, i);
}

function name(path: string) {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function FilesView({ deviceId }: { deviceId: string }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const mobile = useIsMobile();
  const device = useHub((s) => s.devices[deviceId]);
  const qs = new URLSearchParams(search);
  const path = qs.get('path') ?? '';
  const file = qs.get('file') ?? '';
  const roots = device?.roots.length ? device.roots : [device?.info?.home ?? '~'];
  const atTop = !path;
  const [starting, setStarting] = useState(false);
  // the hub's own computer is the owner's alone (docs/design/ACCOUNTS.md 5): a member browses nothing there
  // (the owner's role, not the owner token: the owner signed in with a password browses it too)
  const owner = useIsOwner();
  const offLimits = deviceId === 'local' && !owner;

  const go = (p: string | null, f?: string) => {
    const q = new URLSearchParams();
    if (p) q.set('path', p);
    if (f) q.set('file', f);
    const s = q.toString();
    navigate(`/devices/${encodeURIComponent(deviceId)}/files${s ? `?${s}` : ''}`);
  };

  usePageHeader(
    device ? `${device.name} files` : 'Files',
    file && mobile ? `/devices/${encodeURIComponent(deviceId)}/files?path=${encodeURIComponent(path)}` : `/devices?d=${encodeURIComponent(deviceId)}`,
  );

  const list = useLoad(() => (atTop || offLimits ? Promise.resolve([] as FileEntryDto[]) : api().browse(deviceId, path)), [deviceId, path, offLimits]);
  const content = useLoad(() => (file && !offLimits ? api().readDeviceFile(deviceId, file) : Promise.resolve(null)), [deviceId, file, offLimits]);

  const entries = useMemo(() => {
    if (atTop) return roots.map((r) => ({ name: r, path: r, type: 'dir' as const }));
    return [...(list.data ?? [])].sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
  }, [atTop, roots, list.data]);

  // breadcrumb: the root that holds this path, then each folder under it
  const crumbs = useMemo(() => {
    if (atTop) return [] as Array<{ label: string; path: string }>;
    const root = roots.find((r) => path === r || path.startsWith(r.replace(/\/$/, '') + '/')) ?? '';
    const rest = root ? path.slice(root.length).split('/').filter(Boolean) : path.split('/').filter(Boolean);
    const out = root ? [{ label: root, path: root }] : [];
    let acc = root || (path.startsWith('/') ? '' : '');
    for (const seg of rest) {
      acc = acc ? `${acc.replace(/\/$/, '')}/${seg}` : path.startsWith('/') ? `/${seg}` : seg;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [atTop, path, roots]);

  // a root reads as itself (~/code), a folder under it by its own name
  const here = !path ? roots[0] : roots.includes(path) ? path : name(path);

  const startHere = async () => {
    const cwd = path || roots[0];
    setStarting(true);
    const s = await attempt(() => api().createSession({ device: deviceId, cwd }));
    setStarting(false);
    if (s) {
      upsertSession(s);
      navigate(`/s/${s.id}`);
    }
  };

  if (!device)
    return (
      <Page width="wide">
        <PageHeader title="Files" />
        <p className="text-[14px] text-fg-2">
          This device is not paired with the hub.{' '}
          <Link href="/devices" className="link">
            All devices
          </Link>
        </p>
      </Page>
    );

  if (offLimits)
    return (
      <Page width="wide">
        <PageHeader title={`Files on ${device.name}`} />
        <p className="max-w-[60ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
          {device.name} is the hub&apos;s own computer, and only the owner of the hub works there. Pair a computer of your own to browse its files and run sessions on it.{' '}
          <Link href="/devices" className="link">
            All devices
          </Link>
        </p>
      </Page>
    );

  const showList = !mobile || !file;
  const showPreview = !mobile || !!file;
  // while the next file loads, the last one's text is not shown under its name
  const shown = content.loading ? undefined : content.data;
  const lines = shown?.content.split('\n').length ?? 0;

  const breadcrumb = (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-baseline gap-x-1 font-mono text-[12.5px] tracking-[-0.01em]">
      <button type="button" onClick={() => go(null)} className={cn('font-sans text-[13px] tracking-normal hover:text-fg phone:text-[14px]', atTop ? 'text-fg' : 'text-fg-3')}>
        Roots
      </button>
      {crumbs.map((c, i) => (
        <span key={c.path} className="flex items-baseline gap-x-1">
          <span className="text-fg-4">/</span>
          <button
            type="button"
            onClick={() => go(c.path)}
            aria-current={i === crumbs.length - 1 ? 'location' : undefined}
            className={cn('hover:text-fg', i === crumbs.length - 1 ? 'text-fg' : 'text-fg-3')}
          >
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  );

  return (
    <Page width="wide">
      <PageHeader
        title={
          mobile ? (
            // the shell header already says whose files these are
            <span className="sr-only">Files on {device.name}</span>
          ) : (
            <>
              Files on {device.name}
              {!device.online && <span className="ml-2 text-[13px] font-normal tracking-normal text-fg-3">offline</span>}
            </>
          )
        }
        className={cn(mobile && 'pt-4 pb-4')}
        actions={
          !mobile && (
            <Button variant="outline" busy={starting ? 'Starting' : false} disabled={!device.online} onClick={() => void startHere()}>
              Start a session in <span className="mono">{here}</span>
            </Button>
          )
        }
      >
        {breadcrumb}
      </PageHeader>

      {!device.online && (
        <Notice tone="warn" className="mb-4">
          {`${device.name} is offline, so its files cannot be read. They show up again when its device agent reconnects.`}
        </Notice>
      )}

      <div className={cn('border-t border-rule', !mobile && 'grid grid-cols-[360px_minmax(0,1fr)]')}>
        {showList && (
          <div className={cn('min-w-0', !mobile && 'border-r border-rule pr-5')}>
            {!atTop && (
              <button
                type="button"
                onClick={() => go(parent(path) && crumbs.length > 1 ? parent(path) : null)}
                className="flex w-full items-baseline gap-3 border-b border-rule py-[7px] pl-2 text-left font-mono text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg phone:py-3"
              >
                ../
              </button>
            )}
            <LoadingRows loading={list.loading && !atTop && !list.data} rows={6} />
            {list.error && !atTop && <p className="py-3 text-[13px] text-fault">Failed. {list.error}</p>}
            <ul className="rows m-0 list-none p-0" aria-label={atTop ? 'Roots' : `Entries in ${path}`}>
              {entries.map((e) => {
                const dir = e.type === 'dir';
                const on = file === e.path;
                return (
                  <li key={e.path}>
                    <button
                      type="button"
                      aria-current={on || undefined}
                      onClick={() => (dir ? go(e.path) : go(path, e.path))}
                      className={cn('relative flex w-full items-baseline gap-3 py-[7px] pr-1 pl-2 text-left hover:bg-hover phone:py-3', on && 'bg-raise hover:bg-raise')}
                    >
                      {on && <SelectedMark />}
                      <span className={cn('min-w-0 flex-1 truncate font-mono text-[12.5px] tracking-[-0.01em] phone:text-[14px]', dir ? 'text-fg' : 'text-fg-2')}>
                        {e.name}
                        {dir && !atTop ? '/' : ''}
                      </span>
                      <span className="num shrink-0 text-[12px] text-fg-3">{dir ? (atTop ? 'root' : '') : bytes(e.size)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!list.loading && !atTop && !entries.length && !list.error && <p className="py-3 text-[13px] text-fg-3">This folder is empty.</p>}
            {mobile && (
              <div className="pt-5">
                <Button variant="outline" size="touch" full busy={starting ? 'Starting' : false} disabled={!device.online} onClick={() => void startHere()}>
                  Start a session in <span className="mono">{here}</span>
                </Button>
              </div>
            )}
          </div>
        )}
        {showPreview && (
          <div className={cn('min-w-0', !mobile && 'pl-6')}>
            {file ? (
              <div className="pt-4">
                <div className="mb-2 flex items-baseline gap-3">
                  {mobile && (
                    <button type="button" className="-my-3 -ml-3 grid size-11 shrink-0 place-items-center text-fg-3" aria-label="Back to the folder" onClick={() => go(path)}>
                      <ChevronLeft className="size-4" strokeWidth={1.75} />
                    </button>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{name(file)}</span>
                  {shown && <span className="num shrink-0 text-[12px] text-fg-3">{lines.toLocaleString('en-US')} lines</span>}
                </div>
                {content.error && !content.loading ? (
                  <p className="text-[13px] text-fault">Failed. {content.error}</p>
                ) : shown ? (
                  <>
                    <CodeBlock code={shown.content} lang={langFromPath(file)} maxLines={400} className="max-h-[66vh] overflow-auto" />
                    {shown.truncated && <p className="mt-2 text-[12px] text-fg-3">Showing the start. The file is too long to show in full.</p>}
                  </>
                ) : (
                  <LoadingRows loading rows={3} />
                )}
              </div>
            ) : (
              !mobile && (
                <p className="max-w-[52ch] pt-4 text-[14px] text-fg-2">
                  {atTop
                    ? `Sessions on ${device.name} work inside these roots. Open one to look around, then start a session in the folder you need.`
                    : 'Pick a file to read it here. Folders open in the list.'}
                </p>
              )
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
