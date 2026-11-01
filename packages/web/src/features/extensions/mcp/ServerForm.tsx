/**
 * Add or edit an MCP server. A form (stdio command, args and env, or a URL
 * and headers), or "Paste from another CLI": a Claude .mcp.json, Codex
 * config.toml, OpenCode opencode.json or Gemini settings.json, previewed
 * through importMcp before anything is added.
 */
import { useEffect, useState } from 'react';
import type { McpImportFormat } from '@conclave/core/client';
import type { McpServerConfig } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Segmented, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { TextAction } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { HarnessMark } from '@/components/logo';
import { Drawer } from '../hooks/Drawer';
import { SERVER_NAME, joinCommand, splitCommand, target } from './parts';
import { errText } from '@/features/settings/parts';

type Kind = 'stdio' | 'http' | 'sse';
type Mode = 'form' | 'paste';

const FORMATS: Array<{ value: McpImportFormat; label: string; file: string; harness: string; example: string }> = [
  { value: 'claude', label: 'Claude Code', file: '.mcp.json or ~/.claude.json', harness: 'claude-code', example: '{\n  "mcpServers": {\n    "memory": { "command": "uvx", "args": ["basic-memory", "mcp"] }\n  }\n}' },
  { value: 'codex', label: 'Codex', file: '~/.codex/config.toml', harness: 'codex', example: '[mcp_servers.memory]\ncommand = "uvx"\nargs = ["basic-memory", "mcp"]' },
  { value: 'opencode', label: 'OpenCode', file: 'opencode.json', harness: 'opencode', example: '{\n  "mcp": {\n    "memory": { "type": "local", "command": ["uvx", "basic-memory", "mcp"] }\n  }\n}' },
  { value: 'gemini', label: 'Gemini CLI', file: '~/.gemini/settings.json', harness: 'gemini-cli', example: '{\n  "mcpServers": {\n    "memory": { "command": "uvx", "args": ["basic-memory", "mcp"] }\n  }\n}' },
];

function Pairs({ label, rows, setRows, keyHint, addLabel }: { label: string; rows: Array<[string, string]>; setRows: (r: Array<[string, string]>) => void; keyHint: string; addLabel: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">{label}</span>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input mono size="sm" value={k} placeholder={keyHint} aria-label={`${label} name`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} boxClassName="w-[40%] shrink-0" />
          <Input mono size="sm" value={v} placeholder="${secret:name}" aria-label={`${label} value`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} boxClassName="min-w-0 flex-1" />
          <TextAction label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="shrink-0" />
        </div>
      ))}
      <div>
        <TextAction label={addLabel} onClick={() => setRows([...rows, ['', '']])} />
      </div>
    </div>
  );
}

