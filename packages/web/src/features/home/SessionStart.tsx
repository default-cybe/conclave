/**
 * The composer's targets for a new Assistant or Code session: the quiet row,
 * the "+" items and the send. Enter starts the session and opens it at
 * /s/:id.
 *
 * Assistant: the assistant agent on the hub. The row has the permission
 * mode at the left and the model with its effort at the right; no device or
 * folder.
 *
 * Code: the default coding agent (a custom one when picked under "+"). In
 * the desktop app it runs on the app's own computer; in a browser on the
 * hub, "madx (hub)", unless a device was picked in this browser before; on
 * a phone on the last computer used (start.ts startDevice). The row has the
 * permission mode, then the folder ("Choose folder" until one is set; the
 * first send asks for it), then the device unless it is the desktop app's
 * own computer. "+" holds the agent, the device (the hub always among
 * them), a GitHub repository and Ultra.
 * "/" lists the hub's commands, and Resume points at the last session.
 *
 * Effort is in the model's picker: the levels the model has (lib/effort.ts);
 * unset runs at the agent's own level. A level the next model lacks becomes
 * the nearest one it has.
 *
 * Phones (docs/design/MOBILE-V2.md 3, 4): the model with its effort sits in
 * the box (the same picker); the options sheet holds the device and folder,
 * the permission mode and Ultra, with the agent under More options. The
 * first send asks where to work when no folder is set yet.
 *
 * From GitHub (docs/DESIGN.md 30): with a repository picked, the session
 * starts in a new worktree of it on its own branch, on the device picked
 * (the hub unless you choose), so no folder is asked for.
 *
 * Run in a worktree: when the folder is in a git repository, "+" (and the
 * phone's options) offer a worktree of it on a new branch from its current
 * one, so several sessions work on one repository without clashing.
 *
 * A member (docs/design/ACCOUNTS.md 5) codes on devices of their own: the
 * hub never stands in, and with none paired the box says where to pair one
 * instead of starting.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { PermissionMode } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toast, upsertSession, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Input, Segmented } from '@/components/ui/Field';
import { effortOf, useModelEffort, type EffortSetting } from '@/lib/effort';
import type { CyberProgram } from '@conclave/core/providers/access-programs';
import { Sheet, type MenuItem } from '@/components/ui/Overlay';
import { SelectMenu } from '@/components/ui/Select';
import { LiveStatus } from '@/components/motion';
import { AgentPicker } from '@/components/pickers/Pickers';
import { DeviceFolderPicker, PermissionPicker } from '@/features/chat/pickers';
import { ULTRA_LINE } from '@/features/workflows/UltraSwitch';
import { keepSession, type Outgoing } from '@/features/conversation/actions';
import { SEND_EVENT, type ComposerTarget } from '@/features/conversation/ChatComposer';
import { useAgentFollow } from '@/features/conversation/ComposerParts';
import { OptionsButton } from '@/features/conversation/PhoneBox';
import { BranchPicker, RepoList, RepoPicker, type RepoPick } from '@/features/github/RepoPicker';
import { ASSISTANT_AGENT, CODE_AGENT, CODE_NEEDS_DEVICE, commandOf, customAgent, lastOwnSession, needsOwnDevice, placeName, readPicks, savePicks, sessionSetup, startCommands, startEffort, type Picks } from './start';
import { startSurface, useThisComputer } from './here';
import { DeviceChip, FolderChip, computerList, deviceItems, useComputers } from './Where';

export function useSessionTarget(kind: 'assistant' | 'code' = 'code'): ComposerTarget {
  const [, navigate] = useLocation();
  const mobile = useIsMobile();
  const agents = useHub((s) => s.agents);
  const devices = useHub((s) => s.devices);
  const sessions = useHub((s) => s.sessions);
  const hubCommands = useHub((s) => s.commands);
  const skills = useHub((s) => s.skills);
  // "/" lists the hub's commands and the skills; a skill runs as /<name> once the session starts
  const commands = useMemo(() => startCommands(hubCommands, skills), [hubCommands, skills]);
  const defaultModel = useHub((s) => s.hub?.defaultModel);
  const config = useHub((s) => s.config);
  const modelGroups = useHub((s) => s.models);
  const member = useHub((s) => s.me?.role === 'member');
  const here = useThisComputer();
  const computers = useComputers();
  const code = kind === 'code';
  // providers turned off (a coding agent's harness): the last session's model of theirs is not carried over
  const offProviders = useMemo(() => new Set(modelGroups.filter((g) => !g.enabled).map((g) => g.provider)), [modelGroups]);
  const [sheet, setSheet] = useState(false);
  const [asking, setAsking] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [moreOptions, setMoreOptions] = useState(false);
  const [wantRepo, setWantRepo] = useState(false);
  // the box clears at once; until the session opens, a line under it says it is starting
  const [starting, setStarting] = useState<number>();
  // the folder was asked for before the first send: once it is set, the message held goes
  const held = useRef(false);

  // the defaults come from the session you last worked in, read once so they do not move while you look
  const latest = useMemo(() => lastOwnSession(sessions, false, kind), [sessions, kind]);
  const [last, setLast] = useState(latest);
  if (!last && latest) setLast(latest);
  const resume = useMemo(() => lastOwnSession(sessions, true, kind), [sessions, kind]);
  const [picks, setPicks] = useState<Picks>(readPicks);
  const setup = sessionSetup({
    kind,
    picks,
    last,
    agents,
    defaultAgent: config?.defaultAgent as string | undefined,
    defaultDevice: config?.defaultDevice as string | undefined,
    defaultModel,
    devices,
    offProviders,
    member,
    surface: startSurface(),
    here,
  });
  const permissionMode = picks.permissionMode ?? ((config?.permissions as { mode?: PermissionMode } | undefined)?.mode || 'default');
  const effort = useModelEffort(setup.model);
  // what the session asks for: the pick as this model takes it; unset runs at the agent's level
  const thinking = startEffort(picks.thinking, effort);
  const follow = useAgentFollow(setup.agent, setup.model, code);
  const repo: RepoPick | undefined = code && picks.repo ? { repo: picks.repo, ...(picks.base ? { base: picks.base } : {}) } : undefined;
  // a folder picked here (the home folder too), or the last session's; a repository needs none; the assistant works on the hub
  const placeSet = !code || picks.cwd !== undefined || !!setup.cwd || !!repo;
  // "Run in a worktree" is offered only for a folder in a git repository: asked of the device once per folder
  const gitKey = code && !repo && setup.cwd ? `${setup.device}\n${setup.cwd}` : '';
  const [folderGit, setFolderGit] = useState<{ key: string; git: boolean; branch?: string }>();
  useEffect(() => {
    if (!gitKey) return;
    let live = true;
    const [device = '', cwd = ''] = gitKey.split('\n');
    api()
      .folderGit(device, cwd)
      .then((r) => live && setFolderGit({ key: gitKey, git: r.git, ...(r.branch ? { branch: r.branch } : {}) }))
      .catch(() => live && setFolderGit({ key: gitKey, git: false }));
    return () => {
      live = false;
    };
  }, [gitKey]);
  const isGit = !!gitKey && folderGit?.key === gitKey && folderGit.git;
  const worktreeOn = isGit && !!picks.worktree;
  const worktreeDetail = `A new branch${folderGit?.branch ? ` from ${folderGit.branch}` : ''}, so sessions do not clash. Merge or discard it when done.`;

  const update = (p: Picks) => {
    setPicks(p);
    savePicks(p);
  };
  // the default coding agent is no pick: a custom one is kept, and brings its own model and device
  const pickAgent = (agent: string) => update({ permissionMode: picks.permissionMode, thinking: picks.thinking, cyber: picks.cyber, ultra: picks.ultra, assistantModel: picks.assistantModel, ...(agent !== CODE_AGENT ? { agent } : {}) });
  // another model keeps the Effort level when it has it, else the nearest one it has
  const pickModel = (model: string) => {
    const thinking = startEffort(picks.thinking, effortOf(modelGroups, model));
    update(code ? { ...picks, agent: picks.agent, model, thinking } : { ...picks, assistantModel: model, thinking });
  };
  // unset goes back to the agent's level (Code runs at medium unless told, engine.ts CODING_AGENTS)
  const pickEffort = (v: EffortSetting | undefined) => update({ ...picks, thinking: v });
  const pickCyber = (v: CyberProgram | undefined) => update({ ...picks, cyber: v });
  // a device picked by hand is kept for this browser (start.ts startDevice); a folder keeps the device it is on
  const pickDevice = (device: string) => update({ ...picks, device, cwd: undefined, cwdDevice: undefined });
  const pickCwd = (cwd: string) => update({ ...picks, cwd, cwdDevice: setup.device, repo: undefined, base: undefined });
  /** The folder chip's pick: the first send waited for it, so the message goes now. */
  const chooseCwd = (cwd: string) => {
    pickCwd(cwd);
    if (!held.current) return;
    held.current = false;
    // the composer sends what it held once the folder is in the setup
    setTimeout(() => window.dispatchEvent(new Event(SEND_EVENT)), 0);
  };
  const folderChip = (v: boolean) => {
    setFolderOpen(v);
    // closed without a pick: the message stays in the box
    if (!v) held.current = false;
  };
  // the first repository picked moves the session to the hub (a member's stays on their device); a device picked after it stays
  const pickRepo = (v: RepoPick | undefined) => {
    setWantRepo(!!v);
    update({ ...picks, repo: v?.repo, base: v?.base, ...(v && !picks.repo ? { device: member ? setup.device : 'local', cwd: undefined, cwdDevice: undefined } : {}) });
  };
  const pickBase = (base: string | undefined) => update({ ...picks, base });

  const send = async (out: Outgoing): Promise<boolean> => {
    const command = commandOf(out.text, commands);
    const files = out.attachments.length > 0;
    setStarting(Date.now());
    try {
      const common = {
        agent: setup.agent,
        model: setup.model,
        device: setup.device,
        prompt: command || files ? undefined : out.text || undefined,
        ...(picks.permissionMode ? { permissionMode: picks.permissionMode } : {}),
        ...(thinking || picks.cyber ? { chat: { ...(thinking ? { thinking } : {}), ...(picks.cyber ? { cyber: picks.cyber } : {}) } } : {}),
      };
      // a folder set by the first send has not been asked about yet: ask now
      const inWorktree =
        !!picks.worktree && code && !repo && !!setup.cwd && (folderGit?.key === gitKey ? folderGit.git : !!(await api().folderGit(setup.device, setup.cwd).catch(() => undefined))?.git);
      const s = await attempt(() =>
        repo
          ? api().createRepoSession({ ...common, repo: repo.repo, ...(repo.base ? { base: repo.base } : {}) })
          : inWorktree && setup.cwd
            ? api().createWorktreeSession({ ...common, folder: setup.cwd })
            : api().createSession({ ...common, cwd: setup.cwd }),
      );
      if (!s) return false;
      keepSession(s);
      if (code && picks.ultra) {
        const on = await attempt(() => api().updateSession(s.id, { ultra: true }));
        if (on) upsertSession(on);
      }
      if (command) {
        const r = await attempt(() => api().command(s.id, out.text.trim()));
        if (r?.output) toast({ title: `/${command}`, body: r.output, level: 'info' });
      } else if (files) {
        await attempt(() => api().send(s.id, { text: out.text, attachments: out.attachments }));
      }
      // still on the new conversation: open it. Gone elsewhere meanwhile: it waits in the sidebar
      if (window.location.pathname === '/') navigate(`/s/${s.id}`);
      return true;
    } finally {
      setStarting(undefined);
    }
  };

  const deviceName = placeName(devices[setup.device], setup.device);
  // the device says itself unless it is the obvious one: the desktop app's own computer, or the only place there is
  const showDevice = code && !repo && setup.device !== here && computers.length > 1;
  const customs = agents.filter((a) => (a.primary !== false && a.source !== 'builtin' && customAgent(a.name)) || a.name === picks.agent);

  // a member with no device of their own: the hub's computer would refuse every tool, so say where code runs
  if (code && needsOwnDevice(member, devices))
    return {
      model: setup.model,
      onModel: pickModel,
      onEffort: pickEffort,
      phoneOptions: null,
      prepare: () => false,
      send: async () => false,
      sendLabel: 'Start session',
      placeholder: 'Describe a task',
      note: (
        <p>
          {CODE_NEEDS_DEVICE}{' '}
          <Link href="/devices" className="link">
            Pair yours in Devices.
          </Link>
        </p>
      ),
    };

  const plus: MenuItem[] = code
    ? [
        ...(customs.length ? [{ group: true, label: 'Agent' }, { label: `${CODE_AGENT}, the default`, detail: 'Hands work to its subagents itself', checked: setup.agent === CODE_AGENT, onSelect: () => pickAgent(CODE_AGENT) }, ...customs.map((a) => ({ label: a.name, detail: a.description, checked: setup.agent === a.name, onSelect: () => pickAgent(a.name) }))] : []),
        ...(computers.length > 1 ? deviceItems(computers, setup.device, pickDevice) : []),
        { group: true, label: 'Work in' },
        // back from a repository (picked, or only asked for): the folder chip again, open when there is no repository to drop
        { label: 'A folder', checked: !repo && !wantRepo, onSelect: () => (repo ? pickRepo(undefined) : (setWantRepo(false), setTimeout(() => setFolderOpen(true), 0))) },
        { label: 'A GitHub repository', detail: 'A new worktree on its own branch', checked: !!repo || wantRepo, onSelect: () => setWantRepo(true) },
        ...(isGit && !wantRepo ? [{ label: 'Run in a worktree', detail: worktreeDetail, checked: worktreeOn, keep: true, onSelect: () => update({ ...picks, worktree: !picks.worktree || undefined }) }] : []),
        { separator: true, label: '' },
        { label: 'Ultra', detail: ULTRA_LINE, checked: !!picks.ultra, keep: true, onSelect: () => update({ ...picks, ultra: !picks.ultra || undefined }) },
      ]
    : [];

  const permission = <PermissionPicker look="text" value={permissionMode} onChange={(m) => update({ ...picks, permissionMode: m })} className="h-[24px] text-[12px]" />;
  const left = (
    <>
      {permission}
      {code &&
        (repo || wantRepo ? (
          <>
            <RepoPicker look="text" value={repo} onChange={pickRepo} className="h-[24px] text-[12px]" />
            {repo && <BranchPicker look="text" repo={repo.repo} value={repo.base} onChange={pickBase} className="h-[24px] text-[12px]" />}
          </>
        ) : (
          <FolderChip device={setup.device} cwd={picks.cwd ?? setup.cwd} onCwd={chooseCwd} open={folderOpen} onOpenChange={folderChip} />
        ))}
      {showDevice && <DeviceChip device={setup.device} onDevice={pickDevice} />}
    </>
  );

  const field = {
    agent: <AgentPicker look="field" value={setup.agent} onChange={pickAgent} />,
    device: <DeviceFolderPicker look="field" device={setup.device} cwd={setup.cwd} onDevice={pickDevice} onCwd={repo ? undefined : pickCwd} showCwd={!repo} />,
    repo: <RepoPicker look="field" value={repo} onChange={pickRepo} />,
    base: repo ? <BranchPicker look="field" repo={repo.repo} value={repo.base} onChange={pickBase} /> : null,
  };

  return {
    left,
    model: setup.model,
    // Code may run on Claude Code or Codex when the owner turned them on as engines (Settings, Providers)
    harnesses: code,
    effort: thinking,
    follow,
    onModel: pickModel,
    onEffort: pickEffort,
    cyber: picks.cyber,
    onCyber: pickCyber,
    plus,
    phoneOptions: (
      <>
        <OptionsButton label={code ? `Options: ${setup.agent ?? 'agent'} on ${deviceName}` : 'Options: permissions'} onClick={() => setSheet(true)} />
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Options">
          <div className="space-y-5 px-4 pb-5">
            {code && <Row label={repo ? 'Device' : 'Device and folder'}>{field.device}</Row>}
            {code && <Row label="GitHub repository">{field.repo}</Row>}
            {repo && <Row label="Start from">{field.base}</Row>}
            {isGit && (
              <Row label="Run in a worktree">
                <SelectMenu
                  look="field"
                  label="Run in a worktree"
                  value={worktreeOn ? 'on' : 'off'}
                  onChange={(v) => update({ ...picks, worktree: v === 'on' || undefined })}
                  options={[
                    { value: 'off', label: 'Off', text: 'Off', detail: 'Works in the folder itself.' },
                    { value: 'on', label: 'On', text: 'On', detail: worktreeDetail },
                  ]}
                />
              </Row>
            )}
            <Row label="Permissions">
              <PermissionPicker look="field" value={permissionMode} onChange={(m) => update({ ...picks, permissionMode: m })} />
            </Row>
            {code && (
              <Row label="Ultra">
                <SelectMenu
                  look="field"
                  label="Ultra"
                  value={picks.ultra ? 'on' : 'off'}
                  onChange={(v) => update({ ...picks, ultra: v === 'on' || undefined })}
                  options={[
                    { value: 'off', label: 'Off', text: 'Off', detail: 'Workflows only when you ask or the task clearly needs one.' },
                    { value: 'on', label: 'On', text: 'On', detail: ULTRA_LINE },
                  ]}
                />
              </Row>
            )}
            {/* the default coding agent hands work to its subagents itself: another agent is for custom ones */}
            {code && (
              <div>
                <button type="button" aria-expanded={moreOptions} onClick={() => setMoreOptions((o) => !o)} className="flex min-h-11 items-center text-[15px] text-fg-2">
                  More options
                </button>
                {moreOptions && <Row label="Agent">{field.agent}</Row>}
              </div>
            )}
          </div>
        </Sheet>
        {code && (
          <PlaceSheet
            open={asking}
            onClose={() => setAsking(false)}
            device={setup.device}
            cwd={picks.cwd ?? setup.cwd}
            onDevice={pickDevice}
            onStart={(cwd) => {
              pickCwd(cwd);
              setAsking(false);
              // the composer sends what it held once the folder is in the setup
              setTimeout(() => window.dispatchEvent(new Event(SEND_EVENT)), 0);
            }}
            onStartRepo={(r) => {
              update({ ...picks, device: setup.device, cwd: undefined, repo: r.repo, base: r.base });
              setAsking(false);
              setTimeout(() => window.dispatchEvent(new Event(SEND_EVENT)), 0);
            }}
          />
        )}
      </>
    ),
    // Code asks where to work before the first send when no folder is set yet: the sheet on phones, the folder chip elsewhere
    prepare: () => {
      if (placeSet) return true;
      if (mobile) setAsking(true);
      else {
        held.current = true;
        setFolderOpen(true);
      }
      return false;
    },
    send,
    sendLabel: 'Start session',
    placeholder: mobile ? (code ? 'Describe a task' : 'Ask your assistant') : 'Type / for commands',
    commands,
    note: starting ? (
      <LiveStatus state="tool" label={repo ? `Making a worktree of ${repo.repo}` : worktreeOn ? 'Making a worktree' : 'Starting the session'} detail={code ? `${setup.agent ?? 'agent'} on ${deviceName}` : 'on the hub'} startedAt={starting} />
    ) : resume && !mobile ? (
      <p className="truncate">
        Resume{' '}
        <Link href={`/s/${resume.id}`} className="link">
          {resume.title}
        </Link>
        {resume.agent !== ASSISTANT_AGENT && resume.agent !== CODE_AGENT && `, ${resume.agent}`}, <span className="num">{relTime(resume.updatedAt)}</span>
      </p>
    ) : undefined,
  };
}

