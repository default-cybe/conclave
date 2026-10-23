/**
 * Installed plugins: one row each with name, version, description, source,
 * what it adds (from pluginDetail) and an On / Off control. Disabled plugins
 * stay listed, greyed, with what they would add.
 */
import type { PluginDetailDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { OnOff } from '@/components/ui/Field';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Section';
import { addsWords, sourceWords } from './parts';
import { errText } from '@/features/settings/parts';

export function InstalledList({
  list,
  loading,
  error,
  onReload,
  onOpen,
  onBrowse,
  onToggled,
}: {
  list: PluginDetailDto[] | undefined;
  loading: boolean;
  error?: string;
  onReload: () => void;
  onOpen: (name: string) => void;
  onBrowse: () => void;
  onToggled: (name: string, on: boolean) => void;
}) {
  const mobile = useIsMobile();
  const on = list?.filter((p) => p.enabled).length ?? 0;

  const toggle = async (p: PluginDetailDto, v: boolean) => {
    onToggled(p.name, v);
    if (!(await attempt(() => api().setPluginEnabled(p.name, v)))) onToggled(p.name, !v);
  };

  return (
    <section aria-label="Installed plugins">
      {list && list.length > 0 && (
        <p className="m-0 pb-[9px] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
          {list.length === 1 ? (on ? 'Your one plugin is on.' : 'Your one plugin is off.') : on === list.length ? `All ${list.length} are on.` : `${on} of ${list.length} are on.`} A plugin that is off stays installed and loads nothing. Open one to see everything it adds.
        </p>
      )}
      {error && !list && (
        <Notice tone="fault" action={{ label: 'Retry', onClick: onReload }}>
          {`Failed. Could not load plugins: ${errText(error)} Check that the hub is running, then retry.`}
        </Notice>
      )}
      <LoadingRows loading={loading && !list} rows={3} />
      {list && list.length === 0 && (
        <EmptyState action={{ label: 'Browse the marketplace', onClick: onBrowse }}>
          No plugins yet. A plugin adds agents, commands, skills, hooks and MCP servers in one install.
        </EmptyState>
      )}
      <div className={cn('rows', list && list.length > 0 && 'border-t border-rule-2')}>
        {list?.map((p) => {
          const adds = addsWords(p);
          return (
            <div key={p.name} className={cn('flex items-start gap-4 py-3.5', !p.enabled && 'text-fg-3')}>
              <button type="button" onClick={() => onOpen(p.name)} className="-mx-2 -my-1 min-w-0 flex-1 rounded-[var(--r-1)] px-2 py-1 text-left hover:bg-hover" aria-label={`${p.name}, open details`}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className={cn('t-row truncate', p.enabled ? 'text-fg' : 'text-fg-3')}>{p.name}</span>
                  {p.manifest.version && <span className="shrink-0 font-mono text-[11.5px] text-fg-3">{p.manifest.version}</span>}
                  {!p.enabled && <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">off</span>}
                </span>
                {p.manifest.description && (
                  <span className={cn('mt-0.5 line-clamp-2 text-[13px] leading-[1.45] phone:text-[14px]', p.enabled ? 'text-fg-2' : 'text-fg-3')}>{p.manifest.description}</span>
                )}
                <span className="mt-1 block text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
                  {sourceWords(p)}
                  {adds.length > 0 && <>, {p.enabled ? 'adds' : 'would add'} {adds.join(', ')}</>}
                </span>
              </button>
              <div className={cn('shrink-0', mobile ? 'pt-0' : 'pt-0.5')}>
                <OnOff checked={p.enabled} onChange={(v) => void toggle(p, v)} label={`${p.name} enabled`} size={mobile ? 'touch' : 'sm'} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
