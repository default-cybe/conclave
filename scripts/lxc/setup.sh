#!/bin/sh
# Conclave hub in a Linux system container or a VM, as a systemd service.
#
#   sh setup.sh [options]        as root, inside the container
#
# For Debian 12 or 13 and Ubuntu 24.04: a Proxmox CT, Incus, LXD, plain LXC or
# a VM. It installs the packages the hub needs, Bun, a conclave user, Conclave
# itself (a GitHub release when there is one, else the source) and a systemd
# unit, then starts the hub. It offers the root helper, so the hub can add the
# system packages it needs by itself, and the browser's libraries. Run it again
# to update in place. sh setup.sh --help lists the options.
set -eu

# Keep in step with the Dockerfile and the workflows.
BUN_VERSION=${BUN_VERSION:-1.4.2}

CODE=/opt/conclave
DATA=/var/lib/conclave
ETC=/etc/conclave
UNIT=conclave-hub
# nodejs and npm give npx, which starts the Claude Code and Codex adapters
PACKAGES="bash ca-certificates curl git jq ripgrep unzip nodejs npm"

usage() {
  cat <<'EOF'
Usage: sh setup.sh [options]     (as root, inside the container or VM)

Installs or updates the Conclave hub as a systemd service. A run with no
options keeps the choices of the last run.

Options (each can also be set as the environment variable after it):
  --from auto|release|git  CONCLAVE_FROM. auto (the default) installs a GitHub
                           release when one exists for this system, else the
                           source with git.
  --version TAG            CONCLAVE_VERSION. Release tag such as v0.2.0
                           (default: latest).
  --repo OWNER/NAME        REPO. GitHub repo (default: default-cybe/conclave).
  --repo-url URL           CONCLAVE_REPO_URL. Git URL to clone
                           (default: https://github.com/<repo>.git).
  --ref NAME               CONCLAVE_REF. Branch or tag to clone (default: main).
  --source-dir DIR         CONCLAVE_SOURCE_DIR. Install the source from this
                           checkout instead. It is copied.
  --port N                 CONCLAVE_PORT. Port of the hub (default: 7717).
  --uid N                  CONCLAVE_UID. uid and gid for a new conclave user
                           (default: 1000, when free).
  --projects DIR           CONCLAVE_PROJECTS. Projects folder
                           (default: /home/conclave/projects).
  --root-helper, --no-root-helper
                           CONCLAVE_ROOT_HELPER=1 or 0. Install the root helper
                           (conclave system-helper install), so the hub can add
                           the system packages it needs by itself, such as the
                           browser's libraries. Default: ask, yes.
  --browser-libs, --no-browser-libs
                           CONCLAVE_BROWSER_LIBS=1 or 0. Install the browser's
                           system libraries and fonts now, about 150 MB.
                           Default: ask, no. The hub can do it later.
  --no-systemd             Install the unit but do not enable or start it.
                           Only for tests in a container without systemd.
  -h, --help               Show this.

Where things go:
  /opt/conclave            code, owned by root, so the hub cannot change it
  /var/lib/conclave        hub data: config, secrets, database (CONCLAVE_HOME)
  /home/conclave           the conclave user's home: harness logins, git config
  /etc/conclave/env        environment for the hub, KEY=value lines
  /usr/local/libexec/conclave-root-helper, /etc/sudoers.d/conclave
                           the root helper, when it is installed
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'conclave setup: %s\n' "$*" >&2; }
die() {
  printf 'conclave setup: %s\n' "$*" >&2
  exit 1
}
need() { [ "$1" -gt 0 ] || die "$2 needs a value. See --help."; }
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
# Quote a value for the settings file, which this script reads back with "."
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# A yes or no question on the terminal; $2 (y or n) is the answer when there
# is no terminal or the answer is empty.
ask() {
  if [ -t 0 ] && [ -t 1 ]; then
    if [ "$2" = y ]; then printf '%s [Y/n] ' "$1"; else printf '%s [y/N] ' "$1"; fi
    answer=''
    read -r answer || true
    case $answer in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
  fi
  [ "$2" = y ]
}

opt_from='' opt_version='' opt_repo='' opt_repo_url='' opt_ref=''
opt_source_dir='' opt_port='' opt_uid='' opt_projects=''
opt_root_helper='' opt_browser_libs=''
systemd=1
while [ $# -gt 0 ]; do
  arg=$1
  shift
  case $arg in
    --*=*)
      set -- "${arg#*=}" "$@"
      arg=${arg%%=*}
      ;;
  esac
  case $arg in
    --from) need $# "$arg"; opt_from=$1; shift ;;
    --version) need $# "$arg"; opt_version=$1; shift ;;
    --repo) need $# "$arg"; opt_repo=$1; shift ;;
    --repo-url) need $# "$arg"; opt_repo_url=$1; shift ;;
    --ref) need $# "$arg"; opt_ref=$1; shift ;;
    --source-dir) need $# "$arg"; opt_source_dir=$1; shift ;;
    --port) need $# "$arg"; opt_port=$1; shift ;;
    --uid) need $# "$arg"; opt_uid=$1; shift ;;
    --projects) need $# "$arg"; opt_projects=$1; shift ;;
    --root-helper) opt_root_helper=1 ;;
    --no-root-helper) opt_root_helper=0 ;;
    --browser-libs) opt_browser_libs=1 ;;
    --no-browser-libs) opt_browser_libs=0 ;;
    --no-systemd) systemd=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $arg. See --help." ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run this as root"