/** Where a new session works: a device, then a folder on it (one it worked in before, or typed), or a GitHub repository. */
function PlaceSheet({
  open,
  onClose,
  device,
  cwd,
  onDevice,
  onStart,
  onStartRepo,
}: {
  open: boolean;
  onClose: () => void;
  device: string;
  cwd?: string;
  onDevice: (id: string) => void;
  onStart: (cwd: string) => void;
  onStartRepo: (r: RepoPick) => void;
}) {
  const devices = useHub((s) => s.devices);
  const sessions = useHub((s) => s.sessions);
  const [path, setPath] = useState(cwd ?? '');
  const [from, setFrom] = useState<'folder' | 'github'>('folder');
  const [repo, setRepo] = useState<RepoPick>();
  useEffect(() => {
    if (open) setPath(cwd && cwd !== '~' ? cwd : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const list = useMemo(() => computerList(devices), [devices]);
  const known = useMemo(() => {
    const seen = new Set<string>();
    for (const s of Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)) if (s.device === device && s.kind !== 'chat' && s.cwd && s.cwd !== '~') seen.add(s.cwd);
    for (const r of devices[device]?.roots ?? []) seen.add(r);
    return [...seen].slice(0, 4);
  }, [sessions, devices, device]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Where should it work?"
      footer={
        <Button variant="solid" size="touch" full disabled={!devices[device]?.online || (from === 'github' && !repo)} onClick={() => (from === 'github' ? repo && onStartRepo(repo) : onStart(path.trim() || '~'))} className="h-12! rounded-[12px]! text-[16px]!">
          Start
        </Button>
      }
    >
      <div className="px-4 pb-4">
        <div className="pb-1 text-[13px] font-medium text-fg-2">Device</div>
        {list.map((d) => (
          <button key={d.id} type="button" aria-pressed={d.id === device} onClick={() => onDevice(d.id)} className={cn('flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[16px]', d.id === device ? 'bg-hover text-fg' : 'text-fg-2')}>
            <span className="min-w-0 flex-1 truncate">{placeName(d)}</span>
            <span className={cn('text-[14px]', d.online ? 'text-ok' : 'text-fg-3')}>{d.online ? 'online' : 'offline'}</span>
          </button>
        ))}
        <Segmented
          full
          size="touch"
          label="Work in"
          className="mt-4"
          value={from}
          onChange={setFrom}
          options={[
            { value: 'folder', label: 'Folder' },
            { value: 'github', label: 'GitHub' },
          ]}
        />
        {from === 'github' && (
          <div className="mt-3">
            <RepoList value={repo?.repo} onPick={(r) => setRepo({ repo: r.fullName })} className="-mx-2 max-h-[40dvh]" />
            {repo && (
              <div className="mt-3">
                <div className="pb-1.5 text-[13px] font-medium text-fg-2">Start from</div>
                <BranchPicker look="field" repo={repo.repo} value={repo.base} onChange={(base) => setRepo({ repo: repo.repo, ...(base ? { base } : {}) })} />
              </div>
            )}
          </div>
        )}
        {from === 'folder' && (
          <>
            <label htmlFor="start-folder" className="mt-4 block pb-1.5 text-[13px] font-medium text-fg-2">
              Folder
            </label>
            <Input id="start-folder" mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/project" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </>
        )}
        {from === 'folder' && known.length > 0 && (
          <div className="mt-1.5 flex flex-col">
            {known.map((k) => (
              <button key={k} type="button" onClick={() => setPath(k)} className="flex min-h-11 items-center text-left font-mono text-[14px] text-fg-2">
                <span className="truncate">{k}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-fg-2">{label}</div>
      {children}
    </div>
  );
}
