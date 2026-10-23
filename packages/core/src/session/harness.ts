import type { ContentBlock, Session, ToolResultBlock, ToolUseBlock } from '../types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from './runner';
import { renderTranscript } from './transcript';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { projectsOf } from '../projects/attached';
import { RefusedMachine } from '../people/guard';
import { harnessOffWords } from '../acp/harness-off';

const log = logger('harness');

const KIND_SUMMARY: Record<string, string> = {
  read: 'Reading', edit: 'Editing', delete: 'Deleting', move: 'Moving', search: 'Searching', execute: 'Running', think: 'Thinking', fetch: 'Fetching', other: 'Working',
};

/**
 * Run a turn through an external harness (Claude Code, Codex, Gemini CLI,
 * OpenCode) over ACP. The harness owns the loop and tools; we store its stream
 * as normal messages and route its permission prompts into Conclave approvals,
 * so the phone can answer them. The harness session id is kept on the session
 * so the next turn resumes it.
 */
export interface HarnessTurnHooks {
  /** The refusal fallback takes a refused turn (session/refusal-fallback.ts): the runner writes the notice. */
  quietRefusal?: boolean;
  /** How the harness ended the turn (ACP stopReason, or error), and the id of its reply. */
  onStop?: (reason: string, messageId: string) => void;
}

