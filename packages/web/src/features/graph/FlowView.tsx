/**
 * A Code session's flows as blocks (docs/design/VISUAL-PROGRAMMING.md 4 to 6),
 * in the transcript's place while Blocks is on. The file flows/<name>.flow.ts
 * is the program; the canvas reads it from the hub after each edit, when the
 * session goes idle (the agent may have changed it) and on window focus. Run
 * asks like an agent's Bash call; each block then shows its value and each
 * wire the value that went through it. The inspector's input selects are
 * how a phone (and a keyboard) connects blocks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowBlockSpec, FlowNodeLive, FlowOp, FlowRunView, FlowSummary, FlowView as FlowViewDto, GraphNode } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { attempt, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Field, Input, OnOff, Select } from '@/components/ui/Field';
import { Sheet, SideSheet } from '@/components/ui/Overlay';
import { Notice } from '@/components/ui/Section';
import { GraphCanvas, type InsertItem } from './GraphCanvas';
import { blockLine, liveState, stateTone } from './nodes';
import { useHistory } from './history';

type Positions = Record<string, { x: number; y: number }>;
const POLL_MS = 700;
const live = (r?: FlowRunView) => r?.status === 'running' || r?.status === 'approval';

/** What the status line says about a run. */
export function runWords(r?: FlowRunView): string {
  if (!r) return 'Not run yet.';
  const failed = Object.values(r.nodes).filter((n) => !n.ok).length;
  switch (r.status) {
    case 'approval':
      return 'Waiting for your approval to run.';
    case 'running':
      return `Running, ${Object.keys(r.nodes).length} blocks done.`;
    case 'done':
      return `Ran in ${(((r.finishedAt ?? r.startedAt) - r.startedAt) / 1000).toFixed(1)} s.`;
    case 'stopped':
      return 'Stopped.';
    case 'refused':
      return r.error ?? 'Not run.';
    default:
      return `Failed${failed ? ` at ${failed === 1 ? 'one block' : `${failed} blocks`}` : ''}. ${r.error ?? ''}`.trim();
  }
}