export function ServerForm({
  open,
  onClose,
  name,
  cfg,
  taken,
  startMode = 'form',
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Editing this server; null adds a new one. */
  name: string | null;
  cfg?: McpServerConfig;
  taken: string[];
  startMode?: Mode;
  onSaved: () => void;
}) {
  const mobile = useIsMobile();
  const [mode, setMode] = useState<Mode>('form');
  // pick the mode while rendering the open, not in an effect, so the drawer focuses a field that stays
  const opening = open ? `${name ?? ''}:${startMode}` : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (opening !== openedFor) {
    setOpenedFor(opening);
    if (open) setMode(name ? 'form' : startMode);
  }
  const [n, setN] = useState('');
  const [kind, setKind] = useState<Kind>('stdio');
  const [cmd, setCmd] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState<Array<[string, string]>>([]);
  const [headers, setHeaders] = useState<Array<[string, string]>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // paste
  const [format, setFormat] = useState<McpImportFormat>('claude');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Record<string, McpServerConfig> | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setMode(name ? 'form' : startMode);
    setN(name ?? '');
    setKind(cfg?.url ? (cfg.type === 'sse' ? 'sse' : 'http') : 'stdio');
    setCmd(cfg?.command ? joinCommand(cfg) : '');
    setUrl(cfg?.url ?? '');
    setEnv(Object.entries(cfg?.env ?? {}));
    setHeaders(Object.entries(cfg?.headers ?? {}));
    setError(undefined);
    setText('');
    setPreview(null);
  }, [open, name, cfg, startMode]);

  const slug = n.trim();
  const nameErr = !name && slug ? (!SERVER_NAME.test(slug) ? 'Use 1 to 64 letters, digits, dashes and underscores.' : taken.includes(slug) ? `${slug} already exists. Edit that one, or pick another name.` : undefined) : undefined;
  const urlErr = kind !== 'stdio' && url.trim() && !/^https?:\/\//.test(url.trim()) ? 'The URL must start with http:// or https://.' : undefined;
  const ready = !!slug && !nameErr && !urlErr && (kind === 'stdio' ? !!cmd.trim() : !!url.trim());

  const build = (): McpServerConfig => {
    const vars = (rows: Array<[string, string]>) => Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    const keep: McpServerConfig = {};
    if (cfg?.enabled === false) keep.enabled = false;
    if (cfg?.tools) keep.tools = cfg.tools;
    if (kind === 'stdio') {
      const [command, ...args] = splitCommand(cmd);
      const e = vars(env);
      return { command, ...(args.length ? { args } : {}), ...(Object.keys(e).length ? { env: e } : {}), ...keep };
    }
    const h = vars(headers);
    return { type: kind, url: url.trim(), ...(Object.keys(h).length ? { headers: h } : {}), ...keep };
  };

  const saveForm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (name) await api().updateMcpServer(name, { config: build() });
      else await api().addMcpServer(slug, build());
      toast({ title: `${slug} saved. The hub connects to it now.` });
      onSaved();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const readPaste = async () => {
    setBusy(true);
    setError(undefined);
    setPreview(null);
    try {
      const r = await api().importMcp(format, text);
      setPreview(r);
      setPicked(Object.fromEntries(Object.keys(r).map((k) => [k, !taken.includes(k)])));
    } catch (e) {
      setError(`${errText(e)} Check that you pasted the whole file in the ${FORMATS.find((f) => f.value === format)?.label} format.`);
    } finally {
      setBusy(false);
    }
  };

  const addPicked = async () => {
    if (!preview) return;
    const names = Object.keys(preview).filter((k) => picked[k] && !taken.includes(k));
    setBusy(true);
    setError(undefined);
    const failed: string[] = [];
    for (const k of names) {
      try {
        await api().addMcpServer(k, preview[k]);
      } catch (e) {
        failed.push(`${k}: ${errText(e)}`);
      }
    }
    setBusy(false);
    const added = names.length - failed.length;
    if (added) {
      toast({ title: `Added ${plural(added, 'server')}. The hub connects to them now.` });
      onSaved();
    }
    if (failed.length) setError(`Could not add ${failed.join(' ')}`);
    else onClose();
  };

  const chosen = preview ? Object.keys(preview).filter((k) => picked[k] && !taken.includes(k)).length : 0;
  const fmt = FORMATS.find((f) => f.value === format)!;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={name ? `Edit ${name}` : 'Add an MCP server'}
      sub={name ? 'Saved in ~/.conclave/config.json. The server restarts with the new settings.' : 'Saved in ~/.conclave/config.json and started on the hub.'}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          {mode === 'form' ? (
            <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Saving' : false} onClick={() => void saveForm()}>
              Save
            </Button>
          ) : preview ? (
            <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!chosen} busy={busy ? 'Adding' : false} onClick={() => void addPicked()}>
              {chosen ? `Add ${plural(chosen, 'server')}` : 'Add'}
            </Button>
          ) : (
            <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!text.trim()} busy={busy ? 'Reading' : false} onClick={() => void readPaste()}>
              Preview
            </Button>
          )}
        </>
      }
    >
      {!name && (
        <Tabs
          className="mb-5"
          label="How to add"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(undefined);
          }}
          options={[
            { value: 'form', label: 'Fill in' },
            { value: 'paste', label: 'Paste from another CLI' },
          ]}
        />
      )}

      {mode === 'form' ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void saveForm();
          }}
        >
          <Field
            label="Name"
            error={nameErr}
            help={
              name ? undefined : (
                <>
                  Its tools reach agents as <span className="mono">mcp__{slug || 'name'}__tool</span>.
                </>
              )
            }
          >
            <Input mono value={n} disabled={!!name} onChange={(e) => setN(e.target.value)} placeholder="basic-memory" autoComplete="off" data-autofocus={name ? undefined : true} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Transport</span>
            <Segmented
              className="self-start"
              label="Transport"
              value={kind}
              onChange={setKind}
              size={mobile ? 'touch' : 'md'}
              options={[
                { value: 'stdio', label: 'Command' },
                { value: 'http', label: 'HTTP' },
                { value: 'sse', label: 'SSE' },
              ]}
            />
          </div>
          {kind === 'stdio' ? (
            <>
              <Field label="Command and arguments" help="Runs on the hub. Quote arguments that contain spaces.">
                <Input mono value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="uvx basic-memory mcp" autoComplete="off" />
              </Field>
              <Pairs label="Environment" rows={env} setRows={setEnv} keyHint="GITHUB_TOKEN" addLabel="Add a variable" />
            </>
          ) : (
            <>
              <Field label="URL" error={urlErr}>
                <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === 'sse' ? 'http://ha.lan:8123/mcp_server/sse' : 'https://api.githubcopilot.com/mcp/'} autoComplete="off" />
              </Field>
              <Pairs label="Headers" rows={headers} setRows={setHeaders} keyHint="Authorization" addLabel="Add a header" />
            </>
          )}
          <p className="m-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            Keep secrets out of the config: <span className="mono">{'${env:NAME}'}</span> reads a variable on the hub, <span className="mono">{'${secret:name}'}</span> reads a secret saved in Settings.
          </p>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Format" help={<>Paste the file, or just its servers part. From {fmt.file}.</>}>
            <SelectMenu
              label="Format"
              value={format}
              onChange={(f) => {
                setFormat(f);
                setPreview(null);
              }}
              options={FORMATS.map((f) => ({ value: f.value, label: f.label, text: f.label, lead: <HarnessMark harness={f.harness} size={14} />, hint: <span className="font-mono text-[11px]">{f.file}</span> }))}
            />
          </Field>
          <Field label="Config">
            <Textarea
              mono
              minRows={7}
              maxRows={16}
              spellCheck={false}
              data-autofocus
              value={text}
              placeholder={fmt.example}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          {preview && (
            <section aria-label="What will be added">
              <div className="flex items-baseline gap-2 border-b border-rule-2 pb-[9px]">
                <h3 className="t-section text-fg">What will be added</h3>
                <span className="num text-[13px] text-fg-3">{chosen}</span>
              </div>
              {Object.keys(preview).length === 0 && <p className="mt-3 text-[14px] text-fg-2">No servers found in that text. Paste the part with mcpServers, mcp or [mcp_servers.name].</p>}
              <div className="rows">
                {Object.entries(preview).map(([k, c]) => {
                  const exists = taken.includes(k);
                  const keys = Object.keys(c.env ?? c.headers ?? {});
                  return (
                    <div key={k} className="py-2.5">
                      <Checkbox
                        checked={!!picked[k] && !exists}
                        disabled={exists}
                        onChange={(v) => setPicked({ ...picked, [k]: v })}
                        label={<span className="font-mono text-[12.5px] text-fg">{k}</span>}
                        description={
                          <>
                            {exists ? <span className="text-warn">A server with this name exists, so it is skipped. </span> : null}
                            {c.url ? (c.type === 'sse' ? 'sse' : 'http') : 'stdio'}, <span className="mono [overflow-wrap:anywhere]">{target(c)}</span>
                            {keys.length > 0 && (
                              <>
                                , {c.env ? 'env' : 'headers'} <span className="mono">{keys.join(', ')}</span>
                              </>
                            )}
                            {c.enabled === false && ', off'}
                          </>
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
      {error && (
        <p className="mt-4 mb-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
          <span className="text-fault">Failed.</span> {error}
        </p>
      )}
    </Drawer>
  );
}
