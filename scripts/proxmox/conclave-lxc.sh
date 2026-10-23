#!/bin/sh
# Conclave hub in a Proxmox VE container (CT). Run it on the Proxmox host.
#
#   sh conclave-lxc.sh [options]               make a CT and install the hub
#   sh conclave-lxc.sh update <ctid> [options] update the hub in that CT
#   sh conclave-lxc.sh --dry-run ...           print the commands, change nothing
#
# It makes an unprivileged Debian CT with pveam and pct create, starts it,
# pushes scripts/lxc/setup.sh into it with pct push and runs it with pct exec.
# sh conclave-lxc.sh --help lists the options.
set -eu

usage() {
  cat <<'EOF'
Usage: sh conclave-lxc.sh [options]               make a CT and install the hub
       sh conclave-lxc.sh update <ctid> [options] update the hub in that CT

Run it as root on the Proxmox VE host. Each option can also be set as the
environment variable after it.

The container:
  --id N                CT_ID. Default: the next free id (pvesh get /cluster/nextid).
  --hostname NAME       CT_HOSTNAME. Default: conclave.
  --cores N             CT_CORES. Default: 2.
  --memory MB           CT_MEMORY. Default: 4096.
  --swap MB             CT_SWAP. Default: 512.
  --disk GB             CT_DISK. Default: 16.
  --storage NAME        CT_STORAGE. Storage for the disk. Default: local-lvm,
                        or another that holds containers (pvesm status).
  --template-storage S  CT_TEMPLATE_STORAGE. Storage for templates. Default: local.
  --debian 12|13        CT_DEBIAN. Default: the host's own Debian version.
  --bridge NAME         CT_BRIDGE. Default: vmbr0.
  --vlan N              CT_VLAN. VLAN tag. Default: none.
  --ip dhcp|CIDR        CT_IP. Default: dhcp. Static: 192.168.1.50/24.
  --gw IP               CT_GW. Gateway, with a static --ip.
  --ssh-key FILE        CT_SSH_KEY. Public key for root in the CT.
  --projects DIR        CT_PROJECTS. A folder on this host to bind mount at
                        /home/conclave/projects in the CT.
  --no-onboot           CT_ONBOOT=0. Do not start the CT when the host boots.

The hub (passed to setup.sh; update keeps the last choices when left out):
  --from auto|release|git, --version TAG, --repo OWNER/NAME, --repo-url URL,
  --ref NAME, --port N  See scripts/lxc/setup.sh --help.
  --source-dir DIR      A Conclave checkout on this host: copied into the CT and
                        installed from there (no GitHub access needed).
  --root-helper, --no-root-helper
                        CT_ROOT_HELPER=1 or 0. Install the root helper in the
                        CT, so the hub can add the system packages it needs
                        (such as the browser's libraries) by itself.
                        Default: ask, yes.
  --browser-libs, --no-browser-libs
                        CT_BROWSER_LIBS=1 or 0. Install the browser's system
                        libraries and fonts in the CT now, about 150 MB.
                        Default: ask, no.

  --dry-run             Print the commands that change something instead of
                        running them. Queries (next id, templates, storages)
                        still run.
  -h, --help            Show this.
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'conclave-lxc: %s\n' "$*" >&2; }
die() {
  printf 'conclave-lxc: %s\n' "$*" >&2
  exit 1
}
need() { [ "$1" -gt 0 ] || die "$2 needs a value. See --help."; }
has() { command -v "$1" >/dev/null 2>&1; }
# Shell quoting, for printed commands and the setup.sh arguments.
q() {
  case $1 in
    '' | *[!A-Za-z0-9_./:=,@%+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}
show() {
  line='+'
  for a in "$@"; do line="$line $(q "$a")"; done
  printf '%s\n' "$line"
}
# A command that changes something: printed, and run unless --dry-run.
run() {
  show "$@"
  if [ "$dry" = 0 ]; then "$@"; fi
}
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

cmd=create
ctid=''
dry=0
setup_args=''
source_dir=${CONCLAVE_SOURCE_DIR:-}
repo=${REPO:-default-cybe/conclave}
o_id=${CT_ID:-} o_hostname=${CT_HOSTNAME:-conclave} o_cores=${CT_CORES:-2}
o_memory=${CT_MEMORY:-4096} o_swap=${CT_SWAP:-512} o_disk=${CT_DISK:-16}
o_storage=${CT_STORAGE:-} o_tstorage=${CT_TEMPLATE_STORAGE:-local} o_debian=${CT_DEBIAN:-}
o_bridge=${CT_BRIDGE:-vmbr0} o_vlan=${CT_VLAN:-} o_ip=${CT_IP:-dhcp} o_gw=${CT_GW:-}
o_sshkey=${CT_SSH_KEY:-} o_projects=${CT_PROJECTS:-} o_onboot=${CT_ONBOOT:-1}
o_helper=${CT_ROOT_HELPER:-} o_libs=${CT_BROWSER_LIBS:-}

if [ $# -gt 0 ] && [ "$1" = update ]; then
  cmd=update
  shift
  case ${1:-} in '' | -*) die "update needs a CT id: conclave-lxc.sh update <ctid>" ;; esac
  ctid=$1
  shift
elif [ $# -gt 0 ] && [ "$1" = create ]; then
  shift
fi

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
    --id) need $# "$arg"; o_id=$1; shift ;;
    --hostname) need $# "$arg"; o_hostname=$1; shift ;;
    --cores) need $# "$arg"; o_cores=$1; shift ;;
    --memory) need $# "$arg"; o_memory=$1; shift ;;
    --swap) need $# "$arg"; o_swap=$1; shift ;;
    --disk) need $# "$arg"; o_disk=$1; shift ;;
    --storage) need $# "$arg"; o_storage=$1; shift ;;
    --template-storage) need $# "$arg"; o_tstorage=$1; shift ;;
    --debian) need $# "$arg"; o_debian=$1; shift ;;
    --bridge) need $# "$arg"; o_bridge=$1; shift ;;
    --vlan) need $# "$arg"; o_vlan=$1; shift ;;
    --ip) need $# "$arg"; o_ip=$1; shift ;;
    --gw) need $# "$arg"; o_gw=$1; shift ;;
    --ssh-key) need $# "$arg"; o_sshkey=$1; shift ;;
    --projects) need $# "$arg"; o_projects=$1; shift ;;
    --no-onboot) o_onboot=0 ;;
    --root-helper) o_helper=1 ;;
    --no-root-helper) o_helper=0 ;;
    --browser-libs) o_libs=1 ;;
    --no-browser-libs) o_libs=0 ;;
    --source-dir) need $# "$arg"; source_dir=$1; shift ;;
    --repo)
      need $# "$arg"
      repo=$1
      setup_args="$setup_args $arg $(q "$1")"
      shift
      ;;
    --from | --version | --repo-url | --ref | --port)
      need $# "$arg"
      setup_args="$setup_args $arg $(q "$1")"
      shift
      ;;
    --dry-run) dry=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $arg. See --help." ;;
  esac
