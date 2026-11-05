/**
 * `conclave run`: one headless turn. Assistant text streams to stdout, tool
 * lines and notices go to stderr. Approvals are denied unless --yes.
 */
import { fstatSync } from 'node:fs';
import type { ConclaveClient } from '@conclave/core/client/index.ts';
import type { EngineEventEnvelope, Message, PermissionMode, Session, SessionMode, TextBlock } from '@conclave/core/types.ts';
import { err as ep, visible } from '../ansi';
import { bool, parseTimeout, str, type ParsedArgs } from '../args';
import { DedupeNotes, eventSessionId, isActiveStatus } from '../events';
import { formatCost, formatTokens } from '../render/format';
import { shortModel } from '../render/models';
import { resultText, toolTitle } from '../render/tools';
import { CliError, getClient } from './shared';

/**
 * Read piped stdin. When a prompt was given too, stdin may be an idle pipe
 * that never closes (cron, IDEs), so give up if nothing arrives quickly.
 */
function readStdin(waitForFirstMs?: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', done);
      stdin.off('error', done);
      stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer | string) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    };
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.once('error', done);
    if (waitForFirstMs !== undefined) timer = setTimeout(done, waitForFirstMs);
    stdin.resume();
  });
}

/** True when stdout and stderr end up in the same place (terminal, file or pipe). */
function sameDestination(): boolean {
  if (process.stdout.isTTY && process.stderr.isTTY) return true;
  try {
    const a = fstatSync(1);
    const b = fstatSync(2);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

export async function buildPrompt(args: ParsedArgs, fromIndex: number): Promise<string> {
  let prompt = args._.slice(fromIndex).join(' ').trim();
  if (!process.stdin.isTTY) {
    const piped = (await readStdin(prompt && prompt !== '-' ? 300 : undefined)).replace(/\s+$/, '');
    if (piped) prompt = !prompt || prompt === '-' ? piped : `${prompt}\n\n<stdin>\n${piped}\n</stdin>`;
  }
  if (!prompt || prompt === '-') throw new CliError('No prompt. Usage: conclave run <prompt>');
  return prompt;
}

function waitOpen(client: ConclaveClient, onEvent: (e: EngineEventEnvelope) => void, timeoutMs: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let opened = false;
    const t = setTimeout(() => {
      if (!opened) {
        close();
        reject(new CliError(`Could not open the event stream at ${client.baseUrl}/api/ws`));
      }
    }, timeoutMs);
    const close = client.connect(onEvent, {
      onStatus: (s) => {
        if (s === 'open' && !opened) {
          opened = true;
          clearTimeout(t);
          resolve(close);
        }
      },
    });
  });
}