export async function runHarnessTurn(engine: Engine, runner: SessionRunner, session: Session, harness: string, model: string, signal: AbortSignal, hooks: HarnessTurnHooks = {}): Promise<boolean> {
  const adapter = engine.acp;
  if (!adapter) {
    engine.notice(session.id, `The ${harness} harness is not available in this build.`, 'error');
    return false;
  }
  // a harness that is off (the default since v0.4.2): say where to turn it on, before anything starts
  const off = harnessOffWords(harness, engine.config.get().providers[harness]);
  if (off) {
    engine.notice(session.id, off, 'error');
    return false;
  }
  const machine = engine.machineFor(session);
  // a machine this account may not use (the hub for a member, someone else's device): nothing starts, and a
  // harness process already running there for someone else is never handed over (docs/design/ACCOUNTS.md 5)
  if (machine instanceof RefusedMachine) {
    engine.notice(session.id, machine.reason, 'error');
    return false;
  }
  const storedId = session.external?.[harness];
  // a resume id only works where it was made: another device or folder starts a new harness session (2.1 bug 3)
  const madeAt = externalAt(session)[harness];
  const here = { device: session.device, cwd: session.cwd };
  const sameWhere = !madeAt || (madeAt.device === here.device && madeAt.cwd === here.cwd);
  const resumeId = storedId && sameWhere ? storedId : undefined;
  const allMsgs = engine.repos.messages.list(session.id);
  // the last user message is this turn's prompt; everything before is prior context.
  // It is always sent: the adapter uses it only when it has to open a new harness session.
  const lastUser = [...allMsgs].reverse().find((m) => m.role === 'user' && m.kind === 'normal');
  const promptBlocks: ContentBlock[] = lastUser ? lastUser.content.filter((b) => b.type === 'text' || b.type === 'image') : [{ type: 'text', text: '' }];
  const priorContext = renderTranscript(allMsgs.slice(0, -1), { maxChars: 40_000, includeTools: false });

  const projects = projectsOf(engine);
  const gated = !!projects?.pendingGate(session);

  const assistant = engine.addMessage(session.id, { role: 'assistant', kind: 'normal', content: [], model: `${harness}/${model}`, agent: session.agent });
  const content: ContentBlock[] = [];
  const toolIndex = new Map<string, number>(); // harness tool id -> index in content
  let textIndex = -1;
  let thinkingIndex = -1;
  let stopOk = false;
  /** How the harness said the turn ended. */
  let stopReason = 'error';
  /** The harness's own session id, once it says it. */
  let harnessSession: string | undefined;

  const flush = () => engine.updateMessage(assistant.id, { content: [...content] });

  const env = await engine.harnessEnv(session, harness);
  const mcpServers = engine.mcpServersForHarness(session);
  // an untrusted session never runs a harness on its own: default mode whatever the session says
  const untrusted = engine.isUntrusted(session);
  const mode = untrusted && session.permissionMode !== 'plan' ? 'default' : session.permissionMode;

  try {
    for await (const ev of adapter.runTurn({
      harness,
      model,
      effort: engine.harnessEffortFor(session),
      machine,
      owner: engine.accountOf(session),
      cwd: session.cwd,
      prompt: promptBlocks,
      priorContext,
      resumeId,
      env,
      mcpServers,
      // the write gate (projects/service.ts): after a move below an exact match even bypass asks once
      permission: mode === 'bypass' && !gated ? 'auto' : mode === 'plan' ? 'readonly' : 'ask',
      signal,
      requestApproval: async (req) => {
        const now = engine.repos.sessions.get(session.id) ?? session;
        const gate = projects?.pendingGate(now);
        // bypass asked only for the gate: once the owner said yes, the rest of the turn runs as before
        if (gated && !gate && mode === 'bypass') return { decision: 'allow', scope: 'once' };
        const why = gate ? await projects!.gateText(now, gate).catch(() => undefined) : undefined;
        const r = await engine.requestApproval(session.id, { ...req, ...(why ? { summary: `${req.summary}. ${why}` } : {}), harness }, signal);
        if (gate && r.decision === 'allow') projects!.passGate(gate);
        return r;
      },
    })) {
      if (signal.aborted) break;
      switch (ev.type) {
        case 'session':
          if (storedId && ev.id !== storedId && priorContext.trim()) {
            engine.notice(session.id, `${engine.providerLabel(harness)} could not resume here, so the conversation so far was passed as context.`, 'info');
          }
          engine.setExternalId(session.id, harness, ev.id);
          setExternalAt(engine, session.id, harness, here);
          harnessSession = ev.id;
          break;
        case 'effort':
          // the levels the harness offers for this model: the model list offers the same (none hides Effort)
          engine.noteHarnessEffort(`${harness}/${model}`, ev.levels);
          break;
        case 'models':
          // the models its account offers ("daybreak" on a Codex account): the picker lists them next to the built-in ones
          engine.noteHarnessModels(harness, ev.models);
          break;
        case 'text_delta': {
          if (textIndex < 0 || content[textIndex]?.type !== 'text') {
            content.push({ type: 'text', text: '' });
            textIndex = content.length - 1;
            thinkingIndex = -1;
          }
          (content[textIndex] as { text: string }).text += ev.text;
          engine.bus.emit({ type: 'message.delta', sessionId: session.id, messageId: assistant.id, index: textIndex, kind: 'text', text: ev.text });
          break;
        }
        case 'thinking_delta': {
          if (thinkingIndex < 0 || content[thinkingIndex]?.type !== 'thinking') {
            content.push({ type: 'thinking', thinking: '' });
            thinkingIndex = content.length - 1;
            textIndex = -1;
          }
          (content[thinkingIndex] as { thinking: string }).thinking += ev.text;
          engine.bus.emit({ type: 'message.delta', sessionId: session.id, messageId: assistant.id, index: thinkingIndex, kind: 'thinking', text: ev.text });
          break;
        }
        case 'tool_call': {
          const use: ToolUseBlock = { type: 'tool_use', id: ev.id || newId('ht'), name: ev.name, input: ev.input };
          content.push(use);
          toolIndex.set(ev.id, content.length - 1);
          textIndex = -1;
          thinkingIndex = -1;
          engine.bus.emit({ type: 'tool.started', sessionId: session.id, messageId: assistant.id, toolUseId: use.id, name: ev.name || KIND_SUMMARY[ev.kind ?? 'other'] || 'tool', input: ev.input });
          flush();
          break;
        }
        case 'tool_update': {
          const idx = toolIndex.get(ev.id);
          if (idx === undefined) break;
          const use = content[idx] as ToolUseBlock;
          const resultIdx = content.findIndex((b) => b.type === 'tool_result' && b.toolUseId === use.id);
          const text = ev.diff ? `` : (ev.output ?? '');
          const result: ToolResultBlock = {
            type: 'tool_result',
            toolUseId: use.id,
            content: text,
            isError: ev.status === 'failed',
            meta: { external: true, diff: ev.diff ? toUnifiedDiff(ev.diff) : undefined, path: ev.diff?.path },
          };
          if (ev.status === 'completed' || ev.status === 'failed') {
            if (resultIdx >= 0) content[resultIdx] = result;
            else content.push(result);
            engine.bus.emit({ type: 'tool.completed', sessionId: session.id, toolUseId: use.id, result });
          } else if (ev.output) {
            engine.bus.emit({ type: 'tool.progress', sessionId: session.id, toolUseId: use.id, text: ev.output });
          }
          flush();
          break;
        }
        case 'plan':
          engine.setTodos(session.id, ev.entries.map((e) => ({ content: e.content, status: e.status })));
          break;
        case 'usage':
          if (ev.usage) {
            engine.addStats(session.id, { inputTokens: ev.usage.inputTokens ?? 0, outputTokens: ev.usage.outputTokens ?? 0, cacheReadTokens: ev.usage.cacheReadTokens });
            engine.usage.record({
              sessionId: session.id,
              source: harness,
              provider: engine.providers.resolve(`${harness}/${model}`).provider,
              model: ev.model ?? model,
              inputTokens: ev.usage.inputTokens ?? 0,
              outputTokens: ev.usage.outputTokens ?? 0,
              cacheReadTokens: ev.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: ev.usage.cacheWriteTokens ?? 0,
              reasoningTokens: ev.usage.reasoningTokens ?? 0,
              costUsd: ev.usage.costUsd ?? 0,
              purpose: 'turn',
              device: session.device,
              cwd: session.cwd,
            });
            // this turn's usage is counted here: the turns row names the harness session, and the
            // log readers skip that session's lines in the turn's span (usage/service.ts), or the
            // same calls would count again when the harness's own transcript is read
            if (runner.turnId && harnessSession) {
              try {
                engine.repos.turns.setHarnessSession(runner.turnId, harnessSession);
              } catch {
                /* Recap data must not break a turn */
              }
            }
          }
          break;
        case 'rate_limit':
          if (ev.windows.length) engine.usage.setLimit({ provider: harness, label: engine.providerLabel(harness), windows: ev.windows, updatedAt: Date.now(), source: 'headers' });
          break;
        case 'done':
          stopOk = ev.stopReason === 'end_turn';
          stopReason = ev.stopReason;
          if (ev.stopReason === 'error') engine.notice(session.id, `${harness} error: ${ev.error ?? 'unknown'}`, 'error');
          // the ACP agent said it refuses (stopReason refusal): the hub can see it, so the refusal fallback can take the turn
          if (ev.stopReason === 'refusal' && !hooks.quietRefusal) engine.notice(session.id, `${harness} declined to continue.`, 'warning', undefined, { type: 'refusal' });
          if (ev.stopReason === 'max_tokens') engine.notice(session.id, 'The harness hit its output limit.', 'warning');
          break;
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      log.error(`harness ${harness} failed`, err);
      engine.notice(session.id, `${harness} failed: ${(err as Error)?.message ?? String(err)}`, 'error');
    }
  } finally {
    flush();
    engine.updateMessage(assistant.id, { stopReason: stopOk ? 'end_turn' : stopReason === 'refusal' ? 'refusal' : 'aborted' });
  }
  hooks.onStop?.(signal.aborted ? 'cancelled' : stopReason, assistant.id);
  return stopOk;
}

/** Where each harness resume id was made (Session.meta.externalAt), keyed by harness. */
export function externalAt(session: Session): Record<string, { device: string; cwd: string }> {
  const v = session.meta?.externalAt;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, { device: string; cwd: string }>) : {};
}

export function setExternalAt(engine: Engine, sessionId: string, harness: string, where: { device: string; cwd: string }): void {
  const s = engine.repos.sessions.get(sessionId);
  if (!s) return;
  engine.patchMeta(sessionId, { externalAt: { ...externalAt(s), [harness]: where } });
}

function toUnifiedDiff(diff: { path: string; oldText?: string; newText: string }): string {
  const oldLines = (diff.oldText ?? '').split('\n');
  const newLines = diff.newText.split('\n');
  const head = `--- ${diff.path}\n+++ ${diff.path}\n`;
  // minimal diff: mark removed then added (good enough for display; the harness is the source of truth)
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n');
  return head + body;
}
