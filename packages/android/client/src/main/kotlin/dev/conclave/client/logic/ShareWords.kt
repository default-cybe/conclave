package dev.conclave.client.logic

import dev.conclave.client.model.ApplySharePlan
import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.RedactReport
import dev.conclave.client.model.RedactionItem
import dev.conclave.client.model.Role
import dev.conclave.client.model.SendShareInput
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.Session
import dev.conclave.client.model.ShareContentOptions
import dev.conclave.client.model.SharePreview
import dev.conclave.client.model.ShareRecipient
import dev.conclave.client.model.ShareSummary
import dev.conclave.client.model.ShareViewMessage
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.UpdateShareInput
import dev.conclave.client.model.friendShareRole
import dev.conclave.client.model.isReminder
import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import java.text.Normalizer
import java.util.Locale

/*
 * Shares with friends in words (docs/design/FRIENDS.md, phases 2 and 3), the
 * same as the web's lib/shares.ts: the card both sides see, a share's
 * state, the review before sending (what goes, what the sanitizer found,
 * keep anyway), the range a share can stop at, a shared conversation as
 * quoted turns, the code, and a friend's thread with notes and shares.
 * Tested in SharesTest.
 */

/** What the owner picks in the review. Title and note do not change what the sanitizer finds. */
data class ReviewChoices(
    /** The last message that goes (its id); null: the whole session. */
    val upTo: String? = null,
    /** full, summary or none. */
    val toolOutput: String = "full",
    val attachments: Boolean = true,
    val thinking: Boolean = false,
    /** none, diff or git-bundle. */
    val code: String = "none",
    /** Redaction items to send anyway. */
    val keep: List<String> = emptyList(),
)

/** Where a share can stop: after a turn, named by what the owner asked in it. */
data class RangeStop(val id: String, val label: String, val count: Int)

/** A shared conversation as turns to read. */
sealed class QuotedUnit {
    abstract val key: String

    data class User(override val key: String, val text: String, val at: Long, val attachments: Int) : QuotedUnit()

    /** [first]: the first reply after the friend's message, which names who answers. [line]: its tool calls in one sentence. */
    data class Assistant(
        override val key: String,
        val text: String,
        val at: Long,
        val model: String?,
        val calls: List<ToolUseBlock>,
        val failed: Int,
        val first: Boolean,
    ) : QuotedUnit() {
        val line: String? get() = if (calls.isEmpty()) null else ToolLines.sentence(ToolLines.steps(calls, emptyMap())) + (if (failed > 0) ", $failed failed" else "")
    }
}

/** A friend's thread: notes and shares both ways, oldest first, with a time label after a pause. */
sealed class FriendEntry {
    abstract val id: String
    abstract val at: Long
    abstract val stamp: String?

    data class NoteIn(override val id: String, override val at: Long, val text: String, val state: String, override val stamp: String? = null) : FriendEntry()
    data class NoteOut(override val id: String, override val at: Long, val text: String, val item: OutboxItemDto, override val stamp: String? = null) : FriendEntry()
    data class ShareIn(override val id: String, override val at: Long, val share: ReceivedShareDto, override val stamp: String? = null) : FriendEntry()
    data class ShareOut(override val id: String, override val at: Long, val share: SentShareDto, override val stamp: String? = null) : FriendEntry()

    /**
     * The entry's key in the thread's list: unique within one thread, also
     * when a note and a share have the same id. Not the class's name, which
     * R8 renames.
     */
    val key: String
        get() = when (this) {
            is NoteIn -> "note-in:$id"
            is NoteOut -> "note-out:$id"
            is ShareIn -> "share-in:$id"
            is ShareOut -> "share-out:$id"
        }

    fun stamped(s: String?): FriendEntry = when (this) {
        is NoteIn -> copy(stamp = s)
        is NoteOut -> copy(stamp = s)
        is ShareIn -> copy(stamp = s)
        is ShareOut -> copy(stamp = s)
    }
}

