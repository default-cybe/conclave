package dev.conclave.client.logic

import dev.conclave.client.model.Device
import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.ImportBatch
import dev.conclave.client.model.ImportBatchStatus
import dev.conclave.client.model.ImportEstimate
import dev.conclave.client.model.ImportMode
import dev.conclave.client.model.ImportQuery
import dev.conclave.client.model.ImportRequest
import dev.conclave.client.model.ImportedState

/** A state word and its color. [resumeAt] is set for a batch waiting for a limit ("resumes 15:42"). */
data class StateWord(val word: String, val tone: StateTone, val resumeAt: Long? = null)

/** How far a running batch got: "Importing 40 of 212". */
data class BatchProgress(val done: Int, val total: Int, val verb: String)

/**
 * Words for the chat import screens (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 1.14, the same as the web's features/import/words.ts): sources, modes, the
 * state word on a scan row and a batch, batch counts and the cost line.
 */
object ImportWords {
    private val SOURCES = mapOf(
        "claude-code" to "Claude Code",
        "codex" to "Codex",
        "gemini" to "Gemini CLI",
        "opencode" to "OpenCode",
        "claude-ai" to "claude.ai",
        "chatgpt" to "ChatGPT",
    )

    /** The coding CLIs whose chats a device can hold, as Device.info.clis names them. */
    private val CLIS = listOf("claude", "codex", "gemini")

    fun sourceName(source: String): String = SOURCES[source] ?: source

    fun modeLabel(mode: ImportMode): String = when (mode) {
        ImportMode.CHATS -> "Chats only"
        ImportMode.CHATS_LEARN -> "Chats and learn memory"
        ImportMode.LEARN -> "Learn memory only"
    }

    /** The label in a narrow segmented control. */
    fun modeShort(mode: ImportMode): String = when (mode) {
        ImportMode.CHATS -> "Chats only"
        ImportMode.CHATS_LEARN -> "Chats and memory"
        ImportMode.LEARN -> "Memory only"
    }

    fun modeHelp(mode: ImportMode): String = when (mode) {
        ImportMode.CHATS -> "The chats become archived sessions you can search and resume. Nothing is sent to a model."
        ImportMode.CHATS_LEARN -> "The chats become archived sessions, then a small model reads each one and keeps what a future agent should know. Every item must quote the chat."
        ImportMode.LEARN -> "A small model reads the chats and keeps what a future agent should know. No sessions are made."
    }

    fun plural(n: Int, one: String, many: String = one + "s"): String = "$n ${if (n == 1) one else many}"

    /** The state word at the end of a scan row. */
    fun rowState(x: ExternalSessionInfo): StateWord {
        val imp = x.imported
        return when {
            imp != null && imp.state == ImportedState.DIVERGED -> StateWord("continued in both places", StateTone.WARN)
            imp != null && imp.state == ImportedState.BEHIND -> StateWord(imp.newThere?.takeIf { it > 0 }?.let { "$it new there" } ?: "has new messages", StateTone.NEUTRAL)
            // learned in "Learn memory only": there is no session yet, so it can still be imported
            imp != null && imp.sessionId == null -> if (imp.learned) StateWord("learned, not imported", StateTone.DIM) else StateWord("new", StateTone.NEUTRAL)
            imp != null -> StateWord(if (imp.learned) "imported, learned" else "imported", StateTone.DIM)
            x.skip != null -> StateWord("skipped, ${x.skip.wire.replace('-', ' ')}", StateTone.DIM)
            else -> StateWord("new", StateTone.NEUTRAL)
        }
    }

    private val LIVE = setOf(ImportBatchStatus.SCANNING, ImportBatchStatus.IMPORTING, ImportBatchStatus.LEARNING, ImportBatchStatus.CONSOLIDATING, ImportBatchStatus.WAITING_RESET)

    /** Still working (or waiting for a limit to reset). */
    fun isLive(b: ImportBatch): Boolean = b.status in LIVE

