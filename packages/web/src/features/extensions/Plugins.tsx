/**
 * Extensions > Plugins (docs/extensions/IA.md). Two views: Installed and
 * Marketplace (?view=marketplace). ?plugin=<name> opens that plugin.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { PluginDetailDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { Tabs } from '@/components/ui/Tags';
import { InstalledList } from './plugins/Installed';
import { Marketplace } from './plugins/Marketplace';
import { PluginSheet } from './plugins/PluginSheet';

async function loadInstalled(): Promise<PluginDetailDto[]> {
  const list = await api().plugins();
  return Promise.all(
    list.map((p) =>
      api()
        .pluginDetail(p.name)
        .catch((): PluginDetailDto => ({ ...p, agents: [], skills: [], commands: [], hooks: {}, mcpServers: {} })),
    ),
  );
}

export function PluginsTab() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const view = params.get('view') === 'marketplace' ? 'marketplace' : 'installed';
  const open = params.get('plugin');
  const installed = useLoad(loadInstalled, []);
  const [list, setList] = useState<PluginDetailDto[]>();
  const [fresh, setFresh] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => setList(installed.data), [installed.data]);

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      const qs = p.toString();
      navigate(`/extensions/plugins${qs ? `?${qs}` : ''}`, { replace: true });
    },
    [search, navigate],
  );

  const changed = () => {
    installed.reload();
    setVersion((v) => v + 1);
  };

  return (
    <div className="space-y-7 phone:space-y-8">
      <Tabs
        label="Plugins view"
        value={view}
        onChange={(v) => setParam({ view: v === 'marketplace' ? 'marketplace' : null })}
        options={[
          { value: 'installed', label: 'Installed', count: list?.length },
          { value: 'marketplace', label: 'Marketplace' },
        ]}
      />
      {view === 'installed' ? (
        <InstalledList
          list={list}
          loading={installed.loading}
          error={installed.error}
          onReload={installed.reload}
          onOpen={(name) => setParam({ plugin: name })}
          onBrowse={() => setParam({ view: 'marketplace' })}
          onToggled={(name, on) => setList((l) => l?.map((p) => (p.name === name ? { ...p, enabled: on } : p)))}
        />
      ) : (
        <Marketplace
          version={version}
          onOpen={(name) => setParam({ plugin: name })}
          onInstalled={(name) => {
            installed.reload();
            setFresh(name);
            setParam({ plugin: name });
          }}
        />
      )}
      <PluginSheet
        name={open}
        open={!!open}
        justInstalled={!!open && fresh === open}
        onClose={() => {
          setFresh(null);
          setParam({ plugin: null });
        }}
        onChanged={changed}
      />
    </div>
  );
}