# pct exec and incus exec may start this with no HOME.
HOME=${HOME:-/root}
export HOME

# Choices of the last run. Options and environment variables win over them.
saved_from='' saved_version='' saved_repo='' saved_repo_url='' saved_ref=''
saved_source_dir='' saved_port='' saved_projects='' saved_root_helper='' saved_browser_libs=''
if [ -f "$ETC/setup.conf" ]; then
  # shellcheck source=/dev/null
  . "$ETC/setup.conf"
fi

from_given=${opt_from:-${CONCLAVE_FROM:-}}
FROM=${from_given:-${saved_from:-auto}}
SOURCE_DIR=${opt_source_dir:-${CONCLAVE_SOURCE_DIR:-}}
# A new --from drops a saved source folder; otherwise it stays in use.
if [ -z "$SOURCE_DIR" ] && [ -z "$from_given" ]; then SOURCE_DIR=$saved_source_dir; fi
VERSION=${opt_version:-${CONCLAVE_VERSION:-${saved_version:-latest}}}
REPO=${opt_repo:-${REPO:-${saved_repo:-default-cybe/conclave}}}
REPO_URL_SET=${opt_repo_url:-${CONCLAVE_REPO_URL:-$saved_repo_url}}
REPO_URL=${REPO_URL_SET:-https://github.com/$REPO.git}
REF=${opt_ref:-${CONCLAVE_REF:-${saved_ref:-main}}}
PORT_SET=${opt_port:-${CONCLAVE_PORT:-$saved_port}}
PORT=${PORT_SET:-7717}
PROJECTS_SET=${opt_projects:-${CONCLAVE_PROJECTS:-$saved_projects}}
WANT_UID=${opt_uid:-${CONCLAVE_UID:-1000}}
ROOT_HELPER=${opt_root_helper:-${CONCLAVE_ROOT_HELPER:-$saved_root_helper}}
BROWSER_LIBS=${opt_browser_libs:-${CONCLAVE_BROWSER_LIBS:-$saved_browser_libs}}

case $FROM in auto | release | git) ;; *) die "--from takes auto, release or git, not $FROM" ;; esac
case $PORT in '' | *[!0-9]*) die "--port takes a number, not $PORT" ;; esac
case $WANT_UID in '' | *[!0-9]*) die "--uid takes a number, not $WANT_UID" ;; esac
case $ROOT_HELPER in '' | 0 | 1) ;; *) die "CONCLAVE_ROOT_HELPER takes 1 or 0, not $ROOT_HELPER" ;; esac
case $BROWSER_LIBS in '' | 0 | 1) ;; *) die "CONCLAVE_BROWSER_LIBS takes 1 or 0, not $BROWSER_LIBS" ;; esac

