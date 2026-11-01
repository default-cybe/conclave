#!/bin/sh
# Conclave installer for Linux and macOS.
#
#   curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh
#
# Downloads the release for this OS and CPU, checks its SHA256, installs it to
# ~/.local/share/conclave and links ~/.local/bin/conclave. Run it again to update.
#
# Settings (environment variables):
#   REPO                  GitHub repo to install from (default default-cybe/conclave)
#   CONCLAVE_VERSION      release tag such as v0.2.0 (default: latest)
#   CONCLAVE_INSTALL_DIR  default ~/.local/share/conclave
#   CONCLAVE_BIN_DIR      default ~/.local/bin
set -eu

REPO="${REPO:-default-cybe/conclave}"
VERSION="${CONCLAVE_VERSION:-latest}"
INSTALL_DIR="${CONCLAVE_INSTALL_DIR:-$HOME/.local/share/conclave}"
BIN_DIR="${CONCLAVE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'conclave install: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

download() {
  if has curl; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "needs sha256sum or shasum to verify the download"
  fi
}

# Prints the release target, e.g. linux-x64 or darwin-arm64.
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported OS: $os. On Windows, download conclave-windows-x64.zip from https://github.com/$REPO/releases" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported CPU: $arch" ;;
  esac
  # A shell running under Rosetta on Apple silicon still gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  # Older x64 CPUs without AVX2 need Bun's baseline build.
  if [ "$os" = linux ] && [ "$arch" = x64 ] && [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then
    arch=x64-baseline
  fi
  printf '%s-%s\n' "$os" "$arch"
}

has tar || fail "needs tar"
[ -n "${HOME:-}" ] || fail "HOME is not set"

target=$(detect_target)
os_name=${target%%-*}
asset="conclave-$target.tar.gz"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
stage=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

say "Downloading $asset ($VERSION) from $REPO"
download "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
download "$base/$asset.sha256" "$tmp/$asset.sha256" || fail "download failed: $base/$asset.sha256"

expected=$(cut -d ' ' -f 1 <"$tmp/$asset.sha256")
actual=$(sha256_of "$tmp/$asset")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "checksum mismatch for $asset (expected $expected, got $actual)"
fi
say "Checksum OK"

# Unpack next to the install dir, then swap directories. A rename works even
# while an old hub or daemon is still running from the old copy.
parent=$(dirname "$INSTALL_DIR")
mkdir -p "$parent" "$BIN_DIR"
stage=$(mktemp -d "$parent/.conclave-install.XXXXXX")
tar -xzf "$tmp/$asset" -C "$stage"
new="$stage/conclave-$target"
[ -f "$new/conclave" ] || fail "archive does not contain conclave-$target/conclave"
chmod 755 "$new/conclave"

rm -rf "$INSTALL_DIR.old"
if [ -e "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$INSTALL_DIR.old"; fi
mv "$new" "$INSTALL_DIR"
rm -rf "$INSTALL_DIR.old"
ln -sf "$INSTALL_DIR/conclave" "$BIN_DIR/conclave"

installed=$("$INSTALL_DIR/conclave" --version 2>/dev/null || echo "$VERSION")
say ""
say "Installed Conclave $installed"
say "  files    $INSTALL_DIR"
say "  command  $BIN_DIR/conclave"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add this to your shell profile:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
say ""
say "Next steps"
say "  On the server (the hub):"
say "    conclave serve"
say "  On a PC or Mac without the desktop app, with a device code from the hub's Devices page:"
say "    conclave daemon pair https://your-hub.example <code>"
say "    conclave daemon install --start"
say "  With the desktop app, turn on \"Let the hub use this computer\" instead."
say "  Guide: https://conclave.dymnitguys.com"
if [ "$os_name" = linux ] && [ "$(id -u)" = 0 ]; then
  cmd=conclave
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) cmd=$BIN_DIR/conclave ;; esac
  say ""
  say "Tip: once, as root on this machine, let the hub install the system packages it needs (such as the browser's libraries) by itself:"
  say "  $cmd system-helper install"
fi
