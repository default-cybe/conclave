import type { Message, Session } from '../types';
import type { Engine } from '../engine/engine';
import type { SecondOpinionInput } from '../client';
import { renderTranscript, messageText, userText } from '../session/transcript';
import { streamCompletion } from '../session/stream';
import { runSubagent } from '../engine/subagent';
import { redactSecrets } from '../memory/secrets';
import { newId } from '../util/ids';

/**
 * Second opinion / review: send a message (default the last assistant answer)
 * to another model or agent, and drop its reply into the chat as an aside.
 * The main model treats it as quoted context next turn.
 *
 * The reviewer gets a frozen packet by default
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2 item 7): what the owner
 * asked, the answer under review, the diff of the working tree (with new
 * files), and the project's rules (AGENTS.md, CLAUDE.md, a SPEC.md). Not the
 * writer's transcript: a reviewer that reads the writer's reasoning tends to
 * agree with it. The transcript is opt-in with includeTranscript.
 *
 * The reviewer is often another provider, so secrets stay out: new files that
 * usually hold them (.env, keys, credential files) are left out by name, and
 * whatever looks like a token or password in the packet is redacted.
 */

/** Size caps for the parts of the packet. */
export const REVIEW_LIMITS = { brief: 6_000, answer: 8_000, diff: 40_000, rules: 8_000, transcript: 30_000 } as const;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more chars]` : text;
}

/** The owner's own messages up to the target, oldest first, newest kept when cut. */
export function briefOf(msgs: Message[], target: Message): string {
  const asks = msgs.filter((m) => m.seq <= target.seq && m.role === 'user' && m.kind === 'normal' && !m.meta?.auto).map((m) => userText(m).trim()).filter(Boolean);
  const out: string[] = [];
  let size = 0;
  for (let i = asks.length - 1; i >= 0; i--) {
    if (size + asks[i].length > REVIEW_LIMITS.brief && out.length) break;
    out.unshift(asks[i]);
    size += asks[i].length;
  }
  return cut(out.map((a, i) => `${i + 1}. ${a}`).join('\n\n'), REVIEW_LIMITS.brief);
}

/** Tracked changes against HEAD. */
const TRACKED_DIFF = 'git diff --no-color HEAD 2>/dev/null || git diff --no-color 2>/dev/null; true';
/** Untracked files that git does not ignore, one per line. */
const UNTRACKED = 'git ls-files --others --exclude-standard 2>/dev/null | head -n 200; true';
/** Most new files shown in full. */
const MAX_NEW_FILES = 50;

/** New files that usually hold secrets, by base name: env files, keys and certificates, credential and token stores. */
const SECRET_NAMES: RegExp[] = [
  /^\.env(\.[\w.-]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|ppk|tfvars)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/,
  /^credentials?(\.(json|ya?ml|toml|ini|txt))?$/i,
  /^[\w.-]*secrets?\.(json|ya?ml|toml|ini|txt|env)$/i,
  /service[-_]account[\w.-]*\.json$/i,
];

export function looksLikeSecretFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_NAMES.some((re) => re.test(base));
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Tracked changes against HEAD plus untracked files, as one unified diff, and the new files left out because they may hold secrets. */
async function workingDiff(engine: Engine, session: Session): Promise<{ diff: string; leftOut: string[] }> {
  const machine = engine.machineFor(session);
  try {
    const [tracked, untracked] = await Promise.all([
      machine.exec(TRACKED_DIFF, { cwd: session.cwd, timeoutMs: 20_000, maxOutputBytes: 400_000 }),
      machine.exec(UNTRACKED, { cwd: session.cwd, timeoutMs: 10_000, maxOutputBytes: 100_000 }),
    ]);
    const files = untracked.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
    const leftOut = files.filter(looksLikeSecretFile);
    const shown = files.filter((f) => !looksLikeSecretFile(f)).slice(0, MAX_NEW_FILES);
    let added = '';
    if (shown.length) {
      const cmd = `for f in ${shown.map(shq).join(' ')}; do git diff --no-color --no-index -- /dev/null "$f" 2>/dev/null; done; true`;
      added = (await machine.exec(cmd, { cwd: session.cwd, timeoutMs: 20_000, maxOutputBytes: 400_000 })).stdout;
    }
    return { diff: [tracked.stdout.trim(), added.trim()].filter(Boolean).join('\n'), leftOut };
  } catch {
    return { diff: '', leftOut: [] };
  }
}

/** Rule files a reviewer should judge against: project instructions and a SPEC.md. */
async function ruleFiles(engine: Engine, session: Session): Promise<Array<{ path: string; content: string }>> {
  const machine = engine.machineFor(session);
  const out: Array<{ path: string; content: string }> = [];
  try {
    const { loadProjectInstructions } = await import('../extensions/instructions');
    const files = await loadProjectInstructions(machine, session.cwd, engine.config.get());
    // project files only: the user-level ones say how to work, not what this change must meet
    out.push(...files.filter((f) => f.path.startsWith(session.cwd)));
  } catch {
    /* no instructions */
  }
  for (const rel of ['SPEC.md', 'docs/SPEC.md', 'docs/design/SPEC.md']) {
    const path = `${session.cwd.replace(/\/+$/, '')}/${rel}`;
    try {
      out.push({ path, content: await machine.readText(path) });
      break;
    } catch {
      /* not there */
    }
  }
  return out;
}

export interface ReviewPacket {
  brief: string;
  answer: string;
  diff: string;
  rules: Array<{ path: string; content: string }>;
  transcript?: string;
  /** New files kept out of the diff because they may hold secrets. */
  leftOut?: string[];
}

export async function reviewPacket(engine: Engine, session: Session, msgs: Message[], target: Message, input: SecondOpinionInput): Promise<ReviewPacket> {
  // a chat has no files: its answer is judged against the conversation, which is sent by default
  const chat = session.kind === 'chat';
  const none = { diff: '', leftOut: [] as string[] };
  const [work, rules] = chat ? [none, []] : await Promise.all([input.includeDiff === false ? Promise.resolve(none) : workingDiff(engine, session), ruleFiles(engine, session)]);
  const withTranscript = input.includeTranscript ?? chat;
  return {
    brief: redactSecrets(briefOf(msgs, target)),
    answer: redactSecrets(cut(messageText(target).trim(), REVIEW_LIMITS.answer)),
    diff: cut(redactSecrets(work.diff), REVIEW_LIMITS.diff),
    rules,
    ...(work.leftOut.length ? { leftOut: work.leftOut } : {}),
    ...(withTranscript ? { transcript: redactSecrets(renderTranscript(msgs.filter((m) => m.seq <= target.seq), { maxChars: REVIEW_LIMITS.transcript, includeThinking: false })) } : {}),
  };
}

/**
 * The packet as one prompt. A reviewer agent reads files itself, so it gets
 * the rule files by path; a bare model gets their text.
 */
export function renderPacket(p: ReviewPacket, opts: { inlineRules: boolean; instructions?: string }): string {
  const parts: string[] = [];
  parts.push(`What the owner asked:\n<brief>\n${p.brief || '(no request text)'}\n</brief>`);
  parts.push(`The answer to review:\n<answer>\n${p.answer || '(empty)'}\n</answer>`);
  if (p.diff) parts.push(`The change (working tree against HEAD, new files included):\n\`\`\`diff\n${p.diff}\n\`\`\``);
  else if (!p.transcript) parts.push('There is no diff: the working tree has no changes, or this is not a git repository.');
  if (p.leftOut?.length) parts.push(`New files left out of the diff because they may hold secrets: ${p.leftOut.join(', ')}. Tokens and passwords elsewhere show as [redacted].`);
  if (p.rules.length) {
    if (opts.inlineRules) {
      let left: number = REVIEW_LIMITS.rules;
      const shown = p.rules.map((r) => {
        const body = r.content.slice(0, Math.max(0, left));
        left -= body.length;
        return `Contents of ${r.path}:\n${body}${body.length < r.content.length ? '\n[cut]' : ''}`;
      });
      parts.push(`Project rules the change must meet:\n${shown.join('\n\n')}`);
    } else {
      parts.push(`Project rules the change must meet: ${p.rules.map((r) => r.path).join(', ')}. Read the parts that cover what changed.`);
    }
  }
  if (p.transcript) parts.push(`The conversation that produced it (claims in it are the writer's, not facts):\n${p.transcript}`);
  parts.push(`Review the change and the answer against the brief and the rules.${opts.instructions ? ` Focus: ${opts.instructions}` : ''}`);
  return parts.join('\n\n');
}

