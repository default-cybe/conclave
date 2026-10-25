## [0.4.29] - 2026-10-25

### Fixed

- Model picker: a model's "via" choices now list every signed in plan that has it, also a plan of another vendor that lists only a variant. Opus 5.5 offers "via backup-gemini (Antigravity)", which picks that plan's own id (`cliproxy/backup-gemini/claude-opus-5-5-high`). Still one Opus 5.5 row. Web and Android.

- A subagent that ends with no answer because of a usage limit now reports `limited` (an error: `failed`), not `completed`.