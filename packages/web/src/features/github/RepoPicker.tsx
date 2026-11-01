/**
 * Code from GitHub (docs/DESIGN.md 30): pick a repository the hub's token
 * can see, then the branch to start from. The session gets its own worktree
 * on a new branch, so nothing here asks for a folder.
 *
 * RepoList is the searchable list (in a popover on a desktop, in a sheet or
 * inline on a phone). RepoPicker and BranchPicker are the quiet buttons in
 * the composer's row and the fields of the phone's options sheet.
 *
 * IssuePicker picks an open issue of the repository to work on (searchable,
 * or a pasted issue link); the session's first message then carries it. A
 * link pasted into the repository search picks the repository and the issue.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { GithubIssueDto, GithubRepoDto, GithubStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { parseIssueRef, sameRepo } from '@/lib/github';
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

/** An issue to start from; title is unset when it came from a pasted link. */
export interface IssuePick {
  repo: string;
  number: number;
  title?: string;
}

const ROW = 'flex w-full flex-col rounded-[var(--r-1)] px-2 py-1.5 text-left hov:bg-hover phone:min-h-12 phone:justify-center';

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
export function RepoList({ value, onPick, onIssue, autoFocus, className }: { value?: string; onPick: (repo: GithubRepoDto) => void; onIssue?: (issue: IssuePick) => void; autoFocus?: boolean; className?: string }) {
  const [q, setQ] = useState('');
  // a pasted issue link picks its repository and the issue at once
  const pasted = onIssue ? parseIssueRef(q) : undefined;
  const { repos, error, status } = useRepos(pasted ? '' : q, true);
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
        <Input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder={onIssue ? 'Search repositories, or paste an issue link' : 'Search repositories'} aria-label="Search repositories" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div role="listbox" aria-label="Repositories" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {pasted && (
          <button type="button" role="option" aria-selected={false} onClick={() => onIssue?.({ repo: pasted.repo, number: pasted.issue })} className={ROW}>
            <span className="truncate text-[13px] text-fg phone:text-[16px]">
              Issue <span className="num">#{pasted.issue}</span> of {pasted.repo}
            </span>
            <span className="truncate text-[12px] text-fg-3 phone:text-[14px]">A worktree of the repository, with the issue as the task</span>
          </button>
        )}
        {error && <p className="m-0 px-2 py-2 text-[13px] text-fault">{error}</p>}
        {!pasted && !repos && !error && <p className="m-0 px-2 py-2 text-[13px] text-fg-3">Loading repositories</p>}
        {!pasted && repos && !repos.length && <p className="m-0 px-2 py-2 text-[13px] text-fg-3 phone:text-[15px]">{q ? `No repository matches "${q}".` : 'The token sees no repositories.'}</p>}
        {!pasted && repos?.slice(0, 50).map((r) => (
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
export function RepoPicker({ value, onChange, onIssue, look = 'text', className }: { value?: RepoPick; onChange: (v: RepoPick | undefined) => void; onIssue?: (issue: IssuePick) => void; look?: 'text' | 'field'; className?: string }) {
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
          {...(onIssue
            ? {
                onIssue: (i: IssuePick) => {
                  onIssue(i);
                  setOpen(false);
                },
              }
            : {})}
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

/** The open issues of a repository for a search, or the issue a pasted link names. */
function IssueList({ repo, value, onPick }: { repo: string; value?: number; onPick: (v: IssuePick) => void }) {
  const [q, setQ] = useState('');
  const [issues, setIssues] = useState<GithubIssueDto[]>();
  const [error, setError] = useState<string>();
  const ref = parseIssueRef(q, repo);
  const pasted = ref && sameRepo(ref.repo, repo) ? { ...ref, repo } : ref;
  // a link names one issue: no search, the row below picks it; a bare number also searches titles
  const link = !!pasted && !/^#?\d+$/.test(q.trim());
  const search = link ? '' : q.trim();
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        void api()
          .githubIssues(repo, search || undefined)
          .then((r) => {
            if (!live) return;
            setIssues(r);
            setError(undefined);
          })
          .catch((e) => live && setError(e instanceof Error ? e.message : String(e))),
      search ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [repo, search]);
  const known = pasted && pasted.repo === repo ? issues?.find((i) => i.number === pasted.issue) : undefined;
  const shown = link ? (known ? [known] : []) : issues;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="p-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search issues, or paste an issue link" aria-label="Search issues" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div role="listbox" aria-label="Open issues" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {error && <p className="m-0 px-2 py-2 text-[13px] text-fault">{error}</p>}
        {!issues && !error && <p className="m-0 px-2 py-2 text-[13px] text-fg-3">Loading issues</p>}
        {pasted && !known && (
          <button type="button" role="option" aria-selected={false} onClick={() => onPick({ repo: pasted.repo, number: pasted.issue })} className={ROW}>
            <span className="truncate text-[13px] text-fg phone:text-[16px]">
              Issue <span className="num">#{pasted.issue}</span>
              {pasted.repo !== repo ? ` of ${pasted.repo}` : ''}
            </span>
          </button>
        )}
        {issues && !pasted && !issues.length && <p className="m-0 px-2 py-2 text-[13px] text-fg-3 phone:text-[15px]">{q ? `No open issue matches "${q}".` : 'No open issues.'}</p>}
        {shown?.slice(0, 50).map((i) => (
          <button key={i.number} type="button" role="option" aria-selected={value === i.number} onClick={() => onPick({ repo, number: i.number, title: i.title })} className={cn(ROW, value === i.number && 'bg-hover')}>
            <span className="flex items-baseline gap-2 text-[13px] phone:text-[16px]">
              <span className="num shrink-0 text-fg-3">#{i.number}</span>
              <span className={cn('min-w-0 flex-1 truncate text-fg', value === i.number && 'font-medium')}>{i.title}</span>
              {i.updatedAt && <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{relTime(i.updatedAt)}</span>}
            </span>
            {(i.labels.length > 0 || i.comments > 0) && <span className="truncate text-[12px] text-fg-3 phone:text-[14px]">{[i.labels.join(', '), i.comments ? `${i.comments} comment${i.comments === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Issue", or the picked one. Its menu lists the open issues; a pasted link of another repository switches to it. */
export function IssuePicker({ repo, value, onChange, look = 'text', className }: { repo: string; value?: IssuePick; onChange: (v: IssuePick | undefined) => void; look?: 'text' | 'field'; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // the composer row shows the number only, so the repository and branch keep their room
  const words = value ? `#${value.number}${value.title && look === 'field' ? ` ${value.title}` : ''}` : look === 'field' ? 'None' : 'Issue';
  return (
    <>
      <PickerButton ref={ref} look={look} prefix={look === 'text' && value ? 'for' : undefined} data-picker="issue" aria-label={value ? `Issue, #${value.number}` : 'Start from an issue'} title={value?.title} aria-haspopup="dialog" aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>
        <span className="truncate">{words}</span>
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={420} maxHeight={420} label="Issue" sheetTitle="Start from an issue">
        <IssueList
          repo={repo}
          value={value?.number}
          onPick={(v) => {
            onChange(v);
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
              No issue
            </button>
          </div>
        )}
      </Popover>
    </>
  );
}
