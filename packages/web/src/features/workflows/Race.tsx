/**
 * A race's winner (race.js): who won and why, the other racers, its diff,
 * and Keep winner. Keeping applies the winner's branch to the run's checkout
 * (or opens a pull request from the repo session's branch); only then are
 * the other racers' branches deleted. Nothing happens without the owner.
 */
import { useState } from 'react';
import type { KeepWinnerHow, RaceResult, WorkflowRunDetail } from '@conclave/core/client';
import { sessionRepo } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { Notice, SectionHeading } from '@/components/ui/Section';
import { StateWord } from '@/components/ui/List';
import { Diff } from '@/components/ui/Code';
import { api } from '@/lib/api';
import { folderName } from '@/lib/format';
import { modelName } from '@/lib/models';
import { useIsMobile } from '@/lib/hooks';
import { attempt, toast, useHub } from '@/store/store';

/** The race block of a run's result, when the run was a race. */
export function raceOf(result: unknown): RaceResult | undefined {
  const r = (result as { race?: RaceResult } | null | undefined)?.race;
  return r && typeof r === 'object' && Array.isArray(r.arms) ? r : undefined;
}

export function Race({ detail, onKept }: { detail: WorkflowRunDetail; onKept: () => void }) {
  const race = raceOf(detail.result);
  const phone = useIsMobile();
  const session = useHub((s) => (detail.run.sessionId ? s.sessions[detail.run.sessionId] : undefined));
  const [diff, setDiff] = useState<string>();
  const [confirm, setConfirm] = useState<KeepWinnerHow>();
  const [busy, setBusy] = useState<string>();
  if (!race) return null;
  const run = detail.run;
  const callOf = (seq?: number) => (seq ? detail.calls.find((c) => c.seq === seq) : undefined);
  const win = race.arms.find((a) => a.seq === race.winner);
  const winCall = callOf(race.winner ?? undefined);
  const state = winCall?.worktree?.state;
  const others = race.arms.filter((a) => a !== win);
  const open = others.filter((a) => callOf(a.seq)?.worktree?.state === 'kept').length;
  const repo = sessionRepo(session);
  const size = phone ? 'touch' : 'sm';

  const showDiff = async () => {
    if (!race.winner) return;
    setBusy('diff');
    const r = await attempt(() => api().workflowWorktree(run.id, race.winner!, 'diff'));
    setBusy(undefined);
    if (r) setDiff(r.output);
  };
  const keep = async (how: KeepWinnerHow) => {
    setBusy(how);
    const r = await attempt(() => api().keepRaceWinner(run.id, how));
    setBusy(undefined);
    if (!r) return;
    onKept();
    if (!r.ok) {
      toast({ title: 'The winner was not kept', body: r.output.slice(0, 300), level: 'error' });
      return;
    }
    toast({ title: r.pr ? `Opened pull request #${r.pr.number}` : `Applied ${win?.arm ?? 'the winner'}`, body: r.discarded ? `Deleted the other ${r.discarded === 1 ? 'branch' : `${r.discarded} branches`}.` : '', level: 'success' });
  };

  return (
    <section aria-labelledby="wf-race">
      <SectionHeading id="wf-race">Winner</SectionHeading>
      {!win ? (
        <Notice className="mt-3">No racer passed the check, so there is nothing to keep. Each change is still on its branch below.</Notice>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 pt-3 phone:grid-cols-1">
          <div className="min-w-0 max-w-[80ch]">
            <div className="t-title text-fg">{win.arm}</div>
            <div className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
              {['Check passed', win.model ? modelName(win.model) : '', win.files !== undefined ? `${win.files} ${win.files === 1 ? 'file' : 'files'} changed` : '', win.score !== undefined ? `score ${win.score}` : '', winCall?.worktree?.branch].filter(Boolean).join(', ')}
            </div>
            {race.reasons.length > 0 && (
              <ul className="mt-2 space-y-1 text-[13px] text-fg-2 phone:text-[14px]">
                {race.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 phone:gap-2">
            {state === 'kept' ? (
              <>
                <Button variant="quiet" size={size} busy={busy === 'diff' ? 'Loading' : false} onClick={() => void showDiff()}>
                  Diff
                </Button>
                {repo && (
                  <Button variant="outline" size={size} busy={busy === 'pr' ? 'Opening' : false} disabled={!!busy} onClick={() => setConfirm('pr')}>
                    Open pull request
                  </Button>
                )}
                <Button variant="solid" size={size} busy={busy === 'apply' ? 'Applying' : false} disabled={!!busy} onClick={() => setConfirm('apply')}>
                  Keep winner
                </Button>
              </>
            ) : state === 'merged' && open > 0 && repo ? (
              // applied, but the pull request did not open: try it again; the merge is not redone
              <Button variant="outline" size={size} busy={busy === 'pr' ? 'Opening' : false} onClick={() => void keep('pr')}>
                Open pull request
              </Button>
            ) : (
              <StateWord tone="dim">{state === 'merged' ? 'applied' : (state ?? 'gone')}</StateWord>
            )}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div className="rows mt-3">
          {others.map((a) => (
            <div key={a.seq ?? a.arm} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-2 text-[13px] phone:text-[14px]">
              <span className="min-w-0 truncate text-fg-2">{a.arm}</span>
              <span className="text-fg-3">{!a.ran ? 'made no change' : a.passed ? `check passed${a.score !== undefined ? `, score ${a.score}` : ''}` : 'check failed'}</span>
            </div>
          ))}
        </div>
      )}
      {diff !== undefined && (
        <Dialog open onClose={() => setDiff(undefined)} title={winCall?.worktree?.branch ?? 'Diff'} width={760}>
          {diff.trim() ? <Diff diff={diff} maxLines={400} header={false} /> : <p className="text-[13px] text-fg-3">The branch has no changes against where it started.</p>}
        </Dialog>
      )}
      {confirm && win && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            const how = confirm;
            setConfirm(undefined);
            await keep(how);
          }}
          title={confirm === 'pr' ? `Open a pull request with ${win.arm}'s change?` : `Apply ${win.arm}'s change to ${folderName(run.cwd) || 'the run folder'}?`}
          body={`${confirm === 'pr' ? `Its branch is merged into ${repo?.branch ?? 'the session branch'}, pushed, and a pull request opens. Nothing merges on GitHub.` : 'Its branch is merged into the checked out branch. A conflict aborts and changes nothing.'}${open ? ` After that, the other ${open === 1 ? 'branch is' : `${open} branches are`} deleted.` : ''}`}
          confirm={confirm === 'pr' ? 'Open pull request' : 'Keep winner'}
          tone="neutral"
        />
      )}
    </section>
  );
}
