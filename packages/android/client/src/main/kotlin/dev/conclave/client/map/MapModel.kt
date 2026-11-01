package dev.conclave.client.map

import dev.conclave.client.ConclaveJson
import dev.conclave.client.model.MapDelta
import dev.conclave.client.model.MapDevice
import dev.conclave.client.model.MapGroup
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapNodePatch
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import dev.conclave.client.model.MapTool
import dev.conclave.client.model.MapUsage
import dev.conclave.client.motion.KnotState
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.max
import kotlin.math.roundToLong

/*
 * The Map's data on the phone (docs/DESIGN.md 29), the same as the web's
 * features/map/model.ts: words for states, the sentence over the map,
 * deltas applied to a snapshot, and where a node opens. Pure, tested in
 * MapModelTest.
 */

/** The color a state takes: violet for live work, amber for what needs you, the fault color for failures; the rest is quiet. */
enum class MapTone { SIGNAL, WARN, FAULT, DIM }

/** A group's agents and how many run or wait. */
data class GroupStats(val agents: Int, val running: Int, val waiting: Int)

/** Where Open chat goes: the chat, the session, or the workflow run. */
sealed class MapOpen {
    data class Chat(val id: String) : MapOpen()
    data class Session(val id: String) : MapOpen()
    data class Run(val runId: String) : MapOpen()
}

object MapWords {

    fun stateWord(s: MapState): String = when (s) {
        MapState.RUNNING -> "running"
        MapState.WAITING -> "waiting on you"
        MapState.IDLE -> "idle"
        MapState.DONE -> "done"
        MapState.FAILED -> "failed"
        MapState.PAUSED -> "paused"
    }

    fun tone(s: MapState): MapTone = when (s) {
        MapState.RUNNING -> MapTone.SIGNAL
        MapState.WAITING -> MapTone.WARN
        MapState.FAILED -> MapTone.FAULT
        else -> MapTone.DIM
    }

    /** Busy nodes: they get color and streams. */
    fun isBusy(s: MapState): Boolean = s == MapState.RUNNING || s == MapState.WAITING

    /** The last four characters of an id, the way a label shows it ("x7k2"). Runs use their run id. */
    fun shortId(id: String): String {
        val raw = if (id.startsWith("wf:")) id.substring(3) else id
        val tail = if (raw.contains('_')) raw.substring(raw.lastIndexOf('_') + 1) else raw
        return tail.takeLast(4)
    }

    /** The hub's state from its nodes: waiting on you before running, then idle. Workflow runs count through their agents. */
    fun hubState(nodes: List<MapNode>): MapState {
        val counted = nodes.filter { it.kind != MapNodeKind.WORKFLOW }
        if (counted.any { it.state == MapState.WAITING }) return MapState.WAITING
        if (counted.any { it.state == MapState.RUNNING }) return MapState.RUNNING
        return MapState.IDLE
    }

    /** The Knot's state for the hub: a tool running lights the knot; offline draws it still in grey. */
    fun hubKnot(state: MapState, nodes: List<MapNode>, online: Boolean): KnotState = when {
        !online -> KnotState.PAUSED
        state == MapState.WAITING -> KnotState.WAITING
        state == MapState.RUNNING -> if (nodes.any { it.state == MapState.RUNNING && it.tool != null }) KnotState.TOOL else KnotState.THINKING
        else -> KnotState.DONE
    }

    /** What runs and what waits, workflow runs left out (their agents count). */
    fun counts(nodes: List<MapNode>): Pair<Int, Int> {
        var running = 0
        var waiting = 0
        for (n in nodes) {
            if (n.kind == MapNodeKind.WORKFLOW) continue
            if (n.state == MapState.RUNNING) running++ else if (n.state == MapState.WAITING) waiting++
        }
        return running to waiting
    }

    fun groupStats(group: String, nodes: List<MapNode>): GroupStats {
        val mine = nodes.filter { it.group == group && it.kind != MapNodeKind.WORKFLOW }
        val (running, waiting) = counts(mine)
        return GroupStats(mine.size, running, waiting)
    }

