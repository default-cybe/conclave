/**
 * The root helper: the one way the hub gets something done as root
 * (docs/DESIGN.md, The root helper).
 *
 * The owner installs it once, as root: `conclave system-helper install`
 * writes ROOT_HELPER_PATH (root:root 0755) and a sudoers drop-in
 * (ROOT_HELPER_SUDOERS, 0440, checked with visudo) that lets the hub's user
 * run that file, with exactly the action names below, without a password.
 *
 * The helper takes one argument, an action name from a fixed list, and
 * nothing else: no package names, no paths, no options. What each action
 * runs is written into the file when it is installed, so a caller cannot
 * widen what runs as root. The only action today is browser-deps: apt-get
 * update, then the browser's libraries and fonts for the machine's Debian or
 * Ubuntu release (the whole list browser/packages.ts can name).
 *
 * Pure, with no node imports: the CLI writes the files, the hub reads them,
 * the web app shows the line.
 */
import { allBrowserPackages } from '../browser/packages';

export const ROOT_HELPER_PATH = '/usr/local/libexec/conclave-root-helper';
export const ROOT_HELPER_SUDOERS = '/etc/sudoers.d/conclave';
/** Bumped when the script changes; `conclave system-helper status` says when the installed one is older. */
export const ROOT_HELPER_VERSION = 1;
/** Every action the helper takes. Adding one means a new helper, which the owner installs again. */
export const ROOT_HELPER_ACTIONS = ['browser-deps'] as const;
export type RootHelperAction = (typeof ROOT_HELPER_ACTIONS)[number];
/** What Install system libraries says its one step does. */
export const BROWSER_DEPS_SAY =
  "Runs the root helper's browser-deps as root: apt-get update, then the libraries and fonts Chromium and CloakBrowser need on this Debian or Ubuntu release, from the list built into the helper. Nothing else.";

/** What syslog and the journal tag its lines with. */
export const ROOT_HELPER_TAG = 'conclave-root-helper';

/** Where the hub runs (system/host.ts finds it). */
export interface HubPlaceDto {
  /** lxc: a system container (Proxmox CT, Incus, LXD). container: Podman, nspawn and the like. bare: a machine of its own. */
  kind: 'lxc' | 'docker' | 'container' | 'vm' | 'bare';
  /** The Proxmox CT id, when the container's disk name gives it (subvol-100-disk-0, vm-100-disk-0). */
  ctid?: string;
  /** What systemd-detect-virt said: kvm, podman, systemd-nspawn. */
  virt?: string;
}

/** The root helper as the hub sees it (system/host.ts). */
export interface RootHelperDto {
  /** The helper file is there, root's, and takes the action asked about. */
  installed: boolean;
  /** The hub can run it now: sudo is there and lets the hub's user run it (or the hub is root). */
  ready: boolean;
  /** Why the helper cannot run. */
  problem?: string;
  /** The installed helper is older than this Conclave's. It still works; installing again updates it. */
  outdated?: boolean;
  /** The one-time command, as root on the hub's machine, that installs it (or updates it). */
  install: string;
  /** The hub runs as root: it runs the helper without sudo. */
  asRoot?: boolean;
}

/** The PATH the helper sets for itself, whatever its caller had. */
export const ROOT_HELPER_SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/** The line the hub runs for an action, and the owner confirms: through sudo, or straight when the hub is root. */
export function rootHelperLine(action: RootHelperAction, opts: { asRoot?: boolean; path?: string } = {}): string {
  const path = opts.path ?? ROOT_HELPER_PATH;
  return opts.asRoot ? `${path} ${action}` : `sudo ${path} ${action}`;
}

/**
 * A user name that sudoers reads as that one user: no spaces, quotes, commas
 * or colons, and a lower case start, since sudoers reads ALL and Defaults as
 * keywords and an upper case word as an alias.
 */
export function validUserName(name: string): boolean {
  return /^[a-z_][a-zA-Z0-9_.-]{0,31}$/.test(name);
}

/**
 * The sudoers drop-in: the hub's user may run the helper with each action
 * named, as root, with no password. Nothing else: sudo refuses any other
 * argument before the helper even starts.
 */
export function sudoersRule(user: string, opts: { path?: string } = {}): string {
  if (!validUserName(user)) throw new Error(`"${user}" is not a user name sudoers can take.`);
  const path = opts.path ?? ROOT_HELPER_PATH;
  return [
    `# Written by conclave system-helper install. Remove: conclave system-helper remove.`,
    `# ${user} (the Conclave hub) may run the root helper with these actions only, without a password.`,
    `${user} ALL=(root) NOPASSWD: ${ROOT_HELPER_ACTIONS.map((a) => `${path} ${a}`).join(', ')}`,
    '',
  ].join('\n');
}

export interface RootHelperScriptOptions {
  /** PATH inside the helper. Tests put a folder of stand-ins first. */
  path?: string;
  /** The os-release file it reads. */
  osRelease?: string;
}

