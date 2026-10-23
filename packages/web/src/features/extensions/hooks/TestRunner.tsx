/**
 * Hook test runner (IA.md, Hooks > Test runner). Pick an event, edit a sample
 * input, set the matcher value, run. The hub runs the real commands with
 * session id "test" and returns each handler's trace and the merged outcome.
 */
import { useEffect, useMemo, useState } from 'react';
import type { HookGroupDto, HookTestResult } from '@conclave/core/client';
import type { HookEvent } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { duration } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { CodeBlock } from '@/components/ui/Code';
import { TextAction } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { Drawer } from './Drawer';
import { EVENT_ORDER, SAMPLES, matcherField, resultTone, resultWord, scrollBehavior, sourceWords, withPluginRoot, type Tone } from './model';

const TONE: Record<Tone, string> = { ok: 'text-ok', fault: 'text-fault', warn: 'text-warn', dim: 'text-fg-3', neutral: 'text-fg-2' };

export interface TestStart {
  event: HookEvent;
  group?: HookGroupDto;
  /** Prefill the sample input, for example with a recipe's own test case. */
  input?: Record<string, unknown>;
  matcherValue?: string;
}

function sampleText(event: HookEvent) {
  return JSON.stringify(SAMPLES[event], null, 2);
}

export function TestRunner({
  open,
  onClose,
  start,
  cwd,
  glosses,
  roots = {},
  onRan,
}: {
  open: boolean;
  onClose: () => void;
  start: TestStart | null;
  cwd?: string;
  glosses: Partial<Record<HookEvent, string>>;
  /** Plugin name to folder, to show ${CLAUDE_PLUGIN_ROOT} in labels. */
  roots?: Record<string, string>;
  onRan: () => void;
}) {
  const mobile = useIsMobile();
  const [event, setEvent] = useState<HookEvent>('PreToolUse');
  const [input, setInput] = useState(sampleText('PreToolUse'));
  const [matcher, setMatcher] = useState('');
  const [only, setOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !start) return;
    setEvent(start.event);
    setInput(start.input ? JSON.stringify(start.input, null, 2) : sampleText(start.event));
    setMatcher(start.matcherValue ?? '');
    setOnly(!!start.group);
    setResult(null);
    setError(undefined);
  }, [open, start]);

  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(input) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The input must be a JSON object, like { "prompt": "deploy it" }.' };
      return { value: v as Record<string, unknown> };
    } catch (e) {
      return { error: `Not valid JSON. ${e instanceof Error ? e.message : ''} Fix it or reset the sample.`.replace(/\s+/g, ' ') };
    }
  }, [input]);

  const field = matcherField(event);
  const fromInput = field && parsed.value && typeof parsed.value[field] === 'string' ? (parsed.value[field] as string) : undefined;
  const group = start?.group && start.event === event ? start.group : undefined;

  const pickEvent = (e: HookEvent) => {
    setEvent(e);
    setInput(sampleText(e));
    setMatcher('');
    setResult(null);
    setError(undefined);
  };

  const run = async () => {
    if (!parsed.value) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api().testHook({
        event,
        input: parsed.value,
        ...(matcher.trim() ? { matcherValue: matcher.trim() } : {}),
        ...(cwd ? { cwd } : {}),
        ...(group && only ? { only: { source: group.source, ...(group.plugin ? { plugin: group.plugin } : {}), index: group.index, ...(group.path ? { path: group.path } : {}) } } : {}),
      });
      setResult(r);
      onRan();
      requestAnimationFrame(() => document.getElementById('hook-test-result')?.scrollIntoView({ block: 'start', behavior: scrollBehavior() }));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Test a hook"
      sub={cwd ? <>In project <span className="mono">{cwd}</span></> : 'No project picked: user, Claude Code and plugin hooks only.'}
      footer={
        <>
          {busy && <LiveStatus state="tool" label="Running" className="mr-auto" />}
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Close
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!parsed.value} busy={busy ? 'Running' : false} onClick={() => void run()}>
            Run on the hub
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">This runs the real commands on the hub, as session test. A hook that deletes files or calls a server does that for real.</p>
        <Field label="Event">
          <SelectMenu
            label="Event"
            value={event}
            onChange={pickEvent}
            width={mobile ? undefined : 420}
            options={EVENT_ORDER.map((e) => ({ value: e, label: <span className="font-mono text-[12.5px]">{e}</span>, detail: glosses[e] }))}
          />
        </Field>
        <Field
          label="Sample input"
          error={parsed.error}
          help={
            <>
              Sent to each handler on stdin. The hub fills in <span className="mono">session_id</span>, <span className="mono">cwd</span> and <span className="mono">hook_event_name</span>.{' '}
              <TextAction label="Reset sample" onClick={() => setInput(sampleText(event))} />
            </>
          }
        >
          <Textarea mono minRows={5} maxRows={14} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
        {field && (
          <Field label="Matcher value" optional help={fromInput ? <>Each group&apos;s matcher is compared with this. Empty uses <span className="mono">{field}</span> from the input: <span className="mono">{fromInput}</span>.</> : <>Each group&apos;s matcher is compared with this. Empty uses <span className="mono">{field}</span> from the input.</>}>
            <Input mono value={matcher} onChange={(e) => setMatcher(e.target.value)} placeholder={fromInput ?? ''} />
          </Field>
        )}
        {group && (
          <Checkbox
            checked={only}
            onChange={setOnly}
            label="Only this group"
            description={
              <>
                {group.matcher ? <span className="mono">{group.matcher}</span> : 'No matcher'} from {sourceWords(group)}. Off runs every active group that matches.
              </>
            }
          />
        )}
      </div>

      {error && (
        <div className="mt-6 border-t border-rule-2 pt-4">
          <p className="m-0 text-[14px] leading-[1.45] text-fg-2">
            <span className="text-fault">Failed.</span> {error}
          </p>
        </div>
      )}
      {result && <Result result={result} event={event} roots={roots} />}
    </Drawer>
  );
}