    /** The group's state for its dot: waiting before running. */
    fun groupState(group: String, nodes: List<MapNode>): MapState {
        val mine = nodes.filter { it.group == group }
        if (mine.any { it.state == MapState.WAITING }) return MapState.WAITING
        if (mine.any { it.state == MapState.RUNNING }) return MapState.RUNNING
        return MapState.IDLE
    }

    fun groupNoun(n: Int, chats: Boolean = false): String = if (chats) (if (n == 1) "chat" else "chats") else if (n == 1) "agent" else "agents"

    /** "4 agents, 2 running, 1 waiting" under a group's name. */
    fun groupLine(stats: GroupStats, chats: Boolean = false): String {
        val parts = arrayListOf("${stats.agents} ${groupNoun(stats.agents, chats)}")
        if (stats.running > 0) parts += "${stats.running} running"
        if (stats.waiting > 0) parts += "${stats.waiting} waiting"
        return parts.joinToString(", ")
    }

    /** Where Open chat goes. */
    fun open(n: MapNode): MapOpen {
        val run = n.runId
        return when {
            n.kind == MapNodeKind.WORKFLOW && run != null -> MapOpen.Run(run)
            n.kind == MapNodeKind.CHAT -> MapOpen.Chat(n.id)
            else -> MapOpen.Session(n.id)
        }
    }

    /** Stop applies to work that is going or waiting. */
    fun canStop(n: MapNode): Boolean = n.state == MapState.RUNNING || n.state == MapState.WAITING || (n.kind == MapNodeKind.WORKFLOW && n.state == MapState.PAUSED)

    /** The nodes that hang off a node, oldest first. */
    fun childrenOf(nodes: List<MapNode>, id: String): List<MapNode> = nodes.filter { it.parentId == id }.sortedBy { it.startedAt }

    /** "No progress 6m" for a stuck node (the stuck alert fills stuckSince). */
    fun stuckWords(n: MapNode, now: Long): String? {
        val since = n.stuckSince ?: return null
        if (since <= 0) return null
        val m = max(1L, Math.round((now - since) / 60_000.0))
        return if (m >= 60) "No progress ${m / 60}h ${m % 60}m" else "No progress ${m}m"
    }

    /** "Session", "Subagent", "Workflow run": what the drawer calls a node. */
    fun kindWord(k: MapNodeKind): String = when (k) {
        MapNodeKind.CHAT -> "Chat"
        MapNodeKind.SESSION -> "Session"
        MapNodeKind.SUBAGENT -> "Subagent"
        MapNodeKind.WORKFLOW -> "Workflow run"
        MapNodeKind.AGENT -> "Workflow agent"
    }

    /** "no", "one" ... "nine", then the number; with [capital] the first letter up. */
    fun countWord(n: Int, capital: Boolean = false): String {
        val w = listOf("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine").getOrNull(n) ?: n.toString()
        return if (capital) w.replaceFirstChar { it.uppercaseChar() } else w
    }

    /**
     * The sentence over the map, in parts so the screen can color them:
     * "Six running, one waiting on you. 3.4M tokens and $8.12 today."
     */
    data class Sentence(val lead: String?, val running: String?, val waiting: String?, val nothing: Boolean, val tail: String)

