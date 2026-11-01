package dev.conclave.client.logic

import dev.conclave.client.model.ModelInfo

/**
 * Cyber access for ChatGPT plan models (packages/core/src/providers/access-programs.ts):
 * the programs a model takes come from the hub's model list (ModelInfo.cyber). Stored as
 * session.chat.cyber; null is Default, which sends nothing.
 */
object CyberAccess {
    private val LABELS = mapOf("standard" to "Standard", "daybreak_blue" to "Daybreak Blue", "daybreak_red" to "Daybreak Red")

    fun label(program: String?): String = if (program == null) "Default" else LABELS[program] ?: program

    /** The rows the control lists: Default, then the model's programs. Empty: the model has no Cyber access choice. */
    fun choices(m: ModelInfo?): List<String?> {
        val own = m?.cyber.orEmpty().filter { it in LABELS }
        return if (own.isEmpty()) emptyList() else listOf<String?>(null) + own
    }
}
