/**
 * Branches a run kept (spec 3.18): branch, files changed, and the owner's
 * Diff, Merge, Cherry-pick and Discard. Each change to the repository is
 * an owner action with a confirm and an audit entry on the hub. A diff's
 * lines take comments for the session that started the run (CommentTray).
 */
import { useMemo, useState } from 'react';
import type { WorkflowCall, WorktreeAction } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { SectionHeading } from '@/components/ui/Section';
import { StateWord } from '@/components/ui/List';
import { Diff } from '@/components/ui/Code';
import { api } from '@/lib/api';
import { parseDiff } from '@/lib/text';
import { attempt, toast, useHub } from '@/store/store';
import { CommentTray, commentTo } from '../chat/CommentTray';

const STATE_WORD = { live: 'in use', kept: 'kept', removed: 'removed', merged: 'merged', discarded: 'discarded' } as const;

export function Worktrees({ runId, sessionId, calls, onChange }: { runId: string; sessionId?: string; calls: WorkflowCall[]; onChange: (seq: number, state: NonNullable<WorkflowCall['worktree']>['state']) => void }) {
  const kept = calls.filter((c) => c.worktree && c.worktree.state !== 'removed');
  const [diff, setDiff] = useState<{ call: WorkflowCall; text: string }>();
  const files = useMemo(() => (diff ? parseDiff(diff.text) : []), [diff]);
  const session = useHub((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const [confirm, setConfirm] = useState<{ call: WorkflowCall; action: WorktreeAction }>();
  const [busy, setBusy] = useState<string>();
  if (!kept.length) return null;

  const act = async (call: WorkflowCall, action: WorktreeAction) => {
    setBusy(`${call.seq}:${action}`);
    const r = await attempt(() => api().workflowWorktree(runId, call.seq, action));
    setBusy(undefined);
    if (!r) return;
    if (action === 'diff') {
      setDiff({ call, text: r.output });
      return;
    }
    if (!r.ok) {
      toast({ title: `${action === 'merge' ? 'Merge' : action === 'cherry-pick' ? 'Cherry-pick' : 'Discard'} did not apply`, body: r.output.slice(0, 300), level: 'error' });
      return;
    }
    onChange(call.seq, r.state);
    toast({ title: action === 'discard' ? `Deleted ${call.worktree!.branch}` : `Applied ${call.worktree!.branch}`, level: 'success' });
  };

  return (
    <section aria-labelledby="wf-worktrees">
      <SectionHeading id="wf-worktrees" count={kept.length}>
        Branches
      </SectionHeading>
      <div className="rows">
        {kept.map((c) => {
          const wt = c.worktree!;
          const open = wt.state === 'kept';
          return (
            <div key={c.seq} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-3 phone:grid-cols-1">
              <div className="min-w-0">
                <div className="mono truncate text-[13px] text-fg">{wt.branch}</div>
                <div className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
                  {c.label}
                  {wt.files !== undefined ? `, ${wt.files} ${wt.files === 1 ? 'file' : 'files'} changed` : ''}
                  {wt.commit ? `, ${wt.commit.slice(0, 10)}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1 phone:mt-2">
                {open ? (
                  <>
                    <Button variant="quiet" size="sm" busy={busy === `${c.seq}:diff` ? 'Loading' : false} onClick={() => act(c, 'diff')}>
                      Diff
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setConfirm({ call: c, action: 'merge' })}>
                      Merge
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setConfirm({ call: c, action: 'cherry-pick' })}>
                      Cherry-pick
                    </Button>
                    <Button variant="quiet-fault" size="sm" onClick={() => setConfirm({ call: c, action: 'discard' })}>
                      Discard
                    </Button>
                  </>
                ) : (
                  <StateWord tone="dim">{STATE_WORD[wt.state]}</StateWord>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {diff && (
        <Dialog open onClose={() => setDiff(undefined)} title={diff.call.worktree!.branch} width={760}>
          {files.length ? (
            <div className="space-y-4">
              {files.map((f, i) => (
                <Diff key={`${f.path}${i}`} file={f} verb="Changed" maxLines={400} header={files.length > 1} onComment={session ? commentTo(session.id, diff.call.worktree!.branch) : undefined} />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-fg-3">The branch has no changes against where it started.</p>
          )}
          {session && (
            <div className="sticky bottom-0 mt-3 bg-raise">
              <CommentTray session={session} />
            </div>
          )}
        </Dialog>
      )}
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            const c = confirm;
            setConfirm(undefined);
            await act(c.call, c.action);
          }}
          title={confirm.action === 'discard' ? `Delete branch ${confirm.call.worktree!.branch}?` : confirm.action === 'merge' ? `Merge ${confirm.call.worktree!.branch} into the current branch?` : `Cherry-pick the commits of ${confirm.call.worktree!.branch}?`}
          body={confirm.action === 'discard' ? 'Its commits stay in the reflog for a while; the run view keeps the record.' : 'This changes the working tree of the run folder on its device. A conflict aborts and changes nothing.'}
          confirm={confirm.action === 'discard' ? 'Delete' : confirm.action === 'merge' ? 'Merge' : 'Cherry-pick'}
          tone={confirm.action === 'discard' ? 'danger' : 'neutral'}
        />
      )}
    </section>
  );
}
