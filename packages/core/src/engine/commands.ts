import type { Engine } from './engine';
import { expandCommand } from '../extensions/commands';
import { checkPermission, dangerousCommand } from '../session/permissions';
import { BashTool } from '../tools/bash';
import { ReadTool } from '../tools/read';
import type { Tool } from '../tools/types';
import { newId } from '../util/ids';
import { oneLine } from '../util/text';
import { reminder } from '../session/transcript';
import { projectsOf } from '../projects/attached';

/** A command body with shell lines: !`cmd` (Claude Code) or !{cmd} (Gemini CLI). */
const SHELL_LINE = /!`[^`]+`|!\{/;

/** Why a member's command with shell lines does not run (docs/design/ACCOUNTS.md 5). */
export const MEMBER_SHELL_REFUSED = 'commands with shell lines (!`command`) run on the hub, which only the hub owner can use. Put the command in a code block and ask the agent to run it on a device you paired.';

/**
 * Slash commands typed in a session. Built-ins are handled here; anything else
 * is resolved as a custom command (markdown template) and its expanded body is
 * sent to the model as a normal turn.
 */
export async function runCommand(engine: Engine, sessionId: string, line: string): Promise<{ output?: string }> {
  const s = engine.requireSession(sessionId);
  // a member's session sees the commands, skills and agents that ship and plugin ones only: the owner's
  // own (~/.claude, ~/.conclave) and project files read on the hub's disk are not theirs (docs/design/ACCOUNTS.md 2)
  const acct = engine.accountOf(s);
  const member = engine.isMemberSession(s);
  const [raw, ...rest] = line.replace(/^\//, '').split(/\s+/);
  const name = raw.toLowerCase();
  const args = rest.join(' ');

  switch (name) {
    case 'model':
      if (args && engine.isUsableRef(args)) {
        engine.updateSession(sessionId, { model: args });
        return { output: `Model set to ${engine.displayModel(args)}` };
      }
      return { output: (args && engine.harnessOff(args)) || `Current model: ${engine.displayModel(s.model)}` };
    case 'agent':
      if (args && engine.agentNamed(args, member ? undefined : s.cwd, acct)) {
        engine.updateSession(sessionId, { agent: args });
        return { output: `Agent set to ${args}` };
      }
      return { output: `Agents: ${engine.agentsFor(acct).map((a) => a.name).join(', ')}` };
    case 'mode':
      if (['agent', 'chat', 'plan', 'jury', 'debate', 'loop'].includes(args)) {
        engine.updateSession(sessionId, { mode: args as Session['mode'] });
        return { output: `Mode set to ${args}` };
      }
      return { output: `Current mode: ${s.mode}` };
    case 'device': {
      // the session's account's devices only (docs/design/ACCOUNTS.md)
      const devices = engine.devices.list(engine.accountOf(s));
      if (args && devices.some((d) => d.id === args || d.name === args)) {
        const dev = devices.find((d) => d.id === args || d.name === args)!;
        // the same resolution as the device picker: find the project's folder there (projects/service.ts)
        const res = await engine.moveSession(sessionId, { device: dev.id });
        if (res.resolved) return { output: res.freshness?.line ? `${res.line} ${res.freshness.line}` : res.line };
        const top = res.candidates[0];
        return { output: `${res.line}${top ? ` Closest folder: ${top.path} (${top.line}).` : ''} Use the device picker to choose a folder.` };
      }
      return { output: `Devices: ${devices.map((d) => `${d.name}${d.online ? '' : ' (offline)'}`).join(', ')}` };
    }
    case 'move': {
      // /move hub --copy: Move to hub (projects/hubcopy.ts); it runs in the background
      const svc = projectsOf(engine);
      if (/^hub\b/.test(args) && /(^|\s)--copy\b/.test(args) && svc && !member) return { output: svc.copies.start(sessionId).line };
      return { output: 'Usage: /move hub --copy copies this folder to the hub and runs there. /device <name> moves without copying.' };
    }
    case 'cwd':
      if (args) {
        engine.updateSession(sessionId, { cwd: args });
        return { output: `Working directory set to ${args}` };
      }
      return { output: s.cwd };
    case 'compact':
      return { output: (await engine.compact(sessionId, args)) ? 'Compacted.' : 'Nothing to compact yet.' };
    case 'cost':
    case 'usage':
      return {
        output: `This session: ${s.stats.inputTokens} in, ${s.stats.outputTokens} out, ${s.stats.cacheReadTokens} cache read, ${s.stats.cacheWriteTokens ?? 0} cache write, $${s.stats.costUsd.toFixed(4)}`,
      };
    case 'fork': {
      const fork = engine.forkSession(sessionId);
      return { output: `Forked to ${fork.id}` };
    }
    case 'review':
      await engine.secondOpinion(sessionId, { reviewer: args || undefined });
      return { output: 'Second opinion requested.' };
    case 'handoff':
      if (args) {
        // /handoff <model> [brief]: brief asks for a short handover
        const [ref, how] = args.split(/\s+/);
        await engine.handoff(sessionId, ref, how === 'brief' ? { brief: true } : {});
        return { output: `Switched to ${engine.displayModel(ref)}` };
      }
      return { output: 'Usage: /handoff <model> [brief]' };
    case 'jury': {
      const jurors = rest.filter((r) => engine.isUsableRef(r));
      engine.updateSession(sessionId, { mode: 'jury', modeConfig: { ...s.modeConfig, jury: { ...engine.config.get().modes.jury, ...s.modeConfig?.jury, ...(jurors.length ? { jurors } : {}) } } });
      return { output: `Jury mode on${jurors.length ? ` with ${jurors.join(', ')}` : ''}.` };
    }
    case 'debate': {
      const [a, b, rounds] = rest;
      engine.updateSession(sessionId, { mode: 'debate', modeConfig: { ...s.modeConfig, debate: { a: a ?? s.model, b: b ?? engine.config.get().modes.reviewer, rounds: Number(rounds) || 2 } } });
      return { output: 'Debate mode on.' };
    }
    case 'export': {
      const exported = engine.exportSession(sessionId, 'md');
      return { output: exported.content };
    }
    case 'clear': {
      // like Claude Code: SessionEnd (reason clear) for the old conversation, SessionStart (source clear) on the next turn
      const runner = engine.runnerFor(sessionId);
      if (runner.started) await engine.runHook(s, 'SessionEnd', { reason: 'clear' }, 'clear');
      await engine.rewind(sessionId, 0);
      runner.markSessionStart('clear');
      return { output: 'Conversation cleared.' };
    }
    default: {
      // custom command from extensions
      // a member's: what ships, plugins and their own (<home>/accounts/<id>/commands), never another account's
      const cmd = engine.commandNamed(name, s.cwd, acct);
      // a skill typed as /<name> args runs through the Skill tool, as in Claude Code; a command of the same name wins
      const skills = engine.skillsFor(acct, s.cwd);
      const skill = skills.find((k) => (cmd ? k.path === cmd.path : k.name.toLowerCase() === name));
      if (skill) return runSkill(engine, s, skill.name, args);
      if (!cmd) return { output: `Unknown command: /${name}` };
      if (member && SHELL_LINE.test(cmd.body)) return { output: `/${cmd.name} did not run: ${MEMBER_SHELL_REFUSED}` };
      const signal = new AbortController().signal;
      const permit = (command: string) => shellRefusal(engine, s, cmd.name, command, signal);
      const readDenied = await readDeniedFor(engine, s);
      const body = await expandCommand(cmd, args, { machine: engine.machineFor(s), cwd: s.cwd, permit, readDenied });
      await engine.send(sessionId, { text: body });
      return {};
    }
  }
}

/**
 * /<skill> args: the line goes to the model as the owner typed it, with a
 * note to load the skill through the Skill tool first. Refused when the
 * session cannot use tools or its agent has no Skill tool.
 */
async function runSkill(engine: Engine, s: Session, name: string, args: string): Promise<{ output?: string }> {
  if (s.mode === 'chat') return { output: `Skills need tools. Switch this session to Agent mode to run /${name}.` };
  const agent = engine.agentFor(s);
  if (agent?.tools && !agent.tools.includes('Skill')) return { output: `The ${agent.name} agent has no Skill tool, so it cannot run /${name}.` };
  const note = `The owner ran the skill "${name}" by typing /${name}${args ? ' with arguments' : ''}. Call the Skill tool with skill "${name}"${args ? ` and args ${JSON.stringify(args)}` : ''} before anything else, then follow it.`;
  engine.runnerFor(s.id).deliver({ block: reminder(note), wake: false });
  await engine.send(s.id, { text: `/${name}${args ? ` ${args}` : ''}` });
  return {};
}

/**
 * A !`cmd` line in a command or skill gets the check a Bash call in this
 * session gets: rules, mode, the session's grants, then the owner's answer.
 * Returns why it may not run, or undefined.
 */
async function shellRefusal(engine: Engine, s: Session, name: string, command: string, signal: AbortSignal): Promise<string | undefined> {
  const runner = engine.runnerFor(s.id);
  const input = { command };
  let v = checkPermission({
    tool: BashTool as unknown as Tool,
    input,
    content: command.trim(),
    mode: s.permissionMode,
    rules: engine.permissionRulesFor(s),
    sessionAllow: runner.sessionAllow,
    cwd: s.cwd,
    home: (await engine.machineHome(engine.machineFor(s))) ?? '/',
    workspaceRoots: [s.cwd, ...engine.config.get().permissions.additionalDirectories],
  });
  if (v.decision === 'allow' && dangerousCommand(command)) v = { decision: 'ask', reason: 'Potentially destructive command' };
  if (v.decision === 'deny') return v.reason;
  if (v.decision === 'allow') return undefined;
  const rule = BashTool.suggestRule?.(input);
  const res = await engine.requestApproval(s.id, { toolUseId: newId('cmd'), tool: 'Bash', input, summary: `/${name} runs: ${oneLine(command, 160)}`, suggestedRule: rule }, signal);
  if (res.decision !== 'allow') return 'the user denied it';
  if (res.scope === 'session') runner.sessionAllow.push(res.rule ?? rule ?? 'Bash');
  return undefined;
}

/** For `@file` lines: true when a Read deny rule covers the path. Reads are not asked about, as the owner typed the command. */
async function readDeniedFor(engine: Engine, s: Session): Promise<(absPath: string) => boolean> {
  const home = (await engine.machineHome(engine.machineFor(s))) ?? '/';
  const rules = engine.permissionRulesFor(s);
  const workspaceRoots = [s.cwd, ...engine.config.get().permissions.additionalDirectories];
  return (absPath) =>
    checkPermission({ tool: ReadTool as unknown as Tool, input: { file_path: absPath }, content: absPath, mode: s.permissionMode, rules, sessionAllow: [], cwd: s.cwd, home, workspaceRoots }).decision === 'deny';
}

type Session = import('../types').Session;