    fun sentence(snap: MapSnapshot, replay: Long?, online: Boolean, clock: (Long) -> String, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Sentence {
        val (running, waiting) = counts(snap.nodes)
        val lead = when {
            replay != null -> "Replay of ${clockWords(replay, now, clock, zone)}. "
            !online -> "${snap.hub.name.ifBlank { "The hub" }} is offline. "
            else -> null
        }
        val t = snap.totals.today
        val tail = ". ${compact(t.tokens.toDouble())} tokens and ${usd(t.costUsd)} ${if (replay != null) "by then" else "today"}."
        return Sentence(
            lead = lead,
            running = if (running > 0) "${countWord(running, true)} running" else null,
            waiting = if (waiting > 0) "${countWord(waiting, running == 0)} waiting on you" else null,
            nothing = running == 0 && waiting == 0,
            tail = tail,
        )
    }

    /** The sentence as one string, for screen readers and tests. */
    fun sentenceText(s: Sentence): String = buildString {
        s.lead?.let { append(it) }
        if (s.nothing) append("Nothing running")
        s.running?.let { append(it) }
        if (s.running != null && s.waiting != null) append(", ")
        s.waiting?.let { append(it) }
        append(s.tail)
    }

    /** "14:05", or "Yesterday 22:40" when it is not today. */
    fun clockWords(t: Long, now: Long, clock: (Long) -> String, zone: ZoneId = ZoneId.systemDefault()): String {
        val day = Instant.ofEpochMilli(t).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        return if (day == today) clock(t) else "Yesterday ${clock(t)}"
    }

    /** Tick marks for the replay scrubber: every [everyHours] hours on the hour, within [from, to]. */
    fun replayTicks(from: Long, to: Long, everyHours: Int = 3, zone: ZoneId = ZoneId.systemDefault()): List<Long> {
        val out = ArrayList<Long>()
        var t = Instant.ofEpochMilli(from).atZone(zone).truncatedTo(ChronoUnit.HOURS).plusHours(1)
        while (t.toInstant().toEpochMilli() <= to) {
            if (t.hour % everyHours == 0) out.add(t.toInstant().toEpochMilli())
            t = t.plusHours(1)
        }
        return out
    }

    /** "3.4M", "120K", "980": the web's compact numbers. */
    fun compact(n: Double, digits: Int = 1): String {
        if (n.isNaN()) return "0"
        val a = kotlin.math.abs(n)
        val units = listOf(1e9 to "B", 1e6 to "M", 1e3 to "K")
        for ((size, word) in units) {
            if (a < size) continue
            val fixed = if (size == 1e3 && a >= 1e4) 0 else digits
            val s = trimZeros(String.format(java.util.Locale.US, "%.${fixed}f", n / size))
            // 999,950 rounds to "1000K": it reads in the next unit up, "1M"
            if (word != "B" && kotlin.math.abs(s.toDouble()) >= 1000) return compact(Math.signum(n) * size * 1000, digits)
            return s + word
        }
        val r = Math.round(n)
        return if (kotlin.math.abs(r) >= 1000) compact(Math.signum(n) * 1000, digits) else r.toString()
    }

    private fun trimZeros(s: String): String = if (s.contains('.')) s.replace(Regex("""\.0+$"""), "") else s

    /** "$8.12", "$0.04", "<$0.01", "$1.2K". With [precise] small amounts keep their cents. */
    fun usd(v: Double, precise: Boolean = false): String {
        if (v == 0.0) return "$0"
        if (precise || kotlin.math.abs(v) < 1) {
            if (kotlin.math.abs(v) < 0.01) return "<$0.01"
            return "$" + String.format(java.util.Locale.US, "%.2f", v)
        }
        if (kotlin.math.abs(v) >= 1000) return "$" + compact(v)
        return "$" + String.format(java.util.Locale.US, "%.2f", v)
    }

    /** "140ms", "1.8s", "48s", "5m 12s": a tool's duration. */
    fun duration(ms: Long): String = when {
        ms < 1000 -> "${ms}ms"
        ms < 60_000 -> String.format(java.util.Locale.US, if (ms < 10_000) "%.1fs" else "%.0fs", ms / 1000.0)
        else -> "${ms / 60_000}m ${Math.round((ms % 60_000) / 1000.0)}s"
    }

    /** "4m", "1h 12m": how long, short. */
    fun durationShort(ms: Long): String {
        val s = max(0L, Math.round(ms / 1000.0))
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 60) return "${m}m"
        val h = m / 60
        if (h < 24) return if (m % 60 != 0L) "${h}h ${m % 60}m" else "${h}h"
        val d = h / 24
        return if (h % 24 != 0L) "${d}d ${h % 24}h" else "${d}d"
    }

    /** "1h 23m", "4m 05s": until a limit resets. */
    fun countdown(ts: Long, now: Long): String {
        var d = max(0L, ts - now)
        if (d < 1000) return "now"
        val days = d / 86_400_000
        d -= days * 86_400_000
        val h = d / 3_600_000
        d -= h * 3_600_000
        val m = d / 60_000
        val s = (d - m * 60_000) / 1000
        return when {
            days > 0 -> "${days}d ${h}h"
            h > 0 -> "${h}h ${m.toString().padStart(2, '0')}m"
            m > 0 -> "${m}m ${s.toString().padStart(2, '0')}s"
            else -> "${s}s"
        }
    }

