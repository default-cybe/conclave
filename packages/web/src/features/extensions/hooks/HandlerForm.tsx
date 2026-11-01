/**
 * Add or edit one hook handler: event, matcher, type (a command, a prompt or
 * an MCP tool), timeout, an `if` rule and the fail-closed and once switches,
 * at user scope (config.json) or project scope (.conclave/settings.json).
 * saveHooks replaces the whole scope, so the caller rebuilds the full list
 * and sends it. The hub's lint runs as you type and its warnings show above
 * Save (ECOSYSTEM.md 4.3 items 5 and 19).
 */
import { useEffect, useMemo, useState } from 'react';
import type { HookHandlerDto, HookEventInfo, HookLintIssue, McpStatus, McpToolDto } from '@conclave/core/client';
import type { HookEvent, HooksConfig } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Segmented, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { TextAction } from '@/components/ui/Section';
import { Drawer } from './Drawer';
import { EVENT_ORDER, isToolEvent, type Scope } from './model';

export interface HandlerDraft {
  scope: Scope;
  event: HookEvent;
  matcher: string;
  handler: HookHandlerDto;
}

type Kind = 'command' | 'prompt' | 'mcp_tool';
type ToolSet = 'all' | 'read' | 'write';

/** The matcher for some of a server's tools: all of them as a regex, or an exact list. */
function mcpMatcher(server: string, tools: McpToolDto[], set: ToolSet): string {
  if (set === 'all') return `mcp__${server}__.*`;
  const pick = tools.filter((t) => (set === 'read' ? t.readOnly : !t.readOnly));
  return pick.map((t) => t.fullName).join('|');
}