# The system.
[ -r /etc/os-release ] || die "cannot read /etc/os-release"
# In a subshell: the file sets VERSION and other names this script uses.
# shellcheck source=/dev/null
os_info=$(. /etc/os-release && printf '%s|%s|%s' "${ID:-}" "${VERSION_ID:-}" "${PRETTY_NAME:-}")
os_id=${os_info%%|*}
os_rest=${os_info#*|}
os_version=${os_rest%%|*}
os_name=${os_rest#*|}
os_name=${os_name:-$os_id $os_version}
case "$os_id:$os_version" in
  debian:12 | debian:13 | ubuntu:24.04) ;;
  *)
    command -v apt-get >/dev/null 2>&1 || die "needs Debian 12 or 13 or Ubuntu 24.04, found $os_name"
    warn "$os_name is not tested. Going on."
    ;;
esac
if [ "$systemd" = 1 ] && [ ! -d /run/systemd/system ]; then
  die "systemd is not running here. Use a system container or a VM with systemd."
fi
case $(uname -m) in
  x86_64 | amd64)
    release_arch=x64
    bun_arch=x64
    # Older x64 CPUs without AVX2 need Bun's baseline build.
    if [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then bun_arch=x64-baseline; fi
    ;;
  aarch64 | arm64)
    release_arch=arm64
    bun_arch=aarch64
    ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

say "Conclave setup on $os_name"

# Asked on the first run; later runs keep the answers (setup.conf).
if [ -z "$ROOT_HELPER" ]; then
  if ask "Install the root helper, so the hub can add the system packages it needs (such as the browser's libraries) by itself?" y; then ROOT_HELPER=1; else ROOT_HELPER=0; fi
fi
if [ -z "$BROWSER_LIBS" ]; then
  if ask "Install the browser's system libraries and fonts now (about 150 MB)?" n; then BROWSER_LIBS=1; else BROWSER_LIBS=0; fi
fi

step "Packages"
missing=''
for p in $PACKAGES; do
  # shellcheck disable=SC2016
  if ! dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed'; then
    missing="$missing $p"
  fi
done
if [ -n "$missing" ]; then
  say "Installing:$missing"
  export DEBIAN_FRONTEND=noninteractive
  # shellcheck disable=SC2086
  if ! { apt-get update -q && apt-get install -y -q --no-install-recommends $missing; } >"$tmp/apt.log" 2>&1; then
    cat "$tmp/apt.log" >&2
    die "apt-get failed"
  fi
  say "Done"
else
  say "Already installed: $PACKAGES"
fi
command -v runuser >/dev/null 2>&1 || die "runuser is missing (util-linux)"

step "Bun $BUN_VERSION"
if [ "$(/usr/local/bin/bun --version 2>/dev/null || true)" = "$BUN_VERSION" ]; then
  say "Already installed: /usr/local/bin/bun"
