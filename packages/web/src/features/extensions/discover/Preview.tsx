/**
 * The preview sheet (ECOSYSTEM.md 3.4). One sheet for three jobs:
 * - detail: a row click; README head on top, the preview under it, Add at the bottom
 * - add: the Add button; the preview, inputs and options, then install with progress
 * - update: the Update action; what changed upstream, then update
 * Sections in order: title block, how to run it, before you add, fill in,
 * options, what it adds, warnings, needs, equivalent. Routines never install
 * here: Add opens the Routines tab's Add sheet.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { ApiError, type CatalogDetail, type CatalogInput, type CatalogInstallResult, type CatalogItemDto, type CatalogKind, type CatalogPreviewRequest, type HookRecipeDto, type InstallPreview, type InstallSpec, type InstalledRef, type PreviewFile, type PreviewHook, type UpdatePreview } from '@conclave/core/client';
import type { PluginInstall } from '@conclave/core/catalog/recommended';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';
import { useBreakpoint, useIsMobile } from '@/lib/hooks';
import { bytes, plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Radio, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { CodeBlock, Command } from '@/components/ui/Code';
import { Markdown } from '@/features/chat/Markdown';
import { describeSchedule } from '@/lib/schedule';
import { useExtCwd } from '../project';
import { DiscoverSheet } from './Sheet';
import { KIND_ORDER, KIND_TAB, KIND_WORD, categoryWord, cleanReadme, isLive, loadedCounts, commonDir, dayWords, licenseOpen, listWords, repoUrl, shortSha, starsWords, touchWords, underHome, whereWords } from './words';
import { cardFix, stepFix } from './hub-setup';
import { HubFixLine } from './HubSetup';
import { errText } from '@/features/settings/parts';

export type SheetMode = 'detail' | 'add' | 'update';
export interface SheetTarget {
  id: string;
  mode: SheetMode;
  /** The row's item, so the title shows at once. */
  seed?: CatalogItemDto;
}

type Phase = 'idle' | 'installing' | 'done' | 'failed';
type Where = 'user' | 'project' | 'claude-code' | 'codex' | 'gemini';

interface Opts {
  variant: number;
  kind?: CatalogKind;
  plugins?: string[];
  hooks?: boolean;
  toolPreset?: string;
  where: Where;
  device?: string;
  sync: boolean;
}

const BASE_OPTS: Opts = { variant: 0, where: 'user', sync: false };

function specAt(item: CatalogItemDto | undefined, variant: number): InstallSpec | undefined {
  if (!item) return undefined;
  return [item.install, ...(item.variants ?? [])][variant] ?? item.install;
}

function rawError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = typeof e.body === 'string' ? e.body : e.body ? JSON.stringify(e.body, null, 2) : '';
    return [`HTTP ${e.status}`, e.message, body].filter(Boolean).join('\n');
  }
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/** The install steps the progress line walks through while the request runs. */
function progressSteps(p: InstallPreview | undefined, spec: InstallSpec | undefined, tests: number | undefined): string[] {
  const sha = p?.sha ? `Fetching ${shortSha(p.sha)}` : 'Fetching';
  switch (spec?.type) {
    case 'mcp':
      return [`Saving ${spec.server}`, 'Testing connection'];
    case 'plugin':
      return [...(spec.marketplace ? [`Adding the marketplace ${spec.marketplace}`] : []), sha, `Installing ${plural(spec.plugins.length, 'plugin')}`];
    case 'files':
      return [sha, `Copying ${plural(p?.files.length || spec.files.length, 'file')}`];
    case 'hook':
      return ['Writing the script', tests ? `Running ${plural(tests, 'test')}` : 'Running the tests'];
    default:
      return ['Adding'];
  }
}

/** "4 skills, 1 command and 3 hooks" from what the preview said it adds. */
function addedWords(p: InstallPreview | undefined): string {
  if (!p) return '';
  // only what loads: a repo may carry copies for other tools (caveman ships OpenCode commands and a nested plugin)
  const n = loadedCounts(p.files.map((f) => f.path));
  const parts = [
    n.skills && plural(n.skills, 'skill'),
    n.agents && plural(n.agents, 'agent'),
    n.commands && plural(n.commands, 'command'),
    p.hooks.length && plural(p.hooks.length, 'hook'),
    p.mcpServers.length && plural(p.mcpServers.length, 'MCP server'),
  ].filter(Boolean) as string[];
  return parts.length ? ` ${listWords(parts)}.` : '';
}

function doneWords(r: CatalogInstallResult, p?: InstallPreview, enabled = true): ReactNode {
  if (r.test) {
    if (r.test.ok) return <>Added. {plural(r.test.tools, 'tool')}.</>;
    return (
      <>
        Saved disabled. <span className="text-fault">The test failed</span>
        {r.test.error ? `: ${errText(r.test.error)}` : '.'}
      </>
    );
  }
  if (r.recipeTests?.length) {
    const ok = r.recipeTests.filter((t) => t.ok).length;
    return (
      <>
        Added. <span className={ok === r.recipeTests.length ? 'text-ok' : 'text-fault'}>{`${ok} of ${r.recipeTests.length} tests passed.`}</span>
      </>
    );
  }
  return `${enabled ? 'Added.' : 'Added, turned off.'}${addedWords(p)}`;
}

function Block({ title, children, right, className }: { title: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-7', className)}>
      <div className="flex items-baseline gap-3 border-b border-rule-2 pb-[9px]">
        <h3 className="t-section min-w-0 flex-1 text-fg">{title}</h3>
        {right && <div className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{right}</div>}
      </div>
      {children}
    </section>
  );
}

const ROLE_WORD: Record<string, string> = { skill: 'skill', agent: 'agent', command: 'command', hook: 'hook', script: 'script', manifest: 'manifest', mcp: 'MCP config', other: '' };

/**
 * Kinds a live repo holds, for the "Add it as" pick. The detail's tree has them when the hub
 * read it; otherwise the preview names the others in its "This repo also holds" warning.
 */
function liveKinds(detail: CatalogDetail | undefined, preview: InstallPreview | undefined): CatalogKind[] {
  const set = new Set<CatalogKind>(detail?.tree?.kinds ?? []);
  if (preview && preview.item.source !== 'recommended') {
    const m = preview.warnings.map((w) => /^This repo also holds: ([a-z, ]+)\./.exec(w.text)).find(Boolean);
    if (m) {
      set.add(preview.item.kind);
      for (const k of m[1].split(/,\s*/)) if ((KIND_ORDER as string[]).includes(k)) set.add(k as CatalogKind);
    }
  }
  return KIND_ORDER.filter((k) => set.has(k));
}

