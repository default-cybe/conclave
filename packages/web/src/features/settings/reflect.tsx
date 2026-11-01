/**
 * Settings > Reflect (docs/ASSISTANT.md, Nightly reflection), after Claude's
 * Reflect page: the nightly reflection on one page. The switch is the same
 * setting as Settings > Assistant's (one routine, nightly-reflection), with
 * its time and model, Reflect now for the hub's owner, what the last run did,
 * and the notes it keeps, each with Edit and Delete.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { MemoryEntry } from '@conclave/core/types';
import type { ReflectDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { useIsOwner } from '@/lib/people';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { TextAction } from '@/components/ui/Section';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { toast } from '@/store/store';
import { agoWords, errText, Group, SettingRow } from './parts';
import { lastRunWords, modelChoice, REFLECT_LINE, TIME, timeWords } from './reflectWords';

export function ReflectSection() {
  const [r, setR] = useState<ReflectDto>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api()
      .reflect()
      .then(setR)
      .catch((e) => setError(errText(e)));
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load Reflect. {error}</p>;
  if (!r) return <LoadingRows loading rows={6} />;
  return <Body r={r} onChange={setR} />;
}

function Body({ r, onChange }: { r: ReflectDto; onChange: (r: ReflectDto) => void }) {
  const mobile = useIsMobile();
  const owner = useIsOwner();
  const size = mobile ? 'touch' : 'sm';
  const [time, setTime] = useState(r.time ?? '');
  const [busy, setBusy] = useState<string>();
  const [other, setOther] = useState(modelChoice(r.model) === 'other');
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(poll.current), []);

  const call = async (key: string, fn: () => Promise<ReflectDto>) => {
    setBusy(key);
    try {
      onChange(await fn());
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };

  // while a run goes, read the page again every few seconds until it is done
  const follow = (left = 40) => {
    clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      const next = await api().reflect().catch(() => undefined);
      if (next) onChange(next);
      if (left > 0 && next?.last?.status === 'running') follow(left - 1);
    }, 3000);
  };

  const reflectNow = async () => {
    setBusy('now');
    try {
      const out = await api().reflectNow();
      onChange(out.reflect);
      if (out.skipped) toast({ title: `Nothing to reflect on. ${out.skipped}.` });
      else {
        toast({ title: 'Reflecting now. The notes show up here when it is done.' });
        follow();
      }
    } catch (e) {
      toast({ title: `Could not start it. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };

  const choice = other ? 'other' : modelChoice(r.model);
  const timeDirty = time !== (r.time ?? '');

  return (
    <div className="space-y-9">
      <Group title="Nightly reflection" help={REFLECT_LINE}>
        <SettingRow label="Reflect each night" help="Never takes a note from an email, a web page or a tool result. Chats with agents that read those are left out. The same switch as in Settings, Assistant.">
          <OnOff label="Reflect each night" size={size} checked={r.enabled} disabled={busy === 'on'} onChange={(v) => void call('on', () => api().setReflect({ enabled: v }))} />
        </SettingRow>
        <SettingRow label="Time" help={timeWords(r)} top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input mono inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value.trim())} aria-label="Reflect at" placeholder="02:40" className="w-[88px]!" size="sm" invalid={!!time && !TIME.test(time)} />
            {timeDirty && (
              <Button variant="solid" size={size} disabled={!TIME.test(time)} busy={busy === 'time' ? 'Saving' : false} onClick={() => void call('time', () => api().setReflect({ time }))}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Model" help={choice === 'fast' ? 'The small model: about $0.005 a night.' : choice === 'default' ? 'The default model: about $0.07 a night on Sonnet 5.5.' : 'Another model for this routine only.'} top>
          <div className="flex flex-col items-start gap-2 md:items-end">
            <Segmented
              label="Model"
              size={mobile ? 'touch' : 'sm'}
              value={choice}
              onChange={(v) => {
                if (v === 'other') return setOther(true);
                setOther(false);
                void call('model', () => api().setReflect({ model: v === 'fast' ? 'fast' : '' }));
              }}
              options={[
                { value: 'default', label: 'Default' },
                { value: 'fast', label: 'Small' },
                { value: 'other', label: 'Other' },
              ]}
            />
            {choice === 'other' && <ModelPicker look="field" harnesses={false} value={modelChoice(r.model) === 'other' ? r.model : undefined} placeholder="Choose a model" onChange={(v) => void call('model', () => api().setReflect({ model: v }))} />}
          </div>
        </SettingRow>
        <SettingRow
          label="Last run"
          help={
            <>
              {lastRunWords(r.last)}
              {r.last?.sessionId && (
                <>
                  {' '}
                  <Link href={`/s/${r.last.sessionId}`} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                    Open the run
                  </Link>
                </>
              )}
            </>
          }
        >
          {owner ? (
            <Button variant="outline" size={size} busy={busy === 'now' ? 'Starting' : r.last?.status === 'running'} disabled={r.last?.status === 'running'} onClick={() => void reflectNow()}>
              Reflect now
            </Button>
          ) : (
            <span className="text-[12px] text-fg-3 phone:text-[13px]">Reflect now is for the hub's owner.</span>
          )}
        </SettingRow>
      </Group>

      <Notes notes={r.notes} onChanged={() => void api().reflect().then(onChange).catch(() => undefined)} routineId={r.routineId} />
    </div>
  );
}

/** The notes it keeps on how to work with you, newest first, each with Edit and Delete. */
function Notes({ notes, onChanged, routineId }: { notes: MemoryEntry[]; onChanged: () => void; routineId?: string }) {
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string>();
  const [del, setDel] = useState<MemoryEntry>();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';

  const saveEdit = async (id: string) => {
    setBusy(id);
    try {
      await api().updateMemory(id, { content: text.trim() });
      setEditing(undefined);
      onChanged();
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };
  const remove = async (n: MemoryEntry) => {
    try {
      await api().deleteMemory(n.id);
      onChanged();
    } catch (e) {
      toast({ title: `Could not delete. ${errText(e)}`, level: 'error' });
    }
    setDel(undefined);
  };

  return (
    <Group
      title="Notes on how to work with you"
      count={notes.length || undefined}
      rows={false}
      help="The assistant reads these on every turn. Edit one to say it better, or delete one that is wrong. The next reflection reads them before it saves anything."
    >
      {notes.length === 0 ? (
        <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[15px]">No notes yet. After a night with chats, up to 3 show up here.{routineId ? '' : ' Turn it on, or press Reflect now.'}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {notes.map((n) => (
            <li key={n.id} className="border-b border-rule py-3 last:border-b-0">
              {editing === n.id ? (
                <div className="space-y-2">
                  <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} maxRows={6} aria-label="Note" />
                  <div className="flex items-center gap-2">
                    <Button variant="solid" size={size} disabled={!text.trim() || text.trim() === n.content} busy={busy === n.id ? 'Saving' : false} onClick={() => void saveEdit(n.id)}>
                      Save
                    </Button>
                    <Button variant="ghost" size={size} onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[13.5px] leading-[1.45] text-fg phone:text-[15px]">{n.content}</p>
                    <p className="m-0 mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">Kept {agoWords(n.updatedAt)}</p>
                  </div>
                  <span className="flex shrink-0 items-baseline gap-3 pt-0.5">
                    <TextAction
                      label="Edit"
                      onClick={() => {
                        setText(n.content);
                        setEditing(n.id);
                      }}
                    />
                    <TextAction label="Delete" onClick={() => setDel(n)} />
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!del} onClose={() => setDel(undefined)} onConfirm={() => del && remove(del)} title="Delete this note?" body={del ? `"${del.content}" leaves memory. The assistant stops reading it.` : undefined} />
    </Group>
  );
}
