package dev.conclave.client.logic

import dev.conclave.client.model.DebateConfig
import dev.conclave.client.model.JuryConfig
import dev.conclave.client.model.LoopConfig
import dev.conclave.client.model.ModeConfig
import dev.conclave.client.model.SessionMode

/** The composer's mode chip, as on the web (features/chat/modes.ts MODES, chat/pickers.tsx modePatch). */
object SessionModes {
    /** A mode in words. */
    fun label(m: SessionMode): String = when (m) {
        SessionMode.AGENT -> "Agent"
        SessionMode.CHAT -> "Chat"
        SessionMode.PLAN -> "Plan"
        SessionMode.JURY -> "Jury"
        SessionMode.DEBATE -> "Debate"
        SessionMode.LOOP -> "Loop"
    }

    /** One line on what a mode does. */
    fun detail(m: SessionMode): String = when (m) {
        SessionMode.AGENT -> "Tools on, works until done"
        SessionMode.CHAT -> "No tools, just talk"
        SessionMode.PLAN -> "Read only, proposes a plan"
        SessionMode.JURY -> "Several models answer, a judge decides"
        SessionMode.DEBATE -> "Two models argue, a judge concludes"
        SessionMode.LOOP -> "Repeats until a check passes"
    }

    /** The chip's words: "Agent mode", ", Ultra" after it when Ultra is on where the session takes it. */
    fun chipWords(m: SessionMode, ultra: Boolean, ultraOffered: Boolean): String =
        "${label(m)} mode" + if (ultraOffered && ultra) ", Ultra" else ""

    val DEFAULT_JURY = JuryConfig(
        jurors = listOf("anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "zai/glm-5", "google/gemini-3-pro"),
        strategy = "synthesize",
        anonymize = true,
        jurorTools = "none",
    )
    val DEFAULT_DEBATE = DebateConfig(a = "openai/gpt-5.5", b = "anthropic/claude-opus-5-5", rounds = 2)
    val DEFAULT_LOOP = LoopConfig(untilCommand = "bun test", maxIterations = 8)

    /** A mode change's modeConfig: the session's, with that mode's defaults where it has none yet. */
    fun config(mode: SessionMode, cfg: ModeConfig?): ModeConfig {
        val now = cfg ?: ModeConfig()
        return when {
            mode == SessionMode.JURY && now.jury == null -> now.copy(jury = DEFAULT_JURY)
            mode == SessionMode.DEBATE && now.debate == null -> now.copy(debate = DEFAULT_DEBATE)
            mode == SessionMode.LOOP && now.loop == null -> now.copy(loop = DEFAULT_LOOP)
            else -> now
        }
    }
}
