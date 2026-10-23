package dev.conclave.client

import dev.conclave.client.model.AgentDef
import dev.conclave.client.model.AppDto
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.AuditEntry
import dev.conclave.client.model.BtwAnswer
import dev.conclave.client.model.Checkpoint
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.CommandResult
import dev.conclave.client.model.ConfigResponse
import dev.conclave.client.model.ChatSettingsPatch
import dev.conclave.client.model.CreateSessionInput
import dev.conclave.client.model.Device
import dev.conclave.client.model.DevicePatch
import dev.conclave.client.model.DiffResult
import dev.conclave.client.model.ExportResult
import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.FileContent
import dev.conclave.client.model.FileEntry
import dev.conclave.client.model.GatewayKey
import dev.conclave.client.model.HubIdentity
import dev.conclave.client.model.HubInfo
import dev.conclave.client.model.IdentityProof
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.LoginRequest
import dev.conclave.client.model.McpStatus
import dev.conclave.client.model.MemoryEntry
import dev.conclave.client.model.MemoryInput
import dev.conclave.client.model.MemoryKind
import dev.conclave.client.model.MemoryScope
import dev.conclave.client.model.MemoryStats
import dev.conclave.client.model.Message
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.NextModelResult
import dev.conclave.client.model.NotifyChannel
import dev.conclave.client.model.PairRequest
import dev.conclave.client.model.PairResponse
import dev.conclave.client.model.PairingInfo
import dev.conclave.client.model.PasswordStatus
import dev.conclave.client.model.ProviderTestResult
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.ReflectInfo
import dev.conclave.client.model.ReflectNow
import dev.conclave.client.model.ReflectPatch
import dev.conclave.client.model.SwitchEstimate
import dev.conclave.client.model.TailscaleInfo
import dev.conclave.client.model.CloudflareZones
import dev.conclave.client.model.CloudflareZone
import dev.conclave.client.model.RemoteMode
import dev.conclave.client.model.RemoteStatus
import dev.conclave.client.model.HealthInfo
import dev.conclave.client.model.Routine
import dev.conclave.client.model.RoutineInput
import dev.conclave.client.model.RoutineRun
import dev.conclave.client.model.SchedulePreview
import dev.conclave.client.model.SearchHit
import dev.conclave.client.model.SecondOpinionInput
import dev.conclave.client.model.SendInput
import dev.conclave.client.model.SendResult
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.SkillDef
import dev.conclave.client.model.StartTaskInput
import dev.conclave.client.model.SyncResult
import dev.conclave.client.model.Task
import dev.conclave.client.model.TaskInput
import dev.conclave.client.model.TaskStatus
import dev.conclave.client.model.Todo
import dev.conclave.client.model.ToolInfo
import dev.conclave.client.model.UsageRecord
import dev.conclave.client.model.UsageSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.min

/**
 * Non-2xx reply from the hub. [message] is the hub's "error" field when present.
 * [retryAfterSeconds] is set from the retry-after header, as on a 429 after
 * too many failed tries from one address.
 */
class ConclaveApiException(
    val status: Int,
    message: String,
    val body: String? = null,
    val retryAfterSeconds: Long? = null,
) : IOException(message)

enum class ConnectionState { CONNECTING, OPEN, CLOSED }

/** Items emitted by [ConclaveClient.live]. */
sealed class LiveEvent {
    data class Status(val state: ConnectionState) : LiveEvent()
    data class Event(val envelope: dev.conclave.client.model.EventEnvelope) : LiveEvent()

    /** Connected: the hub's seq now. A caller with no seq of its own starts from it, so its next connect can replay. */
    data class Hello(val seq: Long) : LiveEvent()

    /** The hub could not replay missed events, or it restarted: refetch everything. */
    data class Resync(val seq: Long) : LiveEvent()

    /**
     * The hub refused the connection: 401 (this token is not valid there),
     * 403 (the hub does not take connections from this network) or 429 (too
     * many failed tries from this address; wait [retryAfterSeconds]). The
     * next try waits longer than a plain disconnect.
     */
    data class Rejected(val status: Int, val message: String?, val retryAfterSeconds: Long? = null) : LiveEvent()

    /**
     * The machine at [address] did not prove the hub's key: the socket was
     * not opened and the token not sent. The next try, after the usual
     * backoff, checks again.
     */
    data class NotYourHub(val address: String, val message: String) : LiveEvent()
}

/**
 * Typed HTTP + WebSocket client for the Conclave hub.
 * Kotlin mirror of packages/core/src/client/index.ts (the API contract).
 *
 * The token is only ever sent in the Authorization header. It is never logged.
 * With [identity], the hub at [baseUrl] proves its key before anything with
 * the token goes there (HubIdentity.kt).
 */
