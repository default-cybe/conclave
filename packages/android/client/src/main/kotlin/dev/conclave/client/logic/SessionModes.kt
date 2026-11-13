package dev.conclave.client.logic

import dev.conclave.client.model.DebateConfig
import dev.conclave.client.model.JuryConfig
import dev.conclave.client.model.LoopConfig
import dev.conclave.client.model.ModeConfig
import dev.conclave.client.model.SessionMode

/** The style in the composer's Options chip (the session mode), as on the web (features/chat/modes.ts MODES, chat/pickers.tsx modePatch). */
object SessionModes {
    /** The sheet's heading, and the fold that holds Jury, Debate, Loop and Ultra (design review #4). */
    const val HEADING = "Working style"
    const val MORE = "More styles"

    /** Agent, Chat and Plan: always in the sheet. */
    val EVERYDAY = listOf(SessionMode.AGENT, SessionMode.CHAT, SessionMode.PLAN)

    /** Jury, Debate and Loop: under More styles. */
    val MORE_STYLES = SessionMode.entries.filter { it !in EVERYDAY }

    /** The fold starts open while an expert style or Ultra is on. */
    fun moreOpen(m: SessionMode, ultra: Boolean, ultraOffered: Boolean): Boolean = m in MORE_STYLES || (ultraOffered && ultra)

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

    /**
     * What the Options chip (design review #6, web ComposerParts.tsx optionsChanges) has changed from the
     * defaults: [memory] first (its words when not "Use and save", so "No memory" is never the part left
     * out), then [security] on, the style, Ultra, an [agent] other than [defaultAgent], [sameModel] and a
     * [cyber] program (the conversation's switches, design review #7). Null [mode]: no style offered.
     */
    fun optionsChanges(
        mode: SessionMode?,
        ultra: Boolean,
        ultraOffered: Boolean,
        agent: String?,
        defaultAgent: String?,
        memory: String?,
        security: Boolean = false,
        sameModel: Boolean = false,
        cyber: String? = null,
    ): List<String> =
        listOfNotNull(
            memory,
            SECURITY.takeIf { security },
            mode?.takeIf { it != SessionMode.AGENT }?.let(::label),
            "Ultra".takeIf { mode != null && ultraOffered && ultra },
            agent?.takeIf { it.isNotBlank() && defaultAgent != null && it != defaultAgent },
            "Same model".takeIf { sameModel },
            cyber,
        )

    private const val SECURITY = "Security"

    /** Changes the chip always spells out, never folded into "+1": the risky ones (design review, "never hidden"). */
    private val RISKY = setOf("No memory", SECURITY)

    /** The Options chip's words: "Options" at the defaults, else the first change, any risky one, and how many more ("No memory, Security +1"). */
    fun optionsWords(changes: List<String>): String {
        if (changes.isEmpty()) return "Options"
        val said = changes.filterIndexed { i, c -> i == 0 || c in RISKY }
        val more = changes.size - said.size
        return said.joinToString(", ") + if (more > 0) " +$more" else ""
    }

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