    /** The drawer's line after the state: "for 4m", "resumes in 1h 23m", or when it ended. */
    fun stateDetail(n: MapNode, at: Long, clock: (Long) -> String): String? {
        val ended = n.endedAt
        val resume = n.resumeAt
        return when {
            isBusy(n.state) -> "for ${durationShort(at - n.startedAt)}"
            n.state == MapState.PAUSED && resume != null -> "resumes in ${countdown(resume, at)}"
            ended != null -> "at ${clock(ended)}"
            else -> null
        }
    }

    /** "Writing", "Thinking" or "Nothing running": the drawer's Now when no tool runs. */
    fun nowWords(n: MapNode): String = when {
        n.state != MapState.RUNNING -> "Nothing running"
        n.rate > 0 -> "Writing"
        else -> "Thinking"
    }

    /** "It waits for your approval." or "It asked you a question.", while it waits. */
    fun waitingWords(n: MapNode): String? = if (n.state != MapState.WAITING) null else if (n.waitingOn == "question") "It asked you a question." else "It waits for your approval."

    /** "just now" or "4m ago": the last activity. */
    fun lastActivity(n: MapNode, at: Long): String = if (at - n.lastActivityAt < 45_000) "just now" else "${durationShort(at - n.lastActivityAt)} ago"

    /** How long it ran: until it ended, now while busy, else its last activity. */
    fun runFor(n: MapNode, at: Long): Long = max(0L, (n.endedAt ?: if (isBusy(n.state)) at else n.lastActivityAt) - n.startedAt)

    /** The client's Date#getTimezoneOffset(): minutes behind UTC (UTC+2 is -120). */
    fun tzOffset(zone: ZoneId = ZoneId.systemDefault(), at: Long = System.currentTimeMillis()): Int =
        -zone.rules.getOffset(Instant.ofEpochMilli(at)).totalSeconds / 60
}

/** map.delta events: read from JSON, applied to a snapshot. */
object MapDeltas {

    private val toolList = ListSerializer(MapTool.serializer())

    /** The event's delta, or null when it is not one. A null field ("tool": null) is told from one that is not there. */
    fun parse(delta: JsonObject): MapDelta? {
        val at = (delta["at"] as? JsonPrimitive)?.longOrNull ?: (delta["at"] as? JsonPrimitive)?.doubleOrNull?.roundToLong() ?: return null
        val nodes = (delta["nodes"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::patch) } ?: emptyList()
        val groups = decodeList(delta["groups"], MapGroup.serializer())
        val devices = decodeList(delta["devices"], MapDevice.serializer())
        val hub = (delta["hub"] as? JsonObject)?.let { MapState.of(str(it["state"])) }
        return MapDelta(at, nodes, groups, devices, hub)
    }

    private fun <T> decodeList(el: JsonElement?, ser: kotlinx.serialization.KSerializer<T>): List<T> {
        val arr = el as? kotlinx.serialization.json.JsonArray ?: return emptyList()
        return arr.mapNotNull { runCatching { ConclaveJson.decodeFromJsonElement(ser, it) }.getOrNull() }
    }

