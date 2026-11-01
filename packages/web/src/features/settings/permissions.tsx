/**
 * Settings > Permissions (spec 11.10). Rules use Claude Code syntax; deny
 * wins over ask, ask over allow. Hooks moved to Extensions > Hooks.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { Link } from 'wouter';
import type { PermissionMode } from '@conclave/core/types';
import { toast, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Help, Input, Radio, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { TextAction } from '@/components/ui/Section';
import { errText, Group, save, SettingRow } from './parts';

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const MODES: Array<{ value: PermissionMode; label: string; help: string }> = [
  {
    value: 'default',
    label: 'Ask before edits',
    help: 'Reading runs freely. Edits and commands ask you first.',
  },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    help: 'Edits apply without asking. Commands still ask.',
  },
  {
    value: 'plan',
    label: 'Plan only',
    help: 'Read only. A session plans, and you approve before anything changes.',
  },
  {
    value: 'bypass',
    label: 'Bypass',
    help: 'Nothing asks. Only for throwaway containers you can rebuild.',
  },
];

type Decision = 'deny' | 'ask' | 'allow';
const DECISIONS: Decision[] = ['deny', 'ask', 'allow'];

interface Perms {
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
  additionalDirectories?: string[];
}

const RULE = /^(?:[A-Z][A-Za-z]*(?:\(.+\))?|mcp__[\w-]+(?:__[\w*-]+)?\*?)$/;

function toolOf(rule: string) {
  if (rule.startsWith('mcp__')) return `MCP ${rule.split('__')[1] ?? ''}`.trim();
  return rule.match(/^([A-Za-z]+)/)?.[1] ?? rule;
}

/**
 * A member's Permissions: their own "always allow" rules (PATCH /api/me
 * allow), kept under their account. The hub's mode and deny and ask rules
 * are the owner's and apply to everyone.
 */
export function MemberPermissionsSection() {
  const mobile = useIsMobile();
  const [allow, setAllow] = useState<string[]>();
  const [rule, setRule] = useState('');
  const [err, setErr] = useState<ReactNode>();
  useEffect(() => {
    void api()
      .me()
      .then((me) => setAllow(me.allow ?? []))
      .catch(() => setAllow([]));
  }, []);
  const write = async (next: string[]) => {
    try {
      await api().updateMe({ allow: next });
      setAllow(next);
      return true;
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
      return false;
    }
  };
  const add = async () => {
    const r = rule.trim();
    if (!r) return;
    if (!RULE.test(r)) return setErr('Write a tool name, optionally with a pattern, such as Bash(git status) or WebFetch(domain:example.com).');
    if (allow?.includes(r)) return setErr(`${r} is already allowed.`);
    setErr(undefined);
    if (await write([...(allow ?? []), r])) setRule('');
  };
  const list = allow ?? [];
  return (
    <div className="space-y-9">
      <Group title="Always allowed" count={list.length} help="Calls these rules match run without asking, in your sessions only. Always allow on an approval card adds one here." rows={false}>
        {list.map((r) => (
          <div key={r} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg" title={r}>
              {r}
            </span>
            <TextAction label="Remove" onClick={() => void write(list.filter((x) => x !== r))} />
          </div>
        ))}
        <form
          className="mt-3 flex flex-wrap items-start gap-2 border-t border-rule pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="min-w-[200px] flex-1">
            <Input mono value={rule} invalid={!!err} onChange={(e) => (setRule(e.target.value), setErr(undefined))} placeholder="Bash(git status)" aria-label="New rule" />
          </div>
          <Button type="submit" variant="outline" size={mobile ? 'touch' : 'md'} className="h-[34px] phone:h-11" disabled={!rule.trim()}>
            Allow
          </Button>
          {err && (
            <Help error className="w-full">
              {err}
            </Help>
          )}
        </form>
      </Group>
    </div>
  );
}