else
  zip=bun-linux-$bun_arch.zip
  base=https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION
  say "Downloading $zip"
  fetch "$base/$zip" "$tmp/$zip" || die "download failed: $base/$zip"
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "download failed: $base/SHASUMS256.txt"
  expected=$(awk -v f="$zip" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")
  actual=$(sha256sum "$tmp/$zip" | cut -d ' ' -f 1)
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    die "checksum mismatch for $zip (expected $expected, got $actual)"
  fi
  unzip -q -o "$tmp/$zip" -d "$tmp"
  install -m 755 "$tmp/bun-linux-$bun_arch/bun" /usr/local/bin/bun.new
  mv /usr/local/bin/bun.new /usr/local/bin/bun
  ln -sf bun /usr/local/bin/bunx
  say "Installed /usr/local/bin/bun $(/usr/local/bin/bun --version)"
fi

step "User conclave"
if id conclave >/dev/null 2>&1; then
  say "Already there: $(id conclave)"
else
  if getent passwd "$WANT_UID" >/dev/null || getent group "$WANT_UID" >/dev/null; then
    warn "uid or gid $WANT_UID is taken, so conclave gets a free one"
    groupadd --system conclave
    useradd --system --gid conclave --create-home --home-dir /home/conclave --shell /bin/bash conclave
  else
    # 1000 is past the system range; raise its top so useradd does not warn.
    top=999
    if [ "$WANT_UID" -gt "$top" ]; then top=$WANT_UID; fi
    groupadd --system -K SYS_GID_MAX="$top" --gid "$WANT_UID" conclave
    useradd --system -K SYS_UID_MAX="$top" --uid "$WANT_UID" --gid conclave --create-home --home-dir /home/conclave --shell /bin/bash conclave
  fi
  chmod 750 /home/conclave
  say "Made $(id conclave)"
fi
HOME_DIR=$(getent passwd conclave | cut -d : -f 6)
[ -n "$HOME_DIR" ] || die "the conclave user has no home folder"
mkdir -p "$HOME_DIR"
# A bind mount under home can make the folder before the user exists.
if [ "$(stat -c %U "$HOME_DIR")" != conclave ]; then
  chown conclave:conclave "$HOME_DIR"
  chmod 750 "$HOME_DIR"
fi
PROJECTS=${PROJECTS_SET:-$HOME_DIR/projects}
if [ ! -d "$PROJECTS" ]; then
  mkdir -p "$PROJECTS"
  chown conclave:conclave "$PROJECTS"
fi
if ! runuser -u conclave -- test -w "$PROJECTS"; then
  warn "the conclave user cannot write to $PROJECTS. For a bind mount, see the uid notes in docs/INSTALL.md."
fi
say "Home $HOME_DIR, projects $PROJECTS"

mkdir -p "$DATA" "$ETC" "$CODE/bin"
chown conclave:conclave "$DATA"
chmod 700 "$DATA"
if [ ! -f "$ETC/env" ]; then
  cat >"$ETC/env" <<'EOF'
# Environment for the Conclave hub, KEY=value lines. systemd reads it as root.
# Provider keys can go here (ANTHROPIC_API_KEY=...) or in the web app.
# After a change: systemctl restart conclave-hub
EOF
  chmod 600 "$ETC/env"
fi

step "Conclave"
release_base() {
  if [ "$VERSION" = latest ]; then
    printf 'https://github.com/%s/releases/latest/download\n' "$REPO"
  else
    printf 'https://github.com/%s/releases/download/%s\n' "$REPO" "$VERSION"
  fi
}

if [ -n "$SOURCE_DIR" ]; then
  mode=dir
elif [ "$FROM" = auto ]; then
  if curl -fsSL --retry 2 -o /dev/null "$(release_base)/conclave-linux-$release_arch.tar.gz.sha256" 2>/dev/null; then
    mode=release
  else
    say "No release of $REPO for linux-$release_arch ($VERSION). Installing from source."
    mode=git
  fi
else
  mode=$FROM
fi

if [ "$mode" = release ]; then
  # Reuse scripts/install.sh: next to this script, one folder up in a
  # checkout, or from GitHub.
  installer=''
  for f in "$here/install.sh" "$here/../install.sh"; do
    if [ -f "$f" ] && grep -q 'Conclave installer' "$f"; then
      installer=$f
      break
    fi
  done
  if [ -z "$installer" ]; then
    # the copy attached to the release, never main's unreleased one
    ref=latest/download
    if [ "$VERSION" != latest ]; then ref=download/$VERSION; fi
    fetch "https://github.com/$REPO/releases/$ref/install.sh" "$tmp/install.sh" || die "could not download install.sh from $REPO ($ref)"
    installer=$tmp/install.sh
  fi
  if ! HOME=/root REPO="$REPO" CONCLAVE_VERSION="$VERSION" CONCLAVE_INSTALL_DIR="$CODE/release" CONCLAVE_BIN_DIR="$CODE/bin" \
    sh "$installer" >"$tmp/install.log" 2>&1; then
    cat "$tmp/install.log" >&2
    die "installing the release failed"
  fi
  grep -E '^(Downloading|Checksum|Installed)' "$tmp/install.log" || true
  unit_src=$CODE/release/services/$UNIT.service
  installed="release $VERSION of $REPO"
else
  stage=$CODE/src.new
  rm -rf "$stage"
  if [ "$mode" = git ]; then
    say "Cloning $REPO_URL ($REF)"
    if ! GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$stage"; then
      die "git clone failed: $REPO_URL ($REF). For a private repo, copy a checkout in and use --source-dir."
    fi
    installed="source, $REF from $REPO_URL, commit $(git -C "$stage" rev-parse --short HEAD)"
  else
    [ -f "$SOURCE_DIR/packages/cli/src/index.ts" ] || die "$SOURCE_DIR is not a Conclave checkout"
    say "Copying $SOURCE_DIR"
    mkdir -p "$stage"
    tar -C "$SOURCE_DIR" -cf - \
      --exclude=node_modules --exclude=.git --exclude=dist --exclude=target --exclude=out \
      --exclude=.conclave-dev --exclude=coverage --exclude=.claude --exclude='*.tsbuildinfo' \
      --exclude=./packages/desktop/src-tauri/gen --exclude=./packages/desktop/src-tauri/binaries \
      --exclude=./packages/mobile/android --exclude=./packages/mobile/ios . |
      tar -C "$stage" --no-same-owner -xf -
    installed="source from $SOURCE_DIR"
  fi
  say "Installing dependencies"
  if ! (cd "$stage" && bun install --frozen-lockfile --filter @conclave/cli --filter @conclave/web) >"$tmp/deps.log" 2>&1; then
    tail -n 40 "$tmp/deps.log" >&2
    die "bun install failed"
  fi
  say "Building the web app"
  if ! (cd "$stage" && bun run --filter @conclave/web build) >"$tmp/web.log" 2>&1; then
    tail -n 40 "$tmp/web.log" >&2
    die "the web app did not build"
  fi
  [ -f "$stage/packages/web/dist/index.html" ] || die "the web build left no index.html"
  # Swap folders. The running hub keeps its files until the restart below.
  rm -rf "$CODE/src.old"
  if [ -d "$CODE/src" ]; then mv "$CODE/src" "$CODE/src.old"; fi
  mv "$stage" "$CODE/src"
  # In release mode this is a link to the binary: remove it, do not write through it.
  rm -f "$CODE/bin/conclave"
  printf '#!/bin/sh\nexec /usr/local/bin/bun %s/src/packages/cli/src/index.ts "$@"\n' "$CODE" >"$CODE/bin/conclave"
  chmod 755 "$CODE/bin/conclave"
  unit_src=$CODE/src/scripts/systemd/$UNIT.service
fi
version=$(runuser -u conclave -- "$CODE/bin/conclave" --version 2>/dev/null || echo unknown)
say "Conclave $version ($installed)"

# The root helper (docs/DESIGN.md, The root helper): one root-owned script
# with fixed actions, which the conclave user may run with sudo. A run again
# replaces it with this version's.
HELPER=/usr/local/libexec/conclave-root-helper
step "Root helper"
if [ "$ROOT_HELPER" = 1 ]; then
  if "$CODE/bin/conclave" system-helper install --user conclave >"$tmp/helper.log" 2>&1; then
    grep -E '^Wrote ' "$tmp/helper.log" || true
    say "The hub can add the system packages it needs, such as the browser's libraries, by itself."
  else
    cat "$tmp/helper.log" >&2
    warn "the root helper did not install. The hub works without it; Settings, Browser then shows the commands to run."
  fi
elif [ -e "$HELPER" ]; then
  say "Left as it is: $HELPER. To remove it: conclave system-helper remove"
else
  say "Skipped. To add it later, as root here: conclave system-helper install"
fi
if [ "$BROWSER_LIBS" = 1 ]; then
  step "Browser libraries"
  if "$CODE/bin/conclave" system-helper run browser-deps >"$tmp/libs.log" 2>&1; then
    tail -n 1 "$tmp/libs.log"
  else
    tail -n 20 "$tmp/libs.log" >&2
    warn "the browser's libraries did not install. Settings, Browser can install them later."
  fi
fi

step "Service"
# The conclave command for root and the conclave user. As root it runs as the
# conclave user, so whatever it writes stays readable for the hub.
{
  cat <<'EOF'
#!/bin/sh
# Conclave CLI for the hub on this machine. Written by setup.sh.
CONCLAVE_HOME=${CONCLAVE_HOME:-/var/lib/conclave}
export CONCLAVE_HOME
EOF
  if [ -n "$PORT_SET" ]; then
    # shellcheck disable=SC2016
    printf 'CONCLAVE_PORT=${CONCLAVE_PORT:-%s}\nexport CONCLAVE_PORT\n' "$PORT"
  fi
  cat <<'EOF'
if [ "$(id -u)" = 0 ]; then
  # system-helper writes root's own files, so it keeps root.
  case ${1:-} in system-helper) exec /opt/conclave/bin/conclave "$@" ;; esac
  # Stay in this folder when the conclave user may, else go to its home.
  exec runuser -u conclave -- sh -c 'cd "$1" 2>/dev/null || cd; shift; exec "$@"' sh "$PWD" /opt/conclave/bin/conclave "$@"
fi
exec /opt/conclave/bin/conclave "$@"
EOF
} >"$tmp/conclave"
install -m 755 "$tmp/conclave" /usr/local/bin/conclave