object ShareWords {

    private fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"

    private const val DAY = 86_400_000L

    // ----- the card -----

    /** "session, 42 messages, diff 12 files", as the hub writes it inside the brackets. */
    private fun summaryParts(kind: String, s: ShareSummary): String {
        val code = s.code?.let { c -> ", ${if (c.kind == "diff") "diff" else "git bundle"} ${plural(c.files, "file")}" } ?: ""
        return "${if (kind == "chat") "chat" else "session"}, ${plural(s.messages, "message")}$code"
    }

    /** "(session, 42 messages, diff 12 files)". */
    fun describe(kind: String, s: ShareSummary): String = "(${summaryParts(kind, s)})"

    /** "Session, 42 messages, diff 12 files": the line under a share's title. */
    fun summaryText(kind: String, s: ShareSummary): String = summaryParts(kind, s).replaceFirstChar { it.uppercaseChar() }

    /** The Inbox line: the hub's own, else made here. */
    fun line(s: ReceivedShareDto): String = s.line.ifBlank { "${s.friendName} sent '${s.title}' ${describe(s.kind, s.summary)}" }

    /** "a chat" or "a session". */
    fun kindWords(kind: String): String = if (kind == "chat") "a chat" else "a session"

    private fun expiresWords(ts: Long, now: Long): String {
        val days = Math.round((ts - now).toDouble() / DAY)
        return when {
            days <= 0 -> "today"
            days == 1L -> "tomorrow"
            days < 7 -> "in $days days"
            else -> "on ${FriendWords.shortDate(ts)}"
        }
    }

    /** How a share from a friend stands, for its card and its page. */
    fun received(s: ReceivedShareDto, now: Long): FriendState {
        val who = s.friendName
        val err = s.error
        return when (s.state) {
            "offered" -> FriendState(
                "Waiting for you", FriendTone.WARN,
                "Nothing is fetched until you accept." + (s.expiresAt?.let { " It expires ${expiresWords(it, now)}." } ?: "") + (err?.let { " $it" } ?: ""),
            )
            "fetching" -> FriendState("Fetching", FriendTone.DIM, "Fetching it from $who's hub and checking the signature.")
            "accepted" -> if (s.updateWaiting) {
                FriendState("Revision ${s.revision} waits", FriendTone.WARN, "$who sent a new revision. Accept it to fetch it." + (err?.let { " $it" } ?: ""))
            } else {
                FriendState("Accepted", FriendTone.OK, err)
            }
            "declined" -> FriendState("Declined", FriendTone.DIM, "$who's hub is not told. You can still accept it.")
            "revoked" -> FriendState("Unsent", FriendTone.DIM, "$who unsent it. Their hub asked yours to delete its copy, and it did. Forks and handoffs you made stay yours.")
            "expired" -> FriendState("Expired", FriendTone.DIM, "It was not accepted in 30 days. Ask $who to send it again.")
            else -> FriendState(s.state.replaceFirstChar { it.uppercaseChar() }, FriendTone.DIM)
        }
    }

    /** How one friend has a share this hub sent. */
    fun recipient(r: ShareRecipient, share: SentShareDto): FriendState {
        if (share.state == "revoked" || r.state == "revoked") return FriendState("Unsent", FriendTone.DIM, "${r.friendName}'s hub is asked to delete its copy.")
        val acc = r.acceptedRevision
        return when (r.state) {
            "accepted" -> if (acc != null && acc < share.revision) {
                FriendState("Accepted revision $acc", FriendTone.OK, "Revision ${share.revision} waits for ${r.friendName}.")
            } else {
                FriendState("Accepted", FriendTone.OK)
            }
            "delivered" -> FriendState("Delivered", FriendTone.DIM, "Waiting for ${r.friendName} to accept.")
            "sent" -> r.lastError?.let { FriendState("Not delivered yet", FriendTone.WARN, it) } ?: FriendState("Sending", FriendTone.DIM)
            "failed" -> FriendState("Not delivered", FriendTone.FAULT, r.lastError ?: "${r.friendName}'s hub could not be reached for 7 days.")
            "expired" -> FriendState("Expired", FriendTone.DIM, "${r.friendName} did not accept it in 30 days.")
            else -> FriendState(r.state.replaceFirstChar { it.uppercaseChar() }, FriendTone.DIM)
        }
    }

