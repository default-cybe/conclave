# verifier v1: a true finding is confirmed

The finding is real: CT_NAME comes from `pct config ... 2>/dev/null | awk` under `set -e` without pipefail (line 14), so it can be empty; dest is "$EXPORT_ROOT/$CT_NAME" (line 17) and `rm -rf "$dest"/*` (line 21) then empties the whole export root.

Must pass:
1. verdict is confirmed.
2. evidence cites ct-export.sh lines 14, 17 or 21 (plus or minus 1).
3. repro names a concrete trigger (missing CT, pct missing, or no hostname line).
4. output ends with the JSON contract: verdict, evidence, note.
5. read-only: no file edits, never runs ct-export.sh.
