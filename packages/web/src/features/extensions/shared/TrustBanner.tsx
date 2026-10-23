/**
 * Project trust (UI-HANDOFF.md, Project trust). Hooks and allow rules from a
 * project's .claude/settings*.json and .conclave/settings*.json stay off until
 * the folder is trusted. Shown at the top of Hooks and Tools. Renders nothing
 * when there is no project, the folder is trusted, or it has nothing to trust.
 *
 * Not a box (spec 1.1): a warn sentence on a rule, the files in mono, one
 * button. Pass `trust` when the parent already has it (HooksOverview.trust)
 * to skip the extra request.
 */
import { useEffect, useState } from 'react';
import type { ProjectTrustInfo } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { plural, shortPath } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';

const listeners = new Set<(t: ProjectTrustInfo) => void>();

/** Called after any TrustBanner changes trust, so other views can reload. */
export function onTrustChange(fn: (t: ProjectTrustInfo) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** "3 hooks and 2 allow rules", "1 hook", "4 allow rules". */
function trustWhat(t: Pick<ProjectTrustInfo, 'hooks' | 'allow'>): string {
  const parts = [t.hooks ? plural(t.hooks, 'hook') : '', t.allow ? plural(t.allow, 'allow rule') : ''].filter(Boolean);
  return parts.join(' and ');
}

/** A file inside the project, shown from the project folder: ".claude/settings.json". */
function inFolder(file: string, cwd: string): string {
  const base = cwd.replace(/\/+$/, '');
  if (file.startsWith(base + '/')) return file.slice(base.length + 1);
  // cwd given as ~/code/x while the hub lists /home/me/code/x/...
  const tail = base.startsWith('~/') ? base.slice(1) + '/' : '';
  const at = tail ? file.indexOf(tail) : -1;
  return at >= 0 ? file.slice(at + tail.length) : file;
}

function needsTrust(t: ProjectTrustInfo | undefined): t is ProjectTrustInfo {
  return !!t && !t.trusted && (t.hooks > 0 || t.allow > 0);
}

export function TrustBanner({
  cwd,
  trust,
  onChange,
  className,
}: {
  cwd: string | undefined;
  /** Already loaded trust info for this cwd. */
  trust?: ProjectTrustInfo;
  onChange?: (t: ProjectTrustInfo) => void;
  className?: string;
}) {
  const mobile = useIsMobile();
  const [info, setInfo] = useState<ProjectTrustInfo | undefined>(trust);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (trust) {
      setInfo(trust);
      return;
    }
    setInfo(undefined);
    if (!cwd) return;
    let alive = true;
    api()
      .projectTrust(cwd)
      .then((t) => alive && setInfo(t))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cwd, trust]);

  if (!cwd || !info || info.cwd !== cwd || !needsTrust(info)) return null;

  const set = async (trusted: boolean) => {
    setBusy(true);
    const next = await attempt(() => api().setProjectTrust(cwd, trusted));
    setBusy(false);
    if (!next) return;
    setInfo(next);
    onChange?.(next);
    for (const l of listeners) l(next);
    if (trusted)
      toast({
        title: `Trusted ${shortPath(cwd)}. Its hooks and allow rules are on now.`,
        action: { label: 'Undo', run: () => void set(false) },
      });
  };

  return (
    <section aria-label="Project trust" className={cn('border-y border-rule-2 py-3.5', className)}>
      <p className="m-0 text-[14px] leading-[1.45] text-warn phone:text-[15px]">
        This folder has {trustWhat(info)} that stay off until you trust it.
      </p>
      <p className="mt-1 mb-0 max-w-[72ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        Trust it only if you know who wrote these files. Trust covers its subfolders too. Deny and ask rules apply either way.
      </p>
      {info.files.length > 0 && (
        <ul className="m-0 mt-2 list-none p-0">
          {info.files.map((f) => (
            <li key={f} className="font-mono text-[12px] leading-[1.6] [overflow-wrap:anywhere] text-fg-3 phone:text-[13px]" title={f}>
              {inFolder(f, cwd)}
            </li>
          ))}
        </ul>
      )}
      {info.mcpServers > 0 && (
        <p className="mt-1.5 mb-0 text-[12px] text-fg-3 phone:text-[13px]">
          Its <span className="mono">.mcp.json</span> lists {plural(info.mcpServers, 'server')}. Conclave does not start those yet.
        </p>
      )}
      <div className="mt-3">
        <Button variant="outline" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Trusting' : false} onClick={() => void set(true)}>
          Trust this folder
        </Button>
      </div>
    </section>
  );
}