# The unit from scripts/systemd, run as a system service by the drop-in below.
[ -f "$unit_src" ] || die "missing $unit_src"
mkdir -p "/etc/systemd/system/$UNIT.service.d"
install -m 644 "$unit_src" "/etc/systemd/system/$UNIT.service"
{
  say "# Written by setup.sh (scripts/lxc/setup.sh), replaced when it runs again."
  say "# Your own changes go in another file here: systemctl edit $UNIT"
  say "[Unit]"
  say "Wants=network-online.target"
  say "After=network-online.target"
  say ""
  say "[Service]"
  say "User=conclave"
  say "Group=conclave"
  say "WorkingDirectory=$HOME_DIR"
  say "Environment=CONCLAVE_HOME=$DATA"
  if [ -n "$PORT_SET" ]; then say "Environment=CONCLAVE_PORT=$PORT"; fi
  say "Environment=PATH=$HOME_DIR/.local/bin:$HOME_DIR/.bun/bin:/usr/local/bin:/usr/bin:/bin"
  say "EnvironmentFile="
  say "EnvironmentFile=-$ETC/env"
  say "ExecStart="
  say "ExecStart=$CODE/bin/conclave serve"
} >"/etc/systemd/system/$UNIT.service.d/10-setup.conf"

# Updates from the app (docs/DESIGN.md, Updates). The hub cannot change
# /opt/conclave or restart its own system service. When the owner presses
# Update now, it checks the release and writes $DATA/updates/request.json;
# this path unit sees it and starts conclave-update.service as root, which
# checks the signature again with the key built into the installed conclave,
# swaps the release folder (keeping the old one as release.prev), restarts
# the hub and puts the old one back when the new one does not answer.
# A source install updates by running this script again, so it gets none.
if [ "$mode" = release ]; then
  mkdir -p "$DATA/updates"
  chown conclave:conclave "$DATA/updates"
  {
    say "# Written by setup.sh: starts the Conclave updater when the hub asks for an update."
    say "[Unit]"
    say "Description=Conclave update requests"
    say ""
    say "[Path]"
    say "PathExists=$DATA/updates/request.json"
    say "Unit=conclave-update.service"
    say ""
    say "[Install]"
    say "WantedBy=multi-user.target"
  } >/etc/systemd/system/conclave-update.path
  {
    say "# Written by setup.sh: checks a release the hub downloaded, swaps it in, restarts the hub."
    say "[Unit]"
    say "Description=Conclave updater"
    say ""
    say "[Service]"
    say "Type=oneshot"
    say "Environment=CONCLAVE_HOME=$DATA"
    say "ExecStart=$CODE/bin/conclave update finish"
    say "TimeoutStartSec=900"
  } >/etc/systemd/system/conclave-update.service
