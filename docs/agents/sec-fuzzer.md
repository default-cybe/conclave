# sec-fuzzer

Security-mode subagent. GLM (`zai/glm-5.3`), then Opus. Writes seed corpora and harness for one C/C++ entry, runs libFuzzer with ASan/UBSan in Madx Docker only. No model calls while fuzzing. Full shipped prompt: `packages/core/src/agents-defaults/sec-fuzzer.md`.
