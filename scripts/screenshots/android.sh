#!/usr/bin/env bash
# Screenshots of the Android app on a running emulator, paired with the demo
# hub (scripts/demo-hub.ts, started with --url http://10.0.2.2:7810 so the
# pairing link names the address the emulator reaches the host at).
#
#   bash scripts/screenshots/android.sh <demo info.json> <apk or folder with it> [out dir]
#
# .github/workflows/screenshots.yml runs it in the emulator step. It installs
# the app, shoots the Connect screen, opens a conclave://pair link (the form
# fills in) and taps Pair, then shoots the screens of docs/design/MOBILE-V2.md
# 9, light and dark: Home, the side panel, Chats, Code, the Inbox, Settings,
# a session with its tool line folded and open, an approval, a question and a
# chat, and at the end Home with nothing waiting. Taps find their target by
# its text or its content description in a uiautomator dump; the side panel
# opens with the Menu button.
set -euo pipefail

info=$1
apk=$2
out=${3:-docs/screenshots/apps/android}
pkg=dev.conclave.app
activity="$pkg/.MainActivity"
work=$(mktemp -d)
mkdir -p "$out"

# on a failure, keep what explains it next to the screenshots: the screen, the last UI dump and the log
finish() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "android: failed with exit code $code; saving the screen, the UI dump and logcat to $out" >&2
    adb exec-out screencap -p >"$out/failed.png" 2>/dev/null || true
    [ -f "$work/ui.xml" ] && cp "$work/ui.xml" "$out/failed-ui.xml"
    adb logcat -d -t 600 >"$out/failed-logcat.txt" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap finish EXIT