else
  if [ "$systemd" = 1 ]; then systemctl disable --now conclave-update.path >/dev/null 2>&1 || true; fi
  rm -f /etc/systemd/system/conclave-update.path /etc/systemd/system/conclave-update.service
fi

{
  say "# Choices of the last setup.sh run. It reads them when it runs again."
  say "saved_from=$(q "$FROM")"
  say "saved_version=$(q "$VERSION")"
  say "saved_repo=$(q "$REPO")"
  say "saved_repo_url=$(q "$REPO_URL_SET")"
  say "saved_ref=$(q "$REF")"
  say "saved_source_dir=$(q "$SOURCE_DIR")"
  say "saved_port=$(q "$PORT_SET")"
  say "saved_projects=$(q "$PROJECTS_SET")"
  say "saved_root_helper=$(q "$ROOT_HELPER")"
  say "saved_browser_libs=$(q "$BROWSER_LIBS")"
} >"$ETC/setup.conf"

if [ "$systemd" = 1 ]; then
  systemctl daemon-reload
  systemctl enable -q "$UNIT"
  systemctl add-wants multi-user.target "$UNIT.service" >/dev/null 2>&1 || true
  if [ "$mode" = release ]; then systemctl enable -q --now conclave-update.path; fi
  systemctl restart "$UNIT"
  tries=0
  until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      journalctl -u "$UNIT" -n 40 --no-pager >&2 || true
      die "the hub did not answer on port $PORT. Logs: journalctl -u $UNIT"
    fi
    sleep 1
  done
  say "Running, /api/health answers"