done

for n in "$o_cores" "$o_memory" "$o_swap" "$o_disk" ${o_id:+"$o_id"} ${o_vlan:+"$o_vlan"} ${ctid:+"$ctid"}; do
  case $n in '' | *[!0-9]*) die "not a number: $n" ;; esac
done
case $o_onboot in 0 | 1) ;; *) die "CT_ONBOOT takes 0 or 1" ;; esac
case $o_helper in '' | 0 | 1) ;; *) die "CT_ROOT_HELPER takes 1 or 0" ;; esac
case $o_libs in '' | 0 | 1) ;; *) die "CT_BROWSER_LIBS takes 1 or 0" ;; esac
case $o_ip in
  dhcp) ;;
  */*) [ -n "$o_gw" ] || warn "a static --ip without --gw gives the CT no default route" ;;
  *) die "--ip takes dhcp or an address with its prefix, such as 192.168.1.50/24" ;;
esac
if [ -n "$o_sshkey" ] && [ ! -f "$o_sshkey" ]; then die "no such key file: $o_sshkey"; fi
for t in pct pveam pvesh; do
  has "$t" || die "$t is missing. Run this on a Proxmox VE host."
done
if [ "$dry" = 0 ] && [ "$(id -u)" != 0 ]; then die "run this as root on the Proxmox host"; fi

# A new CT asks here, on this terminal (setup.sh in the CT may have none).
# An update asks nothing: setup.sh keeps the CT's last answers.
if [ "$cmd" = create ] && [ "$dry" = 0 ]; then
  if [ -z "$o_helper" ]; then
    if ask "Install the root helper in the CT, so the hub can add the system packages it needs (such as the browser's libraries) by itself?" y; then o_helper=1; else o_helper=0; fi
  fi
  if [ -z "$o_libs" ]; then
    if ask "Install the browser's system libraries and fonts in the CT now (about 150 MB)?" n; then o_libs=1; else o_libs=0; fi
  fi
fi
case $o_helper in 1) setup_args="$setup_args --root-helper" ;; 0) setup_args="$setup_args --no-root-helper" ;; esac
case $o_libs in 1) setup_args="$setup_args --browser-libs" ;; 0) setup_args="$setup_args --no-browser-libs" ;; esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

# setup.sh and install.sh: from this checkout, else from GitHub.
scripts=$(cd "$(dirname "$0")/.." && pwd)
setup_sh=$scripts/lxc/setup.sh
install_sh=$scripts/install.sh
if [ ! -f "$setup_sh" ] || [ ! -f "$install_sh" ]; then
  setup_sh=$tmp/setup.sh
  install_sh=$tmp/install.sh
  # the copies attached to the latest release, never main's unreleased ones
  run curl -fsSL -o "$setup_sh" "https://github.com/$repo/releases/latest/download/setup.sh"
  run curl -fsSL -o "$install_sh" "https://github.com/$repo/releases/latest/download/install.sh"
fi
if [ -n "$source_dir" ]; then
  [ -f "$source_dir/packages/cli/src/index.ts" ] || die "$source_dir is not a Conclave checkout"
fi

# Wait until a CT that just started has network (DHCP can take a few seconds).
wait_network() {
  # shellcheck disable=SC2016
  run pct exec "$1" -- sh -c 'i=0; until getent hosts github.com >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || exit 1; sleep 2; done' ||
    die "CT $1 has no network after a minute. Check its network, then: sh $0 update $1"
}

# Push the scripts (and a source checkout) into the CT, then run setup.sh.
install_hub() {
  id=$1
  run pct exec "$id" -- mkdir -p /root/conclave-setup
  run pct push "$id" "$setup_sh" /root/conclave-setup/setup.sh --perms 755
  run pct push "$id" "$install_sh" /root/conclave-setup/install.sh --perms 755
  if [ -n "$source_dir" ]; then
    run tar -C "$source_dir" -czf "$tmp/conclave-src.tar.gz" \
      --exclude=node_modules --exclude=.git --exclude=dist --exclude=target --exclude=out \
      --exclude=.conclave-dev --exclude=coverage --exclude=.claude --exclude='*.tsbuildinfo' \
      --exclude=./packages/desktop/src-tauri/gen --exclude=./packages/desktop/src-tauri/binaries \
      --exclude=./packages/mobile/android --exclude=./packages/mobile/ios .
    run pct push "$id" "$tmp/conclave-src.tar.gz" /root/conclave-setup/src.tar.gz
    run pct exec "$id" -- sh -c 'rm -rf /root/conclave-src && mkdir -p /root/conclave-src && tar -xzf /root/conclave-setup/src.tar.gz -C /root/conclave-src && rm /root/conclave-setup/src.tar.gz'
    setup_args="$setup_args --source-dir /root/conclave-src"
  fi
  eval "set -- $setup_args"
  run pct exec "$id" -- sh /root/conclave-setup/setup.sh "$@"
}

if [ "$cmd" = update ]; then
  pct status "$ctid" >"$tmp/status" 2>&1 || die "no CT $ctid here"
  if ! grep -q running "$tmp/status"; then
    run pct start "$ctid"
    wait_network "$ctid"
  fi
  install_hub "$ctid"
  say ""
  if [ "$dry" = 1 ]; then say "Dry run. Nothing was changed."; else say "Updated the hub in CT $ctid."; fi
  exit 0
fi

# The id.
if [ -z "$o_id" ]; then
  o_id=$(pvesh get /cluster/nextid)
  case $o_id in '' | *[!0-9]*) die "pvesh get /cluster/nextid gave no id" ;; esac
fi
if pct status "$o_id" >/dev/null 2>&1; then die "CT $o_id exists already. Pick another --id."; fi

# The template: the newest Debian standard one, downloaded when missing.
if [ -z "$o_debian" ]; then
  o_debian=$(cut -d . -f 1 /etc/debian_version 2>/dev/null || true)
  case $o_debian in 12 | 13) ;; *) o_debian=12 ;; esac
fi
case $o_debian in 12 | 13) ;; *) die "--debian takes 12 or 13" ;; esac
pattern="^debian-$o_debian-standard_"
template=$(pveam list "$o_tstorage" 2>/dev/null | awk 'NR > 1 { sub(/.*vztmpl\//, "", $1); print $1 }' | grep "$pattern" | sort -V | tail -n 1 || true)
if [ -z "$template" ]; then
  run pveam update
  template=$(pveam available --section system | awk '{ print $2 }' | grep "$pattern" | sort -V | tail -n 1 || true)
  [ -n "$template" ] || die "pveam has no Debian $o_debian standard template"
  run pveam download "$o_tstorage" "$template"
fi
say "Template: $o_tstorage:vztmpl/$template"

# The storage for the disk.
if [ -z "$o_storage" ]; then
  o_storage=local-lvm
  if has pvesm; then
    active=$(pvesm status --content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }' || true)
    if [ -n "$active" ] && ! printf '%s\n' "$active" | grep -qx local-lvm; then
      if printf '%s\n' "$active" | grep -qx local-zfs; then o_storage=local-zfs; else o_storage=$(printf '%s\n' "$active" | head -n 1); fi
    fi
  fi
fi

net0="name=eth0,bridge=$o_bridge,ip=$o_ip"
if [ -n "$o_gw" ]; then net0="$net0,gw=$o_gw"; fi
if [ -n "$o_vlan" ]; then net0="$net0,tag=$o_vlan"; fi

set -- pct create "$o_id" "$o_tstorage:vztmpl/$template" \
  --hostname "$o_hostname" --cores "$o_cores" --memory "$o_memory" --swap "$o_swap" \
  --rootfs "$o_storage:$o_disk" --net0 "$net0" \
  --unprivileged 1 --features nesting=1 --onboot "$o_onboot" \
  --ostype debian --timezone host --tags conclave \
  --description "Conclave hub. Update: conclave-lxc.sh update $o_id"
if [ -n "$o_sshkey" ]; then set -- "$@" --ssh-public-keys "$o_sshkey"; fi

if [ -n "$o_projects" ]; then
  set -- "$@" --mp0 "$o_projects,mp=/home/conclave/projects"
  say "Projects: $o_projects on this host is /home/conclave/projects in the CT."
  say "The CT is unprivileged, so uid N inside is uid 100000+N here. The"
  say "conclave user is uid 1000 inside, so it reads and writes the folder as"
  say "uid 101000 on this host."
  if [ -d "$o_projects" ]; then
    say "The folder exists, so it is left as it is. To let the hub write to it:"
    say "  chown -R 101000:101000 $(q "$o_projects")"
    say "To keep your own uid on the files instead, map it into the CT"
    say "(docs/INSTALL.md, Proxmox LXC)."
  else
    run mkdir -p "$o_projects"
    run chown 101000:101000 "$o_projects"
  fi
fi

run "$@"
run pct start "$o_id"
wait_network "$o_id"
install_hub "$o_id"

say ""
if [ "$dry" = 1 ]; then
  say "Dry run. Nothing was changed."
  exit 0
fi
say "CT $o_id ($o_hostname) runs the Conclave hub."
say "  Shell in the CT   pct enter $o_id   (or the CT's Console in the Proxmox web UI)"
say "  First run         pct exec $o_id -- conclave remote"
say "  Update later      sh $0 update $o_id"
if [ "$o_helper" = 1 ]; then
  say "  Root helper       in the CT: the hub adds the system packages it needs by itself"
else
  say "  Root helper       not installed. Later, from this shell: pct exec $o_id -- conclave system-helper install"
fi
say "Commands for the hub run inside the CT, not on this host: pct exec $o_id -- <command>."
