/**
 * Settings > Models > Usage fallback (core session/limits.ts limitFallback).
 * An ordered list of models, no accounts: when a model is at its limit on
 * every account, the next model here takes over, on its own account order
 * (Accounts). Off: a limit falls back on the Refusal fallback list as before.
 *
 * Rows: number, model, up, down, remove. Every change saves at once
 * (models.limitFallback), as the Refusal fallback page does.
 */
import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { LimitFallbackConfig } from '@conclave/core/config/schema';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { ModelList, ModelPicker } from '@/components/pickers/ModelPicker';
import { Button, IconButton } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { Popover } from '@/components/ui/Overlay';
import { Group, save, SettingRow } from './parts';

/** The list with one item moved; the same list when the move goes off either end. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

export function UsageFallbackSection() {
  const config = useHub((s) => s.config);
  const own = ((config?.models as { limitFallback?: LimitFallbackConfig } | undefined)?.limitFallback ?? {}) as LimitFallbackConfig;
  const models = own.models ?? [];
  const mobile = useIsMobile();
  const addRef = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);

  const write = (next: Partial<LimitFallbackConfig>) => void save({ models: { limitFallback: { ...own, ...next } } });
  const setModels = (list: string[]) => write({ models: list });

  return (
    <div className="space-y-9">
      <Group title="When a model is at its limit">
        <SettingRow label="Use this list" help="When a model is at its limit on every account, the next model here takes over, on its own account order.">
          <OnOff checked={own.enabled === true} onChange={(v) => write({ enabled: v })} label="Use this list" />
        </SettingRow>
      </Group>

      <Group
        title="Order"
        count={models.length || undefined}
        right={
          <Button ref={addRef} variant="outline" size="sm" aria-expanded={adding} onClick={() => setAdding(true)}>
            Add a model
          </Button>
        }
      >
        {models.length === 0 ? (
          <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[14px]">No models yet. Off or empty: a limit uses the Refusal fallback list.</p>
        ) : (
          models.map((m, i) => (
            <div key={`${m}#${i}`} className="flex items-center gap-3 py-3">
              <span className="num w-4 shrink-0 text-right text-[12.5px] text-fg-3" aria-label={`Step ${i + 1}`}>
                {i + 1}
              </span>
              <ModelPicker look="field" label={`Step ${i + 1} model`} value={m} harnesses={false} onChange={(ref) => setModels(models.map((x, j) => (j === i ? ref : x)))} className="min-w-0 flex-1 md:max-w-[320px]" />
              <span className="ml-auto flex shrink-0 items-center gap-0.5 phone:-mr-2">
                <IconButton label="Move up" size={mobile ? 'touch' : 'sm'} disabled={i === 0} onClick={() => setModels(moveItem(models, i, i - 1))}>
                  <ChevronUp />
                </IconButton>
                <IconButton label="Move down" size={mobile ? 'touch' : 'sm'} disabled={i === models.length - 1} onClick={() => setModels(moveItem(models, i, i + 1))}>
                  <ChevronDown />
                </IconButton>
                <IconButton label="Remove" size={mobile ? 'touch' : 'sm'} onClick={() => setModels(models.filter((_, j) => j !== i))}>
                  <X />
                </IconButton>
              </span>
            </div>
          ))
        )}
      </Group>

      <Popover anchor={addRef} open={adding} onClose={() => setAdding(false)} width={380} maxHeight={480} label="Add a model" sheetTitle="Add a model">
        <ModelList harnesses={false} onChange={(ref) => setModels([...models, ref])} onDone={() => setAdding(false)} />
      </Popover>
    </div>
  );
}
