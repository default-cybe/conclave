# sec-hunter

Security-mode subagent. Web/source logic: Opus (`cliproxy/claude-opus-5-5`), then GLM. For C/C++ PoC override to GLM, then Opus. Reads source, semgrep and catalogue; returns up to 10 leads with file:line, invariant and proof plan. Lab probes only, never live target. Skills: cve-violation-hunt, variant-analysis, tool-semgrep-fix-rule. Full shipped prompt: `packages/core/src/agents-defaults/sec-hunter.md`.