    private fun str(el: JsonElement?): String? = (el as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun num(el: JsonElement?): Double? = (el as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

    private fun patch(o: JsonObject): MapNodePatch? {
        val id = str(o["id"]) ?: return null
        val node = (o["node"] as? JsonObject)?.let { runCatching { ConclaveJson.decodeFromJsonElement(MapNode.serializer(), it) }.getOrNull() }
        return MapNodePatch(
            id = id,
            node = node,
            removed = (o["removed"] as? JsonPrimitive)?.booleanOrNull == true,
            state = MapState.of(str(o["state"])),
            waitingOn = str(o["waitingOn"]),
            clearWaitingOn = o["waitingOn"] is JsonNull,
            title = str(o["title"]),
            tool = (o["tool"] as? JsonObject)?.let { runCatching { ConclaveJson.decodeFromJsonElement(MapTool.serializer(), it) }.getOrNull() },
            clearTool = o["tool"] is JsonNull,
            done = o["done"]?.let { runCatching { ConclaveJson.decodeFromJsonElement(toolList, it) }.getOrNull() } ?: emptyList(),
            usage = (o["usage"] as? JsonObject)?.let { runCatching { ConclaveJson.decodeFromJsonElement(MapUsage.serializer(), it) }.getOrNull() },
            tokensPerMin = num(o["tokensPerMin"]),
            rate = num(o["rate"]),
            lastActivityAt = num(o["lastActivityAt"])?.roundToLong(),
            endedAt = num(o["endedAt"])?.roundToLong(),
            error = str(o["error"]),
        )
    }

    private fun usageGrew(a: MapUsage?, b: MapUsage): Pair<Long, Double> {
        val tokens = b.inputTokens + b.outputTokens - ((a?.inputTokens ?: 0) + (a?.outputTokens ?: 0))
        val cost = b.costUsd - (a?.costUsd ?: 0.0)
        return max(0L, tokens) to max(0.0, cost)
    }

    /**
     * A delta applied to a snapshot. Returns a new snapshot (the old one is
     * not changed). Usage that grew adds to today's totals; finished tools go
     * to the front of the recent list; a whole node replaces the one it names.
     */
    fun apply(snap: MapSnapshot, delta: MapDelta): MapSnapshot {
        val nodes = LinkedHashMap<String, MapNode>()
        for (n in snap.nodes) nodes[n.id] = n
        var tokens = snap.totals.today.tokens
        var cost = snap.totals.today.costUsd
        var groups = snap.groups
        var devices = snap.devices
        if (delta.groups.isNotEmpty()) {
            val g = LinkedHashMap<String, MapGroup>()
            for (x in groups) g[x.id] = x
            for (x in delta.groups) g[x.id] = x
            groups = g.values.toList()
        }
        if (delta.devices.isNotEmpty()) {
            val d = LinkedHashMap<String, MapDevice>()
            for (x in devices) d[x.id] = x
            for (x in delta.devices) d[x.id] = x
            devices = d.values.toList()
        }
        for (p in delta.nodes) {
            val old = nodes[p.id]
            if (p.removed) {
                nodes.remove(p.id)
                continue
            }
            val whole = p.node
            if (whole != null) {
                if (old != null) {
                    val (t, c) = usageGrew(old.usage, whole.usage)
                    tokens += t
                    cost += c
                }
                nodes[p.id] = whole
                continue
            }
            if (old == null) continue
            var next: MapNode = old
            p.state?.let { next = next.copy(state = it) }
            if (p.clearWaitingOn) next = next.copy(waitingOn = null) else p.waitingOn?.let { next = next.copy(waitingOn = it) }
            p.title?.takeIf { it.isNotEmpty() }?.let { next = next.copy(title = it) }
            if (p.clearTool) next = next.copy(tool = null) else p.tool?.let { next = next.copy(tool = it) }
            if (p.done.isNotEmpty()) {
                val seen = p.done.mapNotNull { it.id }.toSet()
                next = next.copy(tools = (p.done.asReversed() + old.tools.filter { it.id == null || it.id !in seen }).take(5))
            }
            p.usage?.let { u ->
                val (t, c) = usageGrew(old.usage, u)
                tokens += t
                cost += c
                next = next.copy(usage = u)
            }
            p.tokensPerMin?.let { next = next.copy(tokensPerMin = it) }
            p.rate?.let { next = next.copy(rate = it) }
            p.lastActivityAt?.takeIf { it > 0 }?.let { next = next.copy(lastActivityAt = max(old.lastActivityAt, it)) }
            p.endedAt?.takeIf { it > 0 }?.let { next = next.copy(endedAt = it) }
            p.error?.takeIf { it.isNotEmpty() }?.let { next = next.copy(error = it) }
            nodes[p.id] = next
        }
        // a node whose parent left the map stands on its own
        val list = nodes.values.map { n ->
            val parent = n.parentId
            if (parent != null && !nodes.containsKey(parent)) n.copy(parentId = null) else n
        }
        val (running, waiting) = MapWords.counts(list)
        return snap.copy(
            at = max(snap.at, delta.at),
            groups = groups,
            devices = devices,
            nodes = list,
            hub = snap.hub.copy(state = delta.hubState ?: MapWords.hubState(list)),
            totals = snap.totals.copy(running = running, waiting = waiting, today = snap.totals.today.copy(tokens = tokens, costUsd = cost)),
        )
    }
}