    fun batchState(b: ImportBatch): StateWord = when (b.status) {
        ImportBatchStatus.SCANNING -> StateWord("reading", StateTone.SIGNAL)
        ImportBatchStatus.IMPORTING -> StateWord("importing", StateTone.SIGNAL)
        ImportBatchStatus.LEARNING -> StateWord("learning", StateTone.SIGNAL)
        ImportBatchStatus.CONSOLIDATING -> StateWord("tidying memory", StateTone.SIGNAL)
        ImportBatchStatus.PAUSED -> StateWord("paused", StateTone.WARN)
        ImportBatchStatus.WAITING_RESET -> StateWord("waiting for reset", StateTone.DIM, b.resumeAt)
        ImportBatchStatus.DONE -> StateWord("done", StateTone.OK)
        ImportBatchStatus.FAILED -> StateWord("failed", StateTone.FAULT)
        ImportBatchStatus.CANCELLED -> StateWord("cancelled", StateTone.DIM)
        ImportBatchStatus.UNDONE -> StateWord("undone", StateTone.DIM)
    }

    fun deviceWord(device: String, names: Map<String, String>): String =
        if (device.startsWith("upload:")) "an uploaded export" else names[device]?.ifBlank { null } ?: device

    /** "Chats and learn memory, 212 chats from arch-desktop". */
    fun batchTitle(b: ImportBatch, names: Map<String, String>): String =
        "${modeLabel(b.mode)}, ${plural(b.total, "chat")} from ${deviceWord(b.device, names)}"

    /** "180 imported, 12 updated, 41 memories, 6 to review, $0.58". */
    fun batchCounts(b: ImportBatch): List<String> = buildList {
        if (b.imported > 0) add("${b.imported} imported")
        if (b.updated > 0) add("${b.updated} updated")
        if (b.forked > 0) add("${b.forked} continued in both places")
        if (b.unchanged > 0) add("${b.unchanged} already here")
        if (b.skipped > 0) add("${b.skipped} skipped")
        if (b.failed > 0) add("${b.failed} failed")
        if (b.mode != ImportMode.CHATS) {
            if (b.learnedSessions > 0) add("${plural(b.learnedSessions, "chat")} read")
            if (b.memoriesAdded > 0) add(plural(b.memoriesAdded, "memory", "memories"))
            if (b.memoriesMerged > 0) add("${b.memoriesMerged} merged")
            if (b.memoriesReview > 0) add("${b.memoriesReview} to review")
            if (b.costUsd > 0) add(Format.usd(b.costUsd))
        }
    }

    fun batchProgress(b: ImportBatch): BatchProgress {
        val copied = b.imported + b.updated + b.forked + b.unchanged + b.skipped + b.failed
        val learning = b.status == ImportBatchStatus.LEARNING || b.status == ImportBatchStatus.CONSOLIDATING ||
            (b.mode == ImportMode.LEARN && b.status != ImportBatchStatus.IMPORTING)
        if (learning) {
            val total = maxOf(1, if (b.mode == ImportMode.LEARN) b.total else b.total - b.skipped - b.failed)
            return BatchProgress(minOf(total, b.learnedSessions), total, if (b.status == ImportBatchStatus.CONSOLIDATING) "Tidying memory" else "Learning")
        }
        return BatchProgress(minOf(b.total, copied), b.total, "Importing")
    }

    private val DROPPED = linkedMapOf(
        "evidence" to "the quote was not in the chat",
        "evidence-role" to "the quote was not the owner or a tool",
        "evidence-unrelated" to "the quote did not back it",
        "number" to "a number not in the chat",
        "basis" to "no clear basis",
        "kind" to "unknown kind",
        "length" to "too long",
        "secret" to "looked like a secret",
        "duplicate" to "said twice",
        "supersedes" to "replaced nothing",
        "not-json" to "unreadable reply",
        "shape" to "unreadable item",
    )

    /** Why learned items were left out, as words: "3 the quote was not in the chat, 1 looked like a secret". */
    fun droppedWords(d: Map<String, Int>): String =
        DROPPED.entries.mapNotNull { (k, words) -> d[k]?.takeIf { it > 0 }?.let { "$it $words" } }.joinToString(", ")

