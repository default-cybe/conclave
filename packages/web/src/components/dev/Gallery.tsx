/**
 * Component gallery at /dev/ui. Every shared piece with real mock data, for
 * builders and screenshot QA. Lazy loaded; not linked from the nav.
 */
import { useState, type ReactNode } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { useHub, toast } from '@/store/store';
import { useUi } from '@/store/ui';
import { Page, PageHeader } from '../ui/Page';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Field, Input, OnOff, Radio, Segmented, Textarea } from '../ui/Field';
import { SelectMenu } from '../ui/Select';
import { ConfirmDialog, Dialog, Menu } from '../ui/Overlay';
import { Tooltip } from '../ui/Tooltip';
import { Kbd, MOD } from '../ui/Kbd';
import { ListRow, MetaLine, StateWord } from '../ui/List';
import { Aside, KV, Notice, Quote, Section, SectionHeading } from '../ui/Section';
import { Stat, StatGroup } from '../ui/Stat';
import { LimitGroup, Meter, limitPeak } from '../ui/Meter';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { FilterLinks, Tabs, Tags } from '../ui/Tags';
import { Table } from '../ui/Table';
import { CodeBlock, Command, Diff, InlineCode } from '../ui/Code';
import { Brand, Mark } from '../brand/Mark';
import { LOGOS, type LogoId } from '../logo/registry';
import { CompanyName, HarnessName, Logo, MarkStack, ModelName, Monogram } from '../logo';
import { Wave } from '../wave';
import { Elapsed, Knot, LiveStatus } from '../motion';
import { ApprovalCard } from '../inbox/ApprovalCard';
import { QuestionCard } from '../inbox/QuestionCard';
import { ModelPicker } from '../pickers/ModelPicker';
import { AgentPicker, DevicePicker } from '../pickers/Pickers';
import { ProviderHeader, ProviderRow } from '../providers/ProviderRow';
import { PairingPanel } from '../devices/PairingPanel';
import { DayAxis, dayMarks } from '../routines/DayAxis';
import { MotionGallery } from './MotionGallery';

const DIFF = `--- a/packages/server/src/auth.ts
+++ b/packages/server/src/auth.ts
@@ -4,7 +4,8 @@
 const SECRET = new TextEncoder().encode(process.env.CONCLAVE_JWT_SECRET!);
+const VERIFY = { algorithms: ['HS256'], issuer: 'conclave' } as const;

 export const auth: MiddlewareHandler = async (c, next) => {
-  const { payload } = await jwtVerify<Claims>(token, SECRET);
+  const { payload } = await jwtVerify<Claims>(token, SECRET, VERIFY);
   c.set('user', payload.sub);`;

function Block({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="mt-10">
      <SectionHeading right={note ? <span className="text-[12px] text-fg-3">{note}</span> : undefined}>{title}</SectionHeading>
      <div className="pt-4">{children}</div>
    </section>
  );
}

