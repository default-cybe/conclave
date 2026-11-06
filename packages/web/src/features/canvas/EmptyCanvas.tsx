/**
 * The empty canvas (ComfyUI's start): a centred hint over the dot grid, and a
 * Describe it box that hands the words to the Agent tab. Once they are sent
 * the box folds to a small Building chip at the top, which counts the blocks
 * as the canvas reloads them.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { cn } from '@/lib/text';

export function EmptyCanvas({ empty, building, blocks, onDescribe, phone }: { empty: boolean; building: boolean; blocks: number; onDescribe?: (text: string) => void; phone: boolean }) {
  const [text, setText] = useState('');
  const go = () => text.trim() && (onDescribe?.(text.trim()), setText(''));
  if (building)
    return (
      <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <span className="rounded-[var(--r-2)] border border-rule-2 bg-raise px-3 py-1 text-[13px] text-fg-2 shadow-[var(--shadow-pop)]">
          <span className="cv-dot-pulse mr-2 inline-block size-1.5 rounded-full bg-signal align-middle" />
          Building…{blocks ? ` ${blocks} ${blocks === 1 ? 'block' : 'blocks'} so far` : ''}
        </span>
      </div>
    );
  if (!empty) return null;
  return (
    <div className={cn('pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6', phone && 'pb-24')}>
      <p className="m-0 text-center text-[15px] text-fg-2">{phone ? 'Tap Nodes, or long-press the canvas, to add a block' : 'Double-click or drag a block from the library to start'}</p>
      {onDescribe && (
        <div className="pointer-events-auto w-full max-w-[480px] space-y-2 rounded-[var(--r-2)] border border-rule-2 bg-raise p-3 shadow-[var(--shadow-pop)]">
          <label htmlFor="cv-describe" className="block text-[12px] font-medium text-fg-3">
            Or describe it
          </label>
          <Textarea id="cv-describe" rows={2} value={text} placeholder="fetch HN top 10, summarise each, post to my inbox" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), go())} />
          <div className="flex justify-end">
            <Button variant="primary" size={phone ? 'touch' : 'sm'} disabled={!text.trim()} onClick={go}>
              Build it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
