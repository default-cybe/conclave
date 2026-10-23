/**
 * Share Conclave memory with Claude Code, Codex, OpenCode and Gemini CLI:
 * the hub serves its own MCP endpoint. Shows the URL, the tools with their
 * read-only flags, then per CLI the HTTP setup (with a gateway key made for
 * that tool, shown once) and the stdio setup (conclave mcp, no token).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { CliName, McpServerSnippets } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useCopy, useIsMobile, useIsWide, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Aside, KV, Section, SectionHeading } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { HarnessName } from '@/components/logo';
import { CLI_LABEL, HARNESS, Step } from './ConnectPanel';
import { errMsg } from './parts';

const ORDER: CliName[] = ['claude', 'codex', 'opencode', 'gemini'];

export function ShareTab() {
  const wide = useIsWide();
  const snippets = useLoad(() => api().mcpServerSnippets(), []);
  const s = snippets.data;

  const body = (
    <div className="min-w-0">
      <p className="mb-6 max-w-[68ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
        Claude Code, Codex, OpenCode and Gemini CLI can search and save Conclave memory over MCP. A fact you tell Codex today is there in Claude Code tomorrow, and both see your connections too.
      </p>
      {snippets.error && !s && /^not found\.?$/i.test(snippets.error.trim()) && <p className="text-[14px] text-fg-2">This hub is older and does not serve its memory over MCP. Update the hub, then come back here.</p>}
      {snippets.error && !s && !/^not found\.?$/i.test(snippets.error.trim()) && (
        <p className="text-[14px] text-fg-2">
          <span className="text-fault">Failed.</span> Could not load the setup snippets: {errMsg(snippets.error)}{' '}
          <button type="button" className="link" onClick={snippets.reload}>
            Try again
          </button>
        </p>
      )}
      {!s && !snippets.error && <LoadingRows loading rows={4} />}
      {s && (
        <div className="space-y-9 phone:space-y-10">
          <section aria-labelledby="share-endpoint">
            <SectionHeading id="share-endpoint">Endpoint</SectionHeading>
            <dl className="pt-2">
              <KV k="URL" keyWidth={88}>
                <span className="mono break-all">{s.url}</span>
              </KV>
              <KV k="Sign in" keyWidth={88}>
                <span className="text-[13px] text-fg-2 phone:text-[14px]">A gateway key, a paired device's token or the hub token, sent as a bearer token. The snippets read it from {s.tokenEnv}.</span>
              </KV>
            </dl>
          </section>
          <Section title="Tools" count={s.tools.length}>
            {s.tools.map((t) => (
              <div key={t.name} className="py-2.5">
                <div className="flex items-baseline gap-3">
                  <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-fg">{t.name}</span>
                  <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{t.readOnly ? 'read only' : 'changes memory'}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 max-w-[72ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]" title={t.description}>
                  {t.description}
                </p>
              </div>
            ))}
          </Section>
          <PerCli s={s} />
          {s.notes.length > 0 && (
            <Section title="Good to know">
              {s.notes.map((n) => (
                <p key={n} className="max-w-[72ch] py-2.5 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                  {n}
                </p>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div id="share" className="scroll-mt-4">
      {wide ? (
        <div className="grid grid-cols-[minmax(0,780px)_minmax(0,1fr)]">
          <div className="min-w-0 pr-10">{body}</div>
          <aside className="min-w-0 border-l border-rule pl-10" aria-label="How sharing works">
            <div className="max-w-[460px] space-y-7">
              <Aside title="Two ways in">
                <KV k="HTTP" keyWidth={56}>
                  <span className="text-[13px] text-fg-2">From any device that reaches the hub. Needs a key, one per tool so you can revoke it.</span>
                </KV>
                <KV k="stdio" keyWidth={56}>
                  <span className="text-[13px] text-fg-2">
                    On a machine with the Conclave CLI. <span className="mono">conclave mcp</span> uses its saved login, so there is no token to handle.
                  </span>
                </KV>
              </Aside>
            </div>
          </aside>
        </div>
      ) : (
        <div className="max-w-[780px]">{body}</div>
      )}
    </div>
  );
}

function PerCli({ s }: { s: McpServerSnippets }) {
  const [cli, setCli] = useState<CliName>('claude');
  // a key is shown once: keep it while the owner looks at the other CLIs
  const [keys, setKeys] = useState<Partial<Record<CliName, string>>>({});
  const clis = ORDER.filter((c) => s.http.some((x) => x.cli === c) || s.stdio.some((x) => x.cli === c));
  const http = s.http.find((x) => x.cli === cli);
  const stdio = s.stdio.find((x) => x.cli === cli);
  return (
    <section aria-labelledby="share-cli">
      <SectionHeading id="share-cli">Add it to a CLI</SectionHeading>
      <FilterLinks label="CLI" value={cli} onChange={setCli} className="mt-3 gap-x-5 gap-y-2" options={clis.map((c) => ({ value: c, label: <HarnessName harness={HARNESS[c]} size={13} /> }))} />
      <div className="mt-5 space-y-8">
        <div>
          <h3 className="text-[13.5px] font-medium text-fg phone:text-[15px]">Over HTTP</h3>
          <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">From any machine that can reach the hub. Make a key for {CLI_LABEL[cli]} first, then set it as {s.tokenEnv} there.</p>
          <KeyMaker key={cli} cli={cli} env={s.tokenEnv} made={keys[cli]} onMade={(k) => setKeys((x) => ({ ...x, [cli]: k }))} />
          {http && <Step step={http} className="mt-4" bare />}
        </div>
        <div>
          <h3 className="text-[13.5px] font-medium text-fg phone:text-[15px]">With the Conclave CLI</h3>
          <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">
            On a machine where you ran <span className="mono">conclave login</span>. No token needed.
          </p>
          {stdio && <Step step={stdio} className="mt-4" bare />}
        </div>
      </div>
    </section>
  );
}

/** "Create a key for this tool": a gateway key named after the CLI, shown once with a copy button. */
function KeyMaker({ cli, env, made: key, onMade }: { cli: CliName; env: string; made?: string; onMade: (key: string) => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, copy] = useCopy();
  const name = `${CLI_LABEL[cli]} memory`;
  const line = key ? `export ${env}=${key}` : '';
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const k = await api().createGatewayKey(name);
      onMade(k.key);
    } catch (e) {
      setError(`Could not create the key. ${errMsg(e)}`);
    }
    setBusy(false);
  };
  return (
    <div className="mt-3">
      {!key ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size={mobile ? 'touch' : 'md'} busy={busy ? 'Creating' : false} onClick={() => void make()}>
            Create a key for this tool
          </Button>
          <span className={cn('text-[12px] phone:text-[13px]', error ? 'text-fault' : 'text-fg-3')}>
            {error ?? (
              <>
                Named {name}. Revoke it any time in{' '}
                <Link href="/settings/gateway" className="link">
                  Settings, Gateway keys
                </Link>
                .
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[13px] text-fg-2 phone:text-[14px]">
            <span className="text-ok">Created {name}.</span> Copy it now. It is not shown again.
          </p>
          <CodeBlock code={line} lang="sh" title={`Put this in the shell profile on the machine with ${CLI_LABEL[cli]}`} wrap />
          <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => copy(line)}>
            {copied ? 'Copied' : 'Copy the key line'}
          </Button>
        </div>
      )}
    </div>
  );
}