/** Most files listed in the sheet; caveman alone brings about 1,800. */
const FILES_MAX = 300;
const ROLE_ORDER: Record<string, number> = { manifest: 0, hook: 1, mcp: 2, script: 3, skill: 4, agent: 5, command: 6, other: 7 };
/** Manifests, hooks, MCP configs and scripts first, then what loads into the prompt, each by path. */
function sortFiles(files: PreviewFile[]): PreviewFile[] {
  return [...files].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || Number(!!b.executable) - Number(!!a.executable) || a.path.localeCompare(b.path));
}

export function PreviewSheet({
  target,
  onClose,
  onChanged,
  onReady,
}: {
  target: SheetTarget | null;
  onClose: () => void;
  onChanged: (id: string, installed: InstalledRef | null) => void;
  /** After "Install on the hub" ran from a step or the Needs block, with the readiness the hub checked again. */
  onReady?: (id: string, ready: CatalogItemDto['ready']) => void;
}) {
  const [, navigate] = useLocation();
  const bp = useBreakpoint();
  const phone = bp === 'phone';
  const hubName = useHub((s) => s.hub?.name) ?? 'the hub';
  const savedSecrets = useHub((s) => s.secrets?.values);
  const devicesMap = useHub((s) => s.devices);
  const defaultDevice = useHub((s) => (s.config as { defaultDevice?: string } | undefined)?.defaultDevice);
  const cwd = useExtCwd();

  const [detail, setDetail] = useState<CatalogDetail>();
  const [preview, setPreview] = useState<InstallPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [opts, setOpts] = useState<Opts>(BASE_OPTS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<CatalogInstallResult>();
  const [failure, setFailure] = useState<{ text: string; raw?: string; canSaveDisabled?: boolean }>();
  const [notice, setNotice] = useState<string>();
  const [recipe, setRecipe] = useState<HookRecipeDto>();
  const [readmeAll, setReadmeAll] = useState(false);
  const [filesAll, setFilesAll] = useState(false);
  const [update, setUpdate] = useState<UpdatePreview>();
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'updating' | 'done' | 'rolled-back'>('idle');
  const [removing, setRemoving] = useState(false);
  const [installedNow, setInstalledNow] = useState<InstalledRef | null | undefined>(undefined);
  /** The options the current preview was made with, so Add never installs a plan made for other options. */
  const [previewKey, setPreviewKey] = useState<string>();
  /** Whether the last install turned the item on, for the done line. */
  const [enabledNow, setEnabledNow] = useState(true);
  const firstPreview = useRef(true);
  const reqSeq = useRef(0);
  /** The hub uses a plan up on the first install call; the next try needs a new one. */
  const usedPlan = useRef<string | undefined>(undefined);
  const lastPreviewError = useRef<string | undefined>(undefined);

  const id = target?.id;
  const mode = target?.mode ?? 'detail';
  // the preview's item carries the install spec it worked out for a live repo, so it wins over the detail's placeholder
  const base: CatalogItemDto | undefined = preview?.item ? { ...(detail ?? {}), ...preview.item } : (detail ?? target?.seed);
  const item: CatalogItemDto | undefined = base ? { ...base, installed: installedNow === undefined ? base.installed : (installedNow ?? undefined) } : undefined;
  const spec = specAt(item, opts.variant);
  const isRoutine = item?.kind === 'routine' || spec?.type === 'routine';
  const isManual = spec?.type === 'manual' && !(item && isLive(item));
  const devices = useMemo(() => Object.values(devicesMap).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)), [devicesMap]);
  const pickDevice = opts.device ?? (defaultDevice && devicesMap[defaultDevice] ? defaultDevice : devices.find((d) => d.online && d.id !== 'local')?.id ?? devices[0]?.id);
  const deviceName = (did?: string) => (did ? (devicesMap[did]?.name ?? did) : 'the device');

  // reset on a new target
  useEffect(() => {
    setDetail(undefined);
    setPreview(undefined);
    setPreviewError(undefined);
    setOpts(BASE_OPTS);
    setValues({});
    setMissing([]);
    setPhase('idle');
    setResult(undefined);
    setFailure(undefined);
    setNotice(undefined);
    setRecipe(undefined);
    setReadmeAll(false);
    setFilesAll(false);
    setUpdate(undefined);
    setUpdateState('idle');
    setInstalledNow(undefined);
    setPreviewKey(undefined);
    usedPlan.current = undefined;
    lastPreviewError.current = undefined;
    firstPreview.current = true;
    if (!id) return;
    let alive = true;
    if (target?.mode !== 'add' || !target.seed) {
      api()
        .catalogItem(id)
        .then((d) => alive && setDetail(d))
        .catch((e) => alive && !target?.seed && setPreviewError(errText(e)));
    }
    if (target?.mode === 'update' && target.seed?.installed) {
      setUpdateState('checking');
      api()
        .catalogUpdatePreview(target.seed.installed.id)
        .then((u) => alive && (setUpdate(u), setUpdateState('idle')))
        .catch((e) => alive && (setFailure(e instanceof ApiError && e.status === 409 ? { text: errText(e) } : { text: `Could not check for changes: ${errText(e)}`, raw: rawError(e) }), setUpdateState('idle')));
    }
    return () => {
      alive = false;
    };
  }, [id, target?.mode, target?.seed]);

  // hook recipes: targets and test count come from the recipe list
  useEffect(() => {
    if (!item || item.install.type !== 'hook') return;
    const rid = item.install.recipe;
    let alive = true;
    api()
      .hookRecipes(cwd)
      .then((list) => alive && setRecipe(list.find((r) => r.id === rid)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item?.id, cwd]);

  const request = (o: Opts): CatalogPreviewRequest | null => {
    if (!id) return null;
    const options: CatalogPreviewRequest['options'] = {};
    if (o.plugins) options.plugins = o.plugins;
    if (o.hooks !== undefined) options.hooks = o.hooks;
    if (o.toolPreset) options.toolPreset = o.toolPreset;
    if (o.where === 'user' || o.where === 'project') {
      if (item?.kind === 'hook') options.scope = o.where;
      if (o.where === 'project' && cwd) options.cwd = cwd;
    } else if (pickDevice) options.target = { cli: o.where, device: pickDevice };
    if (pickDevice && (item?.needs ?? []).some((n) => n.where !== 'hub')) options.device = pickDevice;
    return { id, variant: o.variant, ...(o.kind ? { kind: o.kind } : {}), ...(Object.keys(options).length ? { options } : {}) };
  };

  const keyOf = (o: Opts) => `${JSON.stringify(o)}|${cwd ?? ''}`;

  const runPreview = async (o: Opts): Promise<InstallPreview | undefined> => {
    const req = request(o);
    if (!req) return undefined;
    const seq = ++reqSeq.current;
    setChecking(true);
    try {
      const p = await api().catalogPreview(req);
      if (seq !== reqSeq.current) return undefined;
      setPreview(p);
      setPreviewKey(keyOf(o));
      setPreviewError(undefined);
      lastPreviewError.current = undefined;
      setValues((v) => {
        const next = { ...v };
        for (const inp of p.inputs) if (next[inp.name] === undefined && inp.default !== undefined) next[inp.name] = inp.default;
        return next;
      });
      return p;
    } catch (e) {
      if (seq === reqSeq.current) {
        setPreviewError(errText(e));
        lastPreviewError.current = errText(e);
      }
      return undefined;
    } finally {
      if (seq === reqSeq.current) setChecking(false);
    }
  };

  // preview on open and whenever an option changes (debounced after the first)
  const optsKey = JSON.stringify(opts);
  /** An option changed and its preview has not come back yet. */
  const stale = !!preview && previewKey !== keyOf(opts);
  useEffect(() => {
    if (!id || mode === 'update' || id.startsWith('routine:')) return;
    if (target?.seed && (target.seed.kind === 'routine' || target.seed.install.type === 'routine')) return;
    const first = firstPreview.current;
    firstPreview.current = false;
    const t = setTimeout(() => void runPreview(opts), first ? 0 : 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode, optsKey, cwd]);

  const steps = progressSteps(preview, spec, recipe?.testCount);
  useEffect(() => {
    if (phase !== 'installing') return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, steps.length - 1)), 1400);
    return () => clearInterval(t);
  }, [phase, steps.length]);

  const secretSaved = (inp: CatalogInput) => !!(inp.secret && inp.secretKey && savedSecrets?.includes(inp.secretKey));
  const inputs = preview?.inputs ?? item?.inputs ?? [];
  const emptyRequired = inputs.filter((i) => i.required && !values[i.name]?.trim() && !secretSaved(i)).map((i) => i.name);

  const focusInput = (name: string) => {
    const el = document.getElementById(`disc-in-${name}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  };

  const install = async (enable: boolean, saveOnFail = false) => {
    if (!item) return;
    if (emptyRequired.length) {
      setMissing(emptyRequired);
      setNotice(`Fill in ${inputs.filter((i) => emptyRequired.includes(i.name)).map((i) => i.label.toLowerCase()).join(' and ')} first.`);
      focusInput(emptyRequired[0]);
      return;
    }
    setMissing([]);
    setNotice(undefined);
    setFailure(undefined);
    setPhase('installing');
    try {
      // A plan is valid for 10 minutes and the hub uses it up on the first try. Make a new one
      // when it is close to running out, when it was already sent, or when an option changed since.
      let plan = preview;
      if (!plan || stale || plan.planId === usedPlan.current || plan.expiresAt - Date.now() < 30_000) plan = await runPreview(opts);
      if (!plan) throw new Error(lastPreviewError.current ?? 'Could not prepare the install.');
      // a plan made again at a newer commit is not what the sheet showed: show it before adding
      if (preview?.sha && plan.sha !== preview.sha) {
        setPhase('idle');
        setNotice(`It moved to ${shortSha(plan.sha)} since you opened it. Look it over and press Add again.`);
        return;
      }
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v.trim()) vals[k] = v.trim();
      usedPlan.current = plan.planId;
      const r = await api().catalogInstall({
        planId: plan.planId,
        values: vals,
        ...(enable ? {} : { enable: false }),
        ...(saveOnFail ? { saveOnFail: true } : {}),
        ...(opts.sync && pickDevice ? { syncClis: { device: pickDevice, clis: ['codex', 'opencode'] } } : {}),
      });
      if (!r.ok) {
        setPhase('failed');
        const testErr = r.test && !r.test.ok ? (r.test.error ? errText(r.test.error) : 'The test connect failed.') : undefined;
        const bin = testErr && /not found in \$PATH:?\s*"?([^"\s]+)"?/i.exec(testErr)?.[1];
        const other = (preview?.variants.length ?? 0) > 1 ? ', or pick another way to run it above' : '';
        const text = bin ? `${bin} is not on ${hubName}. Install it${other}. Nothing was saved.` : testErr ? `The test connect failed: ${testErr} Nothing was saved.` : (r.warnings[0] ?? 'The install did not finish.');
        setFailure({ text, raw: JSON.stringify(r, null, 2), canSaveDisabled: !!r.test && !r.test.ok && item.kind === 'mcp' });
        return;
      }
      setResult(r);
      setEnabledNow(enable);
      setPhase('done');
      setInstalledNow(r.installed);
      onChanged(item.id, r.installed);
    } catch (e) {
      // 409 means two things: the plan ran out or the commit moved (check again), or the
      // thing it would add is already there (say so, and change nothing)
      if (e instanceof ApiError && e.status === 409) {
        const msg = errText(e);
        if (/expired|moved/i.test(msg)) {
          setPhase('idle');
          await runPreview(opts);
          setNotice(/moved/i.test(msg) ? `${msg.replace(/\s*Open it again\.?$/, '')} It was checked again at the new commit. Look it over and press Add again.` : 'The preview ran out, so it was made again. Look it over and press Add again.');
          return;
        }
        setPhase('failed');
        setFailure({ text: `${msg} Nothing was changed.` });
        return;
      }
      if (e instanceof ApiError && e.status === 400 && Array.isArray((e.body as { missing?: unknown })?.missing)) {
        // the hub checks the form before it uses the plan, so the same plan can be sent again
        usedPlan.current = undefined;
        const m = (e.body as { missing: string[] }).missing;
        setPhase('idle');
        setMissing(m);
        setNotice(`Fill in ${inputs.filter((i) => m.includes(i.name)).map((i) => i.label.toLowerCase()).join(' and ') || m.join(', ')} first.`);
        if (m[0]) focusInput(m[0]);
        return;
      }
      setPhase('failed');
      setFailure({ text: errText(e), raw: rawError(e) });
    }
  };

  const doUpdate = async () => {
    if (!item?.installed || !update) return;
    setUpdateState('updating');
    setFailure(undefined);
    try {
      const r = await api().catalogUpdate(item.installed.id, update.planId);
      setUpdateState('done');
      setInstalledNow({ ...item.installed, sha: r.sha, version: r.version });
      onChanged(item.id, { ...item.installed, sha: r.sha, version: r.version });
    } catch (e) {
      setUpdateState('idle');
      setFailure({ text: errText(e), raw: rawError(e) });
    }
  };

  const rollback = async () => {
    if (!item?.installed) return;
    try {
      const r = await api().catalogRollback(item.installed.id);
      setUpdateState('rolled-back');
      setInstalledNow({ ...item.installed, sha: r.sha, version: r.version });
      onChanged(item.id, { ...item.installed, sha: r.sha, version: r.version });
    } catch (e) {
      setFailure({ text: errText(e), raw: rawError(e) });
    }
  };

  const remove = async (secrets: boolean) => {
    if (!item?.installed) return;
    try {
      await api().catalogRemove(item.installed.id, secrets ? { secrets: true } : {});
      setInstalledNow(null);
      setResult(undefined);
      setPhase('idle');
      onChanged(item.id, null);
      void runPreview(opts);
    } catch (e) {
      setFailure({ text: `Could not remove it: ${errText(e)}`, raw: rawError(e) });
    }
  };

  const go = (href: string) => {
    onClose();
    navigate(href);
  };

  // "Install on the hub" ran: the card list hears it, and the preview checks the needs and steps again
  const setupDone = (ready: CatalogItemDto['ready']) => {
    if (!item) return;
    onReady?.(item.id, ready);
    void runPreview(opts);
  };

  if (!target) return <DiscoverSheet open={false} onClose={onClose} title="">{null}</DiscoverSheet>;

  const title = item?.name ?? 'Loading';
  const url = item ? repoUrl(item) : undefined;
  const sub = item ? (
    <>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="link text-fg-3 hover:text-fg">
          {item.repo ?? url.replace(/^https?:\/\//, '')}
        </a>
      ) : null}
      {url ? ', ' : ''}
      {KIND_WORD[item.kind]}, {categoryWord(item.category)}
    </>
  ) : undefined;
  const size = phone ? 'touch' : 'md';
  const installed = item?.installed;
  const tab = item ? KIND_TAB[item.kind] : undefined;
  const openHref = result?.installed.href ?? installed?.href ?? tab?.href;
  const openLabel = result?.next.find((n) => n.href === openHref)?.label ?? (tab ? `Open in ${tab.label}` : 'Open');

  // ----- footer -----
  let footer: ReactNode;
  if (!item) footer = null;
  else if (mode === 'update' && installed) {
    footer =
      updateState === 'done' || updateState === 'rolled-back' ? (
        <FooterRow
          status={updateState === 'done' ? <>Updated to {shortSha(update?.to)}.</> : <>Rolled back to {shortSha(update?.from)}.</>}
          actions={
            <>
              {updateState === 'done' && (
                <Button variant="quiet" size={size} onClick={() => void rollback()}>
                  Roll back
                </Button>
              )}
              <Button variant="solid" size={size} onClick={() => go(installed.href)}>
                {openLabel}
              </Button>
            </>
          }
        />
      ) : (
        <FooterRow
          status={failure ? failure.text : update?.needsReview ? <span className="text-warn">Hooks, MCP servers or scripts changed. Read the changes first.</span> : undefined}
          actions={
            <>
              <Button variant="quiet" size={size} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="solid" size={size} disabled={!update || updateState !== 'idle'} busy={updateState === 'updating' ? 'Updating' : updateState === 'checking' ? 'Checking' : false} onClick={() => void doUpdate()}>
                {update?.needsReview ? 'Update anyway' : 'Update'}
              </Button>
            </>
          }
        />
      );
  } else if (isRoutine) {
    const sid = spec?.type === 'routine' ? spec.suggestion : item.id.replace(/^routine:/, '');
    footer = (
      <FooterRow
        status={installed ? 'Added. A routine from this suggestion exists.' : 'Add opens the Routines tab, where you pick the device and the schedule.'}
        actions={
          installed ? (
            <Button variant="solid" size={size} onClick={() => go(installed.href)}>
              Open in Routines
            </Button>
          ) : (
            <Button variant="solid" size={size} onClick={() => go(`/routines?suggest=${encodeURIComponent(sid)}`)}>
              Add
            </Button>
          )
        }
      />
    );
  } else if (isManual) {
    footer = (
      <FooterRow
        status="Nothing to add in one click. Follow the steps above."
        actions={
          url ? (
            <a href={url} target="_blank" rel="noreferrer" className={cn('inline-flex items-center justify-center rounded-[var(--r-1)] border border-solid bg-solid px-3 font-medium text-solid-fg', phone ? 'h-11 text-[15px]' : 'h-[30px] text-[13px]')}>
              Open on GitHub
            </a>
          ) : null
        }
      />
    );
  } else if (phase === 'done' && result) {
    const extra = result.next.filter((n) => n.href !== openHref);
    footer = (
      <FooterRow
        status={
          <>
            <span className="text-fg">{doneWords(result, preview, enabledNow)}</span>
            {extra.map((n) => (
              <span key={n.href}>
                {' '}
                <button type="button" onClick={() => go(n.href)} className="link text-fg-2 hover:text-fg">
                  {n.label}
                </button>
              </span>
            ))}
          </>
        }
        actions={
          <>
            <Button variant="quiet" size={size} onClick={onClose}>
              Close
            </Button>
            {openHref && (
              <Button variant="solid" size={size} onClick={() => go(openHref)}>
                {openLabel}
              </Button>
            )}
          </>
        }
      />
    );
  } else if (installed && phase !== 'installing') {
    footer = (
      <FooterRow
        status={<>Added{installed.sha ? ` at ${shortSha(installed.sha)}` : ''}{installed.matchedBy === 'name' ? '. Found by name, so Discover does not track updates for it.' : '.'}</>}
        actions={
          <>
            {installed.matchedBy === 'record' && (
              <Button variant="danger" size={size} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            )}
            <Button variant="solid" size={size} onClick={() => go(installed.href)}>
              {openLabel}
            </Button>
          </>
        }
      />
    );
  } else {
    const busy = phase === 'installing';
    // only MCP servers and plugins keep an off switch; skills, commands, agents and hook recipes load as soon as they are written
    const canDisable = spec?.type === 'mcp' || spec?.type === 'plugin';
    footer = (
      <FooterRow
        status={
          busy ? (
            <span className="text-signal" aria-live="polite">
              {steps[step]}
            </span>
          ) : phase === 'failed' && failure ? (
            <>
              <span className="text-fault">Failed.</span> {failure.text}
            </>
          ) : notice ? (
            <span className="text-warn">{notice}</span>
          ) : (checking || stale) && preview ? (
            'Checking again'
          ) : !preview && !previewError ? (
            <span className="text-fg-3">{spec?.type === 'mcp' ? 'Building the config' : spec?.type === 'hook' ? 'Checking the recipe' : 'Reading the repo at its commit'}</span>
          ) : undefined
        }
        actions={
          <>
            {failure?.canSaveDisabled && phase === 'failed' ? (
              <Button variant="outline" size={size} onClick={() => void install(false, true)}>
                Save disabled
              </Button>
            ) : canDisable ? (
              <Button variant="quiet" size={size} disabled={busy || !preview || checking || stale} onClick={() => void install(false)}>
                Add disabled
              </Button>
            ) : null}
            <Button variant="solid" size={size} busy={busy ? 'Adding' : false} disabled={!preview || checking || stale} onClick={() => void install(true)}>
              {phase === 'failed' ? 'Try again' : 'Add'}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <>
      <DiscoverSheet open={!!target} onClose={onClose} title={title} sub={sub} footer={footer} label={item ? `${item.name}, ${KIND_WORD[item.kind]}` : 'Preview'}>
        {item ? (
          <Body
            item={item}
            detail={detail}
            preview={preview}
            previewError={previewError}
            mode={mode}
            spec={spec}
            opts={opts}
            setOpts={setOpts}
            values={values}
            setValues={setValues}
            missing={missing}
            secretSaved={secretSaved}
            hubName={hubName}
            readmeAll={readmeAll}
            setReadmeAll={setReadmeAll}
            filesAll={filesAll}
            setFilesAll={setFilesAll}
            recipe={recipe}
            cwd={cwd}
            devices={devices.map((d) => ({ id: d.id, name: d.name, online: d.online }))}
            device={pickDevice}
            deviceName={deviceName}
            result={phase === 'done' ? result : undefined}
            failure={phase === 'failed' || mode === 'update' ? failure : undefined}
            update={mode === 'update' ? update : undefined}
            updateState={updateState}
            onRemoveFailed={() => setRemoving(true)}
            isRoutine={isRoutine}
            onSetupReady={setupDone}
          />
        ) : previewError ? (
          <p className="m-0 text-[14px] text-fg-2">
            <span className="text-fault">Failed.</span> {previewError}
          </p>
        ) : (
          <p className="m-0 text-[14px] text-fg-3">Loading</p>
        )}
      </DiscoverSheet>
      <RemoveDialog open={removing} item={item} onClose={() => setRemoving(false)} onConfirm={remove} />
    </>
  );
}

function FooterRow({ status, actions }: { status?: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {status && <div className="min-w-0 flex-1 basis-[220px] text-[13px] leading-[1.45] text-fg-2 phone:basis-full phone:text-[14px]">{status}</div>}
      <div className="flex shrink-0 items-center gap-2 phone:w-full phone:justify-end">{actions}</div>
    </div>
  );
}

function RemoveDialog({ open, item, onClose, onConfirm }: { open: boolean; item?: CatalogItemDto; onClose: () => void; onConfirm: (secrets: boolean) => Promise<void> }) {
  const [secrets, setSecrets] = useState(false);
  const hasSecrets = !!item?.inputs?.some((i) => i.secret);
  useEffect(() => setSecrets(false), [open]);
  const what: Record<string, string> = {
    mcp: 'It removes the server from config.json.',
    plugin: 'It removes the plugin folder and its hooks.',
    skill: 'It deletes only the files Discover wrote.',
    subagent: 'It deletes only the files Discover wrote.',
    command: 'It deletes only the files Discover wrote.',
    hook: 'It removes the handlers tagged with this recipe, and the script when nothing else uses it.',
  };
  return (
    <ConfirmDialog open={open} onClose={onClose} onConfirm={() => onConfirm(secrets)} title={item ? `Remove ${item.name}?` : 'Remove?'} body={item ? what[item.kind] : undefined} confirm="Remove" busy="Removing">
      {hasSecrets && (
        <Checkbox
          className="mt-3"
          checked={secrets}
          onChange={setSecrets}
          label="Also delete its secrets"
          description="Leave this off when another server uses the same token."
        />
      )}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function Body(p: {
  item: CatalogItemDto;
  detail?: CatalogDetail;
  preview?: InstallPreview;
  previewError?: string;
  mode: SheetMode;
  spec?: InstallSpec;
  opts: Opts;
  setOpts: (fn: (o: Opts) => Opts) => void;
  values: Record<string, string>;
  setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void;
  missing: string[];
  secretSaved: (i: CatalogInput) => boolean;
  hubName: string;
  readmeAll: boolean;
  setReadmeAll: (v: boolean) => void;
  filesAll: boolean;
  setFilesAll: (v: boolean) => void;
  recipe?: HookRecipeDto;
  cwd?: string;
  devices: Array<{ id: string; name: string; online: boolean }>;
  device?: string;
  deviceName: (id?: string) => string;
  result?: CatalogInstallResult;
  failure?: { text: string; raw?: string };
  update?: UpdatePreview;
  updateState: string;
  onRemoveFailed: () => void;
  isRoutine: boolean;
  onSetupReady: (ready: CatalogItemDto['ready']) => void;
}) {
  const { item, detail, preview, spec, opts, setOpts } = p;
  const license = preview?.license ?? item.license;
  const osi = preview?.licenseOsi ?? licenseOpen(license);
  const sha = preview?.sha;
  // routines carry their cron in the tags
  const cron = item.kind === 'routine' ? item.tags.find((t) => /^(@|[\d*])/.test(t) && (t.startsWith('@') || t.trim().split(/\s+/).length === 5)) : undefined;
  const head = [
    item.stars !== undefined ? `${starsWords(item.stars)}${item.starsLive || !item.starsAt ? '' : ` as of ${dayWords(item.starsAt)}`}` : null,
    license ? (
      <>
        {license}
        {osi === false && <span className="text-warn">, not open source</span>}
      </>
    ) : null,
    sha ? (preview?.shaFrom === 'head' ? `Latest commit ${shortSha(sha)}` : `Pinned to ${shortSha(sha)}`) : null,
    cron ? describeSchedule(cron) : null,
  ].filter(Boolean) as ReactNode[];
  const readme = detail?.readme ? cleanReadme(detail.readme) : '';
  const showReadme = p.mode === 'detail' && readme.length > 0;
  const variants = preview?.variants ?? [];
  const pluginSpec = spec?.type === 'plugin' ? (spec as PluginInstall) : undefined;
  const mcpSpec = spec?.type === 'mcp' ? spec : undefined;
  const hookKind = item.kind === 'hook';
  const isSkill = spec?.type === 'files' && spec.files.some((f) => f.to.startsWith('skills/'));
  // the Options block shows only when one of its controls does
  const showPluginPick = !!pluginSpec && (preview?.plugins?.length ?? pluginSpec.plugins.length) > 1;
  const showHooksSwitch = !!pluginSpec && !!(item.hooks?.length || preview?.hooks.length);
  const showSync = isSkill && p.devices.length > 0;
  const kinds = liveKinds(detail, preview);
  const steps = preview?.steps ?? (spec?.type === 'manual' ? spec.steps : spec?.type === 'mcp' ? (spec.setup ?? []) : []);
  // "Install on the hub": per step, and in the Needs block when no step already offers it
  const stepFixes = steps.map((s) => stepFix(s, p.hubName, p.deviceName(p.device)));
  const needsFix = preview && !stepFixes.some((f) => f?.kind === 'run') ? cardFix(preview.item) : null;
  const warnings = preview?.warnings ?? (item.warnings ?? []).map((text) => ({ level: 'warn' as const, text }));
  // what runs and what loads first, so the eight rows shown before "Show all" are the ones to read
  const files = useMemo(() => sortFiles(preview?.files ?? []), [preview?.files]);
  const shownFiles = files.slice(0, p.filesAll ? FILES_MAX : 8);
  const fileDir = files.length > 1 ? commonDir(files.map((f) => f.path)) : '';
  const touch = useIsMobile();
  const needs = preview?.needs ?? (item.needs ?? []).map((n) => ({ ...n, found: null, checkedOn: '' }));
  const hooks: PreviewHook[] = preview?.hooks ?? item.hooks ?? [];
  const touches = touchWords(preview?.touches ?? item.touches);
  const targets = (p.recipe?.targets ?? ['conclave']).filter((t) => t !== 'conclave') as Array<'claude-code' | 'codex' | 'gemini'>;
  const CLI: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
  const failedTests = p.result?.recipeTests?.filter((t) => !t.ok) ?? [];

  return (
    <div className="pb-2">
      {/* 1. Title block */}
      {head.length > 0 && (
        <p className="m-0 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">
          {head.map((h, i) => (
            <span key={i}>
              {h}
              {i < head.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      )}
      <p className="m-0 mt-2 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{item.description}</p>
      {(item.fit || item.risk) && (
        <dl className="m-0 mt-3 space-y-1.5 text-[13px] leading-[1.45] phone:text-[14px]">
          {item.fit && (
            <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3">
              <dt className="text-fg-3">Fits</dt>
              <dd className="m-0 text-fg-2">{item.fit}</dd>
            </div>
          )}
          {item.risk && (
            <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3">
              <dt className="text-fg-3">Risk</dt>
              <dd className="m-0 text-fg-2">{item.risk}</dd>
            </div>
          )}
        </dl>
      )}

      {/* result details: what the install said, failed tests, raw error */}
      {(p.result?.warnings.length ?? 0) > 0 && (
        <Block title="From the install">
          {p.result!.warnings.map((w, i) => (
            <WarningLine key={i} level={/fail|could not|cannot|error/i.test(w) ? 'warn' : 'info'} text={w} />
          ))}
        </Block>
      )}
      {failedTests.length > 0 && (
        <Block title="Tests that failed" right={<button type="button" onClick={p.onRemoveFailed} className="link text-fg-3 hover:text-fg">Remove</button>}>
          {failedTests.map((t) => (
            <div key={t.name} className="border-b border-rule py-2 text-[13px] leading-[1.45] last:border-b-0 phone:text-[14px]">
              <span className="text-fault">{t.name}</span>
              {t.why && <span className="text-fg-2">. {t.why}</span>}
            </div>
          ))}
        </Block>
      )}
      {p.failure?.raw && (
        <details className="mt-5">
          <summary className="cursor-pointer text-[13px] text-fg-3 hover:text-fg phone:text-[14px]">Show the error</summary>
          <CodeBlock code={p.failure.raw} copy className="mt-2" wrap maxLines={16} />
        </details>
      )}

      {/* update: what changed */}
      {p.update && (
        <Block title={`Changes from ${shortSha(p.update.from)} to ${shortSha(p.update.to)}`} right={plural(p.update.changes.length, 'file')}>
          {p.update.changes.length === 0 && <p className="m-0 py-2 text-[13px] text-fg-3">No file it installs changed.</p>}
          {p.update.changes.map((c) => (
            <div key={c.path} className="border-b border-rule py-2 last:border-b-0">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{c.path}</span>
                <span className={cn('shrink-0 text-[12px] phone:text-[13px]', c.executable ? 'text-warn' : 'text-fg-3')}>
                  {c.change}
                  {c.executable ? ', runs code' : ''}
                </span>
              </div>
              {c.diff && <CodeBlock code={c.diff} lang="diff" copy={false} maxLines={12} className="mt-2" />}
            </div>
          ))}
          {p.update.warnings.map((w, i) => (
            <WarningLine key={i} level={w.level} text={w.text} />
          ))}
        </Block>
      )}

      {/* README head on a row click */}
      {showReadme && (
        <Block title="README">
          <div className={cn('mt-3 overflow-hidden', !p.readmeAll && 'max-h-[260px]')}>
            <Markdown text={readme} className="text-[14px]" />
          </div>
          {!p.readmeAll && (
            <button type="button" onClick={() => p.setReadmeAll(true)} className="tap mt-2 text-[13px] text-fg-3 hover:text-fg phone:text-[14px]">
              Show the whole README head
            </button>
          )}
        </Block>
      )}

      {p.isRoutine && (
        <Block title="How it is added">
          <p className="m-0 mt-2.5 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            Routines are added in the Routines tab. Its Add sheet picks the device, shows the schedule, the commands it may run without asking and the prompt, and creates the agent it needs when you do not have it yet.
          </p>
        </Block>
      )}

      {p.mode !== 'update' && !p.isRoutine && (
        <>
          {p.previewError && (
            <p className="m-0 mt-5 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
              <span className="text-fault">Failed.</span> {p.previewError}
              {item.repo ? (
                <>
                  {' '}
                  <a className="link" href={`https://github.com/${item.repo}`} target="_blank" rel="noreferrer">
                    Open on GitHub
                  </a>
                </>
              ) : null}
            </p>
          )}

          {/* kind pick for live results that match several kinds */}
          {kinds.length > 1 && (
            <Block title="Add it as">
              <div className="mt-3">
                <Segmented
                  size={touch ? 'touch' : 'md'}
                  label="Kind"
                  value={opts.kind ?? (preview && kinds.includes(preview.item.kind) ? preview.item.kind : kinds[0])}
                  onChange={(k) => setOpts((o) => ({ ...o, kind: k as CatalogKind }))}
                  options={kinds.map((k) => ({ value: k, label: KIND_WORD[k] }))}
                />
              </div>
            </Block>
          )}

          {/* 2. How to run it */}
          {variants.length > 1 && (
            <Block title="How to run it">
              <div className="mt-3">
                {variants.reduce((n, v) => n + v.label.length, 0) <= 44 ? (
                  <Segmented size={touch ? 'touch' : 'md'} label="How to run it" value={String(opts.variant)} onChange={(v) => setOpts((o) => ({ ...o, variant: Number(v), toolPreset: undefined, plugins: undefined }))} options={variants.map((v) => ({ value: String(v.index), label: v.label }))} />
                ) : (
                  variants.map((v) => (
                    <Radio key={v.index} name="variant" checked={opts.variant === v.index} onChange={() => setOpts((o) => ({ ...o, variant: v.index, toolPreset: undefined, plugins: undefined }))} label={v.label} />
                  ))
                )}
              </div>
            </Block>
          )}

          {/* 3. Before you add */}
          {steps.length > 0 && (
            <Block title="Before you add">
              <ol className="m-0 mt-1 list-none p-0">
                {steps.map((s, i) => (
                  <li key={i} className="border-b border-rule py-2.5 last:border-b-0">
                    <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                      {s.say}
                      {s.on && <span className="text-fg-3"> On {s.on === 'hub' ? p.hubName : 'the device'}.</span>}
                    </p>
                    {s.run && <Command command={s.run} copy className="mt-2" />}
                    {stepFixes[i] && <HubFixLine fix={stepFixes[i]!} itemId={item.id} itemName={item.name} hubName={p.hubName} onReady={p.onSetupReady} className="mt-2" />}
                  </li>
                ))}
              </ol>
            </Block>
          )}

          {/* 4. Fill in */}
          {(preview?.inputs ?? item.inputs ?? []).length > 0 && (
            <Block title="Fill in">
              <div className="mt-3 space-y-4">
                {(preview?.inputs ?? item.inputs ?? []).map((inp) => {
                  const saved = p.secretSaved(inp);
                  const bad = p.missing.includes(inp.name);
                  const help = (
                    <>
                      {inp.description}
                      {inp.secret && inp.secretKey && (
                        <>
                          {' '}
                          {saved ? (
                            <>
                              A value is saved as <span className="mono">{inp.secretKey}</span>. Leave it empty to keep it.
                            </>
                          ) : (
                            <>
                              Saved in the hub's secrets store as <span className="mono">{inp.secretKey}</span>.
                            </>
                          )}
                        </>
                      )}
                    </>
                  );
                  return (
                    <Field key={inp.name} htmlFor={`disc-in-${inp.name}`} label={inp.label} optional={!inp.required} help={help} error={bad ? `${inp.label} is needed. ${inp.description}` : undefined}>
                      <Input
                        type={inp.secret ? 'password' : 'text'}
                        mono={inp.secret || /url|path|host|dir/i.test(inp.name)}
                        autoComplete={inp.secret ? 'new-password' : 'off'}
                        value={p.values[inp.name] ?? ''}
                        placeholder={saved ? 'Saved' : inp.example}
                        onChange={(e) => {
                          const v = e.target.value;
                          p.setValues((x) => ({ ...x, [inp.name]: v }));
                        }}
                      />
                    </Field>
                  );
                })}
              </div>
            </Block>
          )}

          {/* 5. Options */}
          {(showPluginPick || showHooksSwitch || (mcpSpec?.toolPresets?.length ?? 0) > 0 || hookKind || showSync) && (
            <Block title="Options">
              <div className="mt-3 space-y-5">
                {showPluginPick && pluginSpec && (
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">Plugins</div>
                    {(preview?.plugins ?? pluginSpec.plugins.map((source) => ({ source, name: source.split('@')[0], description: undefined, selected: true }))).map((pl) => {
                      const all = pluginSpec.plugins;
                      const on = opts.plugins ? opts.plugins.includes(pl.source) : pl.selected;
                      return (
                        <Checkbox
                          key={pl.source}
                          checked={on}
                          label={pl.name}
                          description={pl.description}
                          onChange={(v) =>
                            setOpts((o) => {
                              const cur = o.plugins ?? (preview?.plugins ? preview.plugins.filter((x) => x.selected).map((x) => x.source) : all);
                              const next = v ? [...new Set([...cur, pl.source])] : cur.filter((x) => x !== pl.source);
                              return { ...o, plugins: next.length ? next : cur };
                            })
                          }
                        />
                      );
                    })}
                  </div>
                )}
                {showHooksSwitch && pluginSpec ? (
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-fg phone:text-[14px]">Hooks</div>
                      <div className="text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">Off installs skills, commands and agents only.</div>
                    </div>
                    <Segmented
                      size={touch ? 'touch' : 'md'}
                      label="Hooks"
                      value={(opts.hooks ?? pluginSpec.hooks !== 'off') ? 'on' : 'off'}
                      onChange={(v) => setOpts((o) => ({ ...o, hooks: v === 'on' }))}
                      options={[
                        { value: 'on', label: 'On' },
                        { value: 'off', label: 'Off' },
                      ]}
                    />
                  </div>
                ) : null}
                {mcpSpec?.toolPresets && mcpSpec.toolPresets.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">Tools it exposes</div>
                    {mcpSpec.toolPresets.map((t) => (
                      <Radio
                        key={t.id}
                        name="preset"
                        checked={(opts.toolPreset ?? mcpSpec.toolPresets![0].id) === t.id}
                        onChange={() => setOpts((o) => ({ ...o, toolPreset: t.id }))}
                        label={t.label}
                        description={t.tools.length ? plural(t.tools.length, 'tool') : 'Every tool the server has'}
                      />
                    ))}
                  </div>
                )}
                {hookKind && (
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">Where it runs</div>
                    <Radio name="where" checked={opts.where === 'user'} onChange={() => setOpts((o) => ({ ...o, where: 'user' }))} label="This hub" description={`Every Conclave session on ${p.hubName}. Saved in config.json.`} />
                    <Radio
                      name="where"
                      disabled={!p.cwd}
                      checked={opts.where === 'project'}
                      onChange={() => setOpts((o) => ({ ...o, where: 'project' }))}
                      label="This project"
                      description={p.cwd ? <span className="mono">{p.cwd}/.conclave/settings.json</span> : 'Pick a project at the top of the page first.'}
                    />
                    {targets.map((t) => (
                      <Radio key={t} name="where" checked={opts.where === t} onChange={() => setOpts((o) => ({ ...o, where: t }))} label={`${CLI[t]} on ${p.deviceName(p.device)}`} description={`Writes the script and the handlers into ${CLI[t]}'s own settings on that device.`}>
                        <SelectMenu
                          look="field"
                          label="Device"
                          value={p.device ?? ''}
                          onChange={(d) => setOpts((o) => ({ ...o, device: d }))}
                          options={p.devices.map((d) => ({ value: d.id, label: d.name, text: d.name, hint: d.online ? undefined : 'offline' }))}
                          width={240}
                        />
                      </Radio>
                    ))}
                  </div>
                )}
                {showSync && (
                  <Checkbox
                    checked={opts.sync}
                    onChange={(v) => setOpts((o) => ({ ...o, sync: v }))}
                    label={`Also sync to Codex and OpenCode on ${p.deviceName(p.device)}`}
                    description="Copies the skill into their folders on that device after the install."
                  />
                )}
              </div>
            </Block>
          )}

          {/* 6. What it adds */}
          {(files.length > 0 || hooks.length > 0 || (preview?.mcpServers.length ?? 0) > 0 || (preview?.scripts.length ?? 0) > 0) && (
            <Block title="What it adds" right={preview && files.length ? `${plural(files.length, 'file')}, ${bytes(preview.totalBytes)}` : undefined}>
              {files.length > 0 && (
                <div className="mt-1">
                  {fileDir && (
                    <p className="m-0 border-b border-rule py-1.5 text-[12px] text-fg-3 phone:text-[13px]">
                      In <span className="mono">{underHome(fileDir)}</span>
                    </p>
                  )}
                  {shownFiles.map((f) => (
                    <div key={f.path} className="flex items-baseline gap-3 border-b border-rule py-1.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={underHome(f.path)}>
                        {f.path.slice(fileDir.length)}
                      </span>
                      {(ROLE_WORD[f.role] || f.executable || f.written) && (
                        <span className={cn('shrink-0 text-[12px] phone:hidden', f.executable ? 'text-fg-2' : 'text-fg-3')}>{[ROLE_WORD[f.role], f.written ? 'by Conclave' : '', f.executable ? 'runs' : ''].filter(Boolean).join(', ')}</span>
                      )}
                      <span className="num w-[64px] shrink-0 text-right text-[12px] text-fg-3 phone:text-[13px]">{bytes(f.bytes)}</span>
                    </div>
                  ))}
                  {files.length > 8 && !p.filesAll && (
                    <button type="button" onClick={() => p.setFilesAll(true)} className="tap mt-1.5 text-[13px] text-fg-3 hover:text-fg phone:text-[14px]">
                      {files.length > FILES_MAX ? `Show ${FILES_MAX} of ${files.length.toLocaleString('en')} files` : `Show all ${files.length} files`}
                    </button>
                  )}
                  {p.filesAll && files.length > FILES_MAX && (
                    <p className="m-0 pt-1.5 text-[12px] text-fg-3 phone:text-[13px]">{`${(files.length - FILES_MAX).toLocaleString('en')} more files are not listed. The repo on GitHub has them all.`}</p>
                  )}
                </div>
              )}
              {hooks.length > 0 && (
                <div className={cn(files.length > 0 && 'mt-4')}>
                  <div className="pb-1 text-[12px] font-medium text-fg-2 phone:text-[13px]">Hooks</div>
                  {hooks.map((h, i) => (
                    <div key={i} className="border-b border-rule py-2 last:border-b-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] phone:text-[14px]">
                        <span className="font-mono text-[12.5px] text-fg">{h.event}</span>
                        {h.matcher && <span className="font-mono text-[12.5px] text-fg-2">{h.matcher}</span>}
                        <span className="text-fg-3">
                          {[h.interpreter, h.timeout ? `${h.timeout} s` : null, h.plugin ?? null].filter(Boolean).join(', ')}
                        </span>
                        {h.network && <span className="text-warn">calls the network</span>}
                      </div>
                      {h.note && <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{h.note}</p>}
                      {h.command && <code className="mt-1 block font-mono text-[12px] leading-[1.5] break-all text-fg-2">{h.command.replace(/\/root\/|\/home\/[^/\s]+\//g, '~/')}</code>}
                    </div>
                  ))}
                </div>
              )}
              {preview?.mcpServers.map((s) => (
                <div key={s.name} className={cn((files.length > 0 || hooks.length > 0) && 'mt-4', 'pt-2')}>
                  <div className="pb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">
                    MCP server <span className="mono text-fg">{s.name}</span>
                  </div>
                  <CodeBlock code={JSON.stringify(s.config, null, 2)} lang="json" />
                </div>
              ))}
              {(preview?.scripts.length ?? 0) > 0 && (
                <div className="mt-4">
                  <div className="pb-1 text-[12px] font-medium text-fg-2 phone:text-[13px]">Scripts in it</div>
                  <p className="m-0 pb-1 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Nothing here runs during the install. Its hooks or the agent may run them later.</p>
                  {preview!.scripts.map((s) => (
                    <div key={s} className="truncate border-b border-rule py-1.5 font-mono text-[12.5px] text-fg last:border-b-0" title={s}>
                      {s.replace(/^\/root\/|^\/home\/[^/]+\//, '~/')}
                    </div>
                  ))}
                </div>
              )}
            </Block>
          )}

          {touches && (
            <p className="m-0 mt-4 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">Can touch: {touches}.</p>
          )}

          {/* 7. Warnings */}
          {(warnings.length > 0 || (preview?.scan?.findings.length ?? 0) > 0) && (
            <Block title="Warnings" right={warnings.length > 1 ? warnings.length : undefined}>
              <div className="mt-1">
                {warnings.map((w, i) => (
                  <WarningLine key={i} level={w.level} text={w.text} />
                ))}
                {preview?.scan?.findings.map((f, i) => (
                  <WarningLine key={`s${i}`} level={f.level} text={`${preview.scan!.tool}: ${f.text}`} file={`${f.file}${f.line ? `:${f.line}` : ''}`} />
                ))}
              </div>
            </Block>
          )}

          {/* 8. Needs */}
          {needs.length > 0 && (
            <Block title="Needs">
              {needs.map((n, i) => (
                <div key={`${n.bin}-${i}`} className="border-b border-rule py-2 last:border-b-0">
                  <div className="flex items-baseline gap-3 text-[13px] phone:text-[14px]">
                    <span className="font-mono text-[12.5px] text-fg">{n.bin}</span>
                    <span className="min-w-0 flex-1 text-fg-3">{whereWords(n.where, n.where === 'hub' ? p.hubName : undefined)}</span>
                    <span className={cn('shrink-0', n.found === true ? 'text-ok' : n.found === false ? 'text-warn' : 'text-fg-3')}>
                      {n.found === true ? 'found' : n.found === false ? `missing${n.checkedOn ? ` on ${n.checkedOn}` : ''}` : 'not checked'}
                    </span>
                  </div>
                  <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{n.why}</p>
                  {n.found === false && n.where !== 'hub' && (
                    <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Install it on {n.checkedOn || 'the device'}. The hub installs only on itself.</p>
                  )}
                </div>
              ))}
              {needsFix && <HubFixLine fix={needsFix} itemId={item.id} itemName={item.name} hubName={p.hubName} onReady={p.onSetupReady} className="mt-2.5" />}
            </Block>
          )}

          {/* 9. Equivalent */}
          {preview?.equivalent && (
            <Block title="Equivalent">
              <p className="m-0 mt-2.5 mb-2 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">The same change by hand.</p>
              <CodeBlock code={preview.equivalent} copy wrap={item.kind === 'mcp'} />
            </Block>
          )}
        </>
      )}
    </div>
  );
}

function WarningLine({ level, text, file }: { level: 'info' | 'warn' | 'risk'; text: string; file?: string }) {
  return (
    <p className={cn('m-0 border-b border-rule py-2 text-[13px] leading-[1.5] last:border-b-0 phone:text-[14px]', level === 'risk' ? 'text-fault' : level === 'warn' ? 'text-warn' : 'text-fg-2')}>
      {file && <span className="mono mr-1.5 text-fg-3">{file}</span>}
      {text}
    </p>
  );
}