export async function runCommand(args: ParsedArgs, promptFrom = 1): Promise<number> {
  const prompt = await buildPrompt(args, promptFrom);
  const asJson = bool(args, 'json');
  const yes = bool(args, 'yes');
  const verbose = bool(args, 'verbose');
  const timeoutMs = parseTimeout(str(args, 'timeout'));
  const { client } = await getClient(args, { quiet: asJson });

  const stdout = process.stdout;
  const stderr = process.stderr;
  const sameTty = sameDestination();
  let lastChar = '\n';
  let wroteAny = false;
  const write = (s: string) => {
    if (!s) return;
    stdout.write(s);
    lastChar = s[s.length - 1];
    wroteAny = true;
  };
  const seen = new DedupeNotes();
  /** Error-ish lines: shown once even when several events report the same thing. */
  const noteOnce = (text: string, styled: (s: string) => string) => {
    if (seen.fresh(text)) note(styled(`· ${text}`));
  };
  const note = (s: string) => {
    if (asJson) return;
    if (sameTty && lastChar !== '\n') write('\n');
    stderr.write(s + '\n');
  };

  let sessionId: string | undefined;
  let session: Session | undefined;
  const early: EngineEventEnvelope[] = [];
  const printed = new Map<string, number>();
  const kinds = new Map<string, Message['kind']>();
  let currentMsg: string | undefined;
  let sawActive = false;
  let finished = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  let lastError: string | undefined;

  const finish = async (code?: number) => {
    if (finished) return;
    finished = true;
    // print anything the stream missed
    let lastStop: Message['stopReason'];
    if (sessionId) {
      try {
        const msgs = await client.messages(sessionId);
        if (!asJson) for (const m of msgs) printMessage(m);
        lastStop = [...msgs].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')?.stopReason;
        session = await client.getSession(sessionId);
      } catch {
        /* best effort */
      }
    }
    const failed = session?.status === 'error' || !!lastError || lastStop === 'error';
    resolveDone(code ?? (failed ? 1 : 0));
  };

  const beginMessage = (id: string) => {
    if (currentMsg === id) return;
    if (currentMsg !== undefined && wroteAny) write(lastChar === '\n' ? '\n' : '\n\n');
    currentMsg = id;
  };

  const printText = (m: Pick<Message, 'id' | 'role' | 'kind' | 'content' | 'author' | 'model'>) => {
    if (m.role !== 'assistant' || m.kind === 'summary') return;
    const kind = m.kind;
    if (kind === 'notice') {
      const text = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join(' ');
      const key = m.id + ':notice';
      if (!printed.has(key) && text) {
        printed.set(key, 1);
        noteOnce(text, ep.dim);
      }
      return;
    }
    m.content.forEach((b, i) => {
      if (b.type !== 'text') return;
      const key = `${m.id}:${i}`;
      const have = printed.get(key) ?? 0;
      if (b.text.length <= have) return;
      const rest = b.text.slice(have);
      printed.set(key, b.text.length);
      if (kind === 'aside') {
        if (have === 0) note(ep.bold(`◆ ${m.author ?? 'Aside'} · ${shortModel(m.model)}`));
        stderr.write(rest);
        if (b.text.length && !rest.endsWith('\n')) stderr.write('\n');
        return;
      }
      beginMessage(m.id);
      write(rest);
    });
  };
  const printMessage = (m: Message) => {
    kinds.set(m.id, m.kind);
    printText(m);
  };

  const handle = async (ev: EngineEventEnvelope) => {
    if (asJson) stdout.write(JSON.stringify(ev) + '\n');
    switch (ev.type) {
      case 'session.updated':
        session = ev.session;
        if (isActiveStatus(ev.session.status)) sawActive = true;
        if (ev.session.status === 'waiting_reset') {
          const at = ev.session.resumeAt ? new Date(ev.session.resumeAt).toLocaleTimeString() : 'later';
          note(ep.yellow(`· Usage limit reached. Waiting for reset at ${at}.`));
        }
        if (ev.session.status === 'error' && ev.session.error) lastError = ev.session.error;
        if (sawActive && (ev.session.status === 'idle' || ev.session.status === 'error')) await finish();
        break;
      case 'message.created':
      case 'message.updated':
        if (!asJson) printMessage(ev.message);
        else kinds.set(ev.message.id, ev.message.kind);
        break;
      case 'message.delta': {
        if (asJson || ev.kind !== 'text') {
          if (verbose && ev.kind === 'thinking' && !asJson) stderr.write(ep.dim(ev.text));
          break;
        }
        const key = `${ev.messageId}:${ev.index}`;
        printed.set(key, (printed.get(key) ?? 0) + ev.text.length);
        if (kinds.get(ev.messageId) === 'aside') stderr.write(ev.text);
        else {
          beginMessage(ev.messageId);
          write(ev.text);
        }
        break;
      }
      case 'tool.started': {
        tools.set(ev.toolUseId, { name: ev.name, input: ev.input });
        const t = toolTitle(ev.name, ev.input, session?.cwd);
        note(`${ep.cyan('●')} ${ep.bold(visible(t.name))} ${visible(t.detail)}`);
        break;
      }
      case 'tool.completed': {
        const t = tools.get(ev.toolUseId);
        // tool output can carry escape codes (a file, a web page); they must not reach the terminal
        const text = visible(resultText(ev.result)).trim();
        const first = text.split('\n').find((l) => l.trim()) ?? '';
        const lines = text ? text.split('\n').length : 0;
        const summary = first.length > 100 ? first.slice(0, 99) + '…' : first;
        if (ev.result.isError) note(`  ${ep.red('⎿')} ${ep.red(summary || 'error')}`);
        else if (verbose || t?.name === 'Bash') note(ep.dim(`  ⎿ ${summary}${lines > 1 ? ` (+${lines - 1} lines)` : ''}`));
        break;
      }
      case 'approval.requested': {
        const a = ev.approval;
        if (yes) {
          note(ep.yellow(`· Allowed: ${visible(a.summary)}`));
          await client.resolveApproval(a.id, { decision: 'allow', scope: 'once' }).catch(() => {});
        } else {
          note(ep.yellow(`· Denied: ${visible(a.summary)} (pass --yes to allow)`));
          await client.resolveApproval(a.id, { decision: 'deny', message: 'Denied: this is a headless run without --yes. Do not retry; continue without this action.' }).catch(() => {});
        }
        break;
      }
      case 'question.asked': {
        const q = ev.question;
        const answers: Record<string, string> = {};
        for (const item of q.questions) answers[item.question] = 'The user is not available (headless run). Decide yourself and state your assumption.';
        note(ep.dim(`· Question skipped: ${q.questions[0]?.question ?? ''}`));
        await client.answerQuestion(q.id, answers).catch(() => {});
        break;
      }
      case 'notice':
        if (ev.notice.level === 'error' || ev.notice.level === 'warning') noteOnce(ev.notice.body || ev.notice.title, ep.yellow);
        break;
      default:
        break;
    }
  };

  const onEvent = (ev: EngineEventEnvelope) => {
    if (!sessionId) {
      early.push(ev);
      return;
    }
    if (eventSessionId(ev) !== sessionId) return;
    void handle(ev);
  };

  const closeWs = await waitOpen(client, onEvent, 8000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const onSigint = async () => {
    note(ep.yellow('\n· Interrupted'));
    if (sessionId) await client.abort(sessionId).catch(() => {});
    await finish(130);
  };
  process.on('SIGINT', onSigint);
  try {
    session = await client.createSession({
      agent: str(args, 'agent'),
      model: str(args, 'model'),
      mode: str(args, 'mode') as SessionMode | undefined,
      permissionMode: str(args, 'permission-mode') as PermissionMode | undefined,
      cwd: str(args, 'cwd') ?? process.cwd(),
      device: str(args, 'device'),
      tags: ['cli-run'],
    });
    sessionId = session.id;
    if (asJson) stdout.write(JSON.stringify({ type: 'run.session', session }) + '\n');
    for (const ev of early.splice(0)) if (eventSessionId(ev) === sessionId) void handle(ev);

    if (timeoutMs) {
      timer = setTimeout(async () => {
        note(ep.red(`· Timed out after ${Math.round(timeoutMs / 1000)}s`));
        await client.abort(sessionId!).catch(() => {});
        await finish(1);
      }, timeoutMs);
    }
    await client.send(session.id, { text: prompt });
    const sentAt = Date.now();
    // Fallback for missed events: poll the session status.
    poll = setInterval(async () => {
      if (finished) return;
      try {
        const s = await client.getSession(sessionId!);
        session = s;
        if (isActiveStatus(s.status)) sawActive = true;
        else if ((s.status === 'idle' || s.status === 'error') && (sawActive || currentMsg || Date.now() - sentAt > 5000)) {
          if (s.status === 'error' && s.error) lastError = s.error;
          await finish();
        }
      } catch {
        /* hub hiccup: keep waiting */
      }
    }, 1500);
    const code = await done;
    if (!asJson) {
      if (wroteAny && lastChar !== '\n') write('\n');
      if (lastError && seen.fresh(lastError)) stderr.write(ep.red(`Error: ${lastError}\n`));
      if (stderr.isTTY && session) {
        const st = session.stats;
        stderr.write(ep.dim(`${session.id} · ${shortModel(session.model)} · ${formatTokens(st.inputTokens)} in / ${formatTokens(st.outputTokens)} out · ${formatCost(st.costUsd)}\n`));
      }
    } else {
      stdout.write(JSON.stringify({ type: 'run.done', sessionId, status: session?.status, exitCode: code, error: lastError, stats: session?.stats }) + '\n');
    }
    return code;
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    process.off('SIGINT', onSigint);
    closeWs();
  }
}
