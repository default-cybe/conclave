/** Inline approval and question boxes. */
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

  useInput((input, key) => {
    if (denyingRef.current) {
      if (key.escape) return setDenying(false);
      if (key.return) return onResolve({ decision: 'deny', message: messageRef.current.trim() || undefined });
      if (key.backspace || key.delete) return setMessage((m) => m.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setMessage((m) => m + input.replace(/[\r\n]/g, ' '));
      return;
    }
    const k = input.toLowerCase();
    if (k === 'y') return onResolve({ decision: 'allow', scope: 'once' });
    if (k === 's') return onResolve({ decision: 'allow', scope: 'session' });
    // an untrusted session has no "always allow" (the hub would count it as once)
    if (k === 'a' && !approval.noAlways) return onResolve({ decision: 'allow', scope: 'always', rule: approval.suggestedRule });
    if (k === 'n') return onResolve({ decision: 'deny' });
    if (k === 'd') return setDenying(true);
    if (key.escape) {
      onResolve({ decision: 'deny', message: 'The user interrupted.' });
      onAbort();
    }
  });

  const t = toolTitle(approval.tool, approval.input, cwd);
  const preview = approvalPreview(approval.tool, approval.input, p, width - 8);
  const from = askFrom(approval);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c('yellow')} paddingX={1}>
      <Text>
        <Text color={c('yellow')} bold>
          Permission needed
        </Text>
        <Text dimColor>
          {from ? ` · ${from}` : ''}
          {approval.harness ? ` · from ${approval.harness}` : ''}
          {queued > 0 ? ` · ${queued} more waiting` : ''}
        </Text>
      </Text>
      <Text wrap="wrap">
        <Text bold>{visible(t.name)}</Text> {visible(approval.summary || t.detail)}
      </Text>
      {preview.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          <Text>{preview.join('\n')}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {denying ? (
          <Text>
            <Text color={c('red')}>Deny with message: </Text>
            {message}
            <Text inverse> </Text>
            <Text dimColor> (enter send · esc back)</Text>
          </Text>
        ) : (
          <>
            <Text>
              <Text color={c('green')} bold>
                y
              </Text>{' '}
              allow once{'   '}
              <Text color={c('green')} bold>
                s
              </Text>{' '}
              allow for this {approval.from ? 'subagent' : 'session'}
              {approval.noAlways ? null : '   '}
              {approval.noAlways ? null : (
                <>
                  <Text color={c('green')} bold>
                    a
                  </Text>{' '}
                  always allow{approval.suggestedRule ? <Text dimColor> ({visible(approval.suggestedRule)})</Text> : null}
                </>
              )}
            </Text>
            <Text>
              <Text color={c('red')} bold>
                n
              </Text>{' '}
              deny{'   '}
              <Text color={c('red')} bold>
                d
              </Text>{' '}
              deny with message{'   '}
              <Text dimColor>esc deny and stop</Text>
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
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
    <Box flexDirection="column" borderStyle="round" borderColor={c('magenta')} paddingX={1}>
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
              <Text color={c(active ? 'magenta' : undefined)}>{active ? '❯ ' : '  '}</Text>
              <Text dimColor>{`${i + 1}. `}</Text>
              {box}
              <Text bold={active}>{label === OTHER ? 'Other (type an answer)' : label}</Text>
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
