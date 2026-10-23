/**
 * The shipped default of a built-in agent (UI-HANDOFF.md, Agents: shipped
 * defaults): the markdown file Conclave ships, read only; when a copy
 * replaces it, a diff from the shipped prompt to the one in use, where that
 * copy lives, and "Reset to default" when deleting the copy brings the
 * shipped one back.
 */
import { useEffect, useState } from 'react';
import { ApiError, type AgentDefaultInfo } from '@conclave/core/client';
import type { AgentDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { makeDiff } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { CodeBlock, Diff } from '@/components/ui/Code';
import { Confirm } from '@/features/memory/parts';
import { TextAction } from '@/components/ui/Section';
import { EditorSection } from '@/features/routines/form';
import { fileWord, homePath, reloadAgents } from './agentWords';

/**
 * Names of the agents Conclave ships, from the inventory (it lists shadowed
 * copies too). Asked once per page load, so opening a user agent does not
 * ask the hub for a shipped default it cannot have. Undefined on a hub
 * without the inventory route.
 */
let builtins: Promise<Set<string> | undefined> | undefined;
function builtinNames(): Promise<Set<string> | undefined> {
  builtins ??= api()
    .extensionsInventory({ kind: 'agent' })
    .then((list) => new Set(list.filter((i) => i.source === 'builtin').map((i) => i.name)))
    .catch(() => {
      builtins = undefined;
      return undefined;
    });
  return builtins;
}

/** Load the shipped default for a name. undefined while loading, null when the agent is not built in. */
export function useAgentDefault(name: string | undefined, version: unknown) {
  const [info, setInfo] = useState<AgentDefaultInfo | null>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!name) return setInfo(null);
    let alive = true;
    builtinNames()
      .then((known) => {
        if (known && !known.has(name)) return null;
        return api().agentDefault(name);
      })
      .then((d) => alive && (setInfo(d), setError(undefined)))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setInfo(null);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [name, version, tick]);
  return { info, error, reload: () => setTick((t) => t + 1) };
}

