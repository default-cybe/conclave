/**
 * What the owner does with a share a friend sent, once accepted (docs/
 * design/FRIENDS.md, phase 3): Continue as fork, Handoff (a fresh session
 * from a brief the owner edits first), Use as reference, and Apply code (a
 * plan the hub checks, then an approval, then a new branch).
 *
 * A fork's and a handoff's first turn asks before any tool runs, whatever
 * the permission mode; the owner's own next message lifts that.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import type { ApplyShareResult, ApplySharePlan, HandoffDraft, ReceivedShareDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { hrefOf } from '@/lib/recents';
import { branchHint, codeWords, planSentence, planUntil } from '@/lib/shares';
import { toast, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Command } from '@/components/ui/Code';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { DeviceFolderPicker } from '@/features/chat/pickers';
import { applyShare, forkShare, handoffShare, planApplyShare, referenceShare } from './actions';

const LABEL = 'text-[12px] font-medium text-fg-2 phone:text-[14px]';
const HELP = 'm-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]';

/** The one line under Continue as fork, and at the top of its dialog. */
export const FORK_LINE = 'Its first turn asks before any tool runs.';

/** Where a new session runs: a device and a folder, the hub's own until the owner picks. */
function Where({ device, cwd, onDevice, onCwd }: { device?: string; cwd?: string; onDevice: (id: string) => void; onCwd: (c: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>Runs on</span>
      <DeviceFolderPicker look="field" device={device} cwd={cwd} onDevice={onDevice} onCwd={onCwd} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Continue as fork
// ---------------------------------------------------------------------------

export function ForkDialog({ s, open, onClose }: { s: ReceivedShareDto; open: boolean; onClose: () => void }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  // the hub's own device until the owner picks another
  const [device, setDevice] = useState<string | undefined>(() => (useHub.getState().devices.local ? 'local' : undefined));
  const [cwd, setCwd] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const chat = s.kind === 'chat';
  useEffect(() => {
    if (!open) return;
    setPrompt('');
    setBusy(false);
  }, [open]);
  const size = phone ? 'touch' : 'md';
  const go = async () => {
    setBusy(true);
    const session = await forkShare(s.id, { ...(device ? { device } : {}), ...(cwd ? { cwd } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
    setBusy(false);
    if (!session) return;
    onClose();
    navigate(hrefOf(session));
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Continue as fork"
      width={540}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} busy={busy ? 'Starting' : false} onClick={() => void go()}>
            Continue as fork
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className={HELP}>
          A new {chat ? 'chat' : 'session'} on your models, with {s.friendName}'s turns quoted. <span className="text-fg">{FORK_LINE}</span> {s.friendName}'s copy stays as it is.
        </p>
        {!chat && <Where device={device} cwd={cwd} onDevice={setDevice} onCwd={setCwd} />}
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>
            First message <span className="font-normal text-fg-3">optional</span>
          </span>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} minRows={2} maxRows={8} prose placeholder="Carry on from here" aria-label="First message" />
          <span className="text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Empty: read it first and write when you are ready.</span>
        </label>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export function HandoffDialog({ s, open, onClose }: { s: ReceivedShareDto; open: boolean; onClose: () => void }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState<HandoffDraft>();
  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState('');
  // the hub's own device until the owner picks another
  const [device, setDevice] = useState<string | undefined>(() => (useHub.getState().devices.local ? 'local' : undefined));
  const [cwd, setCwd] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(undefined);
    setError(undefined);
    setBusy(false);
    let alive = true;
    api()
      .handoffDraft(s.id)
      .then((d) => {
        if (!alive) return;
        setDraft(d);
        setBrief(d.brief);
        setTitle(d.title);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, s.id]);
  const size = phone ? 'touch' : 'md';
  const go = async () => {
    setBusy(true);
    const session = await handoffShare(s.id, { brief: brief.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(device ? { device } : {}), ...(cwd ? { cwd } : {}) });
    setBusy(false);
    if (!session) return;
    onClose();
    navigate(hrefOf(session));
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Handoff"
      width={640}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} disabled={!draft || !brief.trim()} busy={busy ? 'Starting' : false} onClick={() => void go()}>
            Start session
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className={HELP}>
          A fresh session on your models starts from this brief. Edit it first: it is the session's first message. <span className="text-fg">{FORK_LINE}</span>
        </p>
        {error && <p className="m-0 text-[13px] text-fault phone:text-[14px]">{error}</p>}
        {!draft && !error && <p className="m-0 text-[13px] text-fg-3 phone:text-[14px]">Writing the brief</p>}
        {draft && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Title</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" className="phone:text-[16px]" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Brief</span>
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} minRows={8} maxRows={18} aria-label="Brief" className="text-[13px] phone:text-[15px]" />
            </label>
            {draft.files.length > 0 && (
              <div>
                <span className={LABEL}>Files it names</span>
                <ul className="m-0 mt-1 list-none p-0 font-mono text-[12px] leading-[1.6] text-fg-2 phone:text-[13px]">
                  {draft.files.slice(0, 12).map((f) => (
                    <li key={f} className="truncate">
                      {f}
                    </li>
                  ))}
                  {draft.files.length > 12 && <li className="font-sans text-fg-3">and {draft.files.length - 12} more</li>}
                </ul>
              </div>
            )}
            <Where device={device} cwd={cwd} onDevice={setDevice} onCwd={setCwd} />
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Use as reference
// ---------------------------------------------------------------------------

export function ReferenceDialog({ s, open, onClose }: { s: ReceivedShareDto; open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone="neutral"
      title="Use as reference?"
      body={`A read only copy your agents can find with past chat search, marked as ${s.friendName}'s and quoted. It never runs, and memory never learns from it. If ${s.friendName} unsends it, it goes.`}
      confirm="Keep as reference"
      busy="Keeping"
      onConfirm={async () => {
        const session = await referenceShare(s.id);
        if (session) toast({ title: 'Kept as a reference.', body: `Your agents can find it in past chats, marked as ${s.friendName}'s.`, level: 'success', action: { label: 'Open', run: () => navigate(hrefOf(session)) } });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Apply code
// ---------------------------------------------------------------------------

type ApplyStep = 'where' | 'plan' | 'done';

/**
 * The share's code onto a new branch: pick a device and a folder in the
 * repository there; the hub checks it and shows the plan; the owner
 * approves it; the branch is made without checking anything out.
 */
export function ApplyDialog({ s, code, open, onClose }: { s: ReceivedShareDto; code?: { kind: 'diff' | 'git-bundle'; files: string[]; branch?: string }; open: boolean; onClose: () => void }) {
  const phone = useIsMobile();
  const devicesMap = useHub((st) => st.devices);
  const devices = useMemo(() => Object.values(devicesMap).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)), [devicesMap]);
  const [step, setStep] = useState<ApplyStep>('where');
  const [device, setDevice] = useState('');
  const [cwd, setCwd] = useState('');
  const [branch, setBranch] = useState('');
  const [plan, setPlan] = useState<ApplySharePlan>();
  const [done, setDone] = useState<ApplyShareResult>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setStep('where');
    setPlan(undefined);
    setDone(undefined);
    setBusy(false);
    // a device that is on, a computer before the hub's own
    setDevice((d) => d || devices.find((x) => x.online && x.id !== 'local')?.id || devices.find((x) => x.online)?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const dev = devicesMap[device];
  const size = phone ? 'touch' : 'md';
  const hint = branchHint(s.friendName, s.title);

  const check = async () => {
    setBusy(true);
    const p = await planApplyShare(s.id, { device, cwd: cwd.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) });
    setBusy(false);
    if (!p) return;
    setPlan(p);
    setStep('plan');
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    const r = await applyShare(s.id, plan.planId);
    setBusy(false);
    if (!r) return;
    setDone(r);
    setStep('done');
  };

  const footer =
    step === 'where' ? (
      <>
        <Button variant="quiet" size={size} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="solid" size={size} disabled={!device || !cwd.trim()} busy={busy ? 'Checking' : false} onClick={() => void check()}>
          Check
        </Button>
      </>
    ) : step === 'plan' && plan ? (
      <>
        <Button variant="quiet" size={size} onClick={() => setStep('where')}>
          Back
        </Button>
        <Button variant="solid" size={size} disabled={!plan.check.ok} busy={busy ? 'Applying' : false} onClick={() => void apply()}>
          Apply to the new branch
        </Button>
      </>
    ) : (
      <Button variant="solid" size={size} onClick={onClose}>
        Done
      </Button>
    );

  return (
    <Dialog open={open} onClose={onClose} title={step === 'plan' ? 'Approve the code' : step === 'done' ? 'Applied' : 'Apply code'} width={600} footer={footer}>
      {step === 'where' && (
        <div className="flex flex-col gap-4">
          <p className={HELP}>
            {code ? `${codeWords(code)} from ${s.friendName}` : `The code ${s.friendName} sent`} goes onto a new branch in a repository you pick. The hub checks it first and shows you the plan. Nothing changes until you approve it.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Device</span>
            <Select value={device} onChange={(e) => setDevice(e.target.value)} aria-label="Device">
              {devices.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.online}>
                  {d.name}
                  {d.online ? '' : ' (offline)'}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Folder in the repository</span>
            <Input mono value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/project" aria-label="Folder in the repository" className="phone:text-[16px]" />
            {dev?.roots?.length ? (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {dev.roots.slice(0, 6).map((r) => (
                  <button key={r} type="button" onClick={() => setCwd(r)} className="mono min-h-8 text-[12px] text-fg-3 hover:text-fg phone:min-h-11 phone:text-[13px]">
                    {r}
                  </button>
                ))}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>
              Branch <span className="font-normal text-fg-3">optional</span>
            </span>
            <Input mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={hint} aria-label="Branch" className="phone:text-[16px]" />
          </label>
        </div>
      )}
      {step === 'plan' && plan && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-[1.5] text-fg phone:text-[15px]" aria-label={planSentence(plan)}>
            {plan.kind === 'diff' ? 'The diff' : 'The git bundle'} of {plan.files.length} {plan.files.length === 1 ? 'file' : 'files'} goes onto a new branch <span className="font-mono text-[0.92em] font-medium">{plan.branch}</span> in{' '}
            <span className="font-mono text-[0.92em]">{plan.root}</span> on {plan.deviceName}
            {plan.base ? `, from ${plan.base.slice(0, 10)}` : ''}.
          </p>
          {plan.check.ok ? (
            <p className="m-0 text-[13px] leading-[1.5] text-ok phone:text-[14px]">It applies cleanly.</p>
          ) : (
            <p className="m-0 text-[13px] leading-[1.5] text-fault phone:text-[14px]">It would not apply: {plan.check.error}</p>
          )}
          {plan.runsCode.length > 0 && (
            <div className="border-l-2 border-warn py-0.5 pl-3">
              <p className="m-0 text-[13px] leading-[1.5] text-warn phone:text-[14px]">These can run code once you check out or build. Read them first.</p>
              <ul className="m-0 mt-1 list-none p-0 font-mono text-[12px] leading-[1.6] text-fg phone:text-[13px]">
                {plan.runsCode.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <span className={LABEL}>Files</span>
            <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto p-0 font-mono text-[12px] leading-[1.6] text-fg-2 phone:text-[13px]">
              {plan.files.map((f) => (
                <li key={f} className={cn('truncate', plan.runsCode.includes(f) && 'text-warn')}>
                  {f}
                </li>
              ))}
            </ul>
          </div>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">Nothing is checked out and your working tree stays as it is. No hook or script from the share runs.</p>
          <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">{planUntil(plan)}</p>
        </div>
      )}
      {step === 'done' && done && (
        <div role="status" className="flex flex-col gap-3">
          <p className="m-0 text-[15px] leading-[1.45] text-fg phone:text-[16px]">
            <span className="font-mono text-[14px]">{done.branch}</span> is at <span className="font-mono text-[14px]">{done.commit.slice(0, 12)}</span>.
          </p>
          <p className={HELP}>Nothing was checked out. To look at it in {done.root}:</p>
          <Command command={`git switch ${done.branch}`} copy />
        </div>
      )}
    </Dialog>
  );
}