class ConclaveClient(
    baseUrl: String,
    val token: String? = null,
    private val http: OkHttpClient = defaultHttpClient(),
    internal val json: Json = ConclaveJson,
    /** The pinned key and its checks, shared by the clients of one pairing. Null: no check. */
    val identity: HubIdentityGuard? = null,
    /** Checks the hub's signatures. The app passes Tink. */
    val verifier: Ed25519Verifier = JdkEd25519,
) {
    val baseUrl: String = baseUrl.trim().trimEnd('/')
    private val base: HttpUrl = this.baseUrl.toHttpUrl()

    // ---------------------------------------------------------------- plumbing

    /** The hub URL for [segments]; null and empty query values are left out. */
    private fun url(segments: List<String>, query: Map<String, Any?>): HttpUrl {
        val b = base.newBuilder()
        segments.forEach { b.addPathSegment(it) }
        for ((k, v) in query) {
            if (v == null) continue
            val s = v.toString()
            if (s.isEmpty()) continue
            b.addQueryParameter(k, s)
        }
        return b.build()
    }

    /**
     * Builds a path from fixed parts and ids. Ids are path-encoded by OkHttp.
     * The helpers below are internal so each feature keeps its calls in its
     * own file (ConclaveClientProjects.kt, ConclaveClientWorkflows.kt,
     * ConclaveClientImport.kt) instead of all in this one.
     */
    internal fun p(vararg parts: String): List<String> = parts.toList()

    /** With [auth] false the call carries no token and needs no identity check (pairing, health, identity). */
    internal suspend fun <T> call(
        method: String,
        segments: List<String>,
        query: Map<String, Any?>,
        body: String?,
        deserializer: KSerializer<T>?,
        auth: Boolean = true,
    ): T? {
        val reqBuilder = Request.Builder().url(url(segments, query))
        if (auth && token != null) {
            // the token goes only to an address that proved the hub's key
            identity?.ensure(this)
            reqBuilder.header("Authorization", "Bearer $token")
        }
        val reqBody = body?.toRequestBody(JSON_MEDIA)
        if (reqBody != null) {
            reqBuilder.method(method, reqBody)
        } else if (method == "POST" || method == "PUT" || method == "PATCH") {
            reqBuilder.method(method, ByteArray(0).toRequestBody(null))
        } else {
            reqBuilder.method(method, null)
        }
        val (response, text) = try {
            http.newCall(reqBuilder.build()).readText()
        } catch (e: IOException) {
            // the hub's log files hear about it (ClientLogs.kt): no answer is status 0
            ClientLogs.requestFailed(method, segments, 0, e.message)
            throw e
        }
        if (!response.isSuccessful) {
            val msg = errorMessage(text) ?: response.message.ifBlank { "HTTP ${response.code}" }
            ClientLogs.requestFailed(method, segments, response.code, msg)
            throw ConclaveApiException(response.code, msg, text, retryAfter(response.header("retry-after")))
        }
        if (deserializer == null) return null
        if (text.isBlank()) throw ConclaveApiException(response.code, "Empty response", text)
        // a long transcript is megabytes of JSON: not on the caller's (often the main) thread either
        return withContext(Dispatchers.Default) { json.decodeFromString(deserializer, text) }
    }

    /**
     * GET with the token, the body as bytes and its content type (a map
     * picture). The same checks as [call]: the address proves the hub's key
     * first, and a non-2xx answer throws with the hub's words.
     */
    internal suspend fun getBytes(segments: List<String>): Pair<ByteArray, String> {
        val reqBuilder = Request.Builder().url(url(segments, emptyMap())).get()
        if (token != null) {
            identity?.ensure(this)
            reqBuilder.header("Authorization", "Bearer $token")
        }
        val (response, bytes) = http.newCall(reqBuilder.build()).readBytes()
        if (!response.isSuccessful) {
            val text = bytes.decodeToString()
            val msg = errorMessage(text) ?: response.message.ifBlank { "HTTP ${response.code}" }
            throw ConclaveApiException(response.code, msg, text, retryAfter(response.header("retry-after")))
        }
        return bytes to (response.header("content-type") ?: "")
    }

    private fun errorMessage(text: String): String? = try {
        val el = json.parseToJsonElement(text)
        ((el as? JsonObject)?.get("error") as? JsonPrimitive)?.contentOrNull
    } catch (_: Exception) {
        text.takeIf { it.isNotBlank() && it.length < 300 }
    }

    internal suspend fun <T> get(segments: List<String>, de: KSerializer<T>, query: Map<String, Any?> = emptyMap()): T =
        call("GET", segments, query, null, de)!!

    internal suspend fun <T, B> send(method: String, segments: List<String>, bodySer: KSerializer<B>, body: B, de: KSerializer<T>): T =
        call(method, segments, emptyMap(), json.encodeToString(bodySer, body), de)!!

    internal suspend fun <T> sendJson(method: String, segments: List<String>, body: JsonElement?, de: KSerializer<T>): T =
        call(method, segments, emptyMap(), body?.toString(), de)!!

    /** For routes that answer { ok: true }: the body is ignored. */
    internal suspend fun sendUnit(method: String, segments: List<String>, body: JsonElement? = null) {
        call<Unit>(method, segments, emptyMap(), body?.toString(), null)
    }

    internal suspend fun <B> sendUnit(method: String, segments: List<String>, bodySer: KSerializer<B>, body: B) {
        call<Unit>(method, segments, emptyMap(), json.encodeToString(bodySer, body), null)
    }

    // ---------------------------------------------------------------- hub

    suspend fun info(): HubInfo = get(p("api", "info"), HubInfo.serializer())

    /** GET /api/health. Sends no token: true when a Conclave hub answers at this address. */
    suspend fun health(): HealthInfo = call("GET", p("api", "health"), emptyMap(), null, HealthInfo.serializer(), auth = false)!!

    /**
     * Exchange a pairing code for a client token (no auth needed). With
     * [fingerprint] (the QR code's fp) the address first proves it is the hub
     * that made the code; a mismatch throws [HubIdentityException] before the
     * code is sent. The reply's identity is then the key that address proved.
     */
    suspend fun pair(code: String, name: String, platform: String = "android", fingerprint: String? = null): PairResponse {
        val proven = fingerprint?.let { proveIdentity(expectedFingerprint = it, mismatch = HubIdentityException.NOT_THE_CODES_HUB) }
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code, name, platform))
        val res = call("POST", p("api", "pair"), emptyMap(), body, PairResponse.serializer(), auth = false)!!
        if (proven == null) return res
        val claimed = res.identity
        if (claimed != null && !HubKeys.sameKey(claimed.publicKey, proven.publicKey)) {
            throw HubIdentityException(baseUrl, HubIdentityException.NOT_THE_CODES_HUB)
        }
        return res.copy(identity = proven)
    }

    /**
     * Log in with the hub's password, the backup to a pairing code (no auth
     * needed); off until the owner sets one. The reply is the same as pair's.
     * Over plain http to a public address it refuses before sending
     * ([PasswordOverHttpException]).
     */
    suspend fun login(password: String, name: String, platform: String = "android", account: String? = null): PairResponse {
        if (!PasswordRule.allowed(baseUrl)) throw PasswordOverHttpException()
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(password, name, platform, account?.trim()?.ifEmpty { null }))
        return call("POST", p("api", "login"), emptyMap(), body, PairResponse.serializer(), auth = false)!!
    }

    /** GET /api/identity: the hub's key and its signature of the nonce (no auth needed). */
    suspend fun identity(nonce: String): IdentityProof =
        call("GET", p("api", "identity"), mapOf("nonce" to nonce), null, IdentityProof.serializer(), auth = false)!!

    /**
     * Asks the hub at this address to prove its key with a fresh nonce (the
     * TypeScript client's checkIdentity). With [expectedKey] it must be that
     * key, with [expectedFingerprint] a key with that fingerprint, with
     * neither any key that signs (the first answer is trusted). The proof's
     * own fingerprint must be its key's.
     *
     * A stranger throws [HubIdentityException] with [mismatch]: a wrong key, a
     * bad signature, a 4xx other than 429, or an answer that is not a proof (a
     * captive portal page). No answer throws the IOException as it is (the hub
     * is offline, not a stranger); a 5xx, a 429 or the hub's network refusal
     * (403 with code "network") stays a [ConclaveApiException].
     */
    suspend fun proveIdentity(
        expectedKey: String? = null,
        expectedFingerprint: String? = null,
        mismatch: String = HubIdentityException.NOT_YOUR_HUB,
    ): HubIdentity {
        val nonce = HubKeys.nonce()
        val proof = try {
            identity(nonce)
        } catch (e: ConclaveApiException) {
            // the hub's own network refusal says so; anything could send it, so the message is ours and nothing is sent either way
            if (e.status == 403 && e.body != null && NETWORK_CODE.containsMatchIn(e.body)) throw ConclaveApiException(403, HubIdentityException.NETWORK_REFUSED, e.body)
            // 2xx here is an empty answer: not a proof either
            if (e.status in 200..499 && e.status != 429) throw HubIdentityException(baseUrl, mismatch)
            throw e
        } catch (_: SerializationException) {
            throw HubIdentityException(baseUrl, mismatch)
        }
        val raw = HubKeys.rawKey(proof.publicKey) ?: throw HubIdentityException(baseUrl, mismatch)
        val fp = HubKeys.fingerprint(raw)
        if (proof.fingerprint != fp) throw HubIdentityException(baseUrl, mismatch)
        if (expectedKey != null && !HubKeys.sameKey(expectedKey, proof.publicKey)) throw HubIdentityException(baseUrl, mismatch)
        if (expectedFingerprint != null && !HubKeys.sameFingerprint(expectedFingerprint, fp)) throw HubIdentityException(baseUrl, mismatch)
        if (!HubKeys.verify(raw, nonce, proof.signature, verifier)) throw HubIdentityException(baseUrl, mismatch)
        return HubIdentity(HubKeys.encode(raw), fp)
    }

    /** GET /api/auth/password (owner only): whether password login is on. */
    suspend fun passwordStatus(): PasswordStatus = get(p("api", "auth", "password"), PasswordStatus.serializer())

    /** PUT /api/auth/password (owner only): 12 characters or more. */
    suspend fun setPassword(password: String): PasswordStatus =
        sendJson("PUT", p("api", "auth", "password"), buildJsonObject { put("password", password) }, PasswordStatus.serializer())

    /** DELETE /api/auth/password (owner only): password login off. */
    suspend fun clearPassword(): PasswordStatus = call("DELETE", p("api", "auth", "password"), emptyMap(), null, PasswordStatus.serializer())!!

    /**
     * POST /api/pairing: a code of [kind] ("client" for an app, "device" for
     * a computer's daemon) that pairs to the caller's own account.
     */
    suspend fun createPairing(kind: String): PairingInfo =
        sendJson("POST", p("api", "pairing"), buildJsonObject { put("kind", kind) }, PairingInfo.serializer())

    /** GET /api/clients: the apps paired to this account, signed out ones too (revoked). */
    suspend fun apps(): List<AppDto> = get(p("api", "clients"), ListSerializer(AppDto.serializer()))

    // ---------------------------------------------------------------- remote access

    suspend fun remote(): RemoteStatus = get(p("api", "remote"), RemoteStatus.serializer())

    /**
     * PUT /api/remote. Null fields keep their value. [url] is the own address
     * for the tailscale and custom modes; [clearUrl] removes it (sends null).
     */
    suspend fun setRemote(mode: RemoteMode? = null, lan: Boolean? = null, url: String? = null, clearUrl: Boolean = false): RemoteStatus =
        sendJson("PUT", p("api", "remote"), remoteSettingsJson(mode, lan, url, clearUrl), RemoteStatus.serializer())

    internal fun remoteSettingsJson(mode: RemoteMode?, lan: Boolean?, url: String?, clearUrl: Boolean): JsonObject = buildJsonObject {
        if (mode != null) put("mode", mode.wire)
        if (lan != null) put("lan", lan)
        if (clearUrl) put("url", JsonNull) else if (url != null) put("url", url)
    }

    /** Quick tunnel: a new address. Apps get remote.updated with it before the old one stops. 409 when no tunnel mode is set. */
    suspend fun restartRemote(): RemoteStatus = sendJson("POST", p("api", "remote", "restart"), null, RemoteStatus.serializer())

    /** Check and save a Cloudflare API token on the hub; returns the domains it can edit. */
    suspend fun cloudflareToken(token: String): List<CloudflareZone> =
        sendJson("POST", p("api", "remote", "cloudflare"), buildJsonObject { put("token", token) }, CloudflareZones.serializer()).zones

    suspend fun cloudflareZones(): List<CloudflareZone> = get(p("api", "remote", "cloudflare", "zones"), CloudflareZones.serializer()).zones

    /** Make the named tunnel and the DNS name ([name] in front of the zone, "conclave" by default). */
    suspend fun setupStableTunnel(zoneId: String, name: String? = null): RemoteStatus = sendJson(
        "POST", p("api", "remote", "stable"),
        buildJsonObject {
            put("zoneId", zoneId)
            if (!name.isNullOrBlank()) put("name", name)
        },
        RemoteStatus.serializer(),
    )

    /** Delete the named tunnel and its DNS name at Cloudflare. [RemoteStatus.warning] says what could not be removed. */
    suspend fun removeStableTunnel(): RemoteStatus = call("DELETE", p("api", "remote", "stable"), emptyMap(), null, RemoteStatus.serializer())!!

    suspend fun tailscaleInfo(): TailscaleInfo = get(p("api", "remote", "tailscale"), TailscaleInfo.serializer())

    // ---------------------------------------------------------------- sessions

    suspend fun listSessions(
        agent: String? = null,
        taskId: String? = null,
        archived: Boolean? = null,
        search: String? = null,
        device: String? = null,
        limit: Int? = null,
        parentId: String? = null,
        /** CHAT lists chats only, AGENT workbench sessions only (old ones too); null lists both. */
        kind: SessionKind? = null,
    ): List<Session> = get(
        p("api", "sessions"),
        ListSerializer(Session.serializer()),
        mapOf("agent" to agent, "taskId" to taskId, "archived" to archived, "search" to search, "device" to device, "limit" to limit, "parentId" to parentId, "kind" to kind?.wire),
    )

    suspend fun getSession(id: String): Session = get(p("api", "sessions", id), Session.serializer())

    suspend fun createSession(input: CreateSessionInput): Session =
        send("POST", p("api", "sessions"), CreateSessionInput.serializer(), input, Session.serializer())

    suspend fun updateSession(id: String, patch: SessionPatch): Session =
        sendJson("PATCH", p("api", "sessions", id), sessionPatchJson(patch), Session.serializer())

    /** Change some of a chat's switches. */
    suspend fun updateChat(id: String, chat: ChatSettingsPatch): Session = updateSession(id, SessionPatch(chat = chat))

    /** The PATCH body: null fields are left out, except chat.thinking when it goes back to the agent's setting. */
    internal fun sessionPatchJson(patch: SessionPatch): JsonObject {
        val body = json.encodeToJsonElement(SessionPatch.serializer(), patch) as JsonObject
        val chat = patch.chat ?: return body
        if (!chat.agentThinking) return body
        val switches = (body["chat"] as? JsonObject).orEmpty() + ("thinking" to JsonNull)
        return JsonObject(body + ("chat" to JsonObject(switches)))
    }

    suspend fun deleteSession(id: String) = sendUnit("DELETE", p("api", "sessions", id))

    /** Move to main list: delegated work becomes a normal session of its kind; parentId stays (docs/DESIGN.md 43). */
    suspend fun moveToMainList(id: String): Session = sendJson("POST", p("api", "sessions", id, "main-list"), null, Session.serializer())

    suspend fun forkSession(id: String, fromSeq: Long? = null): Session = sendJson(
        "POST", p("api", "sessions", id, "fork"),
        buildJsonObject { if (fromSeq != null) put("fromSeq", fromSeq) },
        Session.serializer(),
    )

    suspend fun messages(id: String, afterSeq: Long? = null): List<Message> =
        get(p("api", "sessions", id, "messages"), ListSerializer(Message.serializer()), mapOf("afterSeq" to afterSeq))

    suspend fun send(id: String, input: SendInput): SendResult =
        send("POST", p("api", "sessions", id, "messages"), SendInput.serializer(), input, SendResult.serializer())

    suspend fun abort(id: String) = sendUnit("POST", p("api", "sessions", id, "abort"))

    /** Messages waiting while the session is busy, in the order they will run (session.queue keeps it current). */
    suspend fun queue(id: String): List<QueuedMessage> =
        get(p("api", "sessions", id, "queue"), ListSerializer(QueuedMessage.serializer()))

    /** Take a waiting message off before it runs: 409 once its turn started, 404 when it is gone. */
    suspend fun unqueue(id: String, pendingId: String) = sendUnit("DELETE", p("api", "sessions", id, "queue", pendingId))

    /** Send a waiting message Stop held (QueuedMessage.held): 404 when it is gone. */
    suspend fun sendQueued(id: String, pendingId: String) = sendUnit("POST", p("api", "sessions", id, "queue", pendingId, "send"))

    /** /btw: a side question answered apart from the transcript; the running turn never sees it. */
    suspend fun btw(id: String, text: String): BtwAnswer =
        sendJson("POST", p("api", "sessions", id, "btw"), buildJsonObject { put("text", text) }, BtwAnswer.serializer())

    suspend fun rewind(id: String, seq: Long, restoreFiles: Boolean = false): Session = sendJson(
        "POST", p("api", "sessions", id, "rewind"),
        buildJsonObject { put("seq", seq); put("restoreFiles", restoreFiles) },
        Session.serializer(),
    )

    suspend fun secondOpinion(id: String, input: SecondOpinionInput) =
        sendUnit("POST", p("api", "sessions", id, "second-opinion"), SecondOpinionInput.serializer(), input)

    /** Switch the session's model; [brief] asks for a short handover (the default keeps the full history). */
    suspend fun handoff(id: String, model: String, brief: Boolean = false): Session =
        sendJson("POST", p("api", "sessions", id, "handoff"), buildJsonObject { put("model", model); if (brief) put("brief", true) }, Session.serializer())

    /**
     * "Try the next model" on a refused reply (Refusal fallback): the hub
     * drops the reply and runs the turn again on the next model and account
     * of the owner's list. [messageId] is the refused reply; the hub answers
     * 409 when it is not the last one. Says which model it tries.
     */
    suspend fun tryNextModel(id: String, messageId: String? = null): NextModelResult = sendJson(
        "POST", p("api", "sessions", id, "next-model"),
        buildJsonObject { if (messageId != null) put("messageId", messageId) },
        NextModelResult.serializer(),
    )

    /** What switching to [model] would cost, against staying. */
    suspend fun switchEstimate(id: String, model: String): SwitchEstimate =
        get(p("api", "sessions", id, "switch-estimate"), SwitchEstimate.serializer(), mapOf("model" to model))

    suspend fun compact(id: String) = sendUnit("POST", p("api", "sessions", id, "compact"))

    suspend fun command(id: String, line: String): CommandResult =
        sendJson("POST", p("api", "sessions", id, "command"), buildJsonObject { put("line", line) }, CommandResult.serializer())

    suspend fun todos(id: String): List<Todo> = get(p("api", "sessions", id, "todos"), ListSerializer(Todo.serializer()))

    suspend fun checkpoints(id: String): List<Checkpoint> =
        get(p("api", "sessions", id, "checkpoints"), ListSerializer(Checkpoint.serializer()))

    suspend fun restoreCheckpoint(id: String, checkpointId: String) =
        sendUnit("POST", p("api", "sessions", id, "checkpoints", checkpointId, "restore"))

    suspend fun diff(id: String): DiffResult = get(p("api", "sessions", id, "diff"), DiffResult.serializer())

    suspend fun exportSession(id: String, format: String = "md"): ExportResult =
        get(p("api", "sessions", id, "export"), ExportResult.serializer(), mapOf("format" to format))

    suspend fun search(q: String): List<SearchHit> = get(p("api", "search"), ListSerializer(SearchHit.serializer()), mapOf("q" to q))

    // ---------------------------------------------------------------- approvals and questions

    suspend fun approvals(): List<ApprovalRequest> = get(p("api", "approvals"), ListSerializer(ApprovalRequest.serializer()))

    suspend fun resolveApproval(id: String, response: ApprovalResponse) =
        sendUnit("POST", p("api", "approvals", id), ApprovalResponse.serializer(), response)

    suspend fun questions(): List<QuestionRequest> = get(p("api", "questions"), ListSerializer(QuestionRequest.serializer()))

    suspend fun answerQuestion(id: String, answers: Map<String, String>) {
        val body = buildJsonObject {
            put("answers", json.encodeToJsonElement(MapSerializer(String.serializer(), String.serializer()), answers))
        }
        sendUnit("POST", p("api", "questions", id), body)
    }

    // ---------------------------------------------------------------- models, agents, extensions

    suspend fun models(): List<ModelGroup> = get(p("api", "models"), ListSerializer(ModelGroup.serializer()))

    suspend fun testProvider(provider: String): ProviderTestResult =
        sendJson("POST", p("api", "providers", provider, "test"), null, ProviderTestResult.serializer())

    suspend fun agents(): List<AgentDef> = get(p("api", "agents"), ListSerializer(AgentDef.serializer()))

    suspend fun saveAgent(def: AgentDef, scope: String = "user"): AgentDef {
        val obj = json.encodeToJsonElement(AgentDef.serializer(), def) as JsonObject
        val body = JsonObject(obj + ("scope" to JsonPrimitive(scope)))
        return sendJson("PUT", p("api", "agents", def.name), body, AgentDef.serializer())
    }

    suspend fun deleteAgent(name: String) = sendUnit("DELETE", p("api", "agents", name))

    suspend fun skills(): List<SkillDef> = get(p("api", "skills"), ListSerializer(SkillDef.serializer()))

    suspend fun commands(): List<CommandDef> = get(p("api", "commands"), ListSerializer(CommandDef.serializer()))

    suspend fun tools(): List<ToolInfo> = get(p("api", "tools"), ListSerializer(ToolInfo.serializer()))

    suspend fun mcp(): List<McpStatus> = get(p("api", "mcp"), ListSerializer(McpStatus.serializer()))

    suspend fun reloadExtensions() = sendUnit("POST", p("api", "reload"))

    suspend fun syncToClis(device: String? = null): SyncResult =
        sendJson("POST", p("api", "sync-clis"), buildJsonObject { if (device != null) put("device", device) }, SyncResult.serializer())

    // ---------------------------------------------------------------- tasks

    suspend fun tasks(status: TaskStatus? = null, agent: String? = null, project: String? = null): List<Task> =
        get(p("api", "tasks"), ListSerializer(Task.serializer()), mapOf("status" to status?.wire, "agent" to agent, "project" to project))

    suspend fun createTask(input: TaskInput): Task =
        send("POST", p("api", "tasks"), TaskInput.serializer(), input, Task.serializer())

    suspend fun updateTask(id: String, patch: TaskInput): Task =
        send("PATCH", p("api", "tasks", id), TaskInput.serializer(), patch, Task.serializer())

    suspend fun deleteTask(id: String) = sendUnit("DELETE", p("api", "tasks", id))

    suspend fun startTask(id: String, opts: StartTaskInput = StartTaskInput()): Session =
        send("POST", p("api", "tasks", id, "start"), StartTaskInput.serializer(), opts, Session.serializer())

    // ---------------------------------------------------------------- routines

    suspend fun routines(): List<Routine> = get(p("api", "routines"), ListSerializer(Routine.serializer()))

    suspend fun createRoutine(input: RoutineInput): Routine =
        send("POST", p("api", "routines"), RoutineInput.serializer(), input, Routine.serializer())

    suspend fun updateRoutine(id: String, patch: RoutineInput): Routine =
        send("PATCH", p("api", "routines", id), RoutineInput.serializer(), patch, Routine.serializer())

    suspend fun deleteRoutine(id: String) = sendUnit("DELETE", p("api", "routines", id))

    suspend fun runRoutine(id: String): RoutineRun = sendJson("POST", p("api", "routines", id, "run"), null, RoutineRun.serializer())

    suspend fun routineRuns(id: String): List<RoutineRun> = get(p("api", "routines", id, "runs"), ListSerializer(RoutineRun.serializer()))

    suspend fun previewSchedule(schedule: String, timezone: String? = null): SchedulePreview =
        get(p("api", "routines", "preview"), SchedulePreview.serializer(), mapOf("schedule" to schedule, "timezone" to timezone))

    // ---------------------------------------------------------------- memory

    suspend fun memories(scope: MemoryScope? = null, kind: MemoryKind? = null, limit: Int? = null, offset: Int? = null): List<MemoryEntry> =
        get(p("api", "memory"), ListSerializer(MemoryEntry.serializer()), mapOf("scope" to scope?.wire, "kind" to kind?.wire, "limit" to limit, "offset" to offset))

    suspend fun searchMemory(query: String, limit: Int = 20): List<MemoryEntry> =
        get(p("api", "memory", "search"), ListSerializer(MemoryEntry.serializer()), mapOf("q" to query, "limit" to limit))

    suspend fun saveMemory(input: MemoryInput): MemoryEntry =
        send("POST", p("api", "memory"), MemoryInput.serializer(), input, MemoryEntry.serializer())

    suspend fun updateMemory(id: String, patch: MemoryInput): MemoryEntry =
        send("PATCH", p("api", "memory", id), MemoryInput.serializer(), patch, MemoryEntry.serializer())

    suspend fun deleteMemory(id: String) = sendUnit("DELETE", p("api", "memory", id))

    suspend fun memoryStats(): MemoryStats = get(p("api", "memory", "stats"), MemoryStats.serializer())

    // ---------------------------------------------------------------- reflect (Settings > Reflect)

    /** The nightly reflection: its switch, time, model, last run and the notes it keeps. */
    suspend fun reflect(): ReflectInfo = get(p("api", "assistant", "reflect"), ReflectInfo.serializer())

    /** The switch is the same setting as Settings > Assistant's on the hub. */
    suspend fun setReflect(patch: ReflectPatch): ReflectInfo =
        send("PUT", p("api", "assistant", "reflect"), ReflectPatch.serializer(), patch, ReflectInfo.serializer())

    /** One reflection now, with the night's rules; the hub's owner only. Answers once it started. */
    suspend fun reflectNow(): ReflectNow = sendJson("POST", p("api", "assistant", "reflect", "run"), null, ReflectNow.serializer())

    // ---------------------------------------------------------------- usage

    suspend fun usage(from: Long? = null, to: Long? = null, tzOffset: Int? = null): UsageSummary =
        get(p("api", "usage"), UsageSummary.serializer(), mapOf("from" to from, "to" to to, "tzOffset" to tzOffset))

    suspend fun usageRecent(limit: Int = 100): List<UsageRecord> =
        get(p("api", "usage", "recent"), ListSerializer(UsageRecord.serializer()), mapOf("limit" to limit))

    suspend fun limits(): List<LimitState> = get(p("api", "limits"), ListSerializer(LimitState.serializer()))

    suspend fun refreshLimits(): List<LimitState> = sendJson("POST", p("api", "limits", "refresh"), null, ListSerializer(LimitState.serializer()))

    // ---------------------------------------------------------------- devices

    suspend fun devices(): List<Device> = get(p("api", "devices"), ListSerializer(Device.serializer()))

    suspend fun updateDevice(id: String, patch: DevicePatch): Device =
        send("PATCH", p("api", "devices", id), DevicePatch.serializer(), patch, Device.serializer())

    suspend fun deleteDevice(id: String) = sendUnit("DELETE", p("api", "devices", id))

    suspend fun browse(device: String, path: String): List<FileEntry> =
        get(p("api", "devices", device, "files"), ListSerializer(FileEntry.serializer()), mapOf("path" to path))

    suspend fun readDeviceFile(device: String, path: String): FileContent =
        get(p("api", "devices", device, "file"), FileContent.serializer(), mapOf("path" to path))

    suspend fun externalSessions(device: String = "local"): List<ExternalSessionInfo> =
        get(p("api", "import", "sessions"), ListSerializer(ExternalSessionInfo.serializer()), mapOf("device" to device))

    suspend fun importSession(source: String, id: String, device: String = "local"): Session = sendJson(
        "POST", p("api", "import"),
        buildJsonObject { put("source", source); put("id", id); put("device", device) },
        Session.serializer(),
    )

    // ---------------------------------------------------------------- gateway

    suspend fun gatewayKeys(): List<GatewayKey> = get(p("api", "gateway", "keys"), ListSerializer(GatewayKey.serializer()))

    suspend fun createGatewayKey(name: String, device: String? = null, agent: String? = null): GatewayKey = sendJson(
        "POST", p("api", "gateway", "keys"),
        buildJsonObject {
            put("name", name)
            if (device != null) put("device", device)
            if (agent != null) put("agent", agent)
        },
        GatewayKey.serializer(),
    )

    suspend fun revokeGatewayKey(id: String) = sendUnit("DELETE", p("api", "gateway", "keys", id))

    // ---------------------------------------------------------------- config and notifications

    suspend fun config(): ConfigResponse = get(p("api", "config"), ConfigResponse.serializer())

    suspend fun updateConfig(patch: JsonObject) = sendUnit("PATCH", p("api", "config"), patch)

    suspend fun notifyChannels(): List<NotifyChannel> = get(p("api", "notify", "channels"), ListSerializer(NotifyChannel.serializer()))

    /** Sends a test through a hub channel. Only browsers get these; the app shows its own test notification. */
    suspend fun testNotify(channel: String) = sendUnit("POST", p("api", "notify", "test"), buildJsonObject { put("channel", channel) })

    suspend fun audit(sessionId: String? = null, limit: Int? = null): List<AuditEntry> =
        get(p("api", "audit"), ListSerializer(AuditEntry.serializer()), mapOf("sessionId" to sessionId, "limit" to limit))

    // ---------------------------------------------------------------- events

    /**
     * ws(s)://.../api/ws. With [active] false it adds active=0: the app
     * connects from the background. The token goes in the Authorization
     * header only, unlike browsers: proxies and tunnels log URLs.
     */
    fun webSocketUrl(active: Boolean? = null): HttpUrl = url(p("api", "ws"), mapOf("active" to if (active == false) 0 else null))

    /**
     * Live events over WebSocket. Reconnects with backoff and replays missed
     * events with {"type":"since","seq":lastSeq}, the same logic as
     * ConclaveClient.connect in TypeScript. Cancel the collector to close.
     *
     * Presence: with [active], the socket tells the hub whether the app is in
     * the foreground. It connects with active=0 while that is false, sends
     * {"type":"presence","active":...} after every (re)connect and on every
     * change, and while it is true sends presence true every
     * [pingIntervalMs] (the hub counts an app as in use for idleSeconds after
     * each one). In the background it sends no frames of its own; protocol
     * pings every [socketPingMs] find a dead connection. Without [active]
     * it pings every [pingIntervalMs] and never reports presence.
     *
     * The Map: while [map] is true the socket asks for map.delta events
     * ({"type":"map","on":true}, again after every reconnect), and says
     * {"on":false} when it turns false (docs/DESIGN.md 29).
     *
     * @param startSeq last seq the caller already processed (0 for none).
     * @param backoffMs wait before the next try after a plain disconnect.
     */
    fun live(
        startSeq: Long = 0,
        pingIntervalMs: Long = 25_000,
        backoffMs: (attempt: Int) -> Long = ::defaultBackoff,
        active: StateFlow<Boolean>? = null,
        socketPingMs: Long = 30_000,
        map: StateFlow<Boolean>? = null,
    ): Flow<LiveEvent> = channelFlow {
        val lastSeq = AtomicLong(startSeq)
        val attempt = AtomicInteger(0)
        val refusals = AtomicInteger(0)
        // connects, reconnects and drops go to the hub's log files (ClientLogs.kt)
        val everOpened = java.util.concurrent.atomic.AtomicBoolean(false)
        val wsClient = http.newBuilder().pingInterval(socketPingMs, TimeUnit.MILLISECONDS).build()
        var round = 0
        while (true) {
            send(LiveEvent.Status(ConnectionState.CONNECTING))
            val guard = identity
            if (guard != null && token != null) {
                // a reconnect checks the address again: another machine may answer there now
                if (round > 0) guard.forget(baseUrl)
                round++
                val failure = try {
                    guard.ensure(this@ConclaveClient)
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    e
                }
                if (failure != null) {
                    send(LiveEvent.Status(ConnectionState.CLOSED))
                    when {
                        // another machine: no socket; keep trying with backoff, checking each time
                        failure is HubIdentityException -> {
                            send(LiveEvent.NotYourHub(failure.address, failure.message ?: HubIdentityException.NOT_YOUR_HUB))
                            delay(backoffMs(attempt.getAndIncrement()))
                        }
                        // the hub wants a pause
                        failure is ConclaveApiException && failure.status == 429 -> {
                            val no = LiveEvent.Rejected(failure.status, failure.message?.takeIf { it.isNotBlank() }, failure.retryAfterSeconds)
                            send(no)
                            delay(refusedWait(no, refusals.getAndIncrement(), backoffMs(attempt.getAndIncrement())))
                        }
                        // no answer, or the hub's own trouble: offline, not a stranger
                        else -> delay(backoffMs(attempt.getAndIncrement()))
                    }
                    continue
                }
            }
            val done = CompletableDeferred<Unit>()
            val opened = CompletableDeferred<Unit>()
            val refused = AtomicReference<LiveEvent.Rejected?>(null)
            val reqBuilder = Request.Builder().url(webSocketUrl(active?.value))
            token?.let { reqBuilder.header("Authorization", "Bearer $it") }
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    ClientLogs.log("info", if (everOpened.getAndSet(true)) "reconnect" else "connect", mapOf("attempt" to attempt.get()))
                    attempt.set(0)
                    refusals.set(0)
                    trySend(LiveEvent.Status(ConnectionState.OPEN))
                    val seq = lastSeq.get()
                    if (seq > 0) webSocket.send("""{"type":"since","seq":$seq}""")
                    opened.complete(Unit)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleFrame(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    handleFrame(bytes.utf8())
                }

                private fun handleFrame(text: String) {
                    when (val frame = Frame.parse(text, json)) {
                        is Frame.Hello -> {
                            val cur = lastSeq.get()
                            // the hub restarted and counts from 0 again: replay cannot cover the gap
                            if (frame.seq < cur) {
                                lastSeq.set(frame.seq)
                                trySend(LiveEvent.Resync(frame.seq))
                            } else if (cur == 0L) {
                                lastSeq.set(frame.seq)
                            }
                            trySend(LiveEvent.Hello(frame.seq))
                        }
                        is Frame.Resync -> {
                            lastSeq.set(frame.seq)
                            trySend(LiveEvent.Resync(frame.seq))
                        }
                        is Frame.Event -> {
                            val seq = frame.envelope.seq
                            while (true) {
                                val cur = lastSeq.get()
                                if (seq <= cur || lastSeq.compareAndSet(cur, seq)) break
                            }
                            trySend(LiveEvent.Event(frame.envelope))
                        }
                        Frame.Pong, Frame.Malformed -> Unit
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    done.complete(Unit)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    done.complete(Unit)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (response != null) {
                        if (response.code == 401 || response.code == 403 || response.code == 429) {
                            val text = runCatching { response.peekBody(4096).string() }.getOrNull().orEmpty()
                            refused.set(LiveEvent.Rejected(response.code, errorMessage(text)?.takeIf { it.isNotBlank() }, retryAfter(response.header("retry-after"))))
                        }
                        response.close()
                    }
                    done.complete(Unit)
                }
            }
            val ws = wsClient.newWebSocket(reqBuilder.build(), listener)
            // presence: the state now (after every connect), then each change
            val presence = active?.let { a ->
                launch {
                    opened.await()
                    a.collect { v -> ws.send(presenceFrame(v)) }
                }
            }
            // the Map: on after every connect while it is open, off once when it closes
            val mapFrames = map?.let { m ->
                launch {
                    opened.await()
                    var on = false
                    m.collect { v ->
                        if (v != on) ws.send(mapFrame(v))
                        on = v
                    }
                }
            }
            val pinger = launch {
                while (true) {
                    delay(pingIntervalMs)
                    when {
                        active == null -> ws.send("""{"type":"ping"}""")
                        // in use: say so again, the hub holds notifications for idleSeconds after each
                        active.value -> ws.send(presenceFrame(true))
                    }
                }
            }
            try {
                done.await()
            } finally {
                pinger.cancel()
                presence?.cancel()
                mapFrames?.cancel()
                ws.cancel()
            }
            send(LiveEvent.Status(ConnectionState.CLOSED))
            val no = refused.get()
            if (opened.isCompleted) ClientLogs.log("info", "disconnect")
            if (no != null) ClientLogs.log("warn", "live.refused", mapOf("status" to no.status), no.message)
            if (no != null) {
                send(no)
                delay(refusedWait(no, refusals.getAndIncrement(), backoffMs(attempt.getAndIncrement())))
            } else {
                delay(backoffMs(attempt.getAndIncrement()))
            }
        }
    }.buffer(Channel.UNLIMITED)

    companion object {
        private val JSON_MEDIA = "application/json".toMediaType()

        /** The hub's network refusal: a 403 whose body has code "network". */
        private val NETWORK_CODE = Regex(""""code"\s*:\s*"network"""")

        /** min(15s, 500ms * 2^attempt), as in the TypeScript client. */
        fun defaultBackoff(attempt: Int): Long = min(15_000L, 500L shl min(attempt, 10))

        /** Background sockets wait longer between tries: min(60s, 1s * 2^attempt). */
        fun backgroundBackoff(attempt: Int): Long = min(60_000L, 1_000L shl min(attempt, 10))

        internal fun presenceFrame(active: Boolean): String = """{"type":"presence","active":$active}"""

        internal fun mapFrame(on: Boolean): String = """{"type":"map","on":$on}"""

        /**
         * How long to wait after the hub refused the socket. 429: what
         * retry-after says. 401 and 403 do not fix themselves on a retry, so
         * one minute, doubling up to eight, and never sooner than [backoff]:
         * an app must not resend one old token in a tight loop.
         */
        fun refusedWait(r: LiveEvent.Rejected, refusals: Int, backoff: Long): Long = when {
            r.status == 429 && r.retryAfterSeconds != null -> maxOf(1_000L, r.retryAfterSeconds * 1_000L)
            r.status == 429 -> maxOf(backoff, 30_000L)
            else -> slowWait(refusals, backoff)
        }

        /** Something a quick retry does not fix (a refused token, another machine at the address): one minute, doubling up to eight. */
        fun slowWait(refusals: Int, backoff: Long): Long = maxOf(backoff, 60_000L shl min(refusals, 3))

        /** The retry-after header in seconds (the hub sends seconds, never a date). */
        internal fun retryAfter(header: String?): Long? = header?.trim()?.toLongOrNull()?.takeIf { it >= 0 }

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}

/**
 * Suspends until the call completes and its body is read, on OkHttp's
 * thread: the body streams after the headers, and on Android a socket read
 * on the main thread throws. The response comes back closed, its status and
 * headers still readable. Cancelling the coroutine cancels the call.
 * [readBytes] is the same for a body that is not text (a map picture).
 */
internal suspend fun Call.readBytes(): Pair<Response, ByteArray> = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            val bytes = try {
                response.use { it.body.bytes() }
            } catch (e: IOException) {
                onFailure(call, e)
                return
            }
            if (cont.isActive) cont.resume(response to bytes)
        }
    })
}

internal suspend fun Call.readText(): Pair<Response, String> = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            val text = try {
                response.use { it.body.string() }
            } catch (e: IOException) {
                onFailure(call, e)
                return
            }
            if (cont.isActive) cont.resume(response to text)
        }
    })
}
