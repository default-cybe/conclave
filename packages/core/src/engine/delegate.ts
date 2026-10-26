/**
 * Delegate (tools/delegate.ts): a primary session (a chat, the assistant, a
 * Code session) hands a job to a Code or Assistant session on one of the
 * owner's devices, waits for its answer and returns it, or with background
 * gets it later as a note, as a background Task does. The child is a real
 * session with parentId set to the caller, on the device and in the folder
 * it was sent to, in the caller's permission mode. readOnly takes its
 * file-editing tools away (engine.ts toolsFor); it does not change the mode.
 */
import type { Device, PermissionMode, Session } from '../types';
import type { Engine } from './engine';
import type { DelegateOutcome, DelegatePlace, DelegateRequest } from '../tools/delegate';
import { projectsOf } from '../projects/attached';
import { agentModelRef } from '../extensions/agent-model';
import { CHAT_AGENT, chatUsesMemory } from '../session/chat';
import { isUntrusted } from '../session/untrusted';
import { isDelegated, movedSession, movedToMain } from '../session/delegated';
import { EngineError } from './errors';
import { missingTools } from './tool-check';
import { runSubagent } from './subagent';

/**
 * Why this session may not delegate, or undefined when it may. Only a
 * primary session at depth 0 hands work on: never a subagent (a delegated
 * session included), a workflow step, a session that reads untrusted input
 * or a member's session.
 */
export function delegateRefusal(engine: Engine, session: Session, depth: number, agentUntrusted?: boolean): string | undefined {
  if (engine.isMemberSession(session)) return "Delegate is the hub owner's: this session cannot hand work to other sessions.";
  if (depth > 0 || session.meta?.subagent) return 'Delegate is not available in a subagent. Do the work yourself, or report back and let the session that started you hand it on.';
  if (session.meta?.workflow) return 'Delegate is not available in a workflow step.';
  if (isUntrusted(session, agentUntrusted ?? engine.agentFor(session).untrusted)) return 'Delegate is not available in a session that reads untrusted input.';
  return undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
const HUB_WORDS = new Set(['hub', 'thehub', 'local', 'localhost', 'here']);

/**
 * A device by the name the model wrote, loosely: case and spaces, dashes
 * and underscores do not count ("madx-arch" is "MadX Arch"). An exact match
 * wins, then the one device whose name contains it. The hub is the default.
 */
export function findDevice(devices: Device[], name: string | undefined): Device | { error: string } {
  const hub = devices.find((d) => d.id === 'local') ?? devices[0];
  const want = name ? norm(name) : '';
  if (!want || HUB_WORDS.has(want)) return hub;
  const exact = devices.find((d) => norm(d.name) === want || norm(d.id) === want);
  if (exact) return exact;
  const near = devices.filter((d) => norm(d.name).includes(want));
  if (near.length === 1) return near[0];
  const names = devices.map((d) => `${d.name}${d.id === 'local' ? ' (the hub)' : d.online ? '' : ' (offline)'}`).join(', ');
  return { error: near.length > 1 ? `"${name}" could be ${near.map((d) => d.name).join(' or ')}. Name one of them.` : `There is no device called "${name}". The devices are: ${names}.` };
}

function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** The words for a device that is not connected. */
export function offlineWords(device: Device, devices: Device[], now = Date.now()): string {
  const seen = device.lastSeenAt ? ` (last seen ${ago(now - device.lastSeenAt)} ago)` : '';
  const online = devices.filter((d) => d.online).map((d) => d.name);
  return `${device.name} is offline${seen}, so nothing can run there now. Its Conclave daemon has to be running and connected. Online now: ${online.join(', ')}.`;
}

/** Most project folders a device line lists. */
const MAX_FOLDERS = 5;

function tilde(path: string, home: string | undefined): string {
  if (!home || home === '/') return path;
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A device's known project folders, the ones used last first: up to five, then how many more. */
function projectFolders(engine: Engine, d: Device): string[] {
  const store = projectsOf(engine)?.store;
  if (!store) return [];
  const locs = store.locationsOnDevice(d.id).sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0));
  const paths = [...new Set(locs.map((l) => tilde(l.path, d.info?.home)))];
  if (paths.length <= MAX_FOLDERS) return paths;
  return [...paths.slice(0, MAX_FOLDERS), `${paths.length - MAX_FOLDERS} more`];
}

