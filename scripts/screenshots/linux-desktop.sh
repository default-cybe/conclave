#!/bin/sh
# Screenshots of the Linux desktop app with the demo hub (scripts/demo-hub.ts),
# light and dark: the connection page on a first start, Home after pairing
# with a conclave://pair link, and a session.
#
#   bun scripts/demo-hub.ts --info /tmp/demo.json &
#   (cd packages/desktop && bun run tauri build --debug --no-bundle)
#   xvfb-run -s "-screen 0 1440x900x24" sh scripts/screenshots/linux-desktop.sh /tmp/demo.json [out dir] [app]
#
# It pairs the way the OS does when someone opens a pairing link: the link
# is the app's only argument. Each run gets its own config folder, with "Let
# the hub use this computer" off, so nothing is installed as a service.
# Expects a bare X server (no window manager): the window sits at 0,0 and is
# cropped to its 1180x800. The session is opened with two clicks
# (x11-click.py) at places that fit the web app's layout at that width.
set -eu

info=$1
out=${2:-docs/screenshots/apps/linux}
app=${3:-packages/desktop/src-tauri/target/debug/conclave-desktop}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
work=$(mktemp -d)
pid=""
trap 'if [ -n "$pid" ]; then pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; fi; rm -rf "$work"' EXIT

# no GPU under Xvfb: WebKitGTK paints a blank window without these
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1

# a fresh client pairing link from the demo hub (codes are single use)
pair_link() {
  # shellcheck disable=SC2016
  INFO="$info" bun -e '
    const i = await Bun.file(process.env.INFO).json();
    const r = await fetch(`${i.url}/api/pairing`, { method: "POST", headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "client" }) });
    const p = await r.json();
    console.log(`conclave://pair?url=${encodeURIComponent(i.url)}&code=${encodeURIComponent(p.code)}&fp=${p.fingerprint}`);
  '
}

# start the app with its own config and data folders; $1 is the profile folder, the rest go to the app
start_app() {
  profile=$1
  shift
  if command -v dbus-run-session >/dev/null; then
    XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" dbus-run-session -- "$app" "$@" >"$profile/app.log" 2>&1 &
  else
    XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" "$app" "$@" >"$profile/app.log" 2>&1 &
  fi
  pid=$!
}

stop_app() {
  # the app first (a child of dbus-run-session when that wraps it), then what started it
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=""
  sleep 1
}

shot() {
  import -window root -crop 1180x800+0+0 +repage "$out/$1"
  echo "$out/$1"
}

for theme in light dark; do
  if [ "$theme" = dark ]; then export GTK_THEME=Adwaita:dark; else export GTK_THEME=Adwaita; fi

  # first start: the connection page
  profile="$work/$theme-first"
  mkdir -p "$profile/config" "$profile/data"
  start_app "$profile"
  sleep 8
  shot "connect-$theme.png"
  stop_app

  # opened from a pairing link: it pairs and loads the hub
  profile="$work/$theme-paired"
  mkdir -p "$profile/config/dev.conclave.desktop" "$profile/data"
  echo '{ "computer": false }' >"$profile/config/dev.conclave.desktop/settings.json"
  start_app "$profile" "$(pair_link)"
  sleep 12
  if ! grep -q '"token"' "$profile/config/dev.conclave.desktop/settings.json"; then
    echo "linux-desktop: the app did not pair. Its log:" >&2
    cat "$profile/app.log" >&2
    exit 1
  fi
  shot "home-$theme.png"

  # Sessions in the top bar, then "Fix login redirect" in the list
  python3 -I "$here/x11-click.py" 305 24
  sleep 2
  python3 -I "$here/x11-click.py" 134 360
  sleep 3
  shot "session-$theme.png"
  stop_app
done
