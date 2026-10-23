package dev.conclave.client.logic

import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendReachability
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.text.Collator
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Friends in words on the phone (docs/design/FRIENDS.md, docs/DESIGN.md 27),
 * the same as the web's lib/friends.ts and lib/friendInbox.ts: the invite
 * link a friend sends, the short key and the safety code in groups, whether
 * friends reach this hub, a friend's state in one line, what waits in the
 * Inbox, and how a sent note is doing. Tested in FriendsTest.
 */

/** The color a friend's words take. */
enum class FriendTone { OK, WARN, FAULT, DIM }

/** A friend's invite: conclave://friend?fp=...&url=...&alt=...&s=...&exp=... */
data class FriendLink(
    /** The link alone, as the hub takes it. */
    val link: String,
    /** The inviting hub's key fingerprint, 32 hex characters. */
    val fp: String,
    /** Where that hub answers, best first. */
    val url: String,
    val alts: List<String>,
    val expiresAt: Long,
)

/** A friend's state, short, with one more line when there is more to say. */
data class FriendState(val word: String, val tone: FriendTone, val line: String? = null)

/** Whether friends reach this hub, in words. */
data class ReachWords(val ok: Boolean, val title: String, val why: String? = null, val detail: String? = null)

/** How a sent note is doing, under it. [retry] and [cancel]: what applies. */
data class DeliveryWords(val word: String, val tone: FriendTone, val line: String? = null, val retry: Boolean = false, val cancel: Boolean = false)

/** One row friends add to the Inbox. */
data class FriendInboxItem(
    /** Unique in the Inbox. */
    val id: String,
    val kind: Kind,
    val friendId: String,
    val name: String,
    val at: Long,
    /** One line under the name. */
    val line: String,
    /** Notes not read yet each count; requests, key changes and share cards count one. */
    val count: Int,
    /** A share card: Accept and Decline in place. */
    val share: ReceivedShareDto? = null,
) {
    enum class Kind { REQUEST, KEY, NOTE, SHARE }
}

object FriendWords {

    private val LINK = Regex("""conclave://friend\?[^\s"'<>]+""", RegexOption.IGNORE_CASE)
    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val SECRET = Regex("^[A-Za-z0-9_-]{22,64}$")

    /** An http or https address with no user, query or fragment, without a trailing slash. */
    private fun cleanUrl(v: String?): String? {
        if (v.isNullOrBlank()) return null
        val u = try {
            URI(v.trim())
        } catch (_: Exception) {
            return null
        }
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = u.host ?: return null
        if (host.isEmpty() || u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return null
        val defaultPort = (scheme == "https" && u.port == 443) || (scheme == "http" && u.port == 80)
        val port = if (u.port >= 0 && !defaultPort) ":${u.port}" else ""
        val path = (u.rawPath ?: "").trimEnd('/')
        return "$scheme://${host.lowercase()}$port$path"
    }

    private fun decode(s: String): String = try {
        URLDecoder.decode(s, StandardCharsets.UTF_8.name())
    } catch (_: Exception) {
        s
    }

    /**
     * The invite in pasted or scanned text: the link alone, or a message with
     * the link in it ("Here is my invite: conclave://friend?..."). Null when
     * there is none or it is not whole. The hub checks it again.
     */
    fun parseLink(text: String?): FriendLink? {
        val m = LINK.find(text ?: "") ?: return null
        // a sentence may end right after the link
        val link = m.value.replace(Regex("""[).,;:!?]+$"""), "")
        val q = LinkedHashMap<String, MutableList<String>>()
        for (pair in link.substringAfter('?').split('&')) {
            if (pair.isEmpty()) continue
            val k = decode(pair.substringBefore('='))
            val v = if (pair.contains('=')) decode(pair.substringAfter('=')) else ""
            q.getOrPut(k) { ArrayList() }.add(v)
        }
        val fp = q["fp"]?.firstOrNull()?.lowercase() ?: ""
        val url = cleanUrl(q["url"]?.firstOrNull())
        val secret = q["s"]?.firstOrNull() ?: ""
        val exp = q["exp"]?.firstOrNull()?.toLongOrNull()
        if (!HEX32.matches(fp) || url == null || !SECRET.matches(secret) || exp == null || exp <= 0) return null
        val alts = ArrayList<String>()
        for (a in q["alt"].orEmpty()) {
            val u = cleanUrl(a)
            if (u != null && u != url && u !in alts) alts.add(u)
        }
        return FriendLink(link, fp, url, alts.take(8), exp * 1000)
    }

    /** "example.com" from "https://example.com:8443/x"; the text itself when it is not an address. */
    fun hostWords(url: String): String = try {
        val u = URI(url)
        val host = u.host ?: return url
        if (u.port >= 0) "$host:${u.port}" else host
    } catch (_: Exception) {
        url
    }

    /** "3f9a 12c0 8e41 07b2": the first groups of four of a key's fingerprint. */
    fun shortFingerprint(fp: String, groups: Int = 4): String =
        fp.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }.chunked(4).take(groups).joinToString(" ")