export default function Gallery() {
  const s = useHub();
  const theme = useUi((x) => x.resolved);
  const [seg, setSeg] = useState<'light' | 'dark' | 'system'>('system');
  const [on, setOn] = useState(true);
  const [chk, setChk] = useState(true);
  const [radio, setRadio] = useState('hub');
  const [sel, setSel] = useState<string | undefined>('weekdays');
  const [model, setModel] = useState<string | undefined>('anthropic/claude-sonnet-5-5');
  const [agent, setAgent] = useState<string | undefined>('coder');
  const [device, setDevice] = useState<string | undefined>('arch-desktop');
  const [tab, setTab] = useState('settings');
  const [filter, setFilter] = useState('all');
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pair, setPair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const approvals = Object.values(s.approvals);
  const questions = Object.values(s.questions);
  const limits = Object.values(s.limits).sort((a, b) => limitPeak(b) - limitPeak(a));
  const started = Date.now() - 12 * 60_000 - 4_000;

  return (
    <Page>
      <PageHeader title="Components" sub={`Shared pieces from docs/design/COMPONENTS.md, ${theme} theme.`} actions={<Button variant="solid">Primary action</Button>} />

      <Block title="Brand">
        <div className="flex flex-wrap items-center gap-10">
          <Brand />
          <Brand size={20} />
          <Mark height={28} />
          <Mark height={14} mono />
        </div>
      </Block>

      <Block title="Motion" note="components/motion, docs/design/CHAT-AND-MOTION.md">
        <MotionGallery />
      </Block>

      <Block title="Type roles">
        <div className="space-y-3">
          <p className="t-status">Two sessions running. <span className="text-warn">Two are waiting on you.</span></p>
          <p className="t-verdict">Use Caddy.</p>
          <p className="t-step">Add your providers</p>
          <p className="t-page">Routines</p>
          <p className="t-title">Move auth middleware to jose</p>
          <p className="t-stat">$149.07</p>
          <p className="t-section">Section heading</p>
          <p className="t-row">Row title, Verify PBS backups for all LXCs</p>
          <p className="t-body">Body text. Claude's 5 hour window is at 72%.</p>
          <p className="t-prose max-w-[72ch] text-fg">Prose for messages and notes. Caddy runs in LXC 101 at <InlineCode>10.0.20.11</InlineCode> and the Proxmox UI is never proxied.</p>
          <p className="t-meta text-fg-3">Meta line, coder, arch-desktop, 12m</p>
          <p className="t-micro font-mono text-fg-3">-60m -45 -30 -15 now</p>
        </div>
      </Block>

      <Block title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="solid">Allow once</Button>
          <Button variant="outline">Allow for this session</Button>
          <Button variant="quiet">Skip for now</Button>
          <Button variant="quiet-fault">Deny</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="danger-outline">Revoke</Button>
          <Button variant="solid" disabled>
            Disabled
          </Button>
          <Button variant="solid" kbd="↵">
            Start
          </Button>
          <Button variant="outline" busy={busy ? 'Testing' : false} onClick={() => setBusy((b) => !b)}>
            Test
          </Button>
          <IconButton label="More actions">
            <MoreHorizontal />
          </IconButton>
          <IconButton label="Close" variant="outline">
            <X />
          </IconButton>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm">Small 26</Button>
          <Button size="md">Medium 30</Button>
          <Button size="lg" variant="solid">
            Large 38
          </Button>
          <Button size="touch">Touch 44</Button>
        </div>
      </Block>

      <Block title="Inputs">
        <div className="grid max-w-[720px] gap-5 md:grid-cols-2">
          <Field label="Hub address" help="The address printed by conclave serve.">
            <Input mono placeholder="https://hub.example.com" />
          </Field>
          <Field label="OpenRouter key" error="Rejected with 401. This looks like an Anthropic key. OpenRouter keys start with sk-or-.">
            <Input mono defaultValue="sk-ant-api03-xxxx" />
          </Field>
          <Field label="Max cost per run">
            <Input prefix="$" defaultValue="0.50" />
          </Field>
          <Field label="Filter">
            <Input size="sm" placeholder="Filter" kbd="/" />
          </Field>
          <Field label="Profile" className="md:col-span-2" help="A few lines about you that every model should know.">
            <Textarea prose placeholder="Security student. Homelab on Proxmox. Short answers, no em dashes." />
          </Field>
          <Field label="Schedule">
            <SelectMenu
              value={sel}
              onChange={setSel}
              options={[
                { value: 'weekdays', label: 'Weekdays at 07:30' },
                { value: 'daily', label: 'Daily at 03:00' },
                { value: 'every', label: 'Every 30 min', detail: 'Interval' },
              ]}
            />
          </Field>
          <Field label="Model">
            <ModelPicker look="field" value={model} onChange={setModel} />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-6">
          <Segmented label="Theme" value={seg} onChange={setSeg} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />
          <OnOff checked={on} onChange={setOn} label="Write what it learns" />
          <Checkbox checked={chk} onChange={setChk} label="Restore files too" />
          <span className="flex items-center gap-1 rounded-[var(--r-2)] border border-rule-2 bg-sunk px-1.5 py-1">
            <AgentPicker value={agent} onChange={setAgent} />
            <span className="h-3.5 w-px bg-rule" />
            <ModelPicker value={model} onChange={setModel} />
            <span className="h-3.5 w-px bg-rule" />
            <DevicePicker value={device} onChange={setDevice} />
          </span>
        </div>
        <div className="mt-4 max-w-[480px]">
          <Radio name="mem" checked={radio === 'hub'} onChange={() => setRadio('hub')} label="Keep notes in the hub" description="Stored in the hub database." />
          <Radio name="mem" checked={radio === 'bm'} onChange={() => setRadio('bm')} label="Use a Basic Memory vault" description="Markdown files you can open in any editor.">
            <Input mono size="sm" defaultValue="~/notes/conclave" />
          </Radio>
        </div>
      </Block>

      <Block title="Tabs, filters, tags">
        <Tabs value={tab} onChange={setTab} options={[{ value: 'settings', label: 'Settings' }, { value: 'runs', label: 'Runs', count: 48 }]} />
        <FilterLinks className="mt-4" value={filter} onChange={setFilter} options={['all', 'homelab', 'uni', 'ctf'].map((v) => ({ value: v, label: v === 'all' ? 'All' : v }))} />
        <p className="mt-4 text-[13px]">
          Tags: <Tags tags={['homelab', 'uni', 'security']} />
        </p>
      </Block>

      <Block title="Logos" note="mono by default, brand where the model is the subject">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {(Object.keys(LOGOS) as LogoId[]).map((id) => (
            <span key={id} className="flex items-center gap-3 text-[13px] text-fg-2">
              <Logo id={id} size={16} />
              <Logo id={id} size={16} tone="brand" />
              <Logo id={id} size={22} tone="brand" />
              {LOGOS[id].name}
            </span>
          ))}
          <span className="flex items-center gap-3 text-[13px] text-fg-2">
            <Monogram name="CLIProxy" size={16} />
            <Monogram name="LM Local" size={22} />
            Fallback
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-6 text-[13px]">
          <ModelName model="anthropic/claude-sonnet-5-5" tone="brand" />
          <ModelName model="claude-code/opus" />
          <ModelName model="claude-code/opus" as="model" tone="brand" />
          <ModelName model="openrouter/deepseek/deepseek-v4" tone="brand" />
          <ModelName model="zai/glm-5" />
          <HarnessName harness="codex" />
          <CompanyName provider="claude-max" name="Claude Max" tone="brand" />
          <span className="flex items-center gap-2 text-fg-2">
            <MarkStack models={['anthropic/claude-opus-5-5', 'openai/gpt-5.5', 'zai/glm-5', 'google/gemini-3-pro']} /> 4 jurors
          </span>
        </div>
      </Block>

      <Block title="Wave" note="hero, scope, strip, ambient">
        <Wave variant="hero" gap={6} className="h-[200px]" />
        <div className="mt-6 grid gap-8 md:grid-cols-2">
          <div>
            <div className="text-[12px] text-fg-3">Model output, last 60 minutes</div>
            <Wave variant="scope" className="mt-2 h-[96px]" series={[0.2, 0.3, 0.45, 0.5, 0.4, 0.3, 0.25, 0.2, 0.3, 0.5, 0.6, 0.5, 0.4, 0.3, 0.35, 0.45, 0.5, 0.55, 0.6, 0.62]} />
          </div>
          <div className="space-y-4 text-[13px]">
            <div>
              <LiveStatus state="writing" startedAt={started} />
            </div>
            <div>
              <LiveStatus state="tool" label="Testing" detail="api.z.ai" />
            </div>
            <div>
              <LiveStatus state={done ? 'done' : 'writing'} startedAt={started} endedAt={done ? started + 724_000 : undefined} />{' '}
              <Button size="sm" variant="quiet" onClick={() => setDone((d) => !d)}>
                {done ? 'Run again' : 'Finish'}
              </Button>
            </div>
            <div className="text-signal">
              <Elapsed since={started} format="short" />
            </div>
            <Wave variant="strip" tone="signal" className="h-[22px]" rate={0.8} />
          </div>
        </div>
        <EmptyState action={{ label: 'New routine', onClick: () => toast({ title: 'Opened the routine editor.' }) }} className="mt-4">
          Routines you schedule show up here with their next run.
        </EmptyState>
      </Block>

      <Block title="Approval and question">
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <SectionHeading count={approvals.length + questions.length} countTone="warn" action={{ label: 'Open inbox', href: '/approvals' }}>
              Waiting on you
            </SectionHeading>
            <div className="pt-3.5">
              {approvals[0] ? <ApprovalCard approval={approvals[0]} /> : <p className="text-[13px] text-fg-3">No approval in the mock right now.</p>}
              {questions[0] && <QuestionCard question={questions[0]} />}
            </div>
          </div>
          <div>
            <Section title="Running" count={2} action={{ label: 'All sessions', href: '/sessions' }}>
              <ListRow inset={false} title="Move auth middleware to jose" meta={<MetaLine parts={['coder', <ModelName key="m" model="anthropic/claude-sonnet-5-5" size={13} />, 'arch-desktop']} />} right={<Knot state="tool" size={14} still label="Running" />} />
              <ListRow inset={false} title="OS assignment: MLFQ scheduler" meta={<MetaLine parts={['tutor', <ModelName key="m" model="codex/gpt-5.5" size={13} />, 'madx']} />} time="31m" state={<Elapsed since={Date.now() - 31 * 60_000} format="short" className="text-signal" />} />
              <ListRow inset={false} title="Suspend broken after kernel 6.17" meta="sysadmin, waiting for reset" state="resumes 15:42" />
              <ListRow inset={false} selected title="Selected row" meta="the only edge bar in the product" time="2m" state="approve" stateTone="warn" onClick={() => undefined} />
            </Section>
          </div>
        </div>
      </Block>

      <Block title="Limits, stats, meters">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rows">
            {limits.slice(0, 3).map((l) => (
              <LimitGroup key={l.provider} limit={l} right="read from OAuth 2 min ago" />
            ))}
          </div>
          <div>
            <StatGroup>
              <Stat value="$4.20" label="today" />
              <Stat value="$149.07" label="30 days" delta="up 12% on last month" />
              <Stat value="73%" label="cache hits" />
            </StatGroup>
            <div className="mt-6 space-y-3 text-[12px] text-fg-3">
              <div className="flex items-center gap-3">
                <span className="w-24">Context</span>
                <Meter value={46} label="Context, 46K of 1M" tone="signal" />
                <span className="num w-20 text-right">46K of 1M</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-24">Cache hits</span>
                <Meter value={45} label="Cache hits 45%" />
                <span className="num w-20 text-right">45%</span>
              </div>
            </div>
            <div className="mt-6">
              <DayAxis marks={dayMarks(Object.values(s.routines), s.runs)} />
            </div>
          </div>
        </div>
      </Block>

      <Block title="Table">
        <Table
          rowKey={(r) => r.name}
          onRowClick={() => undefined}
          defaultSort={{ key: 'cost', dir: 'desc' }}
          columns={[
            { key: 'name', header: 'Model', title: true, render: (r) => <ModelName model={r.ref} tone="brand" />, sort: (a, b) => a.name.localeCompare(b.name) },
            { key: 'sessions', header: 'Sessions', numeric: true, sort: (a, b) => a.sessions - b.sessions },
            { key: 'tokens', header: 'Tokens out', numeric: true },
            { key: 'cost', header: 'Cost', numeric: true, render: (r) => `$${r.cost.toFixed(2)}`, sort: (a, b) => a.cost - b.cost },
          ]}
          rows={[
            { name: 'Sonnet 5.5', ref: 'anthropic/claude-sonnet-5-5', sessions: 41, tokens: '1.2M', cost: 61.12 },
            { name: 'Opus 5.5', ref: 'anthropic/claude-opus-5-5', sessions: 9, tokens: '335K', cost: 32.8 },
            { name: 'GPT-5.5', ref: 'openai/gpt-5.5', sessions: 22, tokens: '410K', cost: 25.34 },
            { name: 'GLM-5', ref: 'zai/glm-5', sessions: 30, tokens: '820K', cost: 0 },
          ]}
        />
      </Block>

      <Block title="Code, command, diff, notices">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Command command="proxmox-backup-client verify --repository root@pam@pbs:tank ct/103" copy />
            <CodeBlock lang="ts" code={`const VERIFY = { algorithms: ['HS256'], issuer: 'conclave' } as const;\nexport const auth = async (c, next) => next();`} />
            <CodeBlock shell code="bun test packages/server" />
          </div>
          <div>
            <Diff diff={DIFF} action={<Button size="sm" variant="quiet">View file</Button>} />
          </div>
        </div>
        <div className="mt-4">
          <Notice time="12:04">Compacted 46K tokens into 3K.</Notice>
          <Notice time="12:06" tone="fault" action={{ label: 'Retry', onClick: () => undefined }}>
            Failed. The hub lost the connection to arch-desktop.
          </Notice>
        </div>
      </Block>

      <Block title="Asides and quotes">
        <div className="grid gap-8 md:grid-cols-2">
          <Aside title="Workspace">
            <KV k="Device">arch-desktop</KV>
            <KV k="Folder" mono>
              ~/code/conclave
            </KV>
            <KV k="Branch" mono>
              feat/jose-auth
            </KV>
            <KV k="Permissions">Accept edits</KV>
          </Aside>
          <Quote cite="From Reverse proxy for the Proxmox homelab, 2h ago">Traefik if you will add containers often: labels pick them up without a reload.</Quote>
        </div>
      </Block>

      <Block title="Providers" note="shared by Settings and onboarding">
        <ProviderHeader />
        <div className="rows">
          <ProviderRow provider="anthropic" testOnMount menu={[{ label: 'Test again' }, { label: 'Change key' }, { label: 'Base URL' }, { separator: true, label: '' }, { label: 'Remove', danger: true }]} />
          <ProviderRow provider="deepseek" testOnMount />
          <ProviderRow provider="moonshot" />
          <ProviderRow provider="ollama" testOnMount />
        </div>
      </Block>

      <Block title="Overlays">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setDialog(true)}>Dialog</Button>
          <Button onClick={() => setConfirm(true)}>Confirm</Button>
          <Button onClick={() => setPair(true)}>Pair a device</Button>
          <Menu
            items={[{ label: 'Run now', hint: 'R' }, { label: 'Pause' }, { label: 'Duplicate' }, { separator: true, label: '' }, { label: 'Delete', danger: true }]}
            trigger={({ ref, props }) => (
              <Button ref={ref} {...props}>
                Menu
              </Button>
            )}
          />
          <Tooltip content="Toggles the theme">
            <Button variant="quiet">Tooltip</Button>
          </Tooltip>
          <Button onClick={() => toast({ title: 'Saved.' })}>Toast</Button>
          <Button onClick={() => toast({ title: 'The hub did not answer.', level: 'error', action: { label: 'Retry', run: () => undefined } })}>Failure toast</Button>
          <span className="ml-2 text-[13px] text-fg-3">
            <Kbd>{MOD}</Kbd> <Kbd>K</Kbd> opens the palette
          </span>
          <StateWord tone="ok">online</StateWord>
          <StateWord tone="fault">failed</StateWord>
          <StateWord tone="warn">approve</StateWord>
        </div>
        <div className="mt-6 max-w-[480px] space-y-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Rename session"
          footer={
            <>
              <Button variant="quiet" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="solid" onClick={() => setDialog(false)}>
                Save
              </Button>
            </>
          }
        >
          <Field label="Title">
            <Input defaultValue="Move auth middleware to jose" />
          </Field>
        </Dialog>
        <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => undefined} title="Delete routine Server watchdog?" body="Its 48 past runs stay in the history." busy="Deleting" />
        <Dialog open={pair} onClose={() => setPair(false)} title="Pair a device" width={560}>
          <PairingPanel kind="client" />
        </Dialog>
      </Block>
    </Page>
  );
}
