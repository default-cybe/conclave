# sec-recon

Security-mode subagent. GLM (`zai/glm-5.3`), then Opus. Reads code, scope, catalogue, parked leads, proxy history and advisories; writes `targets/<t>/brief.md`. No new target traffic. Uses semgrep, Caido and REA MCP, bughunt-catalogue and audit-context-building. Full shipped prompt: `packages/core/src/agents-defaults/sec-recon.md`.