export async function runSecondOpinion(engine: Engine, session: Session, input: SecondOpinionInput, signal: AbortSignal): Promise<void> {
  const reviewerRef = input.reviewer ?? engine.config.get().modes.reviewer;
  const msgs = engine.repos.messages.list(session.id);
  const target = input.messageId ? msgs.find((m) => m.id === input.messageId) : lastAssistant(msgs);
  if (!target) {
    engine.notice(session.id, 'Nothing to review yet.', 'warning');
    return;
  }
  const packet = await reviewPacket(engine, session, msgs, target, input);

  if (engine.isAgentRef(reviewerRef)) {
    const agentName = reviewerRef.slice(1);
    const { text } = await runSubagent(engine, {
      parentSessionId: session.id,
      agent: agentName,
      prompt: renderPacket(packet, { inlineRules: false, instructions: input.instructions }),
      description: `Review by ${agentName}`,
      signal,
    });
    engine.addMessage(session.id, {
      role: 'assistant',
      kind: 'aside',
      content: [{ type: 'text', text }],
      author: `Review (${agentName})`,
      group: newId('review'),
      meta: { messageId: target.id },
    });
    return;
  }

  const system = `You are a second expert giving an independent opinion on another model's work. Be direct: say what is right, what is wrong or risky, and what you would change. If you would answer differently, give your version. Do not be agreeable for its own sake. Cite the diff as path:line where you can. ${input.instructions ?? ''}`.trim();
  const res = await streamCompletion(
    engine,
    reviewerRef,
    { system: [{ text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: renderPacket(packet, { inlineRules: true }) }] }], maxTokens: 3000, signal },
    { sessionId: session.id, purpose: 'review' },
  );
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
  engine.addMessage(session.id, {
    role: 'assistant',
    kind: 'aside',
    content: [{ type: 'text', text }],
    model: engine.displayModel(reviewerRef),
    author: 'Second opinion',
    group: newId('review'),
    // the reply it answers, so every client can place it under that reply
    meta: { messageId: target.id },
  });
  engine.notice(session.id, `Second opinion from ${engine.displayModel(reviewerRef)} added.`, 'success');
}

function lastAssistant(msgs: Message[]): Message | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].kind === 'normal') return msgs[i];
  return undefined;
}