    /** Working right now (a batch waiting for a limit is not). */
    fun isWorking(b: ImportBatch): Boolean = isLive(b) && b.status != ImportBatchStatus.WAITING_RESET

    /** Undo is offered for 30 days while the batch is not working, when it made or learned something (as on the web). */
    fun canUndo(b: ImportBatch, now: Long): Boolean {
        if (b.status == ImportBatchStatus.UNDONE || isWorking(b)) return false
        if ((b.undoUntil ?: 0) <= now) return false
        val made = b.imported + b.forked + b.updated + b.memoriesAdded + b.memoriesReview + b.memoriesMerged
        return made > 0 || b.status == ImportBatchStatus.FAILED || b.status == ImportBatchStatus.CANCELLED
    }

    /** "212 chats, about $0.61 on Haiku 5.5." and the other options after it. */
    fun estimateLine(e: ImportEstimate, mode: ImportMode): Pair<String, String?> {
        if (e.sessions == 0) return "Nothing to import with these filters." to null
        val chats = plural(e.sessions, "chat")
        if (mode == ImportMode.CHATS) {
            val already = if (e.alreadyImported > 0) ", ${e.alreadyImported} already here" else ""
            return "$chats$already. Nothing is sent to a model." to null
        }
        fun price(o: dev.conclave.client.model.ImportCostOption): String =
            if (o.free == true) "free on ${ModelRefs.displayName(o.model)}" else "about ${Format.usd(o.costUsd)} on ${ModelRefs.displayName(o.model)}"
        val first = e.options.firstOrNull()
        val lead = if (first != null) "$chats, ${price(first)}." else "$chats."
        val rest = e.options.drop(1).map { price(it) }
        return lead to rest.takeIf { it.isNotEmpty() }?.let { "Or ${it.joinToString(", ")}." }
    }

    /** "12 skipped: 10 too short, 2 automation." or empty. */
    fun skippedLine(e: ImportEstimate): String {
        val names = listOf("too-short" to "too short", "automation" to "automation", "subagent" to "subagent", "internal" to "internal")
        val parts = names.mapNotNull { (k, w) -> e.skipped[k]?.takeIf { it > 0 }?.let { "$it $w" } }
        val n = e.skipped.values.sum()
        return if (n > 0) "$n skipped: ${parts.joinToString(", ")}." else ""
    }

    /** Devices worth scanning: the hub and paired computers with a coding CLI, online first. */
    fun scanDevices(devices: List<Device>): List<Device> {
        fun hasCli(d: Device) = CLIS.any { d.info?.clis?.containsKey(it) == true }
        return devices.filter { (it.id == "local" || hasCli(it)) && !Locations.isPhone(it) }
            .sortedWith(compareByDescending<Device> { it.online }.thenByDescending { hasCli(it) }.thenBy { it.name.ifBlank { it.id }.lowercase() })
    }

    /** The device the screen starts on: the first online computer that is not the hub, else the first one, else the hub. */
    fun defaultDevice(devices: List<Device>): String =
        devices.firstOrNull { it.online && it.id != "local" }?.id ?: devices.firstOrNull()?.id ?: "local"

    /** "Pick chats first", "Import 12 chats", "Learn from 1 chat". */
    fun startLabel(nothing: Boolean, mode: ImportMode, chosen: Int): String = when {
        nothing -> "Pick chats first"
        mode == ImportMode.LEARN -> "Learn from ${plural(chosen, "chat")}"
        else -> "Import ${plural(chosen, "chat")}"
    }

