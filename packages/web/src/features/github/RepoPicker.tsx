/**
 * Code from GitHub (docs/DESIGN.md 30): pick a repository the hub's token
 * can see, then the branch to start from. The session gets its own worktree
 * on a new branch, so nothing here asks for a folder.
 *
 * RepoList is the searchable list (in a popover on a desktop, in a sheet or
 * inline on a phone). RepoPicker and BranchPicker are the quiet buttons in
 * the composer's row and the fields of the phone's options sheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { GithubRepoDto, GithubStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { Input } from '@/components/ui/Field';
import { Popover } from '@/components/ui/Overlay';
import { PickerButton, SelectMenu } from '@/components/ui/Select';

export interface RepoPick {
  repo: string;
  /** Unset: the repository's default branch. */
  base?: string;
}

/** Whether the hub has a GitHub token, read once per page. */
let statusOnce: Promise<GithubStatusDto> | undefined;
export function githubStatus(fresh = false): Promise<GithubStatusDto> {
  if (fresh || !statusOnce) statusOnce = api().github().catch((e) => ({ connected: false, error: e instanceof Error ? e.message : String(e) }));
  return statusOnce;
}

/** Repositories for a search, a little after typing stops. */
function useRepos(q: string, on: boolean): { repos?: GithubRepoDto[]; error?: string; status?: GithubStatusDto } {
  const [status, setStatus] = useState<GithubStatusDto>();
  const [repos, setRepos] = useState<GithubRepoDto[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!on) return;
    let live = true;
    void githubStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [on]);
  useEffect(() => {
    if (!on || !status?.connected) return;
    let live = true;
    const t = setTimeout(
      () =>
        void api()
          .githubRepos(q.trim() || undefined)
          .then((r) => {
            if (!live) return;
            setRepos(r);
            setError(undefined);
          })
          .catch((e) => live && setError(e instanceof Error ? e.message : String(e))),
      q ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, on, status?.connected]);
  return { repos, error, status };
}

/** The search field and the repositories that match, most recently pushed first. */
export function RepoList({ value, onPick, autoFocus, className }: { value?: string; onPick: (repo: GithubRepoDto) => void; autoFocus?: boolean; className?: string }) {
  const [q, setQ] = useState('');
  const { repos, error, status } = useRepos(q, true);
  if (status && !status.connected)
    return (
      <p className={cn('m-0 px-3 py-3 text-[13px] leading-[1.45] text-fg-2 phone:text-[15px]', className)}>
        {status.error ?? 'Connect GitHub to start from a repository.'}{' '}
        <Link href="/settings/github" className="link">
          Settings, GitHub
        </Link>
      </p>
    );
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="p-2">
        <Input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div role="listbox" aria-label="Repositories" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {error && <p className="m-0 px-2 py-2 text-[13px] text-fault">{error}</p>}
        {!repos && !error && <p className="m-0 px-2 py-2 text-[13px] text-fg-3">Loading repositories</p>}
        {repos && !repos.length && <p className="m-0 px-2 py-2 text-[13px] text-fg-3 phone:text-[15px]">{q ? `No repository matches "${q}".` : 'The token sees no repositories.'}</p>}
        {repos?.slice(0, 50).map((r) => (
          <button
            key={r.fullName}
            type="button"
            role="option"
            aria-selected={value === r.fullName}
            onClick={() => onPick(r)}
            className={cn('flex w-full flex-col rounded-[var(--r-1)] px-2 py-1.5 text-left hov:bg-hover phone:min-h-12 phone:justify-center', value === r.fullName && 'bg-hover')}
          >
            <span className="flex items-baseline gap-2 text-[13px] phone:text-[16px]">
              <span className={cn('min-w-0 flex-1 truncate', value === r.fullName ? 'font-medium text-fg' : 'text-fg')}>{r.fullName}</span>
              <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{[r.private ? 'private' : '', r.canPush ? '' : 'read only', r.pushedAt ? relTime(r.pushedAt) : ''].filter(Boolean).join(', ')}</span>
            </span>
            {r.description && <span className="truncate text-[12px] text-fg-3 phone:text-[14px]">{r.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "From GitHub", or the picked repository. Its menu lists them; picking one sets the default branch as the base. */
export function RepoPicker({ value, onChange, look = 'text', className }: { value?: RepoPick; onChange: (v: RepoPick | undefined) => void; look?: 'text' | 'field'; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PickerButton ref={ref} look={look} prefix={look === 'text' && value ? 'From' : undefined} data-picker="repo" aria-label={value ? `Repository, ${value.repo}` : 'From GitHub'} aria-haspopup="dialog" aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>
        {value ? value.repo : look === 'field' ? 'None, a folder instead' : 'From GitHub'}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={380} maxHeight={420} label="GitHub repository" sheetTitle="GitHub repository">
        <RepoList
          autoFocus
          value={value?.repo}
          onPick={(r) => {
            onChange({ repo: r.fullName });
            setOpen(false);
          }}
        />
        {value && (
          <div className="border-t border-rule p-1">
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="flex min-h-[30px] w-full items-center rounded-[var(--r-1)] px-2 text-left text-[13px] text-fg-2 hov:bg-hover hov:text-fg phone:min-h-11 phone:text-[15px]"
            >
              Work in a folder instead
            </button>
          </div>
        )}
      </Popover>
    </>
  );
}

/** The branch a repo session starts from: the default branch unless the owner picks another. */
export function BranchPicker({ repo, value, onChange, look = 'text', className }: { repo: string; value?: string; onChange: (base: string | undefined) => void; look?: 'text' | 'field'; className?: string }) {
  const [branches, setBranches] = useState<{ defaultBranch: string; branches: string[] }>();
  useEffect(() => {
    let live = true;
    setBranches(undefined);
    void api()
      .githubBranches(repo)
      .then((b) => live && setBranches(b))
      .catch(() => live && setBranches(undefined));
    return () => {
      live = false;
    };
  }, [repo]);
  const options = useMemo(
    () => (branches?.branches ?? (value ? [value] : [])).slice(0, 200).map((b) => ({ value: b, label: b, text: b, ...(b === branches?.defaultBranch ? { hint: 'default' } : {}) })),
    [branches, value],
  );
  const current = value ?? branches?.defaultBranch;
  return (
    <SelectMenu
      look={look}
      label="Start from branch"
      prefix={look === 'text' ? 'from' : undefined}
      value={current}
      placeholder={branches ? 'Branch' : 'default branch'}
      options={options}
      className={className}
      onChange={(b) => onChange(b === branches?.defaultBranch ? undefined : b)}
    />
  );
}
