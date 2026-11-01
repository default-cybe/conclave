/**
 * The project folder for the Extensions area (IA.md: "A project picker sits
 * in the header"). Choices: No project, the folders of recent sessions, or a
 * typed path. Stored with setExtCwd so every tab passes it as cwd.
 */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { PickerButton } from '@/components/ui/Select';
import { MenuList, Popover, type MenuItem } from '@/components/ui/Overlay';
import { setExtCwd, useExtCwd } from '../project';

/** /home/kai/code/x -> ~/code/x, for display only. */
export function shortPath(p: string): string {
  return p.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
}

/**
 * Folders of recent sessions that ran on the hub, newest first, without
 * duplicates. Extensions are read from the hub's own disk, so a folder on
 * another device would load nothing. ~ is expanded with the hub's home.
 */
function useRecentFolders(limit = 8): string[] {
  const sessions = useHub((s) => s.sessions);
  const home = useHub((s) => s.devices.local?.info?.home);
  return useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of Object.values(sessions)) {
      if ((s.device ?? 'local') !== 'local' || !s.cwd || s.cwd === '/' || s.cwd === '~') continue;
      let dir = s.cwd;
      if (dir.startsWith('~/')) {
        if (!home) continue;
        dir = home.replace(/\/+$/, '') + dir.slice(1);
      }
      if (!dir.startsWith('/')) continue;
      seen.set(dir, Math.max(seen.get(dir) ?? 0, s.updatedAt ?? 0));
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p]) => p);
  }, [sessions, home, limit]);
}

export function ProjectPicker({ className }: { className?: string }) {
  const cwd = useExtCwd();
  const recent = useRecentFolders();
  const hubHome = useHub((s) => s.devices.local?.info?.home);
  const hubName = useHub((s) => s.hub?.name) ?? 'the hub';
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();

  const pick = (p: string | undefined) => {
    setExtCwd(p);
    setOpen(false);
  };

  const items: MenuItem[] = [{ label: 'No project', detail: 'User and built-in items only', checked: !cwd, onSelect: () => pick(undefined) }];
  const folders = cwd && !recent.includes(cwd) ? [cwd, ...recent] : recent;
  if (folders.length) {
    items.push({ separator: true, label: '' }, { group: true, label: `Recent session folders on ${hubName}` });
    for (const p of folders) items.push({ label: <span className="mono">{shortPath(p)}</span>, checked: p === cwd, onSelect: () => pick(p) });
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let p = typed.trim().replace(/(.)\/+$/, '$1');
    if (!p) return setError('Type a folder path, for example /home/kai/code/conclave.');
    // the hub reads the folder on its own disk and does not expand ~, so do it here
    if (p === '~' || p.startsWith('~/')) {
      if (!hubHome) return setError('The hub did not say where its home folder is. Type the full path that starts with /.');
      p = hubHome.replace(/\/+$/, '') + p.slice(1);
    }
    if (!p.startsWith('/')) return setError('Use a full path on the hub that starts with / or ~/.');
    setError(undefined);
    setTyped('');
    pick(p);
  };

  return (
    <>
      <PickerButton
        ref={ref}
        look="text"
        prefix="Project"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('max-w-full phone:h-11 phone:text-[15px]', className)}
        title={cwd}
      >
        {cwd ? <span className="mono">{shortPath(cwd)}</span> : 'No project'}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={360} label="Project folder" sheetTitle="Project folder">
        <p className="px-3 pt-3 text-[12px] leading-[1.4] text-fg-3 phone:px-4 phone:text-[13px]">Project items load from .conclave/, .claude/, .agents/, .opencode/ and .gemini/ in this folder on {hubName}.</p>
        <MenuList items={items} onDone={() => setOpen(false)} autoFocus={false} label="Project folder" className="phone:px-2" />
        <form onSubmit={submit} className="border-t border-rule px-3 pt-2.5 pb-3 phone:px-4 phone:pb-4">
          <label htmlFor="ext-cwd-typed" className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
            Type a path
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="ext-cwd-typed"
              mono
              size="sm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="/home/kai/code/conclave"
              autoComplete="off"
              spellCheck={false}
              invalid={!!error}
              aria-describedby={error ? 'ext-cwd-err' : undefined}
              data-autofocus
            />
            <Button type="submit" size="sm" className="phone:h-11">
              Use
            </Button>
          </div>
          {error && (
            <p id="ext-cwd-err" className="mt-1.5 text-[12px] text-fault phone:text-[13px]">
              {error}
            </p>
          )}
        </form>
      </Popover>
    </>
  );
}
