package dev.conclave.client.logic

import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ThinkingLevel
import kotlin.math.abs

/**
 * Effort, as the web app shows it (packages/core/src/providers/effort.ts):
 * the levels a model offers come from the hub's model list (ModelInfo.effort).
 * A stored level the model lacks shows as the nearest one it has, the lower
 * on a tie, and Off on a model that cannot stop thinking is its lowest level.
 * The hub sends the same.
 */
object Effort {
    private val ORDER = listOf(ThinkingLevel.LOW, ThinkingLevel.MEDIUM, ThinkingLevel.HIGH, ThinkingLevel.XHIGH, ThinkingLevel.MAX)

    /** The model's levels, lowest first. */
    fun levels(e: ModelEffort): List<ThinkingLevel> = ORDER.filter { it.wire in e.levels }

    /** What the control lists: Off where the model can stop thinking, then its levels. Empty: no Effort control. */
    fun choices(e: ModelEffort?): List<ThinkingLevel> {
        if (e == null) return emptyList()
        return (if (e.off) listOf(ThinkingLevel.OFF) else emptyList()) + levels(e)
    }

    /** The model's default, when the hub knows it and it is one of the choices. */
    fun defaultOf(e: ModelEffort): ThinkingLevel? = ThinkingLevel.from(e.defaultLevel)?.takeIf { it in choices(e) }

    /** The level the model takes for a stored one; null for none, or for a model without Effort. */
    fun clamp(level: ThinkingLevel?, e: ModelEffort?): ThinkingLevel? {
        if (level == null || e == null) return null
        val have = levels(e)
        if (level == ThinkingLevel.OFF) return if (e.off) ThinkingLevel.OFF else have.firstOrNull()
        if (level in have) return level
        if (have.isEmpty()) return if (e.off) ThinkingLevel.OFF else null
        val at = ORDER.indexOf(level)
        var best = have[0]
        for (l in have) {
            val d = abs(ORDER.indexOf(l) - at)
            val bd = abs(ORDER.indexOf(best) - at)
            if (d < bd || (d == bd && ORDER.indexOf(l) < ORDER.indexOf(best))) best = l
        }
        return best
    }

    /** What the control shows: the stored level as the model takes it, else the model's default. */
    fun shown(level: ThinkingLevel?, e: ModelEffort): ThinkingLevel? = clamp(level, e) ?: defaultOf(e)

    /** The word for a level; a model with one level (a switch) calls it On. */
    fun label(level: ThinkingLevel, e: ModelEffort? = null): String =
        if (level != ThinkingLevel.OFF && e != null && e.levels.size == 1 && e.levels[0] == level.wire) "On" else level.label

    /** The agents that run at medium unless told (core engine.ts CODING_AGENTS). */
    private val CODING_AGENTS = setOf(
        "coder", "general-purpose", "explore", "reviewer", "planner", "security",
        "builder", "tester", "debugger", "refactorer", "designer", "docs-writer", "verifier", "code-researcher", "workflow",
    )

    /** A Claude model that takes an effort level (core providers/anthropic.ts takesEffort). */
    fun takesEffort(model: String?): Boolean {
        if (model.isNullOrBlank()) return false
        val id = model.substringAfterLast('/').lowercase().replace(Regex("-\\d{8}$"), "")
        return Regex("^claude-(opus|sonnet|haiku|fable|mythos)-5").containsMatchIn(id) || Regex("^claude-(opus|sonnet)-4-[678]").containsMatchIn(id)
    }

    /**
     * What a session runs at with no Effort of its own (engine.thinkingFor):
     * its agent's level, else medium for a coding agent on a Claude model
     * that takes one, else nothing (the model's default). [label] names the
     * agent for the picker: "Use the coder agent's".
     */
    fun follow(agent: String?, agentThinking: String?, model: String?): EffortFollow {
        val own = ThinkingLevel.from(agentThinking)
        val level = own ?: if (agent != null && agent in CODING_AGENTS && takesEffort(model)) ThinkingLevel.MEDIUM else null
        return EffortFollow("the ${agent?.ifBlank { null } ?: "agent"} agent", level)
    }

    /** The level a conversation runs at, as the model takes it: the one picked, else [follow]'s, else the model's default. */
    fun running(value: ThinkingLevel?, e: ModelEffort?, follow: EffortFollow? = null): ThinkingLevel? =
        e?.let { shown(value ?: follow?.level, it) }

    /**
     * The model and its effort as the quiet row says them: "Opus 5.5 Medium".
     * The level shows only when the model has more than one (not for Off, nor
     * a model without Effort); no model is "Choose a model".
     */
    fun words(model: String?, value: ThinkingLevel?, e: ModelEffort?, follow: EffortFollow? = null): String {
        val name = ModelRefs.displayName(model).ifBlank { "Choose a model" }
        val level = running(value, e, follow)
        return if (e != null && level != null && level != ThinkingLevel.OFF && e.levels.size > 1) "$name ${label(level, e)}" else name
    }
}

/** What runs with nothing picked: an agent's level, [label] naming the agent ("the coder agent"). A null level is the model's default. */
data class EffortFollow(val label: String, val level: ThinkingLevel?)