/** Removed lines before added ones in each changed run, as diffs usually read. */
function delFirst(diff: string): string {
  const lines = diff.split('\n');
  const head = lines.slice(0, 3);
  const out: string[] = [];
  let del: string[] = [];
  let add: string[] = [];
  const flush = () => {
    out.push(...del, ...add);
    del = [];
    add = [];
  };
  for (const l of lines.slice(3)) {
    if (l.startsWith('-')) del.push(l);
    else if (l.startsWith('+')) add.push(l);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return [...head, ...out].join('\n');
}

/**
 * Keep `context` unchanged lines around each change and drop the rest, so a
 * one-line edit at the end of a long prompt shows that line, not the whole
 * prompt. Hunk headers say where each part starts.
 */
function hunks(diff: string, context = 2): string {
  const lines = diff.split('\n');
  const head = lines.slice(0, 2);
  const body = lines.slice(3);
  const keep = body.map(() => false);
  body.forEach((l, i) => {
    if (l.startsWith('+') || l.startsWith('-')) for (let j = Math.max(0, i - context); j <= Math.min(body.length - 1, i + context); j++) keep[j] = true;
  });
  const out: string[] = [];
  let oldNo = 1;
  let newNo = 1;
  let open = false;
  body.forEach((l, i) => {
    if (keep[i]) {
      if (!open) out.push(`@@ -${oldNo} +${newNo} @@ ${oldNo === 1 && newNo === 1 ? 'From the start' : `From line ${newNo}`}`);
      open = true;
      out.push(l);
    } else open = false;
    if (!l.startsWith('+')) oldNo++;
    if (!l.startsWith('-')) newNo++;
  });
  return [...head, ...out].join('\n');
}

/** One sentence per line, so a diff of prose points at the sentence that changed. */
function proseLines(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => l.replace(/([.!?])\s+(?=[A-Z`("])/g, '$1\n'))
    .join('\n');
}

const COMPARED: Array<[keyof AgentDef, string]> = [
  ['description', 'description'],
  ['model', 'model'],
  ['tools', 'tools'],
  ['disallowedTools', 'blocked tools'],
  ['mode', 'mode'],
  ['permissionMode', 'permission mode'],
  ['memory', 'memory'],
  ['skills', 'skills'],
  ['mcpServers', 'MCP servers'],
  ['primary', 'picker'],
  ['subagent', 'subagent'],
  ['device', 'device'],
];

function otherChanges(shipped: AgentDef, active: AgentDef): string[] {
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  return COMPARED.filter(([k]) => norm(shipped[k]) !== norm(active[k])).map(([, w]) => w);
}

/** Who replaces the shipped agent, and how to get the shipped one back when Reset cannot. */
function overrideWords(d: AgentDefaultInfo): string {
  const a = d.active;
  const where = a?.path ? homePath(a.path) : undefined;
  switch (d.activeSource) {
    case 'user':
      return `Your copy${where ? ` in ${where}` : ''} replaces the shipped one.`;
    case 'project':
      return `This project's copy${where ? ` in ${where}` : ''} replaces the shipped one. Delete that file to use the shipped agent in this project.`;
    case 'plugin':
      return `The ${a?.plugin ?? ''} plugin's agent replaces the shipped one. Turn the plugin off in Extensions to use the shipped agent.`.replace('The  plugin', 'A plugin');
    default:
      return `${a ? fileWord(a).replace(/^a(n)? /, (m) => m[0].toUpperCase() + m.slice(1)) : 'Another file'}${where ? `, ${where},` : ''} replaces the shipped one. Remove or rename that file to use the shipped agent.`;
  }
}

export function ShippedDefault({ d, onReset }: { d: AgentDefaultInfo; onReset: () => void }) {
  const mobile = useIsMobile();
  const [file, setFile] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const active = d.active;
  const changed = d.overridden && active ? otherChanges(d.agent, active) : [];
  const samePrompt = !!active && active.prompt.trim() === d.agent.prompt.trim();
  const path = `agents-defaults/${d.name}.md`;

  return (
    <EditorSection title="Shipped default" id="shipped" right={<TextAction label={file ? 'Hide the shipped file' : 'Show the shipped file'} onClick={() => setFile((f) => !f)} />}>
      <div className="space-y-4 py-3.5">
        <p className="max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
          {d.overridden ? overrideWords(d) : `This is the prompt Conclave ships for ${d.name}.`} The shipped prompts were tested with real model runs.
        </p>
        {d.overridden && active && (
          <>
            {samePrompt ? (
              <p className="text-[13px] text-fg-3 phone:text-[14px]">The prompt is the same as the shipped one.</p>
            ) : (
              <Diff
                diff={hunks(delFirst(makeDiff(proseLines(d.agent.prompt), proseLines(active.prompt), d.name)))}
                verb="Prompt"
                header
                maxLines={mobile ? 24 : 40}
                className="[&_td:last-child]:break-words [&_td:last-child]:whitespace-pre-wrap [&_td:last-child]:[overflow-wrap:anywhere]"
              />
            )}
            {changed.length > 0 && <p className="text-[12px] text-fg-3 phone:text-[13px]">Also different from the shipped agent: {changed.join(', ')}.</p>}
            {d.resettable && (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={() => setConfirm(true)}>
                  Reset to default
                </Button>
                <span className="text-[12px] text-fg-3 phone:text-[13px]">Deletes your copy and brings the shipped {d.name} back.</span>
              </div>
            )}
          </>
        )}
        {file && <CodeBlock code={d.markdown} lang="markdown" title={<span className="mono">{path}</span>} wrap maxLines={mobile ? 18 : 30} />}
      </div>
      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Reset ${d.name} to the shipped default?`}
        body={`Your copy${active?.path ? ` at ${homePath(active.path)}` : ''} is deleted. Sessions that used it keep their history.`}
        confirm="Reset"
        busy="Resetting"
        onConfirm={async () => {
          const ok = await attempt(() => api().deleteAgent(d.name), `${d.name} is back to the shipped default.`);
          if (!ok) return;
          await reloadAgents();
          onReset();
        }}
      />
    </EditorSection>
  );
}