export default function FlowView({ session }: { session: Session }) {
  const sid = session.id;
  const phone = useIsMobile();
  const [flows, setFlows] = useState<FlowSummary[]>();
  const [name, setName] = useState<string>();
  const [view, setView] = useState<FlowViewDto>();
  const [blocks, setBlocks] = useState<FlowBlockSpec[]>([]);
  const [run, setRun] = useState<FlowRunView>();
  const [sel, setSel] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState<string>();
  const [newName, setNewName] = useState('');
  const [positions, setPositions] = useState<Positions>({});
  const history = useHistory(!!view);
  const shaNow = useRef('');
  shaNow.current = view?.sha ?? '';
  const status = useHub((s) => s.sessions[sid]?.status);

  useEffect(() => {
    void api().flowBlocks().then(setBlocks).catch(() => {});
    void api()
      .flows(sid)
      .then((l) => {
        setFlows(l);
        setName((n) => n ?? l[0]?.name);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sid]);

  const load = (n = name) => {
    if (!n) return;
    void api()
      .flowGraph(sid, n)
      .then((v) => {
        setView(v);
        setPositions(v.layout ?? {});
        setRun((r) => (live(r) ? r : v.lastRun));
        setError(undefined);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  // code wins: read the file again when it may have changed under the canvas
  useEffect(() => load(), [sid, name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (status === 'idle') load();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = () => load();
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  });
  // a run goes on in the background: ask for it until it ends
  useEffect(() => {
    if (!name || !live(run)) return;
    const t = setInterval(() => void api().flowRun(sid, name).then((r) => r && setRun(r)).catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [sid, name, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const bySpec = useMemo(() => new Map(blocks.map((b) => [b.block, b])), [blocks]);
  const inserts: InsertItem[] = useMemo(() => blocks.map((b) => ({ kind: b.block, word: b.title, help: b.help })), [blocks]);

  const restore = async (sha: string) => {
    const res = await api().restoreFlow(sid, name!, sha, shaNow.current);
    setView(res.view);
    setDiff(res.diff || undefined);
  };
  /** One op; undo puts back the version before it. A refusal comes back as a toast with the reason. */
  const apply = (op: FlowOp, label: string) =>
    attempt(() => api().flowOp(sid, name!, op, shaNow.current)).then((res) => {
      if (!res || !view) return res;
      const before = view.sha;
      history.push({ label, undo: () => restore(before), redo: () => restore(res.sha) });
      setView(res.view);
      setDiff(res.diff || undefined);
      if (res.nodeId) setSel(res.nodeId);
      return res;
    });
  const saveLayout = async (next: Positions) => {
    setPositions(next);
    await api().saveFlowLayout(sid, name!, next);
  };
  const start = () => void attempt(() => api().runFlow(sid, name!)).then((r) => r && setRun(r));
  const stop = () => void attempt(() => api().stopFlow(sid, name!)).then((r) => r && setRun(r));
  const create = () => {
    const n = newName.trim();
    void attempt(() => api().createFlow(sid, n), `Created flows/${n}.flow.ts`).then((v) => {
      if (!v) return;
      setFlows((l) => [...(l ?? []), { name: v.name, path: v.path }].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName('');
      setName(v.name);
    });
  };

  const newFlow = (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new-flow" aria-label="New flow name" className="w-[140px]" />
      <Button type="submit" variant="outline" size={phone ? 'touch' : 'md'} disabled={!/^[a-z0-9][a-z0-9-]{0,63}$/.test(newName.trim())}>
        New flow
      </Button>
    </form>
  );

  if (error && !view) return <div className="p-6"><Notice tone="fault">The flows did not load. {error}</Notice></div>;
  if (flows && !flows.length)
    return (
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-8 py-10 phone:px-5">
        <p className="text-[14px] text-fg-2">No flows here yet. A flow is a TypeScript file in flows/ that Conclave draws as blocks; you connect blocks, Conclave writes the code, Run runs it with Bun on this session's device.</p>
        {newFlow}
      </div>
    );
  if (!view) return null;
  const node = view.graph.nodes.find((n) => n.id === sel);
  const nodes = run?.nodes ?? {};
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-6 pt-3 pb-2 phone:px-3">
      <div className="flex flex-wrap items-center gap-2">
        {flows && flows.length > 1 ? (
          <Select value={name} onChange={(e) => setName(e.target.value)} aria-label="Flow" mono className="w-[180px]">
            {flows.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="mono text-[13px] text-fg">{view.path}</span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size={phone ? 'touch' : 'md'} disabled={!history.canUndo} title={history.nextUndo ? `Undo ${history.nextUndo}` : 'Nothing to undo'} onClick={history.undo}>
          Undo
        </Button>
        <Button variant="ghost" size={phone ? 'touch' : 'md'} disabled={!history.canRedo} title={history.nextRedo ? `Redo ${history.nextRedo}` : 'Nothing to redo'} onClick={history.redo}>
          Redo
        </Button>
        {live(run) ? (
          <Button variant="outline" size={phone ? 'touch' : 'md'} onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={start} disabled={!!view.graph.error}>
            Run
          </Button>
        )}
      </div>
      <p className={cn('text-[12px] phone:text-[13px]', run?.status === 'failed' || run?.status === 'refused' ? 'text-fault' : 'text-fg-3')} aria-live="polite">
        {view.graph.error ? `The file does not parse: ${view.graph.error}. Fix it in the code; the canvas reads it again.` : `${view.graph.nodes.length} blocks. ${runWords(run)}`}
      </p>
      {diff && <CodeBlock code={diff} lang="diff" />}
      <GraphCanvas
        graph={view.graph}
        selected={sel}
        onSelect={setSel}
        positions={positions}
        inserts={inserts}
        onInsert={(block, after) => void apply({ op: 'insert', block, ...(after ? { after } : {}) }, 'new block')}
        onMove={(nid, at) => {
          const prev = positions;
          const next = { ...positions, [nid]: { x: Math.round(at.x / 8) * 8, y: Math.round(at.y / 8) * 8 } };
          void attempt(() => saveLayout(next));
          history.push({ label: 'move', undo: () => saveLayout(prev), redo: () => saveLayout(next) });
        }}
        flow={{ blocks: bySpec, live: nodes, onConnect: (from, to, input) => void apply({ op: 'connect', nodeId: to, input, from }, 'wire') }}
        className="min-h-[320px] flex-1 rounded-[var(--r-2)] border border-rule"
      />
      {run?.output && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-fg-3">Output</summary>
          <CodeBlock code={run.output} />
        </details>
      )}
      <div className="flex justify-end phone:hidden">{newFlow}</div>
      <InspectorShell open={!!node} label={node?.label ?? 'Block'} onClose={() => setSel(undefined)}>
        {node && <FlowInspector node={node} nodes={view.graph.nodes} spec={node.block ? bySpec.get(node.block) : undefined} live={nodes[node.id]} onOp={apply} />}
      </InspectorShell>
    </div>
  );
}

function InspectorShell({ open, label, onClose, children }: { open: boolean; label: string; onClose: () => void; children: React.ReactNode }) {
  const phone = useIsMobile();
  if (phone)
    return (
      <Sheet open={open} onClose={onClose} label={label} className="cv-inspector">
        {children}
      </Sheet>
    );
  return (
    <SideSheet open={open} onClose={onClose} width={420} modal={false} label={label} className="cv-inspector">
      {children}
    </SideSheet>
  );
}

const WIRE = '\u0000wire';

/**
 * A block's inputs, its last value or error, and its source. Each input is a
 * setting (its widget) or a wire from an earlier block (the select): picking
 * a block in the select is a connection, so it works by tap and by keyboard.
 */
export function FlowInspector({ node, nodes, spec, live: lv, onOp }: { node: GraphNode; nodes: GraphNode[]; spec?: FlowBlockSpec; live?: FlowNodeLive; onOp: (op: FlowOp, label: string) => Promise<unknown> }) {
  const phone = useIsMobile();
  const earlier = nodes.slice(0, nodes.indexOf(node)).flatMap((n) => n.declares.map((d) => ({ name: d, node: n })));
  const tone = stateTone(liveState(lv));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => setDrafts({}), [node.id, node.source]);
  const inputs = node.kind === 'block' ? (spec?.inputs ?? []) : [];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="t-title mono min-w-0 truncate text-fg">{node.label}</div>
          {lv && <span className={cn('cv-state shrink-0 text-[13px]', tone.text)}>{lv.ok ? 'done' : 'failed'}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {spec ? `${spec.title}: ${spec.help}` : blockLine(node)}. Lines {node.span.start} to {node.span.end}.
        </div>
      </div>
      <div className="scroll-y min-h-0 flex-1 space-y-5 px-5 py-4">
        {lv && !lv.ok && <Notice tone="fault">{lv.error ?? 'This block failed.'}</Notice>}
        {inputs.map((inp) => {
          const a = node.args?.[inp.name];
          const wired = a?.ref ? `${a.ref}${a.field ? `.${a.field}` : ''}` : undefined;
          const set = (value: string | number | boolean) => void onOp({ op: 'set', nodeId: node.id, input: inp.name, value }, inp.name);
          const draft = drafts[inp.name] ?? (a && !a.ref && a.value !== undefined ? String(a.value) : '');
          const commit = () => {
            if (drafts[inp.name] === undefined || drafts[inp.name] === String(a?.value ?? '')) return;
            set(inp.widget === 'number' ? Number(drafts[inp.name]) : drafts[inp.name]);
          };
          if (a?.locked)
            return (
              <Field key={inp.name} label={inp.name} help={a.locked}>
                <Input value="computed" disabled />
              </Field>
            );
          return (
            <Field key={inp.name} label={inp.name} help={inp.help}>
              <div className="flex flex-col gap-2">
                {node.block !== 'value' && (
                  <Select
                    aria-label={`${inp.name} comes from`}
                    value={a?.ref ?? WIRE}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === WIRE) void onOp({ op: 'disconnect', nodeId: node.id, input: inp.name }, 'cut wire');
                      else void onOp({ op: 'connect', nodeId: node.id, input: inp.name, from: v }, 'wire');
                    }}
                  >
                    <option value={WIRE}>A setting</option>
                    {earlier.map((x) => (
                      <option key={x.name} value={x.name}>
                        From {x.name}
                      </option>
                    ))}
                  </Select>
                )}
                {wired ? (
                  <p className="mono text-[12px] text-fg-2">wired to {wired}</p>
                ) : inp.widget === 'combo' ? (
                  <Select value={String(a?.value ?? inp.default)} onChange={(e) => set(e.target.value)} aria-label={inp.name}>
                    {inp.options!.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : inp.widget === 'toggle' ? (
                  <OnOff checked={a?.value === true} onChange={set} label={inp.name} size={phone ? 'touch' : 'sm'} />
                ) : (
                  <Input
                    value={draft}
                    aria-label={inp.name}
                    inputMode={inp.widget === 'number' ? 'decimal' : undefined}
                    onChange={(e) => setDrafts((d) => ({ ...d, [inp.name]: e.target.value }))}
                    onBlur={commit}
                    onKeyDown={(e) => e.key === 'Enter' && commit()}
                  />
                )}
              </div>
            </Field>
          );
        })}
        {lv?.ok && lv.value !== undefined && (
          <div>
            <div className="pb-1.5 text-[12px] font-medium text-fg-2">Value, last run{lv.ms !== undefined ? `, ${lv.ms} ms` : ''}</div>
            <CodeBlock code={lv.value} />
          </div>
        )}
        <div>
          <div className="pb-1.5 text-[12px] font-medium text-fg-2">Code</div>
          <CodeBlock code={node.source ?? ''} lang="ts" />
        </div>
        <Button variant="ghost" size={phone ? 'touch' : 'md'} onClick={() => void onOp({ op: 'remove', nodeId: node.id }, 'remove')}>
          Remove block
        </Button>
      </div>
    </div>
  );
}
