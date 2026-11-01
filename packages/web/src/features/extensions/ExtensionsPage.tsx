/**
 * Extensions (docs/extensions/IA.md): one place for everything that changes
 * what an agent can do. A text index on the left like Settings; phones get
 * the index as its own page and each tab opens full screen. The project
 * picker sits in the header (under the title on phones); every tab passes
 * the picked folder as cwd.
 */
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { ListRow, SelectedMark } from '@/components/ui/List';
import { OverviewTab } from './Overview';
import { DiscoverTab } from './Discover';
import { DiscoverLink } from './discover/DiscoverLink';
import { ToolsTab } from './Tools';
import { SkillsTab } from './Skills';
import { CommandsTab } from './Commands';
import { HooksTab } from './Hooks';
import { PluginsTab } from './Plugins';
import { McpServersTab } from './McpServers';
import { SourcesTab } from './Sources';
import { ProjectPicker } from './shared/ProjectPicker';

interface TabDef {
  id: string;
  label: string;
  /** The one-sentence explainer from IA.md, shown under the title. */
  desc: ReactNode;
  /** A shorter line for the phone index, where rows show one line. */
  short: string;
  C: ComponentType;
  width?: number;
}

export const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', desc: 'What is loaded, and whether anything is broken.', short: 'What is loaded, and whether anything is broken.', C: OverviewTab, width: 960 },
  { id: 'discover', label: 'Discover', desc: 'Find tools, skills, plugins, MCP servers, hooks and routines on GitHub and add them here. Each one shows what it runs before you add it.', short: 'Find and add extensions from GitHub.', C: DiscoverTab, width: 960 },
  { id: 'tools', label: 'Tools', desc: 'Tools are the actions an agent can take. Built-in tools ship with Conclave; MCP tools come from servers you connect.', short: 'What agents can do, and what each may run.', C: ToolsTab, width: 960 },
  { id: 'skills', label: 'Skills', desc: 'A skill is a folder of instructions an agent loads when a task needs it. Only the name and description sit in the prompt until then.', short: 'Instructions agents load when a task needs them.', C: SkillsTab, width: 960 },
  { id: 'commands', label: 'Commands', desc: 'A command is a saved prompt you run with /name. Arguments fill placeholders in the text.', short: 'Saved prompts you run with /name.', C: CommandsTab, width: 960 },
  { id: 'hooks', label: 'Hooks', desc: 'Hooks are your scripts that run at fixed points in a session. They can block an action, change its input, or add context for the model.', short: 'Your scripts that run at fixed points.', C: HooksTab, width: 960 },
  { id: 'plugins', label: 'Plugins', desc: 'A plugin bundles skills, commands, agents, hooks and MCP servers. Conclave uses the Claude Code plugin format, which Codex also reads.', short: 'Bundles of skills, commands, agents and hooks.', C: PluginsTab, width: 960 },
  { id: 'mcp', label: 'MCP servers', desc: (
      <>
        MCP servers give agents extra tools, such as your notes, GitHub or a homelab API. Each tool appears as <span className="mono">mcp__server__tool</span>.
      </>
    ), short: 'Servers that give agents extra tools.', C: McpServersTab, width: 960 },
  { id: 'sources', label: 'Sources', desc: 'Conclave reads extensions from several places. When two define the same name, the one lower in this list wins.', short: 'Where extensions come from, and which copy wins.', C: SourcesTab, width: 960 },
];

export default function ExtensionsPage() {
  const { tab } = useParams<{ tab?: string }>();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const current = TABS.find((t) => t.id === tab);

  useEffect(() => {
    if (tab && !current) navigate(mobile ? '/extensions' : '/extensions/overview', { replace: true });
  }, [tab, current, mobile, navigate]);

  if (mobile && !current) return <PhoneIndex />;
  const shown = current ?? TABS[0];
  return mobile ? <PhoneTab t={shown} /> : <DesktopTabs t={shown} />;
}

function TabBody({ t, phone }: { t: TabDef; phone?: boolean }) {
  const C = t.C;
  return (
    <>
      {phone ? (
        <header className="pt-3 pb-6">
          <h1 className="sr-only">{t.label}</h1>
          <ProjectPicker className="-ml-1.5" />
          <p className="mt-3 mb-0 max-w-[64ch] text-[15px] leading-[1.45] text-fg-2">{t.desc}</p>
          <DiscoverLink tab={t.id} className="mt-2" />
        </header>
      ) : (
        <PageHeader title={t.label} actions={<ProjectPicker />} className="pb-6">
          <p className="-mt-3 max-w-[72ch] text-[14px] leading-[1.45] text-fg-2">{t.desc}</p>
          <DiscoverLink tab={t.id} className="mt-1.5" />
        </PageHeader>
      )}
      <C key={t.id} />
    </>
  );
}

function DesktopTabs({ t }: { t: TabDef }) {
  return (
    <Page width="wide">
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-x-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-x-14">
        <nav aria-label="Extensions" className="sticky top-0 self-start pt-6">
          <div className="pb-3 text-[12px] text-fg-3">Extensions</div>
          <ul className="m-0 list-none p-0">
            {TABS.map((x) => {
              const on = x.id === t.id;
              return (
                <li key={x.id}>
                  <Link
                    href={`/extensions/${x.id}`}
                    aria-current={on ? 'page' : undefined}
                    className={cn(
                      'relative flex h-[30px] items-center pl-3 text-[13px] transition-colors duration-[var(--dur-1)]',
                      on ? 'bg-raise font-medium text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg',
                    )}
                  >
                    {on && <SelectedMark />}
                    {x.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 pb-10" style={{ maxWidth: t.width ?? 720 }}>
          <TabBody t={t} />
        </div>
      </div>
    </Page>
  );
}

function PhoneIndex() {
  return (
    <Page width="wide">
      <PageHeader title="Extensions">
        <ProjectPicker className="-ml-1.5 -mt-2" />
      </PageHeader>
      <div className="rows">
        {TABS.map((t) => (
          <ListRow key={t.id} inset={false} href={`/extensions/${t.id}`} title={t.label} meta={<span className="truncate">{t.short}</span>} />
        ))}
      </div>
    </Page>
  );
}

function PhoneTab({ t }: { t: TabDef }) {
  usePageHeader(t.label, '/extensions');
  return (
    <Page width="wide">
      <TabBody t={t} phone />
    </Page>
  );
}