function Result({ result, event, roots }: { result: HookTestResult; event: HookEvent; roots: Record<string, string> }) {
  const [first, ...rest] = result.modelWouldSee.split(/(?<=\.)\s/);
  const blocked = result.blocked || result.permissionDecision === 'deny';
  return (
    <section id="hook-test-result" aria-label="Result" aria-live="polite" className="mt-6 scroll-mt-2">
      <div className="border-b border-rule-2 pb-[9px]">
        <h3 className="t-section text-fg">Result</h3>
      </div>
      <p className="mt-3 mb-0 text-[14px] leading-[1.5] whitespace-pre-wrap text-fg phone:text-[15px]">
        <span className={cn(blocked && 'text-fault')}>{first}</span>
        {rest.length > 0 && ` ${rest.join(' ')}`}
      </p>
      {result.trace.length === 0 && (
        <p className="mt-2 mb-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
          No handler ran for <span className="mono">{event}</span>. Check the matcher value and each handler&apos;s <span className="mono">if</span> rule, or trust the folder if the hooks come from the project.
        </p>
      )}
      {result.updatedInput && <CodeBlock className="mt-3" title="New input" code={JSON.stringify(result.updatedInput, null, 2)} lang="json" />}
      {result.systemMessages.length > 0 && (
        <div className="mt-3 text-[13px] text-fg-2 phone:text-[14px]">
          <div className="text-[12px] text-fg-3">Shown to you</div>
          {result.systemMessages.map((m, i) => (
            <p key={i} className="m-0 mt-1">
              {m}
            </p>
          ))}
        </div>
      )}
      {result.trace.length > 0 && (
        <>
          <div className="mt-5 flex items-baseline gap-2 border-b border-rule pb-1.5">
            <h4 className="text-[12px] font-medium text-fg-3">Handlers that ran</h4>
            <span className="num text-[12px] text-fg-3">{result.trace.length}</span>
          </div>
          <ol className="rows m-0 list-none p-0">
            {result.trace.map((t, i) => (
              <li key={i} className="py-3">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={t.label}>
                    {t.type === 'prompt' ? <span className="font-sans text-fg-3">Prompt: </span> : null}
                    {withPluginRoot(t.label, t.plugin ? roots[t.plugin] : undefined)}
                  </span>
                  <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">
                    <span className={TONE[resultTone(t.result)]}>{resultWord(t.result)}</span>
                    {t.exitCode !== undefined && t.exitCode !== null && <>, exit {t.exitCode}</>}, {t.timedOut ? 'timed out' : duration(t.durationMs)}
                  </span>
                </div>
                {(t.plugin || t.recipe || t.contextChars) && (
                  <div className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
                    {[t.plugin && `plugin ${t.plugin}`, t.recipe && `recipe ${t.recipe}`, t.contextChars && `added ${t.contextChars.toLocaleString('en-US')} chars, about ${Math.round(t.contextChars / 4).toLocaleString('en-US')} tokens`].filter(Boolean).join(', ')}
                  </div>
                )}
                {t.note && <p className="mt-1 mb-0 text-[12px] leading-[1.4] text-warn phone:text-[13px]">{t.note}</p>}
                {t.stderr?.trim() && <CodeBlock className="mt-2" title="stderr" code={t.stderr.replace(/\n$/, '')} wrap maxLines={10} />}
                {t.stdout?.trim() && <CodeBlock className="mt-2" title="stdout" code={t.stdout.replace(/\n$/, '')} wrap maxLines={10} />}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