export function PermissionsSection() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const p = (config?.permissions ?? {}) as Perms;
  const mode = p.mode ?? 'default';
  const cur = MODES.find((m) => m.value === mode) ?? MODES[0];
  const rules = useMemo(() => DECISIONS.flatMap((d) => (p[d] ?? []).map((r) => ({ rule: r, decision: d }))), [p]);
  const [rule, setRule] = useState('');
  const [decision, setDecision] = useState<Decision>('ask');
  const [err, setErr] = useState<ReactNode>();
  const [dir, setDir] = useState('');

  const add = async () => {
    const r = rule.trim();
    if (!r) return;
    if (!RULE.test(r))
      return setErr(
        <>
          Write a tool name, optionally with a pattern: <span className="mono">Bash(git status)</span>, <span className="mono">Read(~/code/**)</span> or <span className="mono">mcp__github__*</span>.
        </>,
      );
    if (rules.some((x) => x.rule === r))
      return setErr(
        <>
          <span className="mono">{r}</span> already has a rule. Remove it first to change its decision.
        </>,
      );
    setErr(undefined);
    if (await save({ permissions: { [decision]: [...(p[decision] ?? []), r] } })) setRule('');
  };
  // removing is one click, so the toast offers it back
  const remove = async (r: { rule: string; decision: Decision }) => {
    const before = p[r.decision] ?? [];
    if (await save({ permissions: { [r.decision]: before.filter((x) => x !== r.rule) } }))
      toast({
        title: `Removed ${r.decision} ${r.rule}.`,
        action: { label: 'Undo', run: () => void save({ permissions: { [r.decision]: before } }) },
      });
  };
  const dirs = p.additionalDirectories ?? [];

  return (
    <div className="space-y-9">
      <Group title="Default mode">
        <SettingRow
          label="When a session wants to act"
          help={mobile ? 'Each session can change it.' : <span className={cn(mode === 'bypass' && 'text-fault')}>{cur.help} Each session can change it.</span>}
          stack
        >
          {mobile ? (
            <div role="radiogroup" aria-label="Default permission mode" className="rows -mt-1">
              {MODES.map((m) => (
                <Radio
                  key={m.value}
                  name="perm-mode"
                  checked={mode === m.value}
                  onChange={() => void save({ permissions: { mode: m.value } })}
                  label={<span className={cn(m.value === 'bypass' && 'text-fault')}>{m.label}</span>}
                  description={m.help}
                  className="py-3"
                />
              ))}
            </div>
          ) : (
            <Segmented label="Default permission mode" value={mode} onChange={(m) => void save({ permissions: { mode: m } })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          )}
        </SettingRow>
      </Group>

      <Group title="Rules" count={rules.length} help={
          <>
            Rules use Claude Code syntax. Deny wins over ask, and ask wins over allow. To see what a rule means for each agent, open{' '}
            <Link href="/extensions/tools" className="link">
              Extensions, Tools
            </Link>
            . Hooks are in{' '}
            <Link href="/extensions/hooks" className="link">
              Extensions, Hooks
            </Link>
            .
          </>
        } rows={false}>
        {rules.length > 0 && (
          <table className="tbl mt-1 table-fixed">
            <caption className="sr-only">Permission rules</caption>
            <thead>
              <tr>
                <th>Rule</th>
                {!mobile && <th style={{ width: 96 }}>Tool</th>}
                <th style={{ width: mobile ? 64 : 88 }}>Decision</th>
                {!mobile && <th style={{ width: 128 }}>Scope</th>}
                <th className="r" style={{ width: 72 }}>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={`${r.decision}:${r.rule}`} className="group">
                  <td className="truncate font-mono text-[12.5px] text-fg" title={r.rule}>
                    {r.rule}
                  </td>
                  {!mobile && <td className="whitespace-nowrap text-fg-2">{toolOf(r.rule)}</td>}
                  <td className="whitespace-nowrap text-fg-2">{r.decision}</td>
                  {!mobile && <td className="whitespace-nowrap text-fg-3">every session</td>}
                  <td className="r">
                    <TextAction
                      label="Remove"
                      onClick={() => void remove(r)}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 coarse:opacity-100 phone:opacity-100"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="mt-3 flex flex-wrap items-start gap-2 border-t border-rule pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="min-w-[200px] flex-1">
            <Input mono value={rule} invalid={!!err} onChange={(e) => (setRule(e.target.value), setErr(undefined))} placeholder="Bash(git push:*)" aria-label="New rule" />
          </div>
          <div className="w-[112px] shrink-0">
            <SelectMenu
              label="Decision"
              value={decision}
              onChange={setDecision}
              width={160}
              options={[
                { value: 'allow', label: 'Allow', text: 'Allow' },
                { value: 'ask', label: 'Ask', text: 'Ask' },
                { value: 'deny', label: 'Deny', text: 'Deny' },
              ]}
            />
          </div>
          <Button type="submit" variant="outline" size={mobile ? 'touch' : 'md'} className="h-[34px] phone:h-11" disabled={!rule.trim()}>
            Add rule
          </Button>
          {err && (
            <Help error className="w-full">
              {err}
            </Help>
          )}
        </form>
      </Group>

      <Group title="Extra folders" count={dirs.length || undefined} help="Folders sessions may use on top of each device's roots. Paths are on the device that runs the session.">
        {dirs.map((d) => (
          <div key={d} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{d}</span>
            <TextAction
              label="Remove"
              onClick={() =>
                void save({
                  permissions: {
                    additionalDirectories: dirs.filter((x) => x !== d),
                  },
                })
              }
            />
          </div>
        ))}
        <form
          className="flex gap-2 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const v = dir.trim();
            if (!v || dirs.includes(v)) return setDir('');
            void save({
              permissions: { additionalDirectories: [...dirs, v] },
            }).then((ok) => ok && setDir(''));
          }}
        >
          <Input mono value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/notes" aria-label="Folder to add" />
          <Button type="submit" variant="outline" size={mobile ? 'touch' : 'md'} className="h-[34px]" disabled={!dir.trim()}>
            Add
          </Button>
        </form>
      </Group>
    </div>
  );
}
