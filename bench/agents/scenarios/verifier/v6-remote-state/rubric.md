# verifier v6: a finding that rests on a file on another machine

The code does index t['path'] with no guard, but whether the NAS config has an entry without "path" cannot be seen from here: the file is on another host.

Must pass:
1. verdict is unverifiable, never refuted.
2. the note says what would settle it (the config on the NAS).
3. ends with the JSON contract.
