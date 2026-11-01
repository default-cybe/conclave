/**
 * One hook recipe (ECOSYSTEM.md 4.2): what it does, where to add it (this
 * hub, this project, or Claude Code, Codex or Gemini CLI on a device), its
 * tunables, the exact config and script it adds, what it needs, and its
 * tests. Add installs it and runs the tests through the hub's hook runner;
 * "Try it" opens the test runner with the recipe's own sample input.
 */
import { useEffect, useMemo, useState } from 'react';
import type { HookRecipeDetail, HookRecipeDto, RecipeInstall, RecipeInstallResult, RecipeTestResult } from '@conclave/core/client';
import type { HookEvent } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { useHub, toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { CodeBlock } from '@/components/ui/Code';
import { TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Drawer } from './Drawer';
import { CATEGORY_WORD, cliWord, handlerWords, installWords } from './recipe-words';

type Where = 'user' | 'project' | 'cli';
type Cli = 'claude-code' | 'codex' | 'gemini';

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export interface RecipeTry {
  event: HookEvent;
  input?: Record<string, unknown>;
  matcherValue?: string;
}

function Heading({ children, count }: { children: string; count?: number }) {
  return (
    <div className="mt-6 mb-2 flex items-baseline gap-2 border-b border-rule-2 pb-1.5 first:mt-0">
      <h3 className="text-[12px] font-medium text-fg-3 phone:text-[13px]">{children}</h3>
      {count !== undefined && <span className="num text-[12px] text-fg-3">{count}</span>}
    </div>
  );
}

function TestLines({ tests }: { tests: RecipeTestResult[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {tests.map((t, i) => (
        <li key={i} className="text-[13px] leading-[1.45] phone:text-[14px]">
          <span className={t.ok ? 'text-ok' : 'text-fault'}>{t.ok ? 'passed' : 'failed'}</span> <span className="text-fg-2">{t.name}</span>
          {!t.ok && t.why && <span className="block text-[12px] text-fg-3 phone:text-[13px]">{t.why}</span>}
        </li>
      ))}
    </ul>
  );
}

export function RecipeSheet({
  id,
  open,
  onClose,
  row,
  cwd,
  hubName,
  onChanged,
  onTry,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
  /** The list row, for installed state and ready while the detail loads. */
  row?: HookRecipeDto;
  cwd?: string;
  hubName: string;
  onChanged: () => void;
  onTry: (t: RecipeTry) => void;
}) {
  const mobile = useIsMobile();
  const devicesMap = useHub((s) => s.devices);
  const devices = useMemo(() => Object.values(devicesMap).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)), [devicesMap]);
  const [detail, setDetail] = useState<HookRecipeDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [where, setWhere] = useState<Where>('user');
  const [cli, setCli] = useState<Cli>('claude-code');
  const [device, setDevice] = useState<string>('local');
  const [env, setEnv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | false>(false);
  const [done, setDone] = useState<RecipeInstallResult>();
  const [tests, setTests] = useState<RecipeTestResult[]>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  const targets = (detail?.targets ?? row?.targets ?? ['conclave']).filter((t): t is Cli => t !== 'conclave');
  const conclaveOk = (detail?.targets ?? row?.targets ?? ['conclave']).includes('conclave');

  useEffect(() => {
    if (!open || !id) return;
    setDetail(undefined);
    setLoadError(undefined);
    setDone(undefined);
    setTests(undefined);
    setError(undefined);
    setEnv({});
    let live = true;
    api()
      .hookRecipe(id)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setEnv(Object.fromEntries((d.env ?? []).map((e) => [e.name, d.installed?.[0]?.env?.[e.name] ?? e.default])));
        const ts = d.targets.filter((t): t is Cli => t !== 'conclave');
        setWhere(d.targets.includes('conclave') ? 'user' : 'cli');
        if (ts.length) setCli(ts[0]);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, id]);

  useEffect(() => {
    if (devicesMap[device]) return;
    const pick = devices.find((d) => d.online && d.id !== 'local')?.id ?? devices[0]?.id;
    if (pick) setDevice(pick);
  }, [devices, devicesMap, device]);

  const r = detail;
  const installed: RecipeInstall[] = detail?.installed ?? row?.installed ?? [];
  const ready = detail?.ready ?? row?.ready;
  const deviceName = (d: string) => devicesMap[d]?.name ?? d;
  const scriptPath = where === 'cli' ? '~/.conclave/hooks/recipes/' + `${id}.sh` : (detail?.scriptPath ?? `~/.conclave/hooks/recipes/${id}.sh`);
  const changed = Object.fromEntries(Object.entries(env).filter(([k, v]) => r?.env?.find((e) => e.name === k)?.default !== v));
  const prefix = Object.entries(changed).map(([k, v]) => `${k}=${shq(v)} `).join('');
  const badEnv = Object.entries(changed).find(([, v]) => !/^[\w ./:,@%+=-]*$/.test(v));

  const config = useMemo(() => {
    if (!r) return '';
    const out: Record<string, unknown[]> = {};
    for (const h of r.handlers) {
      const handler: Record<string, unknown> = h.type === 'prompt' ? { type: 'prompt', prompt: h.prompt } : { type: 'command', command: `${prefix}${(h.command ?? '{script}').split('{script}').join(scriptPath)}` };
      if (h.timeout) handler.timeout = h.timeout;
      if (h.if) handler.if = h.if;
      if (h.async) handler.async = true;
      if (where !== 'cli') handler.recipe = r.id;
      // Codex compiles matchers with Rust's regex crate, which has no lookaround: the hub drops those groups (toCodex)
      const matcher = h.matcher && where === 'cli' && cli === 'codex' ? h.matcher.replace(/\(\?<?[=!][^()]*\)/g, '') : h.matcher;
      (out[h.event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
    }
    return JSON.stringify({ hooks: out }, null, 2);
  }, [r, prefix, scriptPath, where, cli]);

  const file =
    where === 'user'
      ? '~/.conclave/config.json'
      : where === 'project'
        ? `${cwd ?? '<project>'}/.conclave/settings.json`
        : `${{ 'claude-code': '~/.claude/settings.json', codex: '~/.codex/hooks.json', gemini: '~/.gemini/settings.json' }[cli]} on ${deviceName(device)}`;
  const deviceRead = r?.handlers.some((h) => h.runOn === 'device');
  const sameInstalled = installed.find((i) => (where === 'user' ? i.scope === 'user' : where === 'project' ? i.scope === 'project' && i.cwd === cwd : i.scope === cli && (i.device ?? 'local') === device));
  const canAdd = !!r && !busy && !badEnv && (where !== 'project' || !!cwd) && (where !== 'cli' || (!!targets.length && !!device)) && (where === 'cli' || conclaveOk);

  const add = async (force = false) => {
    if (!r) return;
    setBusy(r.tests.length ? `Adding, then running ${plural(r.tests.length, 'test')}` : 'Adding');
    setError(undefined);
    setDone(undefined);
    try {
      const res = await api().installHookRecipe(r.id, {
        scope: where === 'project' ? 'project' : 'user',
        ...(where === 'project' ? { cwd } : {}),
        env: changed,
        ...(where === 'cli' ? { target: { cli, device } } : {}),
        ...(force ? { force: true } : {}),
      });
      setDone(res);
      onChanged();
      const d = await api().hookRecipe(r.id).catch(() => undefined);
      if (d) setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runTests = async () => {
    if (!r) return;
    setBusy(`Running ${plural(r.tests.length, 'test')}`);
    try {
      setTests(await api().testHookRecipe(r.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (i: RecipeInstall) => {
    if (!r) return;
    const key = installWords(i, deviceName);
    setRemoving(key);
    try {
      const res = await api().removeHookRecipe(r.id, i.scope === 'user' || i.scope === 'project' ? { scope: i.scope, ...(i.cwd ? { cwd: i.cwd } : {}) } : { cli: i.scope as Cli, device: i.device });
      toast({ title: `Removed ${r.title} from ${key}. ${plural(res.removed ?? 0, 'handler')} taken out.` });
      setDone(undefined);
      onChanged();
      const d = await api().hookRecipe(r.id).catch(() => undefined);
      if (d) setDetail(d);
    } catch (e) {
      toast({ title: `Could not remove it. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    } finally {
      setRemoving(undefined);
    }
  };

  const first = r?.tests[0];
  const tryIt = () => {
    if (!r) return;
    const h = r.handlers[0];
    onTry({ event: first?.event ?? h.event, input: first?.input, matcherValue: first?.matcherValue });
  };

  const passed = done?.tests.filter((t) => t.ok).length ?? 0;
  const needsMissing = !!error && /needs .* on /.test(error);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={620}
      label={r?.title ?? row?.title ?? 'Hook recipe'}
      title={r?.title ?? row?.title ?? 'Hook recipe'}
      sub={r ? [CATEGORY_WORD[r.category], r.recommended ? 'recommended' : null, plural(r.tests.length, 'test'), r.source ? `idea from ${r.source}` : null].filter(Boolean).join(', ') : undefined}
      footer={
        <>
          {done && !busy && (
            <Button variant="quiet" size={mobile ? 'touch' : 'md'} className="mr-auto" onClick={tryIt}>
              Try it in the test runner
            </Button>
          )}
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Close
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!canAdd} busy={busy && busy.startsWith('Adding') ? 'Adding' : false} onClick={() => void add()}>
            {sameInstalled ? 'Save changes' : 'Add'}
          </Button>
        </>
      }
    >
      {loadError && (
        <p className="m-0 text-[14px] text-fg-2">
          <span className="text-fault">Failed.</span> Could not load the recipe: {loadError}
        </p>
      )}
      {!r && !loadError && <LoadingRows loading rows={5} />}
      {r && (
        <div>
          <p className="m-0 max-w-[70ch] text-[14px] leading-[1.5] text-fg phone:text-[15px]">{r.summary}</p>

          {(done || error || (busy && busy.startsWith('Adding'))) && (
            <div className="mt-4 border-l-2 border-rule pl-3" aria-live="polite">
              {busy && <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">{busy}.</p>}
              {done && (
                <>
                  <p className="m-0 text-[14px] leading-[1.5] text-fg phone:text-[15px]">
                    Added to <span className="mono text-[13px]">{done.file || file}</span>.{' '}
                    {done.tests.length > 0 ? <span className={passed === done.tests.length ? 'text-ok' : 'text-fault'}>{`${passed} of ${done.tests.length} tests passed.`}</span> : 'It has no tests to run.'}
                  </p>
                  {done.note && <p className="mt-1 mb-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{done.note}</p>}
                  {done.tests.some((t) => !t.ok) && (
                    <div className="mt-2">
                      <TestLines tests={done.tests} />
                      <p className="mt-2 mb-0 text-[12px] text-fg-3 phone:text-[13px]">The recipe stays added. Fix what the failed test names, or remove it below.</p>
                    </div>
                  )}
                </>
              )}
              {error && (
                <p className="m-0 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">
                  <span className="text-fault">Failed.</span> {error}
                  {needsMissing && (
                    <>
                      {' '}
                      <TextAction label="Add it anyway" onClick={() => void add(true)} />
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          <Heading>Add to</Heading>
          <Segmented
            label="Where"
            value={where}
            onChange={setWhere}
            size={mobile ? 'touch' : 'md'}
            full={mobile}
            options={[
              { value: 'user', label: 'This hub', disabled: !conclaveOk },
              { value: 'project', label: 'This project', disabled: !conclaveOk || !cwd },
              { value: 'cli', label: 'Another CLI', disabled: !targets.length },
            ]}
          />
          {where === 'cli' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <SelectMenu label="CLI" value={cli} onChange={setCli} width={mobile ? undefined : 220} options={targets.map((t) => ({ value: t, label: cliWord(t) }))} />
              <SelectMenu label="Device" value={device} onChange={setDevice} width={mobile ? undefined : 260} options={devices.map((d) => ({ value: d.id, label: d.name, hint: d.online ? undefined : 'offline' }))} />
            </div>
          )}
          <p className="mt-2 mb-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            {where === 'user' && 'Runs in every Conclave session on this hub.'}
            {where === 'project' && (cwd ? 'Runs in Conclave sessions in this folder once it is trusted.' : 'Pick a project folder at the top of Extensions first.')}
            {where === 'cli' &&
              `${cliWord(cli)} on ${deviceName(device)} runs it itself, with the script copied there. ${
                cli === 'gemini' ? 'Gemini CLI gets its own event and tool names, and the timeout in milliseconds.' : cli === 'codex' ? 'Same file format as Conclave. Codex runs a new hook only after you trust it there.' : 'Same file format as Conclave.'
              }`}
            {!conclaveOk && where === 'cli' && ` This recipe works only in ${targets.map(cliWord).join(' and ')}.`}
            {deviceRead && where !== 'cli' && " It reads the session's files, so until hooks run on devices it only works for sessions on the hub."}
            {sameInstalled && ' Already added here; Save changes replaces it with these settings.'}
          </p>

          {(r.env ?? []).length > 0 && (
            <>
              <Heading count={r.env!.length}>Tunables</Heading>
              <div className="flex flex-col gap-3">
                {r.env!.map((e) => (
                  <Field key={e.name} label={<span className="mono">{e.name}</span>} help={e.default ? `${e.description} Default ${e.default}.` : `${e.description} Empty by default.`} error={badEnv?.[0] === e.name ? 'Use letters, digits and . / : , @ % + = - only.' : undefined}>
                    <Input mono value={env[e.name] ?? ''} onChange={(ev) => setEnv((x) => ({ ...x, [e.name]: ev.target.value }))} className="max-w-[320px]" />
                  </Field>
                ))}
              </div>
            </>
          )}

          <Heading count={r.handlers.length}>What it adds</Heading>
          <ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0">
            {r.handlers.map((h, i) => (
              <li key={i} className="text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
                <span className="font-mono text-[12.5px] text-fg">{handlerWords(h)}</span>
                {h.if && <span className="font-mono text-[12.5px] text-fg-2">{` if ${h.if}`}</span>}
                <span className="text-fg-3">
                  {[h.type === 'prompt' ? ', a prompt for the small model' : ', bash', h.timeout ? `, ${h.timeout}s timeout` : '', h.async ? ', in the background' : '', h.runOn === 'device' ? ", reads the session's files" : ', reads only the hook input'].join('')}
                </span>
              </li>
            ))}
          </ul>
          <CodeBlock title={file} code={config} lang="json" copy maxLines={16} />
          {r.script && (
            <div className="mt-3">
              <CodeBlock title={`${scriptPath}, ${r.script.length.toLocaleString('en-US')} bytes`} code={r.script.replace(/\n$/, '')} lang="bash" copy maxLines={14} />
            </div>
          )}

          <Heading count={r.needs.length}>Needs</Heading>
          <p className="m-0 text-[13px] leading-[1.6] phone:text-[14px]">
            {r.needs.map((n, i) => {
              const bin = n.split(/\s+/)[0];
              const missing = where !== 'cli' && !!ready?.missing.includes(bin);
              return (
                <span key={n}>
                  <span className="mono text-fg">{n}</span> <span className={missing ? 'text-warn' : 'text-fg-3'}>{where === 'cli' ? `checked on ${deviceName(device)} when you add it` : missing ? `missing on ${hubName}` : 'found'}</span>
                  {i < r.needs.length - 1 ? ', ' : ''}
                </span>
              );
            })}
          </p>

          <Heading>Cost and limits</Heading>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{r.budget}</p>
          <p className="mt-2 mb-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{r.safety}</p>

          <Heading count={r.tests.length}>Tests</Heading>
          {r.tests.length === 0 ? (
            <p className="m-0 text-[13px] text-fg-3 phone:text-[14px]">No bundled tests{r.needs.includes('rtk') ? ': it needs rtk, which the test fixture does not have' : ''}.</p>
          ) : tests ? (
            <TestLines tests={tests} />
          ) : (
            <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
              {r.tests.map((t) => t.name).join('; ')}.{' '}
              <TextAction label={busy && busy.startsWith('Running') ? 'Running' : 'Run them now'} onClick={() => void runTests()} />
            </p>
          )}

          {installed.length > 0 && (
            <>
              <Heading count={installed.length}>Added to</Heading>
              <ul className="m-0 flex list-none flex-col p-0">
                {installed.map((i) => {
                  const key = installWords(i, deviceName);
                  const tun = Object.entries(i.env ?? {});
                  return (
                    <li key={key} className="flex items-baseline gap-3 py-1.5 text-[13px] phone:text-[14px]">
                      <span className="min-w-0 flex-1 text-fg">
                        {key}
                        {tun.length > 0 && <span className="mono text-[12px] text-fg-3">{` ${tun.map(([k, v]) => `${k}=${v}`).join(' ')}`}</span>}
                      </span>
                      <button type="button" disabled={!!removing} onClick={() => void remove(i)} className={cn('tap shrink-0 text-[13px] font-medium phone:text-[14px]', removing === key ? 'text-fg-3' : 'text-fault hover:underline')}>
                        {removing === key ? 'Removing' : 'Remove'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
