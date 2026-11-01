package dev.conclave.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// What the app tells the hub's log files about itself (docs/DESIGN.md 33),
// the same as packages/web/src/lib/clientLog.ts: connects and reconnects,
// failed requests with their status and folded path, and what the app adds.
// Batches go to POST /api/logs/client (sendClientLogs in core's client).
// Only event names, statuses, paths with their ids folded and short error
// messages go, never text from a chat.

/** One thing the app reports about itself. */
@Serializable
data class ClientLogEvent(
    val ts: Long? = null,
    /** debug, info, warn or error. */
    val level: String,
    /** A short name: connect, reconnect, request.failed... */
    val event: String,
    /** A short error message. */
    val msg: String? = null,
    /** Small flat facts: status, path, attempt. */
    val fields: Map<String, JsonPrimitive>? = null,
)

@Serializable
data class ClientLogBatch(
    /** android. */
    val app: String,
    val version: String? = null,
    /** "Android 16". */
    val platform: String? = null,
    val events: List<ClientLogEvent>,
)

@Serializable
data class ClientLogResult(val accepted: Int = 0, val dropped: Int = 0)

/** POST /api/logs/client. */
suspend fun ConclaveClient.sendClientLogs(batch: ClientLogBatch): ClientLogResult =
    send("POST", p("api", "logs", "client"), ClientLogBatch.serializer(), batch, ClientLogResult.serializer())

/**
 * Events wait here and go in batches: every [intervalMs], soon after
 * [soonAt] are waiting, or when [flush] is called (the app goes to the
 * background). At most [maxQueue] wait and [perMinute] are taken a minute;
 * the same event again within 10 seconds counts on the one before. A hub
 * without the route (404) stops the sending for this run; offline, 401, 429
 * and 5xx keep the events for the next try; another 4xx drops the batch.
 */
class LogBatcher(
    private val app: String = "android",
    private val version: String? = null,
    private val platform: String? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxQueue: Int = 200,
    private val perMinute: Int = 60,
    private val batchSize: Int = 50,
    private val soonAt: Int = 20,
    private val send: suspend (ClientLogBatch) -> Unit,
) {
    private val lock = Any()
    private val sending = Mutex()
    private val queue = ArrayDeque<ClientLogEvent>()
    private var minute = 0L
    private var inMinute = 0
    private var dropped = 0

    /** A refusal that will not change (an older hub): nothing more is sent. */
    @Volatile
    var off = false
        private set

    /** Set by [start]: a flush soon after [soonAt] events are waiting. */
    @Volatile
    private var soon: (() -> Unit)? = null

    val pending: Int get() = synchronized(lock) { queue.size }
    val droppedCount: Int get() = synchronized(lock) { dropped }

    /** Report one event. Never throws. */
    fun log(level: String, event: String, fields: Map<String, Any?> = emptyMap(), msg: String? = null) {
        if (off) return
        val now = clock()
        val text = msg?.replace(Regex("\\s+"), " ")?.trim()?.take(240)?.ifBlank { null }
        var kick = false
        synchronized(lock) {
            val last = queue.lastOrNull()
            if (last != null && last.event == event && last.msg == text && now - (last.ts ?: 0) < SAME_WITHIN_MS) {
                val f = (last.fields ?: emptyMap()).toMutableMap()
                f["repeats"] = JsonPrimitive(((f["repeats"]?.content?.toIntOrNull()) ?: 1) + 1)
                queue[queue.size - 1] = last.copy(fields = f)
                return
            }
            val m = now / 60_000
            if (m != minute) {
                minute = m
                inMinute = 0
            }
            if (inMinute >= perMinute || queue.size >= maxQueue) {
                dropped++
                return
            }
            inMinute++
            queue.addLast(ClientLogEvent(ts = now, level = level, event = event.take(64), msg = text, fields = prims(fields)))
            kick = queue.size == soonAt
        }
        if (kick) soon?.invoke()
    }

    /** Send what waits, one batch. Returns true when it went (or there was nothing). */
    suspend fun flush(): Boolean = sending.withLock {
        if (off) return false
        val batch = synchronized(lock) {
            if (dropped > 0) {
                queue.addLast(ClientLogEvent(ts = clock(), level = "warn", event = "log.dropped", fields = mapOf("dropped" to JsonPrimitive(dropped))))
                dropped = 0
            }
            queue.take(batchSize)
        }
        if (batch.isEmpty()) return true
        try {
            send(ClientLogBatch(app = app, version = version, platform = platform, events = batch))
            synchronized(lock) { repeat(batch.size) { queue.removeFirstOrNull() } }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: ConclaveApiException) {
            when {
                e.status == 404 -> {
                    off = true
                    synchronized(lock) { queue.clear() }
                }
                e.status in 400..499 && e.status != 401 && e.status != 429 -> synchronized(lock) { repeat(batch.size) { queue.removeFirstOrNull() } }
            }
            false
        } catch (e: Exception) {
            // offline: keep them for the next try
            false
        }
    }

    /** Flush every [intervalMs] in [scope], and soon after many are waiting. */
    fun start(scope: CoroutineScope, intervalMs: Long = 30_000): Job {
        soon = { scope.launch { delay(1000); flush() } }
        return scope.launch {
            while (isActive) {
                delay(intervalMs)
                flush()
            }
        }
    }

    companion object {
        const val SAME_WITHIN_MS = 10_000L

        private fun prims(fields: Map<String, Any?>): Map<String, JsonPrimitive>? {
            if (fields.isEmpty()) return null
            val out = LinkedHashMap<String, JsonPrimitive>()
            for ((k, v) in fields) {
                if (out.size >= 12) break
                out[k.take(40)] = when (v) {
                    null -> JsonNull
                    is Boolean -> JsonPrimitive(v)
                    is Number -> JsonPrimitive(v)
                    else -> JsonPrimitive(v.toString().take(200))
                }
            }
            return out
        }
    }
}

