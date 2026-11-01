`ledgerkit report --currency EUR` still prints USD when a ledgerkit.json exists. The flag parser looks broken.

To see it, run `bun src/cli.ts report --month 2026-03 --currency EUR` in this folder. The header says USD. When I delete ledgerkit.json, the flag works.

Please fix it so the settings follow the order the README describes.