else
  say "Unit installed, not enabled or started (--no-systemd)"
fi
rm -rf "$CODE/src.old"
if [ "$mode" = release ]; then rm -rf "$CODE/src"; else rm -rf "$CODE/release"; fi

ip=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)
say ""
say "Conclave hub $version"
say "  Hub       http://${ip:-127.0.0.1}:$PORT"
say "  Logs      journalctl -u $UNIT -f"
say "  Code      $CODE"
say "  Data      $DATA"
say "  Home      $HOME_DIR"
say "  Projects  $PROJECTS"
say "  Settings  $ETC/env (KEY=value lines, then systemctl restart $UNIT)"
if [ -e "$HELPER" ]; then
  say "  Root      $HELPER (the hub may run it with sudo; remove: conclave system-helper remove)"
fi
if [ "$systemd" = 0 ]; then
  say ""
  say "Start the hub by hand: conclave serve"
fi
say ""
say "First run, as root in this container (on Proxmox: pct enter <id>):"
say "  conclave remote             the hub's address and a login link for your browser"
say "  conclave pair-phone         a pairing code and QR code for the apps"
say "  conclave password set       optional: a hub password, to log in without a code"
say "  conclave secret anthropic   optional: a provider key, or add one in the web app"
say "  conclave doctor             checks the install"
if [ "$mode" = release ]; then
  say "To update: Settings, About in the web app, or run this script again. It keeps the choices above."
else
  say "To update, run this script again. It keeps the choices above."
fi
