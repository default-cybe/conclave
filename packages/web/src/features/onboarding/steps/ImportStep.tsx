/**
 * Step 6, Import (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.14): past
 * Claude Code, Codex and Gemini CLI chats on a machine, grouped by project,
 * with the choice to also learn memory from them. The cleanup warning comes
 * with its one tap fix, and "Keep importing new chats" turns on the watch
 * job. The import runs on the hub and keeps going when the owner moves on.
 */
import { useState } from 'react';
import { useIsMobile } from '@/lib/hooks';
import { toast, updateConfig, useHub } from '@/store/store';
import { OnOff } from '@/components/ui/Field';
import { LiveStatus, Roll } from '@/components/motion';
import { PastChats } from '@/features/import/PastChats';
import { Batches } from '@/features/import/Batches';
import { isLive, useImport } from '@/features/import/store';
import { batchProgress } from '@/features/import/words';
import { StepFrame } from '../StepLayout';

export function ImportStep() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config) as { import?: { watch?: boolean } } | undefined;
  const watch = !!config?.import?.watch;
  const [saving, setSaving] = useState(false);
  const live = useImport((s) => s.batches.find(isLive));
  const last = useImport((s) => s.batches[0]);

  const setWatch = async (on: boolean) => {
    setSaving(true);
    try {
      await updateConfig({ import: { ...(config?.import ?? {}), watch: on } } as never);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const p = live ? batchProgress(live) : undefined;
  const summary = live && p ? (
    <LiveStatus state="tool" label={p.verb} detail={<Roll value={`${p.done} of ${p.total}`} />} startedAt={live.createdAt} />
  ) : last && last.status === 'done' ? (
    `Imported ${last.imported + last.updated} chats${last.memoriesAdded ? ` and learned ${last.memoriesAdded} memories` : ''}.`
  ) : (
    'Pick the chats to bring over, or skip this step.'
  );

  return (
    <StepFrame summary={summary}>
      <div className="space-y-8">
        <PastChats compact noUpload />
        <div className={mobile ? 'space-y-3' : 'flex items-start justify-between gap-6'}>
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">Keep importing new chats</div>
            <p className="m-0 mt-0.5 max-w-[56ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Every 6 hours the hub reads the online machines and imports new chats the same way, so they are copied before the tools delete them.</p>
          </div>
          <OnOff checked={watch} onChange={(v) => void setWatch(v)} label="Keep importing new chats" disabled={saving} size={mobile ? 'touch' : 'sm'} />
        </div>
        <Batches limit={2} title="Imports" />
      </div>
    </StepFrame>
  );
}
