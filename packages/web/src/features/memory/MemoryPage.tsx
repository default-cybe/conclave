/**
 * Memory (spec 11.7) in four tabs: Notes (/memory), Connections (other
 * memory stores), Import and export (other tools' memory files, markdown
 * out), and Share (Conclave memory for Claude Code, Codex, OpenCode and
 * Gemini CLI over MCP). /memory/connections#share lands on Share.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import type { MemoryKind } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { useIsMobile, useNow } from '@/lib/hooks';
import { Page, PageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tags';
import { NotesTab } from './Notes';
import { ConnectionsTab } from './Connections';
import { ImportExportTab } from './ImportExport';
import { ShareTab } from './Share';
import { useConnectionList } from './store';
import { storeWords } from './words';

type TabId = 'notes' | 'connections' | 'import' | 'share';

const TABS: Array<{ id: TabId; label: string; href: string }> = [
  { id: 'notes', label: 'Notes', href: '/memory' },
  { id: 'connections', label: 'Connections', href: '/memory/connections' },
  { id: 'import', label: 'Import and export', href: '/memory/import' },
  { id: 'share', label: 'Share', href: '/memory/share' },
];

const WEEK = 7 * 86_400_000;

export default function MemoryPage() {
  const { tab } = useParams<{ tab?: string }>();
  const [, navigate] = useLocation();
  const mobile = useIsMobile();
  const now = useNow(60_000);
  const memories = useHub((s) => s.memories);
  const conns = useConnectionList();
  const [adding, setAdding] = useState<MemoryKind | null>(null);
  const [addConn, setAddConn] = useState(false);
  const current: TabId = (TABS.find((t) => t.id === tab)?.id ?? 'notes') as TabId;

  // old links point at /memory/connections#share
  useEffect(() => {
    if (window.location.hash === '#share' && tab !== 'share') navigate('/memory/share#share', { replace: true });
    else if (tab && !TABS.some((t) => t.id === tab) && tab !== 'notes') navigate('/memory', { replace: true });
  }, [tab, navigate]);

  const all = Object.values(memories);
  const thisWeek = all.filter((m) => now - m.createdAt < WEEK).length;
  const sub = all.length ? `${all.length} ${all.length === 1 ? 'note' : 'notes'}${thisWeek ? `, ${thisWeek} this week` : ''}` : undefined;
  const store = storeWords(conns.list);
  const size = mobile ? 'touch' : 'md';

  const actions =
    current === 'notes' ? (
      <Button variant="solid" size={size} onClick={() => setAdding('fact')}>
        Add a note
      </Button>
    ) : current === 'connections' ? (
      <Button variant="solid" size={size} onClick={() => setAddConn(true)}>
        Add a connection
      </Button>
    ) : undefined;

  return (
    <Page width="wide">
      <PageHeader title="Memory" sub={sub} actions={actions}>
        <p className="-mt-2 mb-4 min-h-[17px] text-[12px] text-fg-2 phone:min-h-[19px] phone:text-[13px]">
          {store.text}
          {store.problem && <span className="text-fault"> {store.problem}</span>}
          {current !== 'connections' && conns.list && (
            <>
              {' '}
              <Link href="/memory/connections" className="link">
                {conns.list?.length ? 'Connections' : 'Connect a store'}
              </Link>
            </>
          )}
        </p>
        <Tabs label="Memory" value={current} options={TABS.map((t) => ({ value: t.id, label: t.label, href: t.href }))} className="flex-wrap gap-y-2" />
      </PageHeader>
      {current === 'notes' && <NotesTab adding={adding} setAdding={setAdding} store={store.text} />}
      {current === 'connections' && <ConnectionsTab adding={addConn} setAdding={setAddConn} />}
      {current === 'import' && <ImportExportTab />}
      {current === 'share' && <ShareTab />}
    </Page>
  );
}