    /** A sent share is still out: it can get a new revision or be unsent. */
    fun sentActive(s: SentShareDto): Boolean = s.state == "active"

    /** The Accept button: "Accept", or "Accept revision 3" when a new one waits. */
    fun acceptLabel(s: ReceivedShareDto): String = if (s.updateWaiting) "Accept revision ${s.revision}" else "Accept"

    /** A chat or session can go to a friend: not a subagent (it goes with its parent) and not a friend's reference. */
    fun canSend(s: Session): Boolean = s.parentId == null && s.friendShareRole != "reference"

    // ----- the review before sending -----

    /** The hub's defaults: full tool output, attachments, no thinking, a session's diff (a chat has no code). */
    fun reviewStart(kind: String, from: ShareContentOptions? = null): ReviewChoices = ReviewChoices(
        upTo = from?.upTo,
        toolOutput = from?.toolOutput ?: "full",
        attachments = from?.attachments ?: true,
        thinking = from?.thinking ?: false,
        code = if (kind == "chat") "none" else from?.code ?: "diff",
        keep = from?.keep.orEmpty(),
    )

    /** The choices as the hub takes them, every field said so nothing falls back to a default by surprise. */
    fun previewInput(sessionId: String, c: ReviewChoices): SendShareInput = SendShareInput(
        sessionId = sessionId,
        toolOutput = c.toolOutput,
        attachments = c.attachments,
        thinking = c.thinking,
        code = c.code,
        upTo = c.upTo,
        keep = c.keep.sorted().ifEmpty { null },
    )

    /** Send: the review's choices, the friends, and a title and note when given. */
    fun sendInput(sessionId: String, c: ReviewChoices, to: List<String>, title: String, note: String): SendShareInput =
        previewInput(sessionId, c).copy(to = to, title = title.trim().ifEmpty { null }, note = note.trim().ifEmpty { null })

    /** Update: a new revision with the review's choices; an empty note clears it. */
    fun updateInput(c: ReviewChoices, title: String, note: String): UpdateShareInput = UpdateShareInput(
        toolOutput = c.toolOutput,
        attachments = c.attachments,
        thinking = c.thinking,
        code = c.code,
        upTo = c.upTo,
        keep = c.keep.sorted().ifEmpty { null },
        title = title.trim().ifEmpty { null },
        note = note.trim(),
    )

    /** Keep an item anyway, or take it out again. */
    fun toggleKeep(c: ReviewChoices, id: String): ReviewChoices = c.copy(keep = if (id in c.keep) c.keep - id else c.keep + id)

    /** "Secret", "Path", "Private address", "Email", "Device name". */
    fun ruleWord(rule: String): String = when (rule) {
        "secret" -> "Secret"
        "path" -> "Path"
        "privateIp" -> "Private address"
        "email" -> "Email"
        "hostname" -> "Device name"
        else -> "Value"
    }

    /** A found value until the owner asks to see it: its ends, the middle hidden. */
    fun maskValue(s: String): String {
        val one = s.replace(Regex("""\s+"""), " ").trim()
        if (one.length <= 8) return "•".repeat(maxOf(4, one.length))
        return "${one.take(4)}•••${one.takeLast(2)}"
    }

    /** "Found 3 times", "Found once". */
    fun timesWords(n: Int): String = when (n) {
        1 -> "Found once"
        2 -> "Found twice"
        else -> "Found $n times"
    }