/**
 * The devices a session can hand work to, for the end of Delegate's
 * description: each online one by name with its known project folders, then
 * the ones that are offline. The runner reads it once per turn, so a device
 * that connects mid-turn does not change the tools the cache holds.
 */
export function delegateCatalog(engine: Engine, session: Session): string {
  const devices = engine.devices.list(engine.accountOf(session));
  const lines = devices.filter((d) => d.online).map((d) => {
    const folders = projectFolders(engine, d);
    return `- ${d.name}${d.id === 'local' ? ' (the hub, the default)' : ''}${folders.length ? `: ${folders.join(', ')}` : ''}`;
  });
  const offline = devices.filter((d) => !d.online).map((d) => d.name);
  return `\n\nDevices online now, with their known project folders:\n${lines.join('\n')}${offline.length ? `\nOffline now, so nothing runs there: ${offline.join(', ')}.` : ''}`;
}

/**
 * The child's permission mode: the parent's, so bypass stays bypass and plan stays plan.
 * The owner chose that mode for this work; a child that asks (or plans) instead stalls a job
 * started from a phone. readOnly limits the child's tools, not its mode.
 */
export function delegateMode(parent: PermissionMode | undefined): PermissionMode {
  return parent ?? 'default';
}

/** Start the child and wait for its answer (or, with background, return once it started). Throws with words for the model. */
export async function runDelegate(engine: Engine, parentId: string, req: DelegateRequest): Promise<DelegateOutcome> {
  const parent = engine.getSession(parentId);
  if (!parent) throw new Error('This session is gone.');
  const refused = delegateRefusal(engine, parent, req.depth);
  if (refused) throw new Error(refused);
  const acct = engine.accountOf(parent);
  const devices = engine.devices.list(acct);
  const device = findDevice(devices, req.device);
  if ('error' in device) throw new Error(device.error);
  if (!device.online) throw new Error(offlineWords(device, devices));

  const machine = engine.machineFor({ ...parent, device: device.id });
  const home = (await engine.machineHome(machine)) ?? '/';
  const folder = req.folder ? machine.resolve(req.folder, home) : home;
  const st = await machine.stat(folder).catch(() => null);
  if (!st) throw new Error(`There is no folder ${req.folder ?? folder} on ${device.name}.`);
  if (st.type !== 'dir') throw new Error(`${req.folder} on ${device.name} is a file. Pass the folder it is in and name the file in the brief.`);

  const agentName = req.agent ?? (req.to === 'assistant' ? 'assistant' : req.readOnly ? 'explore' : 'coder');
  const def = engine.agentNamed(agentName, undefined, acct);
  if (!def) throw new Error(`There is no agent called ${agentName}. For code use explore or coder; for the assistant leave agent out.`);
  if (def.name === CHAT_AGENT) throw new Error('The chat agent has no files or shell. Use explore or coder for code, or leave agent out.');
  // idea-9: the brief against the agent's tools before anything starts; a read-only job also loses the file-editing tools (engine.ts toolsFor)
  const capability = missingTools(`${req.prompt}\n${req.title}`, def, req.readOnly ? 'read-only' : undefined);
  if (capability) throw new Error(capability);

  // the model a new session of this agent gets, as createSession picks it; a model the owner named wins
  const base = engine.config.get().defaultModel;
  let model = def.model ? agentModelRef(engine, def.model, base).model : base;
  if (req.model) {
    // a harness that is off, or a model the owner hid, says where to turn it on before the generic refusal
    const hidden = engine.harnessOff(req.model);
    if (hidden) throw new Error(hidden);
    const named = agentModelRef(engine, req.model, base);
    // never run a job the owner pinned to one model on another
    if (named.note) {
      const why = named.tier ? `no usable ${named.tier} model is set up on this hub` : 'it is not set up on this hub';
      throw new Error(`The model ${req.model} cannot run here: ${why}. Name a model from the model picker as provider/model, or leave model out.`);
    }
    model = named.model;
  }
  const off = engine.harnessOff(model);
  if (off) throw new Error(off);

  // a session in plan mode (its permission mode, or a plan session) hands on read-only work only
  const permissionMode = delegateMode(parent.mode === 'plan' ? 'plan' : parent.permissionMode);
  const place: DelegatePlace = { to: req.to, device: device.id, deviceName: device.name, folder, readOnly: req.readOnly, permissionMode };
  const from = parent.kind === 'chat' ? "the owner's chat" : `the owner's ${parent.agent} session`;
  const notes = [`Handed over from ${from}. Your final message goes back there as the answer, so make it the result itself.`];
  if (req.readOnly) notes.push('This job is read-only: look and report, change nothing. You have no file-editing tools; run only commands that look, never ones that change files or state.');
  engine.audit(parent.id, 'session.delegate', `${req.to} (${def.name}) on ${device.name} in ${folder}, ${permissionMode}`);
  const res = await runSubagent(engine, {
    parentSessionId: parent.id,
    agent: def.name,
    prompt: `${req.prompt.trim()}\n\n${notes.join(' ')}`,
    description: req.title,
    background: req.background,
    signal: req.signal,
    delegate: {
      cwd: folder,
      device: device.id,
      title: req.title,
      model,
      permissionMode,
      readOnly: req.readOnly,
      tags: ['delegated'],
      // a model the owner named is never swapped on a 404 or a stall (subagent.ts driveSubagent)
      meta: { delegate: { ...place, toolUseId: req.toolUseId }, ...(req.model ? { pinnedModel: true } : {}) },
      // a chat with memory off hands on a job that leaves no trace either
      ...(chatUsesMemory(parent) ? {} : { chat: { webSearch: true, memory: false } }),
    },
  });
  return { sessionId: res.sessionId, agent: def.name, place, text: res.text, ...(res.error ? { error: res.error } : {}) };
}

