/**
 * A program block's inspector in Canvas (docs/design/VISUAL-PROGRAMMING.md 4
 * to 6), and the words for a program run. The inspector's input selects are
 * how a phone (and a keyboard) connects blocks.
 */
import { useEffect, useState } from 'react';
import type { FlowBlockSpec, FlowNodeLive, FlowOp, FlowRunView, GraphNode } from '@conclave/core/client';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Field, Input, OnOff, Select } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Section';
import { blockLine, liveState, nodeTitle, stateTone } from './nodes';

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
  const [rename, setRename] = useState(node.declares[0] ?? '');
  useEffect(() => {
    setDrafts({});
    setRename(node.declares[0] ?? '');
  }, [node.id, node.source]); // eslint-disable-line react-hooks/exhaustive-deps
  const renameNow = () => {
    const next = rename.trim();
    if (next && next !== node.declares[0]) void onOp({ op: 'rename', nodeId: node.id, name: next }, 'rename');
  };
  const inputs = node.kind === 'block' ? (spec?.inputs ?? []) : [];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="t-title mono min-w-0 truncate text-fg">{node.kind === 'code' ? nodeTitle(node) : node.label}</div>
          {lv && <span className={cn('cv-state shrink-0 text-[13px]', tone.text)}>{lv.ok ? 'done' : 'failed'}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {spec ? `${spec.title}: ${spec.help}` : blockLine(node)}. Lines {node.span.start} to {node.span.end}.
        </div>
      </div>
      <div className="scroll-y min-h-0 flex-1 space-y-5 px-5 py-4">
        {lv && !lv.ok && <Notice tone="fault">{lv.error ?? 'This block failed.'}</Notice>}
        {node.kind === 'block' && node.declares[0] && (
          <Field label="Name" help="What other blocks call its value. Renaming changes it everywhere it is read.">
            <Input value={rename} aria-label="Name" mono onChange={(e) => setRename(e.target.value)} onBlur={renameNow} onKeyDown={(e) => e.key === 'Enter' && renameNow()} />
          </Field>
        )}
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
                {/* a choice or a switch is a setting: a wire of any value into it would not run */}
                {node.block !== 'value' && (inp.widget === 'text' || a?.ref) && (
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
        <Button variant="ghost" size={phone ? 'touch' : 'md'} onClick={() => void onOp({ op: 'remove', nodeId: node.id }, 'remove')} title="Delete or Backspace on the canvas">
          Remove block
        </Button>
      </div>
    </div>
  );
}
