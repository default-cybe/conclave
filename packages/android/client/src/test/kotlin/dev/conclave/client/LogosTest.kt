package dev.conclave.client

import dev.conclave.client.logic.Format
import dev.conclave.client.logic.LogoId
import dev.conclave.client.logic.Logos
import dev.conclave.client.logic.ModelRefs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LogosTest {
    @Test
    fun picksModelFamilyMarks() {
        assertEquals(LogoId.CLAUDE, Logos.model("anthropic/claude-sonnet-5-5"))
        assertEquals(LogoId.GPT, Logos.model("openai/gpt-5.5"))
        assertEquals(LogoId.GPT, Logos.model("openai/o3-mini"))
        assertEquals(LogoId.GEMINI, Logos.model("google/gemini-3-pro"))
        assertEquals(LogoId.GLM, Logos.model("zai/glm-5"))
        assertEquals(LogoId.DEEPSEEK, Logos.model("openrouter/deepseek/deepseek-v4"))
        assertEquals(LogoId.QWEN, Logos.model("ollama/qwen3-coder:30b"))
        assertEquals(LogoId.KIMI, Logos.model("moonshot/kimi-k2"))
        assertEquals(LogoId.MISTRAL, Logos.model("mistral/devstral-medium"))
        assertEquals(LogoId.GROK, Logos.model("xai/grok-4"))
        // the model id names no family: fall back to the company
        assertEquals(LogoId.OLLAMA, Logos.model("ollama/phi4"))
        assertEquals(LogoId.GROQ, Logos.model("groq/some-model"))
        assertNull(Logos.model("cliproxy/custom"))
        assertNull(Logos.model(null))
    }

    @Test
    fun harnessRefsShowTheHarnessOrTheFamily() {
        assertEquals(LogoId.CLAUDE_CODE, Logos.harness("claude-code/opus"))
        assertEquals(LogoId.CLAUDE_CODE, Logos.harness("claude-code"))
        assertEquals(LogoId.GEMINI_CLI, Logos.harness("gemini-cli/default"))
        assertEquals(LogoId.OPENCODE, Logos.harness("opencode/glm-5"))
        assertNull(Logos.harness("anthropic/claude-opus-5-5"))
        // the model picker shows the family for a harness ref
        assertEquals(LogoId.CLAUDE, Logos.model("claude-code/opus"))
        assertEquals(LogoId.CLAUDE, Logos.model("claude-code/default"))
        assertEquals(LogoId.GPT, Logos.model("codex/default"))
        assertEquals(LogoId.GLM, Logos.model("opencode/glm-5"))
        assertNull(Logos.model("opencode/default"))
    }

    @Test
    fun picksCompanyMarks() {
        assertEquals(LogoId.ANTHROPIC, Logos.company("claude-max"))
        assertEquals(LogoId.ANTHROPIC, Logos.company("claude-code"))
        assertEquals(LogoId.OPENAI, Logos.company("codex"))
        assertEquals(LogoId.ZAI, Logos.company("zai-coding"))
        assertEquals(LogoId.GOOGLE, Logos.company("gemini-cli"))
        assertEquals(LogoId.MOONSHOT, Logos.company("kimi"))
        assertEquals(LogoId.OPENROUTER, Logos.company("OpenRouter"))
        assertNull(Logos.company("cliproxy"))
    }

    @Test
    fun monogramsForUnknownMarks() {
        assertEquals("C", Logos.monogram("CLIProxy"))
        assertEquals("CL", Logos.monogram("CLIProxy", letters = 2))
        assertEquals("LS", Logos.monogram("LM Studio"))
        assertEquals("?", Logos.monogram(""))
    }

    @Test
    fun writesModelNamesLikeTheirMakers() {
        assertEquals("Sonnet 5.5", ModelRefs.displayName("anthropic/claude-sonnet-5-5"))
        assertEquals("Opus 4.1", ModelRefs.displayName("anthropic/claude-opus-4-1-20250805"))
        assertEquals("Sonnet 3.7", ModelRefs.displayName("anthropic/claude-3-7-sonnet"))
        assertEquals("GPT-5.5", ModelRefs.displayName("openai/gpt-5.5"))
        assertEquals("GPT-5.5 Codex", ModelRefs.displayName("openai/gpt-5.5-codex"))
        assertEquals("o3-mini", ModelRefs.displayName("openai/o3-mini"))
        assertEquals("Gemini 3 Pro", ModelRefs.displayName("google/gemini-3-pro"))
        assertEquals("GLM-5", ModelRefs.displayName("zai/glm-5"))
        assertEquals("GLM-4.5V", ModelRefs.displayName("zai/glm-4.5v"))
        assertEquals("Qwen3 Coder 30B", ModelRefs.displayName("ollama/qwen3-coder-30b"))
        assertEquals("DeepSeek V4", ModelRefs.displayName("openrouter/deepseek/deepseek-v4"))
        assertEquals("Kimi K2", ModelRefs.displayName("moonshot/kimi-k2"))
        assertEquals("Devstral Medium", ModelRefs.displayName("mistral/devstral-medium"))
        assertEquals("Claude Code", ModelRefs.displayName("claude-code/default"))
        assertEquals("Opus", ModelRefs.displayName("claude-code/opus"))
        assertEquals("Codex", ModelRefs.displayName("codex"))
        assertEquals("", ModelRefs.displayName(null))
    }

    @Test
    fun namesProvidersAndHarnesses() {
        assertEquals("Claude Max", ModelRefs.providerName("claude-max"))
        assertEquals("Z.ai", ModelRefs.providerName("zai"))
        assertEquals("Gemini CLI", ModelRefs.providerName("gemini-cli"))
        assertEquals("Custom Proxy", ModelRefs.providerName("custom-proxy"))
        assertEquals("Claude Code", ModelRefs.harnessLabel("claude-code/opus"))
        assertNull(ModelRefs.harnessLabel("anthropic/claude-opus-5-5"))
        assertEquals("claude-code", ModelRefs.cliHarness("claude"))
        assertEquals("gemini-cli", ModelRefs.cliHarness("gemini"))
        assertNull(ModelRefs.cliHarness("git"))
        assertEquals("Sonnet 5.5", ModelRefs.cleanName("Claude Sonnet 5.5"))
        assertEquals("Claude Code", ModelRefs.cleanName("Claude Code"))
    }

    @Test
    fun formatsElapsedCounters() {
        assertEquals("0:00", Format.elapsed(0))
        assertEquals("0:42", Format.elapsed(42_000))
        assertEquals("12:04", Format.elapsed((12 * 60 + 4) * 1000L))
        assertEquals("1:02:04", Format.elapsed((3600 + 2 * 60 + 4) * 1000L))
    }
}
