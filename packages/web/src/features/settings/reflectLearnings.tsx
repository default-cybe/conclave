/**
 * Reflect's Learnings (docs/ASSISTANT.md, Learnings): corrections,
 * preferences and praise caught from what you typed, each with Save, Edit
 * and Skip and a place to save it, and skill ideas from requests you repeat.
 * Nothing is written until Save; a file target shows its diff first.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { LearningPreview, LearningsDto, LearningTarget, LearningView } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Segmented, Textarea } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { TextAction } from '@/components/ui/Section';
import { toast } from '@/store/store';
import { agoWords, errText, Group } from './parts';

const KIND_WORDS = { correction: 'Correction', preference: 'Preference', remember: 'Remember', positive: 'Worked well' } as const;

export function LearningsSection() {
  const [d, setD] = useState<LearningsDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    api()
      .learnings()
      .then(setD)
      .catch((e) => setError(errText(e)));
  }, []);
  const call = async (key: string, fn: () => Promise<LearningsDto>, done?: string) => {
    setBusy(key);
    try {
      setD(await fn());
      if (done) toast({ title: done });
    } catch (e) {
      toast({ title: `Could not do that. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };
  if (error) return <p className="text-[13px] text-fault">Could not load Learnings. {error}</p>;
  if (!d) return <LoadingRows loading rows={3} />;
  return (
    <div className="space-y-9">
      <Group title="Learnings" count={d.pending || undefined} rows={false} help="Corrections and preferences you typed in chats and code sessions. Nothing is saved until you press Save. Incognito chats are never read.">
        {d.items.length === 0 ? (
          <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[15px]">Nothing waits.{d.queued ? ` ${d.queued} message${d.queued === 1 ? '' : 's'} wait for the next check.` : ' When you correct the assistant or say what you prefer, it shows up here.'}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {d.items.map((it) => (
              <Item key={it.id} it={it} busy={busy} onSave={(target, text, kind, mergeInto) => call(it.id, () => api().saveLearning(it.id, { target, text, ...(target === 'memory' ? { memoryKind: kind } : {}), ...(mergeInto ? { mergeInto } : {}) }), 'Saved.')} onSkip={() => call(it.id, () => api().skipLearning(it.id))} />
            ))}
          </ul>
        )}
      </Group>
      <Group
        title="Skill ideas"
        rows={false}
        help={d.ideasAt ? `Looked ${agoWords(d.ideasAt)} at your last 14 days.` : 'Requests you made three times or more in the last 14 days, as a skill or routine you can save.'}
      >
        <div className="py-3">
          <Button variant="outline" size="sm" busy={busy === 'find' ? 'Looking' : false} onClick={() => void call('find', () => api().findIdeas())}>
            {d.ideasAt ? 'Look again' : 'Look for ideas'}
          </Button>
        </div>
        {d.ideasAt && !d.ideas.length && <p className="m-0 pb-3 text-[13px] text-fg-3">No request came up often enough.</p>}
        <ul className="m-0 list-none p-0">
          {d.ideas.map((i) => (
            <li key={i.id} className="border-t border-rule py-3">
              <p className="m-0 text-[13.5px] text-fg phone:text-[15px]">
                <span className="text-fg-3">{i.kind === 'skill' ? 'Skill' : 'Routine'}</span> <span className="font-mono">{i.name}</span>
              </p>
              <p className="m-0 mt-0.5 text-[13px] text-fg-2">{i.description}</p>
              <p className="m-0 mt-0.5 text-[12px] text-fg-3">From: {i.examples.join(', ')}</p>
              <span className="mt-2 flex items-baseline gap-3">
                <TextAction label={i.kind === 'skill' ? 'Save skill' : 'Save routine'} onClick={() => void call(i.id, () => api().saveIdea(i.id), 'Saved.')} />
                <TextAction label="Skip" onClick={() => void call(i.id, () => api().skipIdea(i.id))} />
              </span>
            </li>
          ))}
        </ul>
      </Group>
    </div>
  );
}

function Item({ it, busy, onSave, onSkip }: { it: LearningView; busy?: string; onSave: (t: LearningTarget, text: string, kind: 'fact' | 'profile', mergeInto?: string) => void; onSkip: () => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [target, setTarget] = useState<LearningTarget>('memory');
  const [edit, setEdit] = useState<string>();
  const [kind, setKind] = useState<'fact' | 'profile'>('fact');
  const [merge, setMerge] = useState<string>();
  const [preview, setPreview] = useState<LearningPreview>();
  const opt = it.targets.find((t) => t.target === target)!;
  const text = edit ?? (target === 'memory' ? it.fact : it.rule);
  const mem = it.similar.find((s) => s.kind === 'memory');

  useEffect(() => {
    setPreview(undefined);
    if (target === 'memory' || opt.refused) return;
    api()
      .previewLearning(it.id, { target, text })
      .then(setPreview)
      .catch(() => undefined);
  }, [it.id, target, text, opt.refused]);

  return (
    <li className="border-b border-rule py-3.5 last:border-b-0">
      <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
        {KIND_WORDS[it.kind]}
        {it.count > 1 && <span className="num"> · said {it.count} times</span>} · {Math.round(it.confidence * 100)}% sure ·{' '}
        <Link href={`/s/${it.sessionId}`} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
          {it.sessionTitle ?? 'the chat'}
        </Link>
      </p>
      <blockquote className="m-0 mt-1.5 border-l-2 border-rule-2 pl-3 text-[13px] text-fg-2 italic phone:text-[14px]">{it.quote}</blockquote>
      <div className="mt-2.5">
        {edit !== undefined ? <Textarea value={edit} onChange={(e) => setEdit(e.target.value)} minRows={1} maxRows={4} aria-label="Learning" /> : <p className="m-0 text-[14px] leading-[1.45] text-fg phone:text-[15px]">{text}</p>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Segmented label="Save to" size={size} value={target} onChange={(v) => (setTarget(v), setEdit(undefined))} options={it.targets.map((t) => ({ value: t.target, label: t.target === 'memory' ? 'Memory' : t.target === 'agent' ? 'Agent' : t.target === 'project' ? 'Project' : 'Skill' }))} />
        {target === 'memory' && <Segmented label="Memory kind" size={size} value={kind} onChange={setKind} options={[{ value: 'fact', label: 'Fact' }, { value: 'profile', label: 'Profile' }]} />}
      </div>
      <p className="m-0 mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">{opt.refused ?? opt.label}</p>
      {target === 'memory' && mem && (
        <label className="mt-1.5 flex items-start gap-2 text-[12.5px] text-fg-2">
          <input type="checkbox" checked={merge === mem.ref} onChange={(e) => setMerge(e.target.checked ? mem.ref : undefined)} className="mt-0.5" />
          <span>Replace a near memory instead: "{mem.text}"</span>
        </label>
      )}
      {preview && preview.diff.length > 0 && (
        <pre className="m-0 mt-2 overflow-x-auto rounded-[var(--r-1)] bg-sunk p-2.5 font-mono text-[11.5px] leading-[1.5] text-fg-2">
          <span className="text-fg-3">{preview.path}</span>
          {'\n'}
          {preview.diff.map((l, i) => (
            <span key={i} className={l.startsWith('+') ? 'text-ok' : undefined}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Button variant="solid" size={size} disabled={!!opt.refused || !text.trim()} busy={busy === it.id ? 'Saving' : false} onClick={() => onSave(target, text.trim(), kind, target === 'memory' ? merge : undefined)}>
          Save
        </Button>
        <Button variant="ghost" size={size} onClick={() => setEdit(edit === undefined ? text : undefined)}>
          {edit === undefined ? 'Edit' : 'Cancel edit'}
        </Button>
        <Button variant="ghost" size={size} onClick={onSkip}>
          Skip
        </Button>
      </div>
    </li>
  );
}

/** Home's small line when learnings wait: a link to Reflect. */
export function LearningsBadge() {
  const [n, setN] = useState(0);
  useEffect(() => {
    api()
      .learningsCount()
      .then((r) => setN(r.pending))
      .catch(() => undefined);
  }, []);
  if (!n) return null;
  return (
    <Link href="/settings/reflect" className="inline-flex items-center gap-2 text-[13px] text-fg-2 hover:text-fg">
      <span className="num text-[13px] font-[550] text-warn">{n}</span>
      {n === 1 ? 'learning waits' : 'learnings wait'} for review in Reflect
    </Link>
  );
}
