package dev.conclave.client.logic

import dev.conclave.client.model.Session
import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Imported chats (the hub's core/src/session/imported.ts, the same rules): a
 * chat copied in from claude.ai, ChatGPT, Claude Code, Codex or Gemini CLI is
 * stored archived and tagged "imported", with meta.import saying where it came
 * from. Until the owner writes in it, it sits in an "Imported" group of its
 * own, newest first by its original date, with its source and that date
 * ("claude.ai, 2 May"). The first message sent in one unarchives it and stamps
 * meta.import.continuedAt: from then on it is a normal conversation.
 */
object Imported {
    /** The group's key and name. */
    const val KEY = "imported"
    const val WORDS = "Imported"

    /** How many rows the side panel lists at most. */
    const val LIMIT = 30

    private val SOURCES = mapOf(
        "claude-code" to "Claude Code",
        "codex" to "Codex",
        "gemini" to "Gemini CLI",
        "opencode" to "OpenCode",
        "claude-ai" to "claude.ai",
        "chatgpt" to "ChatGPT",
    )

    private fun long(s: Session, key: String): Long? = (s.meta?.obj("import")?.get(key) as? JsonPrimitive)?.longOrNull

    /** Still in the Imported place: imported, archived as the import left it, never written in here, not a merge's duplicate. */
    fun inImported(s: Session): Boolean {
        if ("imported" !in s.tags || !s.archived) return false
        val m = s.meta?.obj("import")
        return (long(s, "continuedAt") ?: 0L) == 0L && m?.string("duplicateOf") == null
    }

    /** Where it came from, by name: "claude.ai". Null with no import record. */
    fun source(s: Session): String? {
        val src = s.meta?.obj("import")?.string("source") ?: s.tags.firstOrNull { it in SOURCES }
        return src?.let { SOURCES[it] ?: it }
    }

    /** When the chat started at its source; the Imported group sorts by it, newest first. */
    fun date(s: Session): Long = long(s, "createdAt")?.takeIf { it > 0 } ?: s.createdAt.takeIf { it > 0 } ?: s.updatedAt

    /** "claude.ai, 2 May" this year, "ChatGPT, Sept 2025" before. */
    fun label(s: Session, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        val day = Instant.ofEpochMilli(date(s)).atZone(zone)
        val pattern = if (day.year == Instant.ofEpochMilli(now).atZone(zone).year) "d MMM" else "MMM yyyy"
        val date = day.format(DateTimeFormatter.ofPattern(pattern, Locale.UK))
        return source(s)?.let { "$it, $date" } ?: date
    }
}
