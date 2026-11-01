/**
 * "Install on the hub" in Discover: what the hub may run on itself to put a
 * missing program in place, and in what order (docs/EXTENSIONS.md, Discover).
 *
 * The rules:
 * - Only user-level installs, run as the hub's own user, never with sudo:
 *   uv and uvx from astral's install script, Python CLIs with
 *   `uv tool install`, and the `on: 'hub'` setup steps of items that ship
 *   with Conclave.
 * - Programs that need root (docker, Chrome, system packages) are never
 *   installed from here. The owner gets the Debian command to run by hand.
 * - Commands come from this file and from the shipped list only. Steps from
 *   GitHub search or the MCP registry are text from the internet: shown with
 *   copy, never run.
 * - Prerequisites first: uv before `uv tool install ...`, then the step.
 *
 * Pure, with no node imports, so the web app's mock can plan with it too.
 * The catalog service checks the programs and runs the commands.
 */
import type { CatalogItem, CatalogNeed, InstallSpec, SetupStep } from './recommended';

/**
 * uv's release, pinned. The script is that release's own uv-installer.sh, the
 * same script https://astral.sh/uv/install.sh serves for the latest release,
 * so the version is fixed and the download is GitHub's. Checked 2026-10-22:
 * the file answers 200 and says APP_VERSION="0.12.24" (0.12.24 came out on
 * 2026-10-08, the last of 0.12). It installs to $XDG_BIN_HOME, else
 * ~/.local/bin, and UV_NO_MODIFY_PATH=1 keeps it out of shell profiles.
 */
export const UV_VERSION = '0.12.24';
export const UV_INSTALLER_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.sh`;

/** A user-level installer the hub may run for a missing program. */
export interface HubInstaller {
  /** Programs it puts in ~/.local/bin. */
  gives: string[];
  /** Programs it needs first. The hub never installs these itself (curl needs root). */
  needs: string[];
  say: string;
  run: string;
}

const UV: HubInstaller = {
  gives: ['uv', 'uvx'],
  needs: ['curl'],
  say: `Installs uv ${UV_VERSION} and uvx into ~/.local/bin with astral's install script from the uv release. It does not change shell profiles.`,
  run: `curl -LsSf ${UV_INSTALLER_URL} | env UV_NO_MODIFY_PATH=1 sh`,
};

/** The fixed table: user-level installers by the program they give. Nothing else is installed this way. */
export const HUB_INSTALLERS: Readonly<Record<string, HubInstaller>> = { uv: UV, uvx: UV };

/** Programs that need root, with the Debian package that has them. */
const APT: Readonly<Record<string, string>> = {
  docker: 'docker.io',
  curl: 'curl',
  wget: 'wget',
  git: 'git',
  jq: 'jq',
  bash: 'bash',
  grep: 'grep',
  sed: 'sed',
  tar: 'tar',
  unzip: 'unzip',
  python3: 'python3',
  pip3: 'python3-pip',
  node: 'nodejs',
  npm: 'npm',
  npx: 'npm',
  rg: 'ripgrep',
  r2: 'radare2',
  r2pm: 'radare2',
  radare2: 'radare2',
  chromium: 'chromium',
  sqlite3: 'sqlite3',
  make: 'make',
  gcc: 'gcc',
  ssh: 'openssh-client',
  rsync: 'rsync',
};

const CHROME_DEB = 'google-chrome-stable_current_amd64.deb';

/** The command to run by hand, as root, on Debian or Ubuntu. undefined when Conclave knows none. */
export function rootCommand(bin: string): string | undefined {
  // Chrome is not in Debian's archive: Google's own package
  if (bin === 'google-chrome' || bin === 'google-chrome-stable') return `curl -LO https://dl.google.com/linux/direct/${CHROME_DEB} && sudo apt-get install -y ./${CHROME_DEB}`;
  const pkg = APT[bin];
  return pkg ? `sudo apt-get install -y ${pkg}` : undefined;
}