    /** The whole fingerprint in groups of four, two lines of four groups. */
    fun fingerprintLines(fp: String): List<String> =
        fp.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }.chunked(4).chunked(4).map { it.joinToString(" ") }

    /** "18342 90311 55120 07718" as its groups of five digits, however it was spaced. */
    fun safetyGroups(code: String): List<String> = code.filter { it.isDigit() }.chunked(5)

    private const val MIN = 60_000L
    private const val HOUR = 60 * MIN
    private const val DAY = 24 * HOUR

    private val SHORT_DATE = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

    fun shortDate(ts: Long, zone: ZoneId = ZoneId.systemDefault()): String = Instant.ofEpochMilli(ts).atZone(zone).format(SHORT_DATE)

    /** "just now", "4m ago", "3h ago", "2d ago", "on 17 Aug". */
    fun agoText(ts: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val d = now - ts
        return when {
            d < 45_000 -> "just now"
            d < HOUR -> "${maxOf(1L, Math.round(d.toDouble() / MIN))}m ago"
            d < DAY -> "${Math.round(d.toDouble() / HOUR)}h ago"
            d < 7 * DAY -> "${Math.round(d.toDouble() / DAY)}d ago"
            else -> "on ${shortDate(ts, zone)}"
        }
    }

    private fun day(ts: Long, zone: ZoneId) = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()

    /** "Today 14:02", "Yesterday 09:10", "16 Oct 18:30": the label over a group of notes. */
    fun stampText(ts: Long, now: Long, clock: (Long) -> String, zone: ZoneId = ZoneId.systemDefault()): String {
        val d = day(ts, zone)
        val today = day(now, zone)
        return when (d) {
            today -> "Today ${clock(ts)}"
            today.minusDays(1) -> "Yesterday ${clock(ts)}"
            else -> "${shortDate(ts, zone)} ${clock(ts)}"
        }
    }

    /** "until 14:05 today", "until 09:30 tomorrow", "until 16 Oct 09:30": when an invite stops working. */
    fun untilText(ts: Long, now: Long, clock: (Long) -> String, zone: ZoneId = ZoneId.systemDefault()): String {
        val d = day(ts, zone)
        val today = day(now, zone)
        return when (d) {
            today -> "until ${clock(ts)} today"
            today.plusDays(1) -> "until ${clock(ts)} tomorrow"
            else -> "until ${shortDate(ts, zone)} ${clock(ts)}"
        }
    }

    /** "in 6 min", "in 1h 22m", "now". */
    fun inTime(ts: Long, now: Long): String {
        val d = ts - now
        return when {
            d <= 30_000 -> "now"
            d < HOUR -> "in ${maxOf(1L, Math.round(d.toDouble() / MIN))} min"
            else -> "in ${Format.durationShort(d)}"
        }
    }

    private const val PULLS = "Until then your hub still fetches what friends hold for it."

    /**
     * Whether a friend's hub reaches this one (FRIENDS.md 5): a tunnel or an
     * own URL does; Tailscale serves only the tailnet, and with remote
     * access off only this network reaches the hub.
     */
    fun reachWords(r: FriendReachability?): ReachWords? {
        if (r == null) return null
        if (r.ok) {
            val at = r.best?.url?.let { " at ${hostWords(it)}" } ?: ""
            return ReachWords(true, "Friends reach this hub$at.", detail = if (r.best?.kind == "quick") "A quick tunnel gets a new address when it restarts. Your hub sends friends the new one." else null)
        }
        val fix = "Turn on a tunnel or use your own URL in Remote access."
        val title = "Friends cannot reach this hub."
        return when (r.mode) {
            "off" -> ReachWords(false, title, "Remote access is off.", "$fix $PULLS")
            "tailscale" -> ReachWords(false, title, "Tailscale serves only your tailnet.", "$fix $PULLS")
            else -> ReachWords(false, "Friends cannot reach this hub yet.", detail = r.reason ?: "The hub has no outside address yet. $PULLS")
        }
    }

    /** A friend's state: "Seen 4m ago", "Wants to be friends", with more when there is more to say. */
    fun state(f: FriendDto, now: Long): FriendState {
        if (f.isBlocked) return FriendState("New key", FriendTone.FAULT, f.blockedReason ?: "${f.name}'s hub has a new key. Nothing is sent or taken until you confirm it.")
        if (f.isPending) {
            return if (f.asked) {
                FriendState("Wants to be friends", FriendTone.WARN, "Asked ${agoText(f.createdAt, now)}.")
            } else {
                FriendState("Waiting for them", FriendTone.DIM, "You asked ${agoText(f.createdAt, now)}. You are friends once their owner accepts.")
            }
        }
        if (f.isRemoved) return FriendState("Removed", FriendTone.DIM)
        val queued = if (f.queued > 0) "${f.queued} waiting to go." else ""
        val seen = f.lastSeen
        val err = f.lastError
        if (err != null) {
            return FriendState(if (seen != null) "Seen ${agoText(seen, now)}" else "Not reached yet", FriendTone.WARN, listOf(err, queued).filter { it.isNotEmpty() }.joinToString(" "))
        }
        return FriendState(if (seen != null) "Seen ${agoText(seen, now)}" else "Not seen yet", FriendTone.DIM, queued.ifEmpty { null })
    }

    private val collator: Collator = Collator.getInstance(Locale.ROOT)

    /** Friends in the order the list shows them: what needs you first, then by name. */
    fun order(list: List<FriendDto>): List<FriendDto> {
        fun rank(f: FriendDto) = when {
            f.isBlocked -> 0
            f.isPending && f.asked -> 1
            f.isActive -> 2
            else -> 3
        }
        return list.sortedWith { a, b -> (rank(a) - rank(b)).takeIf { it != 0 } ?: collator.compare(a.name, b.name) }
    }

    /** A friend a share can go to: active ones, by name. */
    fun shareTargets(friends: List<FriendDto>): List<FriendDto> = friends.filter { it.isActive }.sortedWith { a, b -> collator.compare(a.name, b.name) }

    /** How a sent note is doing, under it. */
    fun delivery(o: OutboxItemDto, name: String, now: Long): DeliveryWords = when (o.state) {
        "delivered" -> DeliveryWords(if (o.via == "pull") "$name's hub fetched it" else "Delivered", FriendTone.DIM)
        "queued" -> if (o.attempts == 0) {
            DeliveryWords("Sending", FriendTone.DIM, cancel = true)
        } else {
            // a short reason fits under a note; a long one (an address and the error) stays on the friend's details
            val err = o.lastError
            val why = if (err != null && err.length <= 70) err else "$name's hub has not taken it yet."
            val next = o.nextTry?.let { "Trying again ${inTime(it, now)}." } ?: ""
            DeliveryWords("Waiting", FriendTone.WARN, listOf(why, next).filter { it.isNotEmpty() }.joinToString(" "), cancel = true)
        }
        "failed" -> DeliveryWords("Not delivered", FriendTone.FAULT, o.lastError ?: "$name's hub could not be reached for 7 days.", retry = true)
        "expired" -> DeliveryWords("Not delivered", FriendTone.FAULT, "It lapsed before it arrived.")
        "cancelled" -> DeliveryWords("Cancelled", FriendTone.DIM)
        else -> DeliveryWords(o.state.replaceFirstChar { it.uppercaseChar() }, FriendTone.DIM)
    }

    /** Why there is no composer on a friend's page, or null when notes can go. */
    fun cannotWrite(f: FriendDto): String? = when {
        f.isPending -> if (f.asked) "Accept ${f.name}'s request to write to them." else "You can write once ${f.name} accepts."
        f.isBlocked -> "Confirm ${f.name}'s new key to write again."
        f.isRemoved -> "You are not friends with ${f.name} any more."
        else -> null
    }

    // ----- read marks and the Inbox -----

    /**
     * Notes from a friend not read yet. The hub keeps one read mark per
     * friend ([FriendDto.readAt]): a note that came after it is new. A hub from
     * before read marks sets neither, and each note's own flag counts.
     */
    fun unreadNotes(f: FriendDto, notes: List<InboxItemDto>): List<InboxItemDto> {
        val note = { n: InboxItemDto -> n.type == "note" && n.state != "failed" }
        if (f.unread == null) return notes.filter { note(it) && it.read == false }
        val mark = f.readAt ?: 0
        return notes.filter { note(it) && it.receivedAt > mark }
    }

    /** A share waits for the owner: an offer, or a newer revision of one accepted. */
    fun shareWaiting(s: ReceivedShareDto): Boolean = s.state == "offered" || (s.state == "accepted" && s.updateWaiting)

    /** A share card counts while it waits for the owner and they have not seen it. */
    fun unreadShare(s: ReceivedShareDto): Boolean = !s.read && shareWaiting(s)

    private fun oneLine(s: String) = s.replace(Regex("""\s+"""), " ").trim()

    /**
     * Requests to accept, key changes to confirm, notes not read yet (one row
     * per friend, with its newest note and how many) and share cards not seen
     * yet (one row each), newest first.
     */
    fun inbox(friends: List<FriendDto>, notes: List<InboxItemDto>, shares: List<ReceivedShareDto> = emptyList()): List<FriendInboxItem> {
        val out = ArrayList<FriendInboxItem>()
        val byId = friends.associateBy { it.id }
        for (f in friends) {
            if (f.isPending && f.asked) out += FriendInboxItem("request:${f.id}", FriendInboxItem.Kind.REQUEST, f.id, f.name, f.createdAt, "Wants to be friends", 1)
            if (f.isBlocked) out += FriendInboxItem("key:${f.id}", FriendInboxItem.Kind.KEY, f.id, f.name, f.lastSeen ?: f.createdAt, "Has a new key. Confirm it before anything more moves.", 1)
            if (f.isRemoved) continue
            val fresh = unreadNotes(f, notes.filter { it.friendId == f.id })
            // the hub counts every note; the app holds the newest few hundred
            val count = maxOf(fresh.size, if (f.unread == null) 0 else f.unreadNotes ?: 0)
            if (count == 0) continue
            val last = fresh.maxByOrNull { it.receivedAt }
            val text = last?.text?.let { oneLine(it) }?.ifEmpty { null } ?: if (last?.state == "fetching") "A note is on its way." else "New notes"
            out += FriendInboxItem("note:${f.id}", FriendInboxItem.Kind.NOTE, f.id, f.name, last?.receivedAt ?: f.readAt ?: f.createdAt, text, count)
        }
        for (s in shares) {
            val f = byId[s.friendId] ?: continue
            if (f.isRemoved || !unreadShare(s)) continue
            val line = if (s.state == "offered") "Sent '${s.title}'" else "Sent revision ${s.revision} of '${s.title}'"
            out += FriendInboxItem("share:${s.id}", FriendInboxItem.Kind.SHARE, f.id, f.name, s.receivedAt, line, 1, s)
        }
        return out.sortedByDescending { it.at }
    }

    /** How many Inbox items friends add: each new note, each request, each key change, each share card. */
    fun waiting(items: List<FriendInboxItem>): Int = items.sumOf { it.count }

    /**
     * What to tell the hub is read once a friend's page shows it: the newest
     * note not read yet, and each share card not read yet. Nothing when all
     * is read.
     */
    fun readTargets(f: FriendDto, notes: List<InboxItemDto>, shares: List<ReceivedShareDto>): List<String> {
        if (f.unread == 0) return emptyList()
        val newest = unreadNotes(f, notes.filter { it.friendId == f.id }).maxByOrNull { it.receivedAt }
        return listOfNotNull(newest?.id) + shares.filter { it.friendId == f.id && unreadShare(it) }.map { it.id }
    }
}