export function HandlerForm({
  open,
  onClose,
  initial,
  editing,
  cwd,
  events,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial: HandlerDraft;
  /** True when changing an existing handler. */
  editing: boolean;
  cwd?: string;
  events: HookEventInfo[];
  /** Returns an error sentence, or undefined when saved. */
  onSave: (d: HandlerDraft) => Promise<string | undefined>;
}) {
  const mobile = useIsMobile();
  const [scope, setScope] = useState<Scope>('user');
  const [event, setEvent] = useState<HookEvent>('PreToolUse');
  const [matcher, setMatcher] = useState('');
  const [type, setType] = useState<Kind>('command');
  const [body, setBody] = useState('');
  const [server, setServer] = useState('');
  const [tool, setTool] = useState('');
  const [toolInput, setToolInput] = useState('{}');
  const [timeout, setTimeoutS] = useState('');
  const [rule, setRule] = useState('');
  const [failClosed, setFailClosed] = useState(false);
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lint, setLint] = useState<HookLintIssue[]>([]);
  const [servers, setServers] = useState<McpStatus[]>();
  const [builder, setBuilder] = useState(false);
  const [mServer, setMServer] = useState('');
  const [mTools, setMTools] = useState<McpToolDto[]>();
  const [mSet, setMSet] = useState<ToolSet>('all');
  const [tools, setTools] = useState<McpToolDto[]>();

  useEffect(() => {
    if (!open) return;
    const h = initial.handler;
    setScope(initial.scope);
    setEvent(initial.event);
    setMatcher(initial.matcher);
    setType(h.type);
    setBody((h.type === 'prompt' ? h.prompt : h.command) ?? '');
    setServer(h.server ?? '');
    setTool(h.tool ?? '');
    setToolInput(JSON.stringify(h.input ?? {}, null, 2));
    setTimeoutS(h.timeout ? String(h.timeout) : '');
    setRule(h.if ?? '');
    setFailClosed(h.onFailure === 'block');
    setOnce(!!h.once);
    setError(undefined);
    setLint([]);
    setBuilder(false);
  }, [open, initial]);

  // MCP servers, for the matcher builder and mcp_tool handlers
  useEffect(() => {
    if (!open || servers) return;
    api()
      .mcp()
      .then(setServers)
      .catch(() => setServers([]));
  }, [open, servers]);

  useEffect(() => {
    if (!mServer) return setMTools(undefined);
    let live = true;
    api()
      .mcpTools(mServer)
      .then((t) => live && setMTools(t))
      .catch(() => live && setMTools([]));
    return () => {
      live = false;
    };
  }, [mServer]);

  useEffect(() => {
    if (type !== 'mcp_tool' || !server) return setTools(undefined);
    let live = true;
    api()
      .mcpTools(server)
      .then((t) => live && setTools(t))
      .catch(() => live && setTools([]));
    return () => {
      live = false;
    };
  }, [type, server]);

  const info = events.find((e) => e.event === event);
  const takesMatcher = !!info?.matcherValue;
  const toolEvent = isToolEvent(event);
  const secs = timeout.trim() ? Number(timeout) : undefined;
  const badTimeout = secs !== undefined && (!Number.isFinite(secs) || secs <= 0);
  const parsedInput = useMemo(() => {
    if (type !== 'mcp_tool') return { value: undefined };
    try {
      const v = JSON.parse(toolInput || '{}') as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The input must be a JSON object, like { "query": "${cwd}" }.' };
      return { value: v as Record<string, unknown> };
    } catch {
      return { error: 'Not valid JSON. Fix it, or set it back to {}.' };
    }
  }, [type, toolInput]);
  const picked = tools?.find((t) => t.name === tool);
  const ready =
    (type === 'mcp_tool' ? !!server && !!tool.trim() && !parsedInput.error : !!body.trim()) && !badTimeout && (scope === 'user' || !!cwd);

  const draftHandler = (): HookHandlerDto => {
    const handler: HookHandlerDto = { ...initial.handler, type };
    for (const k of ['command', 'prompt', 'server', 'tool', 'input', 'allowWrite', 'if', 'timeout', 'onFailure', 'once'] as const) delete handler[k];
    if (type === 'command') handler.command = body.trim();
    else if (type === 'prompt') handler.prompt = body.trim();
    else {
      handler.server = server;
      handler.tool = tool.trim();
      handler.input = parsedInput.value ?? {};
      if (picked && !picked.readOnly) handler.allowWrite = true;
    }
    if (secs) handler.timeout = secs;
    if (rule.trim() && toolEvent) handler.if = rule.trim();
    if (failClosed) handler.onFailure = 'block';
    if (once) handler.once = true;
    return handler;
  };

  // lint the handler as typed, after a short pause
  useEffect(() => {
    if (!open) return;
    // a slow answer for an older draft must not replace the answer for what is typed now
    let live = true;
    const t = setTimeout(() => {
      const hooks = { [event]: [{ ...(takesMatcher && matcher.trim() ? { matcher: matcher.trim() } : {}), hooks: [draftHandler()] }] } as HooksConfig;
      api()
        .lintHooks(hooks)
        .then((l) => live && setLint(l))
        .catch(() => live && setLint([]));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, event, matcher, type, body, server, tool, toolInput, timeout, rule, failClosed, once]);

  const submit = async () => {
    setBusy(true);
    const err = await onSave({ scope, event, matcher: takesMatcher ? matcher.trim() : '', handler: draftHandler() });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  const serverOptions = (servers ?? []).map((s) => ({ value: s.name, label: s.name, detail: s.status === 'connected' ? `${s.tools ?? 0} tools` : s.status }));
  const shown = lint.filter((i) => !(i.level === 'error' && /has no command|has no prompt|needs "server" and "tool"/.test(i.text)));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? 'Edit handler' : 'Add a handler'}
      sub={scope === 'user' ? <span className="mono">~/.conclave/config.json</span> : cwd ? <span className="mono">{cwd}/.conclave/settings.json</span> : undefined}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Saving' : false} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Save to</span>
          <Segmented
            className="self-start"
            label="Scope"
            value={scope}
            onChange={setScope}
            size={mobile ? 'touch' : 'md'}
            options={[
              { value: 'user', label: 'User' },
              { value: 'project', label: 'This project', disabled: !cwd },
            ]}
          />
          <p className="m-0 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
            {scope === 'user'
              ? 'Runs in every session on this hub.'
              : cwd
                ? 'Runs in sessions in this folder and its subfolders, once the folder is trusted.'
                : 'Pick a project folder at the top of Extensions to save project hooks.'}
          </p>
        </div>
        <Field label="Event" help={info ? `${info.gloss}.` : undefined}>
          <SelectMenu
            label="Event"
            value={event}
            onChange={setEvent}
            width={mobile ? undefined : 420}
            options={EVENT_ORDER.map((e) => ({ value: e, label: <span className="font-mono text-[12.5px]">{e}</span>, detail: events.find((x) => x.event === e)?.gloss }))}
          />
        </Field>
        {takesMatcher && (
          <Field
            label="Matcher"
            optional
            help={
              toolEvent ? (
                <>
                  Compared with the tool name. A regex like <span className="mono">Edit|Write</span> or <span className="mono">mcp__github__.*</span>. Empty matches every tool.{' '}
                  {!builder && serverOptions.length > 0 && <TextAction label="Pick an MCP server" onClick={() => setBuilder(true)} />}
                </>
              ) : (
                <>Compared with: {info?.matcherValue}. Empty matches all of them.</>
              )
            }
          >
            <Input mono value={matcher} onChange={(e) => setMatcher(e.target.value)} placeholder={toolEvent ? 'Bash' : (info?.matcherValue?.split(',')[0] ?? '')} />
          </Field>
        )}
        {takesMatcher && toolEvent && builder && (
          <div className="-mt-1 flex flex-col gap-2.5 border-l border-rule-2 pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <SelectMenu label="MCP server" className="w-[240px] phone:w-full" value={mServer || undefined} placeholder="Server" onChange={setMServer} width={mobile ? undefined : 300} options={serverOptions} />
              <Segmented
                label="Which tools"
                value={mSet}
                onChange={setMSet}
                size={mobile ? 'touch' : 'sm'}
                options={[
                  { value: 'all', label: 'All tools' },
                  { value: 'read', label: 'Read tools' },
                  { value: 'write', label: 'Write tools' },
                ]}
              />
            </div>
            {mServer && mTools && (
              <p className="m-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                {mSet === 'all'
                  ? `Every tool of ${mServer}, now and later.`
                  : (() => {
                      const n = mTools.filter((t) => (mSet === 'read' ? t.readOnly : !t.readOnly)).length;
                      return n ? `${n} of ${mTools.length} tools, by name. Tools the server adds later are not included.` : `${mServer} marks none of its ${mTools.length} tools as ${mSet === 'read' ? 'read only' : 'writing'}.`;
                    })()}{' '}
                <TextAction
                  label="Use it"
                  onClick={() => {
                    const m = mcpMatcher(mServer, mTools, mSet);
                    if (m) {
                      setMatcher(m);
                      setBuilder(false);
                    }
                  }}
                />
              </p>
            )}
            {mServer && !mTools && <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">Reading its tools.</p>}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Runs</span>
          <Segmented
            className="self-start"
            label="Handler type"
            value={type}
            onChange={setType}
            size={mobile ? 'touch' : 'md'}
            options={[
              { value: 'command', label: 'A command' },
              { value: 'prompt', label: 'A prompt' },
              { value: 'mcp_tool', label: 'An MCP tool', disabled: !serverOptions.length && type !== 'mcp_tool' },
            ]}
          />
        </div>
        {type !== 'mcp_tool' ? (
          <Field
            label={type === 'command' ? 'Command' : 'Prompt'}
            help={
              type === 'command'
                ? 'Runs in a shell on the hub with the event as JSON on stdin. Exit 2 blocks; stderr becomes the reason.'
                : 'A small model reads the event and this prompt. It answers {"ok": true} to let it go on, or {"ok": false, "reason": "..."} to block.'
            }
          >
            <Textarea
              mono={type === 'command'}
              minRows={3}
              spellCheck={type === 'prompt'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={type === 'command' ? '~/.conclave/hooks/guard-push.sh' : 'Block the call if it touches files outside the repo.'}
            />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
              <Field label="Server">
                <SelectMenu label="Server" value={server || undefined} placeholder="Server" onChange={(v) => (setServer(v), setTool(''))} options={serverOptions} />
              </Field>
              <Field label="Tool" help={picked ? (picked.readOnly ? 'Read only.' : 'Not marked read only, so it may change things. Saved with allowWrite.') : undefined}>
                {tools?.length ? (
                  <SelectMenu label="Tool" value={tool || undefined} placeholder="Tool" onChange={setTool} options={tools.map((t) => ({ value: t.name, label: <span className="font-mono text-[12.5px]">{t.name}</span>, detail: t.readOnly ? 'read only' : 'writes' }))} />
                ) : (
                  <Input mono value={tool} onChange={(e) => setTool(e.target.value)} placeholder="search_notes" />
                )}
              </Field>
            </div>
            <Field
              label="Input"
              error={parsedInput.error}
              help={
                <>
                  JSON sent as the tool&apos;s arguments. <span className="mono">{'${cwd}'}</span>, <span className="mono">{'${prompt}'}</span> or <span className="mono">{'${tool_input.file_path}'}</span> take values from the event. On SessionStart and UserPromptSubmit the tool&apos;s text is added to the context.
                </>
              }
            >
              <Textarea mono minRows={3} maxRows={10} spellCheck={false} value={toolInput} onChange={(e) => setToolInput(e.target.value)} />
            </Field>
          </>
        )}
        <Field
          label="Timeout"
          optional
          error={badTimeout ? 'Write a number of seconds above zero.' : undefined}
          help={event === 'SessionEnd' ? 'Seconds. The hub stops the handler after this. Empty means 1.5 seconds, so shutdown is not held up.' : `Seconds. The hub stops the handler after this. Empty means ${type === 'command' ? 600 : type === 'prompt' ? 30 : 60}.`}
        >
          <Input value={timeout} inputMode="decimal" onChange={(e) => setTimeoutS(e.target.value)} placeholder={event === 'SessionEnd' ? '1.5' : type === 'command' ? '600' : type === 'prompt' ? '30' : '60'} suffix="seconds" boxClassName="max-w-[200px]" />
        </Field>
        {toolEvent && (
          <Field
            label={
              <>
                <span className="mono">if</span>, only for some calls
              </>
            }
            optional
            help={
              <>
                A permission rule, like <span className="mono">Bash(git push *)</span> or <span className="mono">mcp__github__*</span>. The handler runs only for calls that match it.
              </>
            }
          >
            <Input mono value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Bash(git push *)" />
          </Field>
        )}
        <div className="flex flex-col gap-2.5">
          {toolEvent && <Checkbox checked={failClosed} onChange={setFailClosed} label="Block the call if this hook fails" description="A crash or a timeout then counts as a block, so a guard cannot fail open. Claude Code ignores this field." />}
          <Checkbox checked={once} onChange={setOnce} label="Run once per session" />
        </div>
        {shown.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Warnings">
            {shown.map((i, n) => (
              <li key={n} className={i.level === 'error' ? 'text-[13px] leading-[1.45] text-fault phone:text-[14px]' : 'text-[13px] leading-[1.45] text-warn phone:text-[14px]'}>
                {i.text}
                {i.fix && takesMatcher && i.fix[event]?.[0]?.matcher && i.fix[event]![0].matcher !== matcher.trim() && (
                  <>
                    {' '}
                    <TextAction label="Use the fix" onClick={() => setMatcher(i.fix![event]![0].matcher ?? '')} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="m-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
            <span className="text-fault">Failed.</span> {error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
