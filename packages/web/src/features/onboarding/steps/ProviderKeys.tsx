/**
 * The API key rows of setup's Connect a model step (spec 11.11, graft 9).
 * Keys are write only: Save (or Enter) saves with setSecret and tests with
 * testProvider, and the result shows in words. CLI logins as engines are a
 * "Set up later" page (Coding agents), not part of this step.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PROVIDERS } from '@/lib/providers';
import { reloadConfig, reloadModels, updateConfig, useHub } from '@/store/store';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { ProviderHeader, ProviderRow, type ProviderResult } from '@/components/providers/ProviderRow';
import { andList, LINK } from '../parts';

/** `onReady`: how many providers work now, a tested key or a local runtime found. */
export function ProviderKeys({ onReady }: { onReady: (ready: number, rejected: number) => void }) {
  const keys = useHub((s) => s.secrets?.providers);
  const config = useHub((s) => s.config);
  const [more, setMore] = useState(() => PROVIDERS.some((p) => p.more && keys?.includes(p.id)));
  const [results, setResults] = useState<Record<string, ProviderResult['state']>>({});
  const [epoch, setEpoch] = useState<Record<string, number>>({});

  const shown = PROVIDERS.filter((p) => !p.more || more);

  const onResult = (id: string) => (r: ProviderResult) => {
    setResults((m) => ({ ...m, [id]: r.state }));
    // a local runtime that answered is ready to use
    const p = PROVIDERS.find((x) => x.id === id);
    if (p?.signIn === 'none' && r.state === 'found') {
      const cur = (config?.providers as Record<string, { enabled?: boolean }> | undefined)?.[id];
      if (cur?.enabled !== true) void updateConfig({ providers: { [id]: { enabled: true } } }).catch(() => undefined);
    }
  };

  const states = Object.values(results);
  const ready = states.filter((s) => s === 'works' || s === 'found').length;
  const bad = states.filter((s) => s === 'rejected').length;
  useEffect(() => onReady(ready, bad), [ready, bad, onReady]);

  const remount = (id: string) => setEpoch((e) => ({ ...e, [id]: (e[id] ?? 0) + 1 }));

  return (
    <section>
      <SectionHeading rule={false} className="pb-1">
        Or paste an API key
      </SectionHeading>
      <p className="m-0 max-w-[64ch] pb-3 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">For a provider you pay per use. Each key is tested when you save it.</p>
      <ProviderHeader />
      <div className="rows border-b border-rule">
        {shown.map((p) => (
          <ProviderRow
            key={`${p.id}:${epoch[p.id] ?? 0}`}
            provider={p.id}
            testOnMount
            onResult={onResult(p.id)}
            menu={
              keys?.includes(p.id)
                ? [
                    { label: 'Test again', onSelect: () => remount(p.id) },
                    {
                      label: 'Remove key',
                      danger: true,
                      onSelect: async () => {
                        await api().setSecret('providers', p.id, null);
                        await reloadConfig();
                        void reloadModels();
                        setResults((m) => ({ ...m, [p.id]: 'notset' }));
                        remount(p.id);
                      },
                    },
                  ]
                : p.signIn === 'none'
                  ? [{ label: 'Look again', onSelect: () => remount(p.id) }]
                  : undefined
            }
          />
        ))}
      </div>
      {!more && (
        <div className="pt-3">
          <TextAction className={LINK} label={`More providers: ${andList(PROVIDERS.filter((p) => p.more).map((p) => p.name))}`} onClick={() => setMore(true)} />
        </div>
      )}
    </section>
  );
}