/** Single quotes when the text has anything a shell would read. */
function quote(s: string): string {
  return /^[\w.,=+@:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `uv tool install <pkg>` for a need that names its Python package. */
export function uvToolCommand(pkg: string): string {
  return `uv tool install ${quote(pkg)}`;
}

/** The program a command starts, after VAR=value words and `env`. */
export function firstProgram(run: string): string | undefined {
  const words = run.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (words[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  const w = words[i];
  return w && /^[\w.+-]+$/.test(w) ? w : undefined;
}

/** What "Install on the hub" works on: one setup step, one missing need, or every missing need on the hub. */
export type HubSetupTarget = { step: number; variant: number } | { bin: string } | { missing: true };

export interface HubSetupCommand {
  say: string;
  run: string;
}

/** A missing program the hub does not install itself. */
export interface HubByHand {
  bin: string;
  /** One line: why the hub cannot do it. */
  why: string;
  /** What to run by hand: the Debian command for root, or the user-level command for an item Conclave does not run. */
  run?: string;
  /** The command needs root. */
  root?: boolean;
}

/** Why nothing runs. The server answers 403 for not-shipped, 400 for a wrong step, 409 for the rest. */
export type HubSetupRefusal = 'not-shipped' | 'no-step' | 'device' | 'no-run' | 'sudo' | 'placeholder' | 'not-needed' | 'nothing' | 'os';

/** What "Install on the hub" would run, shown in the confirm before anything runs. */
export interface HubSetupOffer {
  target: HubSetupTarget;
  /** The account the commands run as, and its home, the working folder. */
  user: string;
  home: string;
  /** In order: installers first, then `uv tool install`, then the step. Empty when nothing can run from here. */
  commands: HubSetupCommand[];
  /** Missing programs it leaves to the owner, each with why and what to run. */
  byHand: HubByHand[];
  /** Programs checked again after the run. */
  checks: string[];
  /** Set when commands is empty: the one line that says why. */
  why?: string;
  refusal?: HubSetupRefusal;
  /** A step whose programs are all on the hub already. It can still run again. */
  done?: boolean;
}

export interface HubFacts {
  /** The program is on the hub's PATH. */
  has(bin: string): boolean;
  user: string;
  home: string;
  /** process.platform of the hub. win32 runs nothing. */
  platform?: string;
}

const NOT_SHIPPED = 'Conclave runs setup only for items from its own list. These commands came from outside it, so copy them and run them yourself if you trust them.';

function stepsOf(spec: InstallSpec | undefined): SetupStep[] {
  if (!spec) return [];
  return spec.type === 'mcp' ? (spec.setup ?? []) : spec.type === 'manual' ? spec.steps : [];
}

/** Why a step cannot run on the hub, or undefined when it can. */
function stepRefusal(step: SetupStep | undefined): { refusal: HubSetupRefusal; why: string } | undefined {
  if (!step) return { refusal: 'no-step', why: 'There is no such step.' };
  if (!step.run?.trim()) return { refusal: 'no-run', why: 'Nothing to run: this step is for you to do.' };
  if (step.on !== 'hub') return { refusal: 'device', why: step.on === 'device' ? 'This step runs on the device, not on the hub. Run it there.' : 'This step does not say it runs on the hub.' };
  if (/(^|[\s;&|(])sudo(\s|$)/.test(step.run)) return { refusal: 'sudo', why: 'It asks for root, which Conclave never uses. Run it by hand.' };
  if (/<[^<>\n]+>|\{\{[^}]+\}\}/.test(step.run)) return { refusal: 'placeholder', why: 'It has a value to fill in first. Run it by hand.' };
  return undefined;
}

/** Every program an offer for this item may ask about, so the caller can check them first. */
export function hubSetupBins(item: CatalogItem): string[] {
  const out = new Set<string>();
  const add = (bin: string | undefined) => {
    if (!bin || out.has(bin)) return;
    out.add(bin);
    const inst = HUB_INSTALLERS[bin];
    if (inst) for (const b of [...inst.gives, ...inst.needs]) add(b);
  };
  for (const n of item.needs ?? []) {
    if (n.where !== 'hub') continue;
    add(n.bin);
    if (n.uvTool) add('uv');
  }
  for (const spec of [item.install, ...(item.variants ?? [])]) {
    for (const s of stepsOf(spec)) {
      if (s.on !== 'hub' || !s.run) continue;
      add(firstProgram(s.run));
      for (const g of s.gives ?? []) add(g);
    }
  }
  return [...out];
}

/**
 * The commands "Install on the hub" runs for one target, in order, and what
 * it leaves to the owner. `shipped` is true only for an item whose definition
 * ships with Conclave; anything else runs nothing.
 */
export function hubSetupOffer(item: CatalogItem, target: HubSetupTarget, facts: HubFacts, opts: { shipped: boolean }): HubSetupOffer {
  const specs = [item.install, ...(item.variants ?? [])];
  const commands: HubSetupCommand[] = [];
  const byHand: HubByHand[] = [];
  const checks = new Set<string>();
  const planned = new Set<string>();
  const have = (bin: string) => planned.has(bin) || facts.has(bin);
  const push = (c: HubSetupCommand) => {
    if (!commands.some((x) => x.run === c.run)) commands.push(c);
  };
  const hand = (h: HubByHand) => {
    if (!byHand.some((x) => x.bin === h.bin)) byHand.push(h);
  };
  const offer = (extra: Partial<HubSetupOffer> = {}): HubSetupOffer => ({
    target,
    user: facts.user,
    home: facts.home,
    commands,
    byHand,
    checks: [...checks],
    ...extra,
  });
  const refuse = (refusal: HubSetupRefusal, why: string): HubSetupOffer => {
    commands.length = 0;
    checks.clear();
    return offer({ refusal, why });
  };
  const stack = new Set<string>();

  /** A step of a shipped item that gives this program, the chosen way to run it first. */
  const givingStep = (bin: string): SetupStep | undefined => {
    for (const spec of specs) for (const s of stepsOf(spec)) if (s.gives?.includes(bin) && !stepRefusal(s)) return s;
    return undefined;
  };

  /** Plan a hub step: its first program, then the step. False when that program cannot be put in place. */
  const runStep = (step: SetupStep): boolean => {
    const run = step.run!;
    const pre = firstProgram(run);
    if (pre && !step.gives?.includes(pre) && !ensure(pre)) {
      for (const g of step.gives ?? []) hand({ bin: g, why: `Its setup step needs ${pre} first.`, run });
      return false;
    }
    push({ say: step.say, run });
    for (const g of step.gives ?? []) {
      planned.add(g);
      checks.add(g);
    }
    return true;
  };

  /** Put one program in place, or say why not. True when it is there or will be after the commands. */
  function ensure(bin: string, need?: CatalogNeed): boolean {
    if (have(bin)) return true;
    if (stack.has(bin)) return false;
    stack.add(bin);
    try {
      const inst = HUB_INSTALLERS[bin];
      if (inst) {
        for (const pre of inst.needs) {
          if (!ensure(pre)) {
            hand({ bin, why: `Its installer needs ${pre} first.`, run: inst.run });
            return false;
          }
        }
        push({ say: inst.say, run: inst.run });
        for (const g of inst.gives) {
          planned.add(g);
          checks.add(g);
        }
        return true;
      }
      if (need?.uvTool) {
        const run = uvToolCommand(need.uvTool);
        if (!ensure('uv')) {
          hand({ bin, why: 'It installs with uv, which the hub cannot install yet.', run });
          return false;
        }
        push({ say: `Installs ${need.uvTool} with uv into ~/.local/bin.`, run });
        planned.add(bin);
        checks.add(bin);
        return true;
      }
      const step = givingStep(bin);
      if (step) return runStep(step);
      const root = rootCommand(bin);
      hand(root ? { bin, why: `${bin} needs root to install. Install it on the server by hand.`, run: root, root: true } : { bin, why: `Conclave does not know how to install ${bin}. Install it on the hub by hand.` });
      return false;
    } finally {
      stack.delete(bin);
    }
  }

  // ----- refusals that hold whatever the target -----
  if (facts.platform === 'win32') return refuse('os', 'Install on the hub works on Linux and macOS hubs.');

  if ('step' in target) {
    const step = stepsOf(specs[target.variant])[target.step];
    const bad = stepRefusal(step);
    if (bad) return refuse(bad.refusal, bad.why);
    if (!opts.shipped) return refuse('not-shipped', NOT_SHIPPED);
    const done = !!step!.gives?.length && step!.gives.every((g) => facts.has(g));
    if (!runStep(step!)) return refuse('nothing', `It needs ${byHand.filter((h) => !step!.gives?.includes(h.bin)).map((h) => h.bin).join(' and ') || 'a program'} on the hub first.`);
    return offer(done ? { done } : {});
  }

  const hubNeeds = (item.needs ?? []).filter((n) => n.where === 'hub');
  let wanted: CatalogNeed[];
  if ('bin' in target) {
    const need = (item.needs ?? []).find((n) => n.bin === target.bin);
    if (!need) return refuse('not-needed', `This item does not need ${target.bin}.`);
    if (need.where !== 'hub') return refuse('device', `${need.bin} is needed ${need.where === 'every-device' ? 'on every device' : 'on the device'}. The hub installs only on itself.`);
    wanted = [need];
  } else wanted = hubNeeds;
  const missing = wanted.filter((n) => !facts.has(n.bin));
  if (!missing.length) return refuse('nothing', 'bin' in target ? `${target.bin} is already on the hub.` : 'Nothing is missing on the hub.');

  if (!opts.shipped) {
    // nothing runs, but the owner still gets the command to copy
    for (const n of missing) {
      const root = rootCommand(n.bin);
      const inst = HUB_INSTALLERS[n.bin];
      hand(root ? { bin: n.bin, why: `${n.bin} needs root to install. Install it on the server by hand.`, run: root, root: true } : { bin: n.bin, why: 'Install it on the hub by hand.', ...(inst ? { run: inst.run } : {}) });
    }
    return refuse('not-shipped', NOT_SHIPPED);
  }
  for (const n of missing) ensure(n.bin, n);
  if (!commands.length) {
    const roots = byHand.filter((h) => h.root).map((h) => h.bin);
    const rest = byHand.filter((h) => !h.root && !h.run).map((h) => h.bin);
    return refuse(
      'nothing',
      roots.length
        ? `${andList(roots)} ${roots.length > 1 ? 'need' : 'needs'} root to install, so install ${roots.length > 1 ? 'them' : 'it'} on the server by hand.`
        : `Conclave does not know how to install ${andList(rest.length ? rest : byHand.map((h) => h.bin))}. Install ${byHand.length > 1 ? 'them' : 'it'} on the hub by hand.`,
    );
  }
  return offer();
}

function andList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** True when the offer has something the button can run. */
export function canRunOnHub(offer: HubSetupOffer | undefined): offer is HubSetupOffer {
  return !!offer && offer.commands.length > 0 && !offer.refusal;
}

/** The last lines of a stream of output chunks, both streams in the order they came. */
export class TailLines {
  private lines: string[] = [];
  private partial = '';

  constructor(
    private readonly max = 200,
    private readonly lineMax = 2000,
  ) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk.replace(/\r\n/g, '\n')).split('\n');
    this.partial = parts.pop() ?? '';
    if (this.partial.length > this.lineMax * 4) this.partial = this.partial.slice(-this.lineMax * 4);
    for (const p of parts) this.add(p);
  }

  /** A whole line, such as "$ command". Ends any partial line first. */
  line(text: string): void {
    this.flush();
    this.add(text);
  }

  flush(): void {
    if (this.partial) this.add(this.partial);
    this.partial = '';
  }

  private add(line: string): void {
    // progress bars redraw with \r: keep what the line ended as
    const last = line.split('\r').filter(Boolean).pop() ?? '';
    this.lines.push(last.length > this.lineMax ? `${last.slice(0, this.lineMax)} ...` : last);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  text(): string {
    this.flush();
    return this.lines.join('\n');
  }
}