/** The actions an installed helper says it takes (its "# actions:" line). */
export function helperActions(script: string): string[] {
  const m = /^# actions: (.*)$/m.exec(script);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

/** The version an installed helper says it is. */
export function helperVersion(script: string): number | undefined {
  const m = /^# version: (\d+)$/m.exec(script);
  return m ? Number(m[1]) : undefined;
}

/** One shell word, single quoted when it has anything a shell would read. */
function sq(s: string): string {
  return /^[\w.,=+@:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The helper, a POSIX sh script. It checks its argument before anything
 * else, reads no environment (it sets PATH, umask and the locale itself),
 * and does not source os-release (it reads two fields with sed).
 */
export function rootHelperScript(opts: RootHelperScriptOptions = {}): string {
  const path = opts.path ?? ROOT_HELPER_SAFE_PATH;
  const osRelease = opts.osRelease ?? '/etc/os-release';
  const classic = allBrowserPackages(false).join(' ');
  const t64 = allBrowserPackages(true).join(' ');
  const actions = ROOT_HELPER_ACTIONS.join(' ');
  return `#!/bin/sh
# ${ROOT_HELPER_TAG}: lets the Conclave hub do a few fixed things as root.
# version: ${ROOT_HELPER_VERSION}
# actions: ${actions}
#
# Written by \`conclave system-helper install\`. Do not edit: it is replaced
# when that runs again. Remove it with \`conclave system-helper remove\`
# (or delete this file and ${ROOT_HELPER_SUDOERS}).
#
# The hub's user may run it through sudo (${ROOT_HELPER_SUDOERS}). It takes
# exactly one argument, an action name from the list above, and nothing else.
# What each action runs is written below; nothing comes from the caller.
#
#   browser-deps  apt-get update, then the libraries and fonts Chromium and
#                 CloakBrowser need, for this Debian or Ubuntu release.
set -eu
PATH=${sq(path)}
export PATH
umask 022
LC_ALL=C
export LC_ALL
unset IFS || true

TAG=${ROOT_HELPER_TAG}
OS_RELEASE=${sq(osRelease)}

say() { printf '%s\\n' "$*"; }
note() {
  if command -v logger >/dev/null 2>&1; then logger -t "$TAG" -- "$*" 2>/dev/null || true; fi
}
refuse() {
  printf '%s: %s\\n' "$TAG" "$1" >&2
  note "refused: $1"
  exit 2
}

if [ "$#" -ne 1 ]; then refuse "takes exactly one action: ${actions}"; fi
case $1 in
  browser-deps) action=$1 ;;
  *) refuse "unknown action. It takes one of: ${actions}" ;;
esac

[ "$(id -u)" = 0 ] || refuse "runs as root only: sudo $0 $action"

# Who asked: sudo sets SUDO_USER itself. Only a plain name goes in the log.
by=root
case \${SUDO_USER:-} in
  '' | *[!A-Za-z0-9_.-]*) ;;
  *) by=$SUDO_USER ;;
esac

# One field of os-release, without running it.
os_field() {
  sed -n "s/^$1=//p" "$OS_RELEASE" | head -n 1 | sed "s/^[\\"']//; s/[\\"']\$//"
}

browser_deps() {
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-query >/dev/null 2>&1; then
    refuse "needs apt-get, so Debian or Ubuntu. This machine has none. Install the browser's libraries with its own package manager."
  fi
  [ -r "$OS_RELEASE" ] || refuse "cannot read $OS_RELEASE"
  os_id=$(os_field ID)
  os_version=$(os_field VERSION_ID)
  os_name=$(os_field PRETTY_NAME)
  major=\${os_version%%.*}
  # Debian 13 and Ubuntu 24.04 renamed some libraries with a t64 suffix.
  case $os_id in
    debian)
      case $major in
        '') t64=1 ;; # testing and unstable have no VERSION_ID; both are past 13
        *[!0-9]*) refuse "does not know Debian $os_version" ;;
        *) if [ "$major" -ge 13 ]; then t64=1; else t64=0; fi ;;
      esac
      ;;
    ubuntu)
      case $major in
        '' | *[!0-9]*) refuse "does not know Ubuntu $os_version" ;;
        *) if [ "$major" -ge 24 ]; then t64=1; else t64=0; fi ;;
      esac
      ;;
    *) refuse "knows the package names of Debian and Ubuntu only. This is \${os_name:-\${os_id:-an unknown system}}. Install the browser's libraries by hand." ;;
  esac
  if [ "$t64" = 1 ]; then
    packages='${t64}'
  else
    packages='${classic}'
  fi
  missing=''
  for p in $packages; do
    # shellcheck disable=SC2016
    if ! dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'ok installed'; then
      missing="$missing $p"
    fi
  done
  if [ -z "$missing" ]; then
    say "The browser's libraries and fonts are all installed."
    note "browser-deps for $by: nothing to install"
    return 0
  fi
  say "Installing for the browser on \${os_name:-$os_id $os_version}:$missing"
  note "browser-deps for $by on \${os_name:-$os_id $os_version}:$missing"
  DEBIAN_FRONTEND=noninteractive
  export DEBIAN_FRONTEND
  if ! apt-get -q -o DPkg::Lock::Timeout=300 update; then
    note "browser-deps for $by: apt-get update failed"
    say "apt-get update failed." >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  if ! apt-get -q -y -o DPkg::Lock::Timeout=300 install --no-install-recommends $missing; then
    note "browser-deps for $by: apt-get install failed"
    say "apt-get install failed." >&2
    exit 1
  fi
  note "browser-deps for $by: installed"
  say "Done."
}

case $action in
  browser-deps) browser_deps ;;
esac
`;
}
