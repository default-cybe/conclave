/**
 * The tools of one MCP server: name, the mcp__server__tool name agents see,
 * description, read-only flag and input schema. "Try" runs one tool with
 * JSON arguments; tools not marked read-only ask first.
 */
import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { McpCallResult, McpToolDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Drawer } from '../hooks/Drawer';
import { argsTemplate } from './parts';
import { errText } from '@/features/settings/parts';

function resultText(r: McpCallResult): string {
  if (typeof r.content === 'string') return r.content;
  return r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
}

export function ToolsDrawer({ server, open, onClose }: { server: string | null; open: boolean; onClose: () => void }) {
  const [tools, setTools] = useState<McpToolDto[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [openTool, setOpenTool] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !server) return;
    let alive = true;
    setTools(undefined);
    setError(undefined);
    setQ('');
    setOpenTool(null);
    setLoading(true);
    api()
      .mcpTools(server)
      .then((t) => alive && setTools(t))
      .catch((e) => alive && setError(errText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, server]);

  const shown = (tools ?? []).filter((t) => !q.trim() || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const ro = tools?.filter((t) => t.readOnly).length ?? 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={`Tools of ${server ?? ''}`}
      title={
        <>
          Tools, <span className="font-mono text-[15px]">{server}</span>
        </>
      }
      sub={tools ? `${plural(tools.length, 'tool')}, ${ro} read only. Agents see them as mcp__${server}__<tool>.` : ' '}
    >
      {error && (
        <p className="m-0 text-[14px] leading-[1.45] text-fg-2">
          <span className="text-fault">Failed.</span> {error} Restart the server, then open its tools again.
        </p>
      )}
      <LoadingRows loading={loading} rows={5} />
      {tools && tools.length > 8 && <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tools" aria-label="Filter tools" boxClassName="mb-3" />}
      {tools && tools.length === 0 && <p className="m-0 text-[14px] text-fg-2">This server offers no tools.</p>}
      <ul className="rows m-0 list-none p-0">
        {shown.map((t) => (
          <ToolRow key={t.name} server={server!} tool={t} open={openTool === t.name} onToggle={() => setOpenTool(openTool === t.name ? null : t.name)} />
        ))}
      </ul>
    </Drawer>
  );
}

function ToolRow({ server, tool, open, onToggle }: { server: string; tool: McpToolDto; open: boolean; onToggle: () => void }) {
  const mobile = useIsMobile();
  const [args, setArgs] = useState(() => argsTemplate(tool.inputSchema));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<McpCallResult | null>(null);
  const [error, setError] = useState<string>();

  let parsed: Record<string, unknown> | undefined;
  let parseErr: string | undefined;
  try {
    const v = JSON.parse(args || '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    else parseErr = 'Arguments must be a JSON object, like { "query": "pbs" }.';
  } catch (e) {
    parseErr = `Not valid JSON. ${e instanceof Error ? e.message : ''}`.trim();
  }

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      setResult(await api().callMcpTool(server, tool.name, parsed));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-1">
      <button type="button" onClick={onToggle} aria-expanded={open} className="-mx-2 flex w-[calc(100%+16px)] items-start gap-2 rounded-[var(--r-1)] px-2 py-2 text-left hover:bg-hover phone:min-h-11">
        <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-fg-3 transition-transform duration-[var(--dur-2)]', open && 'rotate-90')} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{tool.name}</span>
            <span className={cn('ml-auto shrink-0 text-[12px] phone:text-[13px]', tool.readOnly ? 'text-fg-3' : 'text-fg-2')}>{tool.readOnly ? 'read only' : 'can change things'}</span>
          </span>
          {tool.description && <span className={cn('mt-0.5 block text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]', !open && 'line-clamp-2')}>{tool.description}</span>}
        </span>
      </button>
      {open && (
        <div className="pb-3 pl-5.5">
          <p className="m-0 font-mono text-[11.5px] text-fg-3">{tool.fullName}</p>
          <CodeBlock className="mt-2" title="Input schema" code={JSON.stringify(tool.inputSchema ?? { type: 'object' }, null, 2)} lang="json" maxLines={14} />
          <Field className="mt-3" label="Arguments" error={parseErr}>
            <Textarea mono minRows={3} maxRows={10} spellCheck={false} value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button variant="outline" size={mobile ? 'touch' : 'sm'} disabled={!parsed} busy={busy ? 'Running' : false} onClick={() => (tool.readOnly ? void run() : setConfirm(true))}>
              Try
            </Button>
            <span className="text-[12px] text-fg-3 phone:text-[13px]">{tool.readOnly ? 'Runs on the server now.' : 'Asks first: this tool can change things.'}</span>
          </div>
          {error && (
            <p className="mt-3 mb-0 text-[13px] leading-[1.45] text-fg-2">
              <span className="text-fault">Failed.</span> {error}
            </p>
          )}
          {result && (
            <div className="mt-3">
              <div className={cn('mb-1 text-[12px]', result.isError ? 'text-fault' : 'text-fg-3')}>{result.isError ? 'The tool returned an error' : 'Result'}</div>
              <CodeBlock code={resultText(result) || '(empty)'} wrap maxLines={18} />
            </div>
          )}
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title={`Run ${tool.name} on ${server}?`}
            tone="neutral"
            confirm="Run it"
            busy="Running"
            onConfirm={run}
          >
            <p className="m-0">It is not marked read only, so it may change things on the server.</p>
            <CodeBlock className="mt-3" code={JSON.stringify(parsed ?? {}, null, 2)} lang="json" />
          </ConfirmDialog>
        </div>
      )}
    </li>
  );
}