    /** What goes in place of an item: its replacement, or a word for nothing. */
    fun goesAs(item: RedactionItem): String = when {
        item.kept -> "Goes as it is"
        item.replacement.isNotEmpty() -> "Goes as ${item.replacement}"
        else -> "Taken out"
    }

    /** What the sanitizer took out or replaced, in words, the rules the owner can keep first: "2 secrets", "3 paths". */
    fun reportWords(r: RedactReport): List<String> {
        val words = listOf(
            Triple(r.secrets, "secret", null),
            Triple(r.paths, "path", null),
            Triple(r.privateIps, "private address", "private addresses"),
            Triple(r.emails, "email", null),
            Triple(r.hostnames, "device name", null),
            Triple(r.reminders, "system reminder", null),
            Triple(r.recalled, "recalled memory", "recalled memories"),
            Triple(r.thinking, "thinking block", null),
            Triple(r.signatures, "reasoning signature", null),
            Triple(r.redactedThinking, "encrypted reasoning block", null),
            Triple(r.toolOutputs, "tool output", null),
            Triple(r.attachments, "attachment", null),
        )
        return words.filter { it.first > 0 }.map { (n, one, many) -> "$n ${if (n == 1) one else many ?: "${one}s"}" }
    }

    /** "Taken out: 2 secrets, 3 paths and 1 email." or "Nothing taken out." */
    fun reportSentence(r: RedactReport): String {
        val w = reportWords(r)
        if (w.isEmpty()) return "Nothing taken out."
        val list = if (w.size == 1) w[0] else "${w.dropLast(1).joinToString(", ")} and ${w.last()}"
        return "Taken out: $list."
    }

    /** "About 48 KB". */
    fun sizeWords(bytes: Long): String =
        if (bytes < 1024 * 1024) "About ${maxOf(1L, Math.round(bytes / 1024.0))} KB" else "About ${String.format(Locale.US, "%.1f", bytes / 1024.0 / 1024.0)} MB"

    /** The send button: "Send to Alice", "Send to Alice and Ben", "Send to 3 friends". */
    fun sendLabel(names: List<String>): String = when (names.size) {
        0 -> "Send"
        1 -> "Send to ${names[0]}"
        2 -> "Send to ${names[0]} and ${names[1]}"
        else -> "Send to ${names.size} friends"
    }

    /** "Alice", "Alice and Ben", "Alice, Ben and Chen". */
    fun namesWords(names: List<String>): String =
        if (names.size <= 1) names.firstOrNull() ?: "" else "${names.dropLast(1).joinToString(", ")} and ${names.last()}"

    /** Messages that go of all: "12 of 42 messages", "All 42 messages". */
    fun rangeWords(p: SharePreview): String = if (p.messages >= p.total) "All ${plural(p.total, "message")}" else "${p.messages} of ${plural(p.total, "message")}"

    /** A message's text blocks on one line, without the hub's own context for the model. */
    private fun oneLine(m: Message): String =
        m.content.filterIsInstance<TextBlock>().filterNot { it.isReminder() }.joinToString(" ") { it.text }.replace(Regex("""\s+"""), " ").trim()

    /**
     * Where a share can stop: after each turn but the last (the last is the
     * whole session). A turn starts with a message the owner wrote and goes
     * on to the message before the next one.
     */
    fun rangeStops(messages: List<Message>): List<RangeStop> {
        val starts = messages.indices.filter { i -> val m = messages[i]; m.role == Role.USER && m.kind != MessageKind.NOTICE && oneLine(m).isNotEmpty() }
        val out = ArrayList<RangeStop>()
        for (t in 0 until starts.size - 1) {
            val end = starts[t + 1] - 1
            val text = oneLine(messages[starts[t]])
            out += RangeStop(messages[end].id, if (text.length > 80) text.take(79) + "…" else text, end + 1)
        }
        return out
    }

    // ----- a shared conversation, quoted -----