/**
 * The app's one batcher. The client reports failed calls and the live
 * connection to it; the app starts it with one line (HubRepository).
 */
object ClientLogs {
    @Volatile
    var batcher: LogBatcher? = null

    fun log(level: String, event: String, fields: Map<String, Any?> = emptyMap(), msg: String? = null) {
        try {
            batcher?.log(level, event, fields, msg)
        } catch (_: Exception) {
            // logging never breaks the app
        }
    }

    /** Start sending through [send] (the paired client's sendClientLogs). */
    fun start(scope: CoroutineScope, version: String?, platform: String?, send: suspend (ClientLogBatch) -> Unit): LogBatcher {
        val b = LogBatcher(version = version, platform = platform, send = send)
        batcher = b
        b.log("info", "app.start")
        b.start(scope)
        return b
    }

    /** The app's one line: send through whichever client is paired now ([client] may change as the hub moves). */
    fun startFor(scope: CoroutineScope, version: String?, platform: String?, client: () -> ConclaveClient?): LogBatcher =
        start(scope, version, platform) { b -> (client() ?: throw java.io.IOException("not paired")).sendClientLogs(b) }

    /** A failed call: method, folded path and status (0: no answer). The logs route itself is left out. */
    fun requestFailed(method: String, segments: List<String>, status: Int, msg: String?) {
        if (segments.take(3) == listOf("api", "logs", "client")) return
        val level = if (status == 0 || status >= 500 || status == 401 || status == 403) "warn" else "info"
        log(level, "request.failed", mapOf("method" to method, "path" to foldPath(segments), "status" to status), msg)
    }

    /** /api/sessions/ses_0abc12/messages -> /api/sessions/:id/messages */
    fun foldPath(segments: List<String>): String =
        "/" + segments.joinToString("/") { seg ->
            if (ID.matches(seg) || UUID.matches(seg) || (seg.length > 24 && seg.any { it.isDigit() })) ":id" else seg
        }.take(160)

    private val ID = Regex("^[a-z]{1,8}_[A-Za-z0-9]{6,}$")
    private val UUID = Regex("^[0-9a-fA-F-]{16,}$")
}