    /** What the toast says after Undo. */
    fun undoLine(r: dev.conclave.client.model.ImportUndoResult): String {
        val kept = buildString {
            if (r.kept.isNotEmpty()) append(" ${plural(r.kept.size, "memory", "memories")} you edited since ${if (r.kept.size == 1) "was" else "were"} kept.")
            if (r.keptSessions.isNotEmpty()) append(" ${plural(r.keptSessions.size, "session")} you kept going in ${if (r.keptSessions.size == 1) "was" else "were"} kept.")
        }
        return "Undid the import: ${plural(r.sessionsRemoved, "session")}, ${plural(r.messagesRemoved, "message")} and ${plural(r.memoriesRemoved, "memory", "memories")} removed.$kept"
    }
}

/** Whether a project's box is ticked: all of it, part of it, or none. */
enum class PickState { ALL, SOME, NONE }

/**
 * What the owner ticked on the scan list. [all] picks the whole query;
 * [groups] picks whole projects; [keys] picks single chats (and skipped
 * chats, which a whole pick leaves out); [exclude] unticks chats inside an
 * [all] or [groups] pick. A group's rows must be loaded before it is
 * unticked under [all], so its chats can go in [exclude].
 */
data class ImportPick(
    val all: Boolean = false,
    val groups: Set<String> = emptySet(),
    val keys: Set<String> = emptySet(),
    val exclude: Set<String> = emptySet(),
) {
    val nothing: Boolean get() = !all && groups.isEmpty() && keys.isEmpty()

    private fun whole(group: String) = all || group in groups

    /** A chat can be ticked when it is not a subagent's thread, and a skipped one only outside Select all (with Show skipped on). */
    fun pickable(x: ExternalSessionInfo, showSkipped: Boolean): Boolean =
        x.parentKey == null && (x.skip == null || (showSkipped && !all))

    fun picked(x: ExternalSessionInfo, group: String): Boolean = when {
        x.skip != null -> x.key in keys
        whole(group) -> x.key !in exclude
        else -> x.key in keys
    }

    fun groupState(group: String, rows: List<ExternalSessionInfo>?): PickState {
        if (whole(group)) {
            val own = rows?.filter { it.skip == null && it.parentKey == null } ?: return PickState.ALL
            val out = own.count { it.key in exclude }
            return when {
                out == 0 -> PickState.ALL
                out == own.size -> PickState.NONE
                else -> PickState.SOME
            }
        }
        return if (rows?.any { it.key in keys } == true) PickState.SOME else PickState.NONE
    }

    /** Tick or untick a whole project. */
    fun pickGroup(group: String, rows: List<ExternalSessionInfo>, on: Boolean): ImportPick {
        val mine = rows.map { it.key }.toSet()
        val keys = keys - mine
        if (all) {
            val out = if (on) exclude - mine else exclude + rows.filter { it.skip == null }.map { it.key }
            return copy(keys = keys, exclude = out)
        }
        return copy(groups = if (on) groups + group else groups - group, keys = keys, exclude = exclude - mine)
    }

    fun pickRow(x: ExternalSessionInfo, group: String, on: Boolean): ImportPick = when {
        x.skip != null || !whole(group) -> copy(keys = if (on) keys + x.key else keys - x.key)
        else -> copy(exclude = if (on) exclude - x.key else exclude + x.key)
    }

    /**
     * The request the hub takes: the whole query minus [exclude] for
     * [all], else the keys of every ticked chat (whole projects resolved from
     * their loaded rows). Null when nothing is ticked.
     */
    fun toRequest(device: String, mode: ImportMode, query: ImportQuery, rows: Map<String, List<ExternalSessionInfo>>): ImportRequest? {
        if (nothing) return null
        if (all) return ImportRequest(device = device, mode = mode, query = query, exclude = exclude.takeIf { it.isNotEmpty() }?.sorted())
        val out = LinkedHashSet(keys)
        for (g in groups) {
            rows[g].orEmpty().filter { it.skip == null && it.parentKey == null && it.key !in exclude }.forEach { out += it.key }
        }
        if (out.isEmpty()) return null
        val skippedPicked = rows.values.any { list -> list.any { it.skip != null && it.key in keys } }
        return ImportRequest(device = device, mode = mode, keys = out.toList(), includeSkipped = if (skippedPicked) true else null)
    }
}