const BUSY: readonly Session['status'][] = ['running', 'waiting_approval', 'waiting_input', 'waiting_reset'];

/**
 * Move to main list: a delegated session becomes a normal session of its
 * kind (Code or Assistant) in its project (session/delegated.ts). Its
 * parentId stays, so the caller's finished call still opens it, and the
 * call's result keeps its own copy of where it ran. Refused while it works
 * on the job: its caller waits on that answer. A session already moved
 * comes back as it is.
 */
export function moveToMainList(engine: Engine, id: string): Session {
  const s = engine.getSession(id);
  if (!s) throw new EngineError(404, `Session ${id} not found`);
  if (movedToMain(s)) return s;
  if (!isDelegated(s)) throw new EngineError(400, 'Only delegated work moves to the main list.');
  if (BUSY.includes(s.status) || engine.runnerFor(id).busy) throw new EngineError(409, 'It is still working on the job. Move it once it has answered.');
  const next = movedSession(s);
  engine.repos.sessions.update(next);
  // its next turn runs as a primary session: no subagent step limit, and it may hand work on itself
  engine.runnerFor(id).depth = 0;
  engine.bus.emit({ type: 'session.updated', session: next });
  engine.audit(id, 'session.main-list', `moved from delegated work${s.parentId ? ` of ${s.parentId}` : ''}`);
  // its project, as a session started there gets at the end of a turn
  void projectsOf(engine)?.attach(next).catch(() => undefined);
  return next;
}