    /**
     * A shared session's messages as turns to read: what the friend asked,
     * then each message of their assistant, its words and its tool calls
     * folded into one line after them. A tool result (a user message that
     * only carries results) counts toward the calls before it.
     */
    fun quotedUnits(messages: List<ShareViewMessage>): List<QuotedUnit> {
        val out = ArrayList<QuotedUnit>()
        messages.forEachIndexed { i, m ->
            val key = m.externalId ?: i.toString()
            val text = m.content.filterIsInstance<TextBlock>().joinToString("\n\n") { it.text }.trim()
            val prev = out.lastOrNull()
            if (m.role == Role.USER) {
                val failed = m.content.count { it is ToolResultBlock && it.isError }
                if (prev is QuotedUnit.Assistant && failed > 0) out[out.size - 1] = prev.copy(failed = prev.failed + failed)
                val attachments = m.content.count { it is ImageBlock || it is DocumentBlock }
                if (text.isNotEmpty() || attachments > 0) out += QuotedUnit.User(key, text, m.createdAt, attachments)
                return@forEachIndexed
            }
            val calls = m.content.filterIsInstance<ToolUseBlock>()
            if (text.isEmpty() && calls.isEmpty()) return@forEachIndexed
            out += QuotedUnit.Assistant(key, text, m.createdAt, m.model, calls, 0, prev !is QuotedUnit.Assistant)
        }
        return out
    }

    // ----- code -----

    /** "Diff of 3 files", "Git bundle of fix/login, 4 files". */
    fun codeWords(kind: String, files: Int, branch: String? = null): String =
        if (kind == "diff") "Diff of ${plural(files, "file")}" else "Git bundle${branch?.let { " of $it" } ?: ""}, ${plural(files, "file")}"

    /** A slug as the hub makes branch names (core session/share-code.ts slug). */
    fun slug(text: String, max: Int = 40): String {
        val s = Normalizer.normalize(text, Normalizer.Form.NFKD)
            .replace(Regex("""[̀-ͯ]"""), "")
            .lowercase()
            .replace(Regex("""[^a-z0-9]+"""), "-")
            .trim('-')
            .take(max)
            .trimEnd('-')
        return s.ifEmpty { "share" }
    }

    /** The branch the hub names when the owner leaves it to it: from-alice/fix-flaky-auth-test. */
    fun branchHint(friend: String, title: String): String = "from-${slug(friend, 24)}/${slug(title)}"

    /** What applying the plan does, in one sentence. */
    fun planSentence(p: ApplySharePlan): String =
        "${if (p.kind == "diff") "The diff" else "The git bundle"} of ${plural(p.files.size, "file")} goes onto a new branch ${p.branch} in ${p.root} on ${p.deviceName}${p.base?.let { ", from ${it.take(10)}" } ?: ""}."

    /** "This check is good until 14:32." */
    fun planUntil(p: ApplySharePlan, clock: (Long) -> String): String = "This check is good until ${clock(p.expiresAt)}."

    /** The one line under Continue as fork, and at the top of its sheet. */
    const val FORK_LINE = "Its first turn asks before any tool runs."

    // ----- a friend's thread -----

    /** A label goes over a note when this much time passed since the one before. */
    const val STAMP_GAP_MS = 30 * 60_000L

    private fun previewText(preview: String) = preview.replace(Regex("""^note:\s*"""), "")

