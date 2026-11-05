/** Inline approval and question menus: numbered choices, arrows and enter, no box. */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalResponse, QuestionRequest } from '@conclave/core/types.ts';
import { inkColor as c, tui as p, visible } from '../ansi';
import { approvalPreview, toolTitle } from '../render/tools';
import { useRefState } from './Picker';

export function ApprovalBox({
  approval,
  width,
  cwd,
  queued,
  onResolve,
  onAbort,
}: {
  approval: ApprovalRequest;
  width: number;
  cwd?: string;
  queued: number;
  onResolve: (r: ApprovalResponse) => void;
  onAbort: () => void;
}): React.JSX.Element {
  const [denying, setDenying, denyingRef] = useRefState(false);
  const [message, setMessage, messageRef] = useRefState('');
  const [cursor, setCursor, cursorRef] = useRefState(0);
  const choices = approvalChoices(approval);

  const pick = (key: ApprovalKey) => {
    const r = approvalResponse(key, approval);
    if (r) onResolve(r);
    else setDenying(true);
  };

  useInput((input, key) => {
    if (denyingRef.current) {
      if (key.escape) return setDenying(false);
      if (key.return) return onResolve({ decision: 'deny', message: messageRef.current.trim() || undefined });
      if (key.backspace || key.delete) return setMessage((m) => m.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setMessage((m) => m + input.replace(/[\r\n]/g, ' '));
      return;
    }
    if (key.escape) {
      onResolve({ decision: 'deny', message: 'The user interrupted.' });
      onAbort();
      return;
    }
    if (key.upArrow) return setCursor((c) => (c - 1 + choices.length) % choices.length);
    if (key.downArrow || key.tab) return setCursor((c) => (c + 1) % choices.length);
    if (key.return) return pick(choices[cursorRef.current].key);
    const n = Number(input);
    if (n >= 1 && n <= choices.length) return pick(choices[n - 1].key);
    // the letter keys of earlier versions still work: y s a n d
    const letter = choices.find((ch) => ch.letter === input.toLowerCase());
    if (letter) pick(letter.key);
  });

  const t = toolTitle(approval.tool, approval.input, cwd);
  const preview = approvalPreview(approval.tool, approval.input, p, width - 4);
  const from = askFrom(approval);
  // a Bash preview is the command itself, so it is not repeated on the title line
  const summary = preview.length ? (approval.tool === 'Bash' ? '' : t.detail) : approval.summary || t.detail;
  const meta = [from, approval.harness ? `from ${approval.harness}` : '', queued > 0 ? `${queued} more waiting` : ''].filter(Boolean).join(' · ');
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={c('yellow')} bold>
          {visible(t.name)}
        </Text>
        {summary ? <Text> {visible(summary)}</Text> : null}
        {meta ? <Text dimColor>{` · ${meta}`}</Text> : null}
      </Text>
      {preview.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          <Text>{preview.join('\n')}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {denying ? (
          <Text>
            <Text color={c('red')}>Tell it what to do instead: </Text>
            {message}
            <Text inverse> </Text>
            <Text dimColor> (enter send · esc back)</Text>
          </Text>
        ) : (
          <>
            <Text>Do you want to proceed?</Text>
            {choices.map((ch, i) => (
              <Text key={ch.key} wrap="truncate-end">
                <Text color={c(i === cursor ? 'cyan' : undefined)}>{i === cursor ? '❯ ' : '  '}</Text>
                <Text dimColor={i !== cursor}>{`${i + 1}. `}</Text>
                <Text color={c(i === cursor ? 'cyan' : undefined)}>{ch.label}</Text>
                {ch.note ? <Text dimColor>{` ${visible(ch.note)}`}</Text> : null}
              </Text>
            ))}
            <Text dimColor>esc to deny and stop</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export type ApprovalKey = 'once' | 'session' | 'always' | 'deny' | 'message';

/** The numbered choices of an approval, in order. An untrusted session has no "always" (the hub would count it as once). */
export function approvalChoices(a: Pick<ApprovalRequest, 'noAlways' | 'suggestedRule' | 'from'>): Array<{ key: ApprovalKey; letter: string; label: string; note?: string }> {
  return [
    { key: 'once', letter: 'y', label: 'Yes' },
    { key: 'session', letter: 's', label: `Yes, for the rest of this ${a.from ? 'subagent' : 'session'}` },
    ...(a.noAlways ? [] : [{ key: 'always' as const, letter: 'a', label: 'Yes, always', note: a.suggestedRule ? `(${a.suggestedRule})` : undefined }]),
    { key: 'deny', letter: 'n', label: 'No' },
    { key: 'message', letter: 'd', label: 'No, and tell it what to do instead' },
  ];
}

/** What a choice sends to the hub; undefined for "tell it", which asks for a message first. */
export function approvalResponse(key: ApprovalKey, a: Pick<ApprovalRequest, 'noAlways' | 'suggestedRule'>): ApprovalResponse | undefined {
  switch (key) {
    case 'once':
      return { decision: 'allow', scope: 'once' };
    case 'session':
      return { decision: 'allow', scope: 'session' };
    case 'always':
      return a.noAlways ? undefined : { decision: 'allow', scope: 'always', rule: a.suggestedRule };
    case 'deny':
      return { decision: 'deny' };
    case 'message':
      return undefined;
  }
}

/** "Subagent email asks", "Workflow research, agent search 3, asks": who asks when it is not this session (web lib/asks.ts askFromLine). */
export function askFrom(r: Pick<ApprovalRequest, 'from'>): string | undefined {
  const f = r.from;
  if (!f) return undefined;
  return visible(f.workflow ? `Workflow ${f.workflow.name}, agent ${f.label}, asks` : `Subagent ${f.agent} asks`);
}

const OTHER = '__other__';

export function QuestionBox({ question, onAnswer, onAbort }: { question: QuestionRequest; onAnswer: (answers: Record<string, string>) => void; onAbort: () => void }): React.JSX.Element {
  const [qi, setQi, qiRef] = useRefState(0);
  const [cursor, setCursor, cursorRef] = useRefState(0);
  const [picked, setPicked, pickedRef] = useRefState<Set<number>>(new Set());
  const [, setAnswers, answersRef] = useRefState<Record<string, string>>({});
  const [typing, setTyping, typingRef] = useRefState<string | null>(null);
  const q = question.questions[qi];
  const optionsFor = (i: number) => [...(question.questions[i]?.options ?? []).map((o) => o.label), OTHER];
  const options = optionsFor(qi);

  const commit = (value: string) => {
    const cq = question.questions[qiRef.current];
    const next = { ...answersRef.current, [cq.question]: value };
    setAnswers(next);
    setPicked(new Set());
    setCursor(0);
    setTyping(null);
    if (qiRef.current + 1 < question.questions.length) setQi(qiRef.current + 1);
    else onAnswer(next);
  };

  useInput((input, key) => {
    const q = question.questions[qiRef.current];
    const options = optionsFor(qiRef.current);
    const cursor = cursorRef.current;
    const picked = pickedRef.current;
    const typing = typingRef.current;
    if (!q) return;
    if (typing !== null) {
      if (key.escape) return setTyping(null);
      if (key.return) return commit(typing.trim());
      if (key.backspace || key.delete) return setTyping((t) => (t ?? '').slice(0, -1));
      if (input && !key.ctrl && !key.meta) setTyping((t) => (t ?? '') + input.replace(/[\r\n]/g, ' '));
      return;
    }
    if (key.escape) return onAbort();
    if (key.upArrow) return setCursor((c) => (c - 1 + options.length) % options.length);
    if (key.downArrow || key.tab) return setCursor((c) => (c + 1) % options.length);
    const num = Number(input);
    if (num >= 1 && num <= options.length && !q.multiSelect) {
      if (options[num - 1] === OTHER) return setTyping('');
      return commit(options[num - 1]);
    }
    if (q.multiSelect && input === ' ') {
      if (options[cursor] === OTHER) return setTyping('');
      const next = new Set(picked);
      if (next.has(cursor)) next.delete(cursor);
      else next.add(cursor);
      return setPicked(next);
    }
    if (key.return) {
      if (options[cursor] === OTHER) return setTyping('');
      if (q.multiSelect) {
        const labels = [...picked].sort((a, b) => a - b).map((i) => options[i]);
        return commit(labels.length ? labels.join(', ') : options[cursor]);
      }
      return commit(options[cursor]);
    }
  });

  if (!q) return <Text dimColor>No question</Text>;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={c('magenta')} bold>
          {q.header ?? 'Question'}
        </Text>
        {question.questions.length > 1 ? <Text dimColor>{` ${qi + 1}/${question.questions.length}`}</Text> : null}
        {askFrom(question) ? <Text dimColor>{` · ${askFrom(question)}`}</Text> : null}
      </Text>
      <Text wrap="wrap">{q.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((label, i) => {
          const active = i === cursor;
          const desc = q.options[i]?.description;
          const box = q.multiSelect && label !== OTHER ? (picked.has(i) ? '[x] ' : '[ ] ') : '';
          return (
            <Text key={i} wrap="truncate-end">
              <Text color={c(active ? 'cyan' : undefined)}>{active ? '❯ ' : '  '}</Text>
              <Text dimColor={!active}>{`${i + 1}. `}</Text>
              {box}
              <Text color={c(active ? 'cyan' : undefined)}>{label === OTHER ? 'Other (type an answer)' : label}</Text>
              {desc ? <Text dimColor> {desc}</Text> : null}
            </Text>
          );
        })}
      </Box>
      {typing !== null ? (
        <Text>
          <Text color={c('magenta')}>Answer: </Text>
          {typing}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text dimColor>{q.multiSelect ? 'space toggle · enter confirm · esc stop' : 'enter select · 1-9 pick · esc stop'}</Text>
      )}
    </Box>
  );
}