if [ -d "$apk" ]; then for f in "$apk"/*.apk; do apk=$f; break; done; fi

# a value from the info file: url, token, sessions.fix, addresses.0
field() {
  python3 - "$info" "$1" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d.get(k)
    if d is None:
        break
print("" if d is None else d)
EOF
}

hub=$(field url)
token=$(field token)
phone_url=$(field addresses.0)

# a fresh client pairing link (codes are single use and last 10 minutes)
pair_link() {
  curl -fsS -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"kind":"client"}' "$hub/api/pairing" >"$work/pairing.json"
  python3 - "$work/pairing.json" "$phone_url" <<'EOF'
import json, sys, urllib.parse
p = json.load(open(sys.argv[1]))
q = lambda s: urllib.parse.quote(s, safe="")
print(f"conclave://pair?url={q(sys.argv[2])}&code={q(p['code'])}&fp={p['fingerprint']}")
EOF
}

shot() {
  adb exec-out screencap -p >"$out/$1"
  echo "$out/$1"
}

# the screen as uiautomator sees it; it fails while the UI animates, so it tries again.
# The old file goes first, so a failed dump never reads an earlier screen.
dump() {
  for _ in 1 2 3 4 5; do
    adb shell rm -f /sdcard/ui.xml >/dev/null 2>&1 || true
    adb shell uiautomator dump /sdcard/ui.xml >"$work/dump.log" 2>&1 || true
    if adb shell cat /sdcard/ui.xml >"$work/ui.xml" 2>/dev/null && grep -q '<hierarchy' "$work/ui.xml"; then return 0; fi
    sleep 1
  done
  return 1
}

# what the screen held when a wait gave up: the texts uiautomator saw, or why it saw nothing
explain() {
  if [ -s "$work/ui.xml" ] && grep -q '<hierarchy' "$work/ui.xml"; then
    echo "android: texts on screen:" >&2
    python3 - "$work/ui.xml" >&2 <<'PY'
import sys
import xml.etree.ElementTree as ET
for n in ET.parse(sys.argv[1]).getroot().iter("node"):
    t = n.get("text") or n.get("content-desc")
    if t:
        print(f"  {t!r} {n.get('bounds')} enabled={n.get('enabled')}")
PY
  else
    echo "android: no UI dump; uiautomator said: $(tr -d '\r' <"$work/dump.log" 2>/dev/null)" >&2
  fi
  adb logcat -d -t 400 AndroidRuntime:E '*:S' >&2 2>/dev/null || true
}

# "x y" of the lowest node whose text or description is exactly $1; "words*" matches what starts with them
find_text() {
  python3 - "$work/ui.xml" "$1" <<'EOF'
import re, sys
import xml.etree.ElementTree as ET
want = sys.argv[2]
prefix = want.endswith("*")
best = None
for n in ET.parse(sys.argv[1]).getroot().iter("node"):
    seen = [t for t in (n.get("text"), n.get("content-desc")) if t]
    if not any(t.startswith(want[:-1]) if prefix else t == want for t in seen):
        continue
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
    if m:
        x1, y1, x2, y2 = map(int, m.groups())
        c = ((x1 + x2) // 2, (y1 + y2) // 2)
        if best is None or c[1] > best[1]:
            best = c
if best is None:
    sys.exit(1)
print(best[0], best[1])
EOF
}

# wait up to $2 seconds for $1 on screen; with tap, tap it
# a slow emulator can show "System UI isn't responding" over the app; Wait keeps everything running
dismiss_anr() {
  local xy
  if grep -q "isn&apos;t responding\|isn't responding" "$work/ui.xml" && xy=$(find_text Wait); then
    echo "android: dismissing a not responding dialog" >&2
    # shellcheck disable=SC2086
    adb shell input tap $xy
    sleep 2
    return 0
  fi
  return 1
}

await_text() {
  local text=$1 secs=$2 action=${3:-} xy end=$((SECONDS + $2))
  while [ $SECONDS -lt $end ]; do
    if dump; then
      if dismiss_anr; then continue; fi
      if xy=$(find_text "$text"); then
        # shellcheck disable=SC2086
        if [ "$action" = tap ]; then adb shell input tap $xy; fi
        return 0
      fi
    fi
    sleep 2
  done
  echo "android: \"$text\" did not show in ${secs}s" >&2
  explain
  shot "missing-$(printf '%s' "$text" | tr -c 'A-Za-z0-9' '-').png" >&2 || true
  return 1
}

# open the side panel with the Menu button and tap the row $1 in it
panel() {
  await_text Menu 15 tap && sleep 2 && await_text "$1" 10 tap
}

# answer what waits on the owner through the hub (deny the approval, take each question's first option),
# so Home can be shot with nothing waiting
resolve_waiting() {
  curl -fsS -H "authorization: Bearer $token" "$hub/api/approvals" >"$work/approvals.json"
  curl -fsS -H "authorization: Bearer $token" "$hub/api/questions" >"$work/questions.json"
  python3 - "$work/approvals.json" "$work/questions.json" >"$work/resolve.txt" <<'EOF'
import json, sys
for a in json.load(open(sys.argv[1])):
    print("approvals", a["id"], json.dumps({"decision": "deny"}))
for q in json.load(open(sys.argv[2])):
    answers = {x["question"]: ((x.get("options") or [{"label": "Yes"}])[0]["label"]) for x in q.get("questions", [])}
    print("questions", q["id"], json.dumps({"answers": answers}))
EOF
  while read -r kind id body; do
    curl -fsS -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body" "$hub/api/$kind/$id" >/dev/null || true
  done <"$work/resolve.txt"
}

open_link() {
  adb shell am start -W -a android.intent.action.VIEW -d "'$1'" -n "$activity" >/dev/null
  sleep "${2:-4}"
}

theme() {
  if [ "$1" = dark ]; then adb shell cmd uimode night yes >/dev/null; else adb shell cmd uimode night no >/dev/null; fi
  sleep 3
}

adb wait-for-device
# the action waits for boot already; the package manager can still lag behind it
for _ in $(seq 1 60); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && adb shell pm path android >/dev/null 2>&1 && break
  sleep 2
done
adb devices
adb shell wm size
# no "isn't responding" or crash dialogs over the screens (the emulator is slow under CI load);
# the setting applies at the next configuration change, which the first theme switch makes
adb shell settings put global hide_error_dialogs 1 || true
# the hub on this machine must answer before anything is paired
curl -fsS "$hub/api/health" >/dev/null || { echo "android: the demo hub at $hub does not answer" >&2; exit 1; }
adb install -r "$apk"
# no permission dialogs over the screens: notifications, and the camera for the QR scanner
adb shell pm grant "$pkg" android.permission.POST_NOTIFICATIONS || true
adb shell pm grant "$pkg" android.permission.CAMERA || true

for t in light dark; do
  theme "$t"
  adb shell am force-stop "$pkg"
  adb shell am start -W -n "$activity" >/dev/null
  sleep 6
  shot "connect-$t.png"
done

# pair the way a scanned QR code or a tapped link does: the form fills in, Pair sends it
theme light
open_link "$(pair_link)" 5
shot connect-code-light.png
# the light switch can recreate the screen just as Pair is tapped and lose the tap;
# while the form still shows, tap again (the code is used only once pairing works)
for _ in 1 2 3; do
  await_text Pair 30 tap || break
  await_text Menu 30 && break
done
# paired: Home's top bar has the Menu button
await_text Menu 60
sleep 5

fix=$(field sessions.fix)
push=$(field sessions.push)
routes=$(field sessions.routes)
chat=$(field sessions.chat)
run=$(field workflowRun)
mem=$(field memoryItem)

for t in light dark; do
  theme "$t"
  # the links below stack screens on top of each other; start fresh
  adb shell am force-stop "$pkg"
  adb shell am start -W -n "$activity" >/dev/null
  await_text Menu 30
  open_link conclave://new 3
  # after a cold start the hub's data arrives in parts; "2 need you" under the greeting means it is in
  await_text "2 need you" 30
  shot "home-$t.png"
  await_text Menu 15 tap && sleep 2 && await_text Recents 10 && shot "panel-$t.png"
  await_text Chats 10 tap && sleep 3 && shot "chats-$t.png"
  panel Code && sleep 3 && shot "code-$t.png"
  panel Inbox && sleep 3 && shot "inbox-$t.png"
  panel Settings && sleep 3 && shot "settings-$t.png"
  # the finished session: its tool calls as one line, then the line open
  open_link "conclave://session/$fix" && shot "session-$t.png"
  await_text "Read redirect.ts*" 15 tap && sleep 2 && shot "session-open-$t.png"
  open_link "conclave://session/$push" && await_text "Allow once" 20 && shot "approval-$t.png"
  open_link "conclave://session/$routes" && await_text "Keep the old API route?" 20 && shot "question-$t.png"
  open_link "conclave://chat/$chat" && shot "chat-$t.png"
  if [ -n "$run" ]; then open_link "conclave://workflow-run/$run" && shot "workflow-$t.png"; fi
  # Memory > Map: the tree, the 3D clusters, and an item's sheet over each
  open_link "conclave://memory-map?view=tree" && await_text Rings 20 && sleep 2 && shot "memory-map-tree-$t.png"
  if [ -n "$mem" ]; then
    open_link "conclave://memory-map?view=tree&item=$mem" && await_text "Center here" 20 && sleep 2 && shot "memory-map-tree-sheet-$t.png"
    open_link "conclave://memory-map?view=clusters&item=$mem" && await_text "Center here" 20 && sleep 2 && shot "memory-map-3d-sheet-$t.png"
  fi
  open_link "conclave://memory-map?view=clusters" && await_text Clusters 20 && sleep 3 && shot "memory-map-3d-$t.png"
  open_link "conclave://memory-map?view=timeline" && await_text Timeline 20 && sleep 3 && shot "memory-map-timeline-$t.png"
done

# Home with nothing waiting: the question answered and the push denied on the hub
resolve_waiting || true
for t in light dark; do
  theme "$t"
  adb shell am force-stop "$pkg"
  adb shell am start -W -n "$activity" >/dev/null
  await_text Menu 30
  open_link conclave://new 3
  sleep 4
  shot "home-empty-$t.png"
done
theme light
ls -l "$out"
