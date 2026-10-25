/**
 * A repo session in its view (docs/DESIGN.md 30): one line under the
 * header with the repository, the branch and where it stands ("Pull request
 * #3 is open. Checks passed."), and Push, Open pull request and Clean up.
 * Phones get the same line over the composer, and rows and actions in the
 * conversation sheet. Archiving a repo session offers Clean up too.
 *
 * The hub reads the pull request from GitHub every two minutes while it is
 * open; Check now reads it at once.
 *
 * A folder worktree ("Run in a worktree") has the same line with Merge into
 * <base> and Discard; Push and Open pull request only when its origin is on
 * GitHub and GitHub is connected.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PrDraft, RepoSessionDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toast, upsertSession } from '@/store/store';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { branchShort, ciTone, ciWords, prWords, repoActions, sessionRepo, worktreeActions } from '@/lib/github';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox, Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';

const TONE = { signal: 'text-signal', fault: 'text-fault', ok: 'text-ok', dim: 'text-fg-3' } as const;

/** The session's repository state from the hub: on open, when its summary changes, and after each turn. */
export function useRepoSession(session: Session): { repo?: RepoSessionDto; reload: (refresh?: boolean) => Promise<void>; set: (r: RepoSessionDto) => void } {
  const meta = sessionRepo(session);
  const [repo, setRepo] = useState<RepoSessionDto>();
  const key = `${session.id}:${JSON.stringify(meta ?? null)}:${session.status === 'running' ? 'run' : 'rest'}`;
  const reload = useCallback(
    async (refresh = false) => {
      const r = await api()
        .sessionRepo(session.id, refresh)
        .catch(() => undefined);
      if (r) setRepo(r);
    },
    [session.id],
  );
  useEffect(() => {
    if (!meta) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { repo: repo?.sessionId === session.id ? repo : undefined, reload, set: setRepo };
}

/** Push, Open pull request and Clean up, with the dialogs they need. */
export function useRepoActions(session: Session, repo: RepoSessionDto | undefined, reload: (refresh?: boolean) => Promise<void>) {
  const mobile = useIsMobile();
  const [commit, setCommit] = useState<{ message: string } | undefined>();
  const [pr, setPr] = useState<PrDraft & { draft: boolean; message: string }>();
  const [clean, setClean] = useState(false);
  const [merge, setMerge] = useState<{ squash: boolean }>();
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState<string | false>(false);
  const size = mobile ? 'touch' : 'md';
  const dirty = repo?.dirty ?? 0;
  const commitWords = `${dirty} ${dirty === 1 ? 'file is' : 'files are'} not committed.`;
  const defaultMessage = session.title && session.title !== 'New chat' ? session.title : 'Work from Conclave';

  const push = async (commitMessage?: string) => {
    setBusy('push');
    const r = await attempt(() => api().pushSession(session.id, commitMessage ? { commitMessage } : {}));
    setBusy(false);
    if (r) toast({ title: r.line, level: 'success' });
    await reload();
  };
  const startPush = () => (dirty ? setCommit({ message: defaultMessage }) : void push());
  const startPr = async () => {
    setBusy('draft');
    const d = await attempt(() => api().prDraft(session.id));
    setBusy(false);
    if (d) setPr({ ...d, draft: false, message: defaultMessage });
  };
  const openPr = async () => {
    if (!pr) return;
    setBusy('pr');
    // what is not committed goes in a commit first, so the pull request has it
    if (dirty && !(await attempt(() => api().pushSession(session.id, { commitMessage: pr.message.trim() || defaultMessage })))) return setBusy(false);
    const r = await attempt(() => api().openPullRequest(session.id, { title: pr.title.trim(), body: pr.body, ...(pr.draft ? { draft: true } : {}) }));
    setBusy(false);
    if (!r) return;
    setPr(undefined);
    toast({ title: `Opened pull request #${r.pr?.number}.`, level: 'success' });
    await reload();
  };
  const cleanUp = async (discard = false) => {
    const done = !!repo?.canCleanUp;
    const r = await attempt(() => api().cleanupSession(session.id, discard ? { discard: true, force: true } : done && !dirty ? {} : { force: true }));
    if (r) toast({ title: r.line, level: 'success' });
    await reload();
  };
  const doMerge = async () => {
    setBusy('merge');
    const r = await attempt(() => api().mergeSession(session.id, merge?.squash ? { squash: true } : {}));
    setBusy(false);
    setMerge(undefined);
    if (r) toast({ title: r.line, level: 'success' });
    await reload();
  };
  const commits = repo?.commits ?? 0;
  const folderGone = repo ? `The worktree on ${repo.deviceName} and ${branchShort(repo.branch)} go.` : '';

  const dialogs = (
    <>
      <Dialog
        open={!!commit}
        onClose={() => setCommit(undefined)}
        title="Commit and push?"
        description={`${commitWords} The hub commits them on ${repo ? branchShort(repo.branch) : 'the branch'}, then pushes.`}
        footer={
          <>
            <Button variant="quiet" size={size} onClick={() => setCommit(undefined)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              size={size}
              busy={busy === 'push' ? 'Pushing' : false}
              onClick={async () => {
                await push(commit?.message.trim() || defaultMessage);
                setCommit(undefined);
              }}
            >
              Commit and push
            </Button>
          </>
        }
      >
        <label htmlFor="repo-commit-message" className="mb-1.5 block text-[12px] text-fg-3 phone:text-[14px]">
          Commit message
        </label>
        <Input id="repo-commit-message" value={commit?.message ?? ''} onChange={(e) => setCommit({ message: e.target.value })} autoFocus />
      </Dialog>
      <Dialog
        open={!!pr}
        onClose={() => setPr(undefined)}
        width={640}
        title="Open a pull request"
        description={pr && repo ? `${repo.repo}, ${branchShort(pr.head)} into ${pr.base}. Drafted from the session; change it as you like.` : undefined}
        footer={
          <>
            <Button variant="quiet" size={size} onClick={() => setPr(undefined)}>
              Cancel
            </Button>
            <Button variant="solid" size={size} disabled={!pr?.title.trim()} busy={busy === 'pr' ? 'Opening' : false} onClick={() => void openPr()}>
              Open pull request
            </Button>
          </>
        }
      >
        {pr && (
          <div className="space-y-3">
            <div>
              <label htmlFor="pr-title" className="mb-1.5 block text-[12px] text-fg-3 phone:text-[14px]">
                Title
              </label>
              <Input id="pr-title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} autoFocus />
            </div>
            <div>
              <label htmlFor="pr-body" className="mb-1.5 block text-[12px] text-fg-3 phone:text-[14px]">
                Description
              </label>
              <Textarea id="pr-body" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} minRows={6} maxRows={14} />
            </div>
            {dirty > 0 && (
              <div>
                <label htmlFor="pr-commit" className="mb-1.5 block text-[12px] text-fg-3 phone:text-[14px]">
                  {commitWords} They go in a commit first:
                </label>
                <Input id="pr-commit" value={pr.message} onChange={(e) => setPr({ ...pr, message: e.target.value })} />
              </div>
            )}
            <Checkbox checked={pr.draft} onChange={(draft) => setPr({ ...pr, draft })} label="Open as a draft" />
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!merge}
        onClose={() => setMerge(undefined)}
        title={repo ? `Merge into ${repo.base}?` : 'Merge?'}
        description={repo ? `${commits} ${commits === 1 ? 'commit' : 'commits'} of ${branchShort(repo.branch)} go into ${repo.base} in ${repo.clonePath}. Refused if that checkout has uncommitted changes or the merge conflicts.` : undefined}
        footer={
          <>
            <Button variant="quiet" size={size} onClick={() => setMerge(undefined)}>
              Cancel
            </Button>
            <Button variant="solid" size={size} busy={busy === 'merge' ? 'Merging' : false} onClick={() => void doMerge()}>
              Merge
            </Button>
          </>
        }
      >
        <Checkbox checked={!!merge?.squash} onChange={(squash) => setMerge({ squash })} label="Squash into one commit" />
      </Dialog>
      <ConfirmDialog
        open={discard}
        onClose={() => setDiscard(false)}
        tone="danger"
        title="Discard this worktree?"
        body={repo ? `${folderGone}${commits ? ` ${commits} ${commits === 1 ? 'commit is' : 'commits are'} not merged and are lost.` : ''}${dirty ? ` ${commitWords} They are lost.` : ''}` : undefined}
        confirm="Discard"
        busy="Discarding"
        onConfirm={async () => {
          await cleanUp(true);
          setDiscard(false);
        }}
      />
      <ConfirmDialog
        open={clean}
        onClose={() => setClean(false)}
        tone={dirty ? 'danger' : 'neutral'}
        title="Clean up?"
        body={
          repo?.folder && !repo.pr
            ? `${folderGone}${dirty ? ` ${commitWords} They are lost.` : ''}`
            : repo
              ? `The worktree on ${repo.deviceName} goes. ${branchShort(repo.branch)} stays on GitHub.${dirty ? ` ${commitWords} They are lost.` : ''}${repo.canCleanUp ? '' : ' The pull request is not merged or closed yet.'}`
              : undefined
        }
        confirm="Clean up"
        busy="Cleaning up"
        onConfirm={async () => {
          await cleanUp();
          setClean(false);
        }}
      />
    </>
  );
  return { startPush, startPr, startCleanUp: () => setClean(true), startMerge: () => setMerge({ squash: false }), startDiscard: () => setDiscard(true), busy, dialogs };
}

/** The line under the header (desktop) or over the composer (phones). */
export function RepoBar({ session }: { session: Session }) {
  const meta = sessionRepo(session);
  const mobile = useIsMobile();
  const { repo, reload } = useRepoSession(session);
  const act = useRepoActions(session, repo, reload);
  const [checking, setChecking] = useState(false);
  if (!meta) return null;
  const can = repo ? repoActions(repo) : { push: false, openPr: false, viewPr: !!meta.pr, cleanUp: false };
  const wt = repo ? worktreeActions(repo) : { merge: false, discard: false };
  const size = mobile ? 'touch' : 'sm';
  const href = repo ? repo.url : meta.folder ? '' : `https://github.com/${meta.repo}`;
  const repoLink = href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-fg hov:underline">
      {meta.repo}
    </a>
  ) : (
    <span className="text-fg">{meta.repo}</span>
  );
  const branch = <span className="font-mono text-[12px] text-fg-2 phone:text-[13px]">{branchShort(meta.branch)}</span>;
  // the hub's sentence, else the summary the session carries
  const ci = ciWords(meta.ci);
  const line = repo?.line ?? [meta.pr ? `${prWords(meta.pr)}.` : '', ci ? `${ci}.` : ''].filter(Boolean).join(' ');
  // phones keep one action over the composer; the conversation sheet has the rest
  const one = mobile ? (can.cleanUp ? 'cleanUp' : wt.merge ? 'merge' : can.openPr ? 'openPr' : can.push ? 'push' : undefined) : undefined;
  if (mobile) can.cleanUp = one === 'cleanUp';
  if (mobile) can.openPr = one === 'openPr';
  if (mobile) can.push = one === 'push';
  if (mobile) wt.merge = one === 'merge';
  if (mobile) wt.discard = false;
  const buttons = (
    <>
      {wt.merge && repo && (
        <Button variant="solid" size={size} onClick={act.startMerge}>
          Merge into {repo.base}
        </Button>
      )}
      {can.cleanUp && (
        <Button variant="solid" size={size} onClick={act.startCleanUp}>
          Clean up
        </Button>
      )}
      {can.openPr && (
        <Button variant={can.push ? 'outline' : 'solid'} size={size} busy={act.busy === 'draft' ? 'Drafting' : false} onClick={() => void act.startPr()}>
          Open pull request
        </Button>
      )}
      {can.push && (
        <Button variant="outline" size={size} busy={act.busy === 'push' ? 'Pushing' : false} onClick={act.startPush}>
          Push
        </Button>
      )}
      {wt.discard && (
        <Button variant="quiet" size={size} onClick={act.startDiscard}>
          Discard
        </Button>
      )}
      {meta.pr && !mobile && (
        <ButtonLink href={meta.pr.url} external variant="quiet" size={size}>
          View pull request
        </ButtonLink>
      )}
      {!mobile && !meta.cleaned && (meta.pr?.state === 'open' || repo?.pushed !== 'never') && (
        <Button
          variant="quiet"
          size={size}
          busy={checking ? 'Checking' : false}
          onClick={async () => {
            setChecking(true);
            await reload(true);
            setChecking(false);
          }}
        >
          Check now
        </Button>
      )}
    </>
  );
  return (
    <>
      <div className={cn('shrink-0', mobile ? 'mx-auto w-full px-4' : 'border-b border-rule bg-bg')} data-repo-bar>
        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', mobile ? 'border-t border-rule py-3' : 'mx-auto max-w-[924px] px-8 py-2')}>
          <p className="m-0 min-w-0 flex-[1_1_320px] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
            {repoLink} on {branch}
            <span className={cn('block', meta.pr?.state === 'open' && meta.ci ? TONE[ciTone(meta.ci)] : 'text-fg-3')}>{line}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2 phone:w-full">{buttons}</div>
        </div>
      </div>
      {act.dialogs}
    </>
  );
}

/** Rows for the phone's conversation sheet: Repository, Branch, Pull request. */
export function repoFacts(session: Session): Array<[string, ReactNode]> {
  const meta = sessionRepo(session);
  if (!meta) return [];
  return [
    ['Repository', meta.repo],
    ['Branch', <span className="font-mono text-[14px]">{branchShort(meta.branch)}</span>],
    ...(meta.pr
      ? [
          [
            'Pull request',
            <a href={meta.pr.url} target="_blank" rel="noreferrer" className={cn(meta.pr.state === 'merged' ? 'text-ok' : 'text-fg')}>
              {prWords(meta.pr, true)}
              {meta.ci && meta.pr.state === 'open' ? `, ${ciWords(meta.ci)?.toLowerCase()}` : ''}
            </a>,
          ] as [string, ReactNode],
        ]
      : []),
  ];
}

/** Push, Open pull request and Clean up as rows of the phone's conversation sheet. */
export function RepoSheetActions({ session, onClose, Action }: { session: Session; onClose: () => void; Action: (p: { children: ReactNode; onClick: () => void }) => ReactNode }) {
  const meta = sessionRepo(session);
  const { repo, reload } = useRepoSession(session);
  const act = useRepoActions(session, repo, reload);
  if (!meta) return null;
  const can = repo ? repoActions(repo) : undefined;
  const wt = repo ? worktreeActions(repo) : undefined;
  const later = (fn: () => void) => () => {
    onClose();
    setTimeout(fn, 0);
  };
  return (
    <>
      {wt?.merge && <Action onClick={later(act.startMerge)}>Merge into {repo?.base}</Action>}
      {can?.push && <Action onClick={later(act.startPush)}>Push</Action>}
      {can?.openPr && <Action onClick={later(() => void act.startPr())}>Open pull request</Action>}
      {can?.viewPr && meta.pr && <Action onClick={() => window.open(meta.pr!.url, '_blank', 'noreferrer')}>View pull request</Action>}
      {can?.cleanUp && <Action onClick={later(act.startCleanUp)}>Clean up</Action>}
      {wt?.discard && <Action onClick={later(act.startDiscard)}>Discard</Action>}
      {act.dialogs}
    </>
  );
}

/**
 * Archive for a repo session whose worktree is still there: it asks whether
 * to clean up too. Other sessions archive at once.
 */
export function useArchiveRepo(session: Session, archive: () => void | Promise<unknown>): { archive: () => void; dialog: ReactNode } {
  const meta = sessionRepo(session);
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const size = mobile ? 'touch' : 'md';
  const ask = !!meta && !meta.cleaned && !session.archived;
  const dialog = (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Archive and clean up?"
      description={meta ? `The worktree of ${meta.repo} is still there. Clean up removes it; ${meta.folder ? `${branchShort(meta.branch)} stays in the repository` : `${branchShort(meta.branch)} stays on GitHub`}. Files that are not committed are lost.` : undefined}
      footer={
        <>
          <Button
            variant="quiet"
            size={size}
            onClick={() => {
              setOpen(false);
              void archive();
            }}
          >
            Archive only
          </Button>
          <Button
            variant="solid"
            size={size}
            busy={busy ? 'Cleaning up' : false}
            onClick={async () => {
              setBusy(true);
              const r = await attempt(() => api().cleanupSession(session.id, { force: true }));
              setBusy(false);
              setOpen(false);
              if (r) {
                const s = await api()
                  .getSession(session.id)
                  .catch(() => undefined);
                if (s) upsertSession(s);
              }
              await archive();
            }}
          >
            Archive and clean up
          </Button>
        </>
      }
    >
      <span />
    </Dialog>
  );
  return { archive: () => (ask ? setOpen(true) : void archive()), dialog };
}