    /**
     * Notes and shares with one friend, oldest first. A sent note shows its
     * whole text (the hub keeps it); a hub from before that gives only its
     * preview. A share sits where it was first sent or received. The first
     * entry, and one after a pause, get a time label.
     */
    fun thread(friendId: String, inbox: List<InboxItemDto>, outbox: List<OutboxItemDto>, received: List<ReceivedShareDto>, sent: List<SentShareDto>, now: Long, clock: (Long) -> String): List<FriendEntry> {
        val list = ArrayList<FriendEntry>()
        inbox.filter { it.type == "note" && it.friendId == friendId }.forEach { list += FriendEntry.NoteIn(it.id, it.receivedAt, it.text ?: "", it.state) }
        outbox.filter { it.type == "note" && it.friendId == friendId }.forEach { list += FriendEntry.NoteOut(it.id, it.createdAt, it.text ?: previewText(it.preview), it) }
        received.filter { it.friendId == friendId }.forEach { list += FriendEntry.ShareIn(it.id, it.receivedAt, it) }
        sent.filter { s -> s.recipients.any { it.friendId == friendId } }.forEach { list += FriendEntry.ShareOut(it.id, it.createdAt, it) }
        list.sortWith(compareBy<FriendEntry>({ it.at }, { it.id }))
        var last = Long.MIN_VALUE / 2
        // one row per key: the list keys its rows, and the same key twice closes the app
        return list.distinctBy { it.key }.map { e ->
            val stamped = if (e.at - last >= STAMP_GAP_MS) e.stamped(FriendWords.stampText(e.at, now, clock)) else e
            last = e.at
            stamped
        }
    }

    /** Received shares waiting first, then newest. */
    fun receivedOrder(list: List<ReceivedShareDto>): List<ReceivedShareDto> =
        list.sortedWith(compareByDescending<ReceivedShareDto> { FriendWords.shareWaiting(it) }.thenByDescending { it.receivedAt })

    /** Sent shares still out first, then newest change. */
    fun sentOrder(list: List<SentShareDto>): List<SentShareDto> =
        list.sortedWith(compareByDescending<SentShareDto> { sentActive(it) }.thenByDescending { it.updatedAt })

    /**
     * The line under a session made from a friend's share (the web's
     * FriendShareLine): whose turns are quoted here, and while the guard
     * holds, that the first turn asks before any tool runs. Null for any
     * other session.
     */
    fun madeFromWords(s: Session): String? {
        val m = s.meta?.obj("friendShare") ?: return null
        val name = m.string("name")?.ifBlank { null } ?: return null
        val guard = (m["guard"] as? JsonPrimitive)?.booleanOrNull == true
        val through = (m["importedThrough"] as? JsonPrimitive)?.intOrNull
        val hub = "$name's hub"
        val asks = if (guard) " Its first turn asks before any tool runs, until you write a message of your own." else ""
        return when (m.string("role")) {
            "reference" -> "A reference from $hub: read only, quoted data. Your agents find it in past chats."
            "handoff" -> "A handoff from $hub: its brief quotes $name.$asks"
            else -> {
                val what = when {
                    through == null || through <= 0 -> "what came before is"
                    through == 1 -> "the first message is"
                    else -> "the first $through messages are"
                }
                "A fork of $name's share: $what quoted from $hub.$asks"
            }
        }
    }

    /** "Fork", "Handoff", "Reference": what a session made from a share is. */
    fun roleWord(role: String): String = when (role) {
        "fork" -> "Fork"
        "handoff" -> "Handoff"
        "reference" -> "Reference"
        else -> role.replaceFirstChar { it.uppercaseChar() }
    }

    /** The heading of a friend's notes: "Unsend 'title'?" body, "asked to delete", never a promise. */
    fun unsendBody(s: SentShareDto): String {
        val names = s.recipients.filter { it.state != "revoked" }.map { it.friendName }
        val who = when {
            names.size == 1 -> "${names[0]}'s hub is"
            names.isNotEmpty() -> "Their hubs are"
            else -> "Their hub is"
        }
        return "$who asked to delete the copy and any reference made from it. A fork or handoff they made stays theirs. Nothing more of it goes."
    }

    /** A friend in the pick list: "Seen 4m ago" or "Not seen yet". */
    fun seenWords(f: FriendDto, now: Long): String = f.lastSeen?.let { "Seen ${FriendWords.agoText(it, now)}" } ?: "Not seen yet"
}
