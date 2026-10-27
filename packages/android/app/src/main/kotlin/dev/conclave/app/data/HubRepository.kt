package dev.conclave.app.data

import android.os.Build
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.ConclaveClient
import dev.conclave.client.ConnectionState
import dev.conclave.client.HubIdentityException
import dev.conclave.client.HubIdentityGuard
import dev.conclave.client.HubKeys
import dev.conclave.client.LiveEvent
import dev.conclave.client.alertAction
import dev.conclave.client.alerts
import dev.conclave.client.friendInbox
import dev.conclave.client.friends
import dev.conclave.client.projects
import dev.conclave.client.receivedShares
import dev.conclave.client.sentShares
import dev.conclave.client.logic.AddressRecovery
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.RemoteWords
import dev.conclave.client.model.AgentDef
import dev.conclave.client.model.AlertAction
import dev.conclave.client.model.AlertItem
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.Device
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.HubInfo
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import dev.conclave.client.model.PairResponse
import dev.conclave.client.model.Project
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.RemoteStatus
import dev.conclave.client.model.Session
import dev.conclave.client.model.Task
import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

sealed class AuthState {
    data object Loading : AuthState()
    data object Unpaired : AuthState()
    data class Paired(val url: String, val hubName: String?) : AuthState()
}

/** Why the app cannot reach the hub right now, in words that say what to do next. */
sealed class HubProblem {
    abstract val text: String

    /** One line for the banner under a header; [text] has the whole story (Home, Settings). */
    open val short: String get() = text

    /** The hub no longer accepts this phone's token (401): pair again. */
    data class Rejected(override val text: String) : HubProblem()

    /** The hub refused this network (403) or wants a pause (429). */
    data class Refused(override val text: String) : HubProblem()

    /** No saved address answers. [newCode]: the address was a quick tunnel, which never comes back, so scan a new code. */
    data class Lost(override val text: String, val newCode: Boolean) : HubProblem() {
        override val short get() = if (newCode) "Can't reach your hub. Scan a new code from Home." else "Can't reach your hub. Retrying."
    }

    data object NoNetwork : HubProblem() {
        override val text = "No network. Conclave connects again when the phone is back online."
    }

    /**
     * The machine at [address] did not prove the hub's key, so nothing with
     * the token went there. Pick another saved address, or pair again.
     */
    data class NotYourHub(val address: String, override val text: String = HubIdentityException.NOT_YOUR_HUB) : HubProblem() {
        override val short get() = "This address is not your hub."
    }
}

/** After a password login: the hub's fingerprint, shown once to compare with the hub's Settings. */
data class NewSignIn(val hubName: String?, val fingerprint: String)

/**
 * Text and files handed to the app with ACTION_SEND or ACTION_SEND_MULTIPLE.
 * [notes] say which files were left out and why. [to] is where it goes: null
 * while the "Share to" picker asks, [HOME] for a new conversation on Home,
 * else the id of the chat or session whose composer takes it.
 */
data class SharePayload(
    val text: String,
    val attachments: List<Attachment>,
    val notes: List<String> = emptyList(),
    val to: String? = null,
) {
    companion object {
        const val HOME = "home"
    }
}

/**
 * Single source of truth for the hub connection: the paired client, the live
 * WebSocket and small caches every screen shares. Lives as long as the process.
 *
 * The hub can have several addresses (a tunnel, an own URL, the same
 * network). The app saves all of them, follows the hub to a new tunnel
 * address, and when the one in use stops answering moves to the first saved
 * one that does (client logic/Remote.kt).
 */
class HubRepository(
    private val scope: CoroutineScope,
    private val settings: SettingsStore,
    private val tokens: SecureTokenStore,
    /** False while the phone has no network: the live connection waits instead of retrying into nothing. */
    private val online: StateFlow<Boolean> = MutableStateFlow(true),
    /** Ticks when the phone moves to another network: reconnect at once, the old path may be gone. */
    private val networkChanges: StateFlow<Int> = MutableStateFlow(0),
) {
    val cleartext = CleartextPolicy()
    val http = HttpClients.create(cleartext)
    private val probeHttp = HttpClients.probe(http)

    private val _auth = MutableStateFlow<AuthState>(AuthState.Loading)
    val auth: StateFlow<AuthState> = _auth.asStateFlow()

    private val _client = MutableStateFlow<ConclaveClient?>(null)
    val client: StateFlow<ConclaveClient?> = _client.asStateFlow()

    private val _connection = MutableStateFlow(ConnectionState.CLOSED)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _events = MutableSharedFlow<EngineEvent>(extraBufferCapacity = 512, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Every live engine event. ConfigUpdated also means "refetch what you show". */
    val events: SharedFlow<EngineEvent> = _events.asSharedFlow()

    val sessions = MutableStateFlow<List<Session>>(emptyList())
    val approvals = MutableStateFlow<List<ApprovalRequest>>(emptyList())
    val questions = MutableStateFlow<List<QuestionRequest>>(emptyList())
    /** File conflicts and stuck turns (docs/DESIGN.md 28), for the Inbox. */
    val alerts = MutableStateFlow<List<AlertItem>>(emptyList())

    /** When each session last streamed text or ran a tool (this phone's clock): [Session.updatedAt] moves on neither, so a busy task would look quiet. */
    private val lastActive = java.util.concurrent.ConcurrentHashMap<String, Long>()
    fun lastActiveAt(sessionId: String): Long = lastActive[sessionId] ?: 0L

    /** Friends: other owners' hubs (docs/design/FRIENDS.md). A removed friend leaves the list. Empty on a hub without friends. */
    val friends = MutableStateFlow<List<FriendDto>>(emptyList())

    /** Notes from friends, the newest few hundred; a friend's page reads further back. */
    val friendNotes = MutableStateFlow<List<InboxItemDto>>(emptyList())

    /** Shares friends sent this hub, and the ones it sent (phases 2 and 3). */
    val receivedShares = MutableStateFlow<List<ReceivedShareDto>>(emptyList())
    val sentShares = MutableStateFlow<List<SentShareDto>>(emptyList())
    val limits = MutableStateFlow<List<LimitState>>(emptyList())
    /** Counts usage_recorded events, so the Usage page reloads after new calls. */
    val usageRecorded = MutableStateFlow(0)
    val devices = MutableStateFlow<List<Device>>(emptyList())

    /** Projects (folders across devices): the side panel groups sessions by them. Empty on a hub without them. */
    val projects = MutableStateFlow<List<Project>>(emptyList())
    val agents = MutableStateFlow<List<AgentDef>>(emptyList())
    val models = MutableStateFlow<List<ModelGroup>>(emptyList())
    val tasks = MutableStateFlow<List<Task>>(emptyList())
    val hubInfo = MutableStateFlow<HubInfo?>(null)
    val lastError = MutableStateFlow<String?>(null)

    /**
     * When the lists above were last known good: the last full load, or the
     * moment the live connection dropped. Null until the hub first answered,
     * so an offline Home can say it cannot tell rather than "nothing".
     */
    val syncedAt = MutableStateFlow<Long?>(null)

    /** Remote access on the hub (GET /api/remote, remote.updated). Null until read, or from a hub without it. */
    val remote = MutableStateFlow<RemoteStatus?>(null)

    /** Why the hub cannot be reached, when it cannot. */
    val problem = MutableStateFlow<HubProblem?>(null)

    /** A password login just worked: the hub's fingerprint to show once. */
    val newSignIn = MutableStateFlow<NewSignIn?>(null)

    /** Bumped by [retry]: the live connection starts over at once. */
    private val retries = MutableStateFlow(0)

    /** The address in use changed by itself (a new tunnel, a fallback): a line for the screen to show once. */
    private val _moved = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val moved: SharedFlow<String> = _moved.asSharedFlow()

    /** The owner's first name from hub config ui.name; Home greets them with it. */
    val ownerName = MutableStateFlow<String?>(null)

    /** Limit percent from config ui.limitWarn: at or over it a limit shows on Home (amber). */
    val limitWarn = MutableStateFlow(70)

    /** Deep link or shortcut waiting to be handled by the UI. */
    val pendingLink = MutableStateFlow<DeepLink?>(null)
    val pendingShare = MutableStateFlow<SharePayload?>(null)

    /** The app is on screen. The socket reports it to the hub (presence), and notifications stay quiet. */
    val visible = MutableStateFlow(false)

    private val holders = MutableStateFlow(0)

    /** Screens that show the Map: while any does, the socket asks for map.delta events. */
    private val mapWatchers = MutableStateFlow(0)
    private val mapWanted = MutableStateFlow(false)

    @Volatile
    private var lastSeq = 0L

    private val recovery = AddressRecovery(::answers)

    val deviceName: String
        get() = listOf(Build.MANUFACTURER, Build.MODEL)
            .filter { !it.isNullOrBlank() }
            .joinToString(" ")
            .ifBlank { "Android" }

    fun start() {
        // what the app reports about itself goes to the hub's log files (client ClientLogs.kt, docs/DESIGN.md 33)
        dev.conclave.client.ClientLogs.startFor(scope, dev.conclave.app.BuildConfig.VERSION_NAME, "Android ${Build.VERSION.RELEASE}") { _client.value }
        scope.launch {
            settings.state.filterNotNull().collect { cleartext.allowedHosts = it.cleartextHosts.map { h -> h.lowercase() }.toSet() }
        }
        scope.launch {
            settings.dropRetired()
            loadPairing()
        }
        scope.launch {
            combine(_client, holders.map { it > 0 }.distinctUntilChanged(), online, networkChanges, retries) { c, wanted, up, _, _ -> Triple(c, wanted, up) }
                .collectLatest { (c, wanted, up) ->
                    when {
                        c == null || !wanted -> setConnection(ConnectionState.CLOSED)
                        !up -> {
                            setConnection(ConnectionState.CLOSED)
                            problem.value = HubProblem.NoNetwork
                        }
                        else -> {
                            if (problem.value == HubProblem.NoNetwork) problem.value = null
                            // a new network: the addresses that failed on the old one get a fresh try
                            recovery.reset()
                            runLive(c)
                        }
                    }
                }
        }
    }

    private suspend fun loadPairing() {
        val s = settings.current()
        cleartext.allowedHosts = s.cleartextHosts.map { it.lowercase() }.toSet()
        val url = s.hubUrl
        val token = if (url != null) tokens.load() else null
        if (url != null && token != null) {
            _client.value = newClient(url, token, guard(tokens.loadHubKey()))
            _auth.value = AuthState.Paired(url, s.hubName)
        } else {
            _auth.value = AuthState.Unpaired
        }
    }

    /**
     * The identity checks for one pairing, shared by its clients as the
     * address changes. A hub paired before identity keeps the first key it
     * proves (trust on first use).
     */
    private fun guard(key: String?): HubIdentityGuard = HubIdentityGuard(
        pinnedKey = key,
        onPinned = { id -> tokens.saveHubKey(id.publicKey) },
        onMismatch = { e -> problem.value = HubProblem.NotYourHub(e.address, e.message ?: HubIdentityException.NOT_YOUR_HUB) },
    )

    /** Every client checks signatures with Tink (Android has no Ed25519 in java.security before 14). */
    private fun newClient(url: String, token: String?, guard: HubIdentityGuard?): ConclaveClient =
        ConclaveClient(url, token, http, identity = guard, verifier = TinkEd25519)

    /** For background entry points (receivers, workers, the service) that may run in a cold process. */
    suspend fun awaitClient(): ConclaveClient? {
        auth.first { it !is AuthState.Loading }
        return _client.value
    }

    /**
     * The Map is open: the socket asks the hub for map.delta events (again
     * after every reconnect) until the returned function is called.
     */
    fun watchMap(): () -> Unit {
        mapWatchers.update { it + 1 }
        mapWanted.value = true
        val released = AtomicBoolean(false)
        return {
            if (released.compareAndSet(false, true)) {
                val left = mapWatchers.updateAndGet { it - 1 }
                if (left <= 0) mapWanted.value = false
            }
        }
    }

    /** Keep the WebSocket open while the returned function has not been called. */
    fun acquireLive(): () -> Unit {
        holders.update { it + 1 }
        val released = AtomicBoolean(false)
        return { if (released.compareAndSet(false, true)) holders.update { it - 1 } }
    }

    /**
     * Pair with a code. [address] is the code's best address; when it cannot
     * be reached (a tunnel still starting, a phone on the hub's Wi-Fi without
     * internet), the QR code's other addresses are tried in order. A wrong or
     * expired code stops at once: each code works one time. With the QR
     * code's [fingerprint], each address proves it is that hub before the code
     * goes there; another machine stops pairing.
     */
    suspend fun pair(address: HubAddress, code: String, alts: List<String> = emptyList(), fingerprint: String? = null): PairResponse {
        // public plain http needs the owner's yes (the pairing screen asks); private networks do not
        val allowHost = if (address.needsWarning) address.host.lowercase() else null
        if (allowHost != null) cleartext.allowedHosts = cleartext.allowedHosts + allowHost
        val candidates = listOf(address.url) + alts.mapNotNull { HubAddress.parse(it) }.filterNot { it.needsWarning }.map { it.url }
        val (url, res) = HubAddresses.firstAnswer(HubAddresses.dedupe(candidates)) { u ->
            newClient(u, null, null).pair(code.trim(), deviceName, "android", fingerprint)
        }
        signedIn(url, res, allowHost, proven = fingerprint != null)
        return res
    }

    /**
     * Log in with the hub's password, the backup to a pairing code. The client
     * refuses plain http to a public address before sending. There is no
     * fingerprint to check against, so the reply's key is kept and its
     * fingerprint shown once ([newSignIn]) to compare with the hub's Settings.
     * [account] is the person's name on a hub with several people
     * (docs/design/ACCOUNTS.md); left out, the owner's password.
     */
    suspend fun login(address: HubAddress, password: String, account: String? = null): PairResponse {
        val res = newClient(address.url, null, null).login(password, deviceName, "android", account)
        signedIn(address.url, res, allowHost = null, proven = false)
        HubKeys.fingerprint(res.identity?.publicKey)?.let { newSignIn.value = NewSignIn(res.hub.name.ifBlank { null }, it) }
        return res
    }

    /** A pairing or a login worked: keep the token, the hub's key and its addresses, and use them. */
    private suspend fun signedIn(url: String, res: PairResponse, allowHost: String?, proven: Boolean) {
        val saved = HubAddresses.atPairing(url, res.addresses)
        val key = res.identity?.publicKey?.takeIf { HubKeys.rawKey(it) != null }
        tokens.save(res.token, key)
        settings.setPairing(url, saved, res.hub.name.ifBlank { null }, res.clientId.ifBlank { null }, allowHost)
        val guard = guard(key)
        // the code's fingerprint just proved this address: no second check before the first request
        if (proven && key != null) guard.trust(url)
        lastSeq = 0
        problem.value = null
        recovery.reset()
        hubInfo.value = res.hub
        _client.value = newClient(url, res.token, guard)
        _auth.value = AuthState.Paired(url, res.hub.name.ifBlank { null })
    }

    suspend fun unpair() {
        tokens.clear()
        settings.clearPairing()
        _client.value = null
        newSignIn.value = null
        lastSeq = 0
        sessions.value = emptyList()
        approvals.value = emptyList()
        questions.value = emptyList()
        alerts.value = emptyList()
        friends.value = emptyList()
        friendNotes.value = emptyList()
        receivedShares.value = emptyList()
        sentShares.value = emptyList()
        limits.value = emptyList()
        devices.value = emptyList()
        projects.value = emptyList()
        agents.value = emptyList()
        models.value = emptyList()
        tasks.value = emptyList()
        hubInfo.value = null
        syncedAt.value = null
        remote.value = null
        problem.value = null
        ownerName.value = null
        _auth.value = AuthState.Unpaired
    }

    /** Runs [block] with the paired client. Throws when not paired. */
    suspend fun <T> api(block: suspend (ConclaveClient) -> T): T {
        val c = _client.value ?: throw IOException("Not paired with a hub")
        return block(c)
    }

    // ------------------------------------------------------------ addresses

    /** GET /api/health at [url], without the token. */
    private suspend fun answers(url: String): Boolean = try {
        ConclaveClient(url, null, probeHttp).health().ok
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }

    /** Use [url] from now on, with the same token. Missed events replay from the last seq. */
    private suspend fun switchTo(url: String) {
        val c = _client.value ?: return
        if (HubAddresses.same(c.baseUrl, url)) return
        val token = c.token ?: return
        settings.setHubUrl(url)
        problem.value = null
        recovery.reset()
        // the same pairing: the same pinned key, and the new address proves it before the first request
        _client.value = newClient(url, token, c.identity)
        _auth.value = AuthState.Paired(url, (auth.value as? AuthState.Paired)?.hubName)
        _moved.tryEmit(url)
    }

    /** Try the hub again now (Home's retry): the live connection starts over without waiting. */
    fun retry() {
        recovery.reset()
        retries.update { it + 1 }
    }

    /**
     * The owner picked another saved address (the identity screen). It proves
     * the hub's key before anything with the token goes there.
     */
    fun useAddress(url: String) {
        scope.launch {
            problem.value = null
            switchTo(url)
            retry()
        }
    }

    /** The hub's remote access status: keep its address list, and follow it to a new tunnel address. */
    private fun onRemote(s: RemoteStatus, from: ConclaveClient) {
        remote.value = s
        val list = HubAddresses.fromStatus(s)
        scope.launch {
            if (list.isNotEmpty()) settings.setHubAddresses(list)
            val next = HubAddresses.moveTo(from.baseUrl, s) ?: return@launch
            // the new tunnel can take a few seconds to answer everywhere; the old one serves for 20 more
            val until = System.currentTimeMillis() + 15_000
            while (System.currentTimeMillis() < until && !answers(next)) delay(2_000)
            if (_client.value === from) switchTo(next)
        }
    }

    /** A screen changed remote access (PUT /api/remote and friends): keep the reply like a remote.updated. */
    fun remoteChanged(s: RemoteStatus) {
        val c = _client.value ?: return
        onRemote(s, c)
    }

    /** The address this phone uses now. */
    val currentUrl: String? get() = _client.value?.baseUrl

    private suspend fun loadRemote(c: ConclaveClient) {
        try {
            onRemote(c.remote(), c)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // an older hub has no /api/remote: keep the addresses from pairing
        }
    }

    /** The socket closed: is the hub still at this address, at another saved one, or gone? */
    private fun recover(c: ConclaveClient) {
        scope.launch {
            if (!online.value || _client.value !== c) return@launch
            val saved = settings.current().hubAddresses
            when (val o = recovery.recover(c.baseUrl, saved)) {
                AddressRecovery.Outcome.Fine -> if (problem.value is HubProblem.Lost) problem.value = null
                AddressRecovery.Outcome.Later -> Unit
                is AddressRecovery.Outcome.Move -> if (_client.value === c) switchTo(o.url)
                is AddressRecovery.Outcome.Lost -> if (_client.value === c && problem.value !is HubProblem.Rejected && problem.value !is HubProblem.NotYourHub) {
                    problem.value = HubProblem.Lost(lostText(c.baseUrl, saved, o.newCode), o.newCode)
                }
            }
        }
    }

    private fun lostText(current: String, saved: List<String>, newCode: Boolean): String {
        if (newCode) return "Can't reach your hub. Its quick tunnel address changes when the hub restarts. Once the hub is on, open Settings, Remote access there and scan the new code."
        val all = (saved + current).mapNotNull { HubAddress.parse(it) }
        if (all.isNotEmpty() && all.all { it.isPrivate }) {
            return "Can't reach your hub. This phone reaches it only on the hub's network. Turn on remote access on the hub to connect from anywhere."
        }
        return "Can't reach your hub at ${HubAddresses.host(current)}. Check that it is running. Conclave keeps trying."
    }

    // ------------------------------------------------------------ live events

    private fun setConnection(state: ConnectionState) {
        // the data was live up to now; from here it is the last known state
        if (_connection.value == ConnectionState.OPEN && state != ConnectionState.OPEN) syncedAt.value = System.currentTimeMillis()
        _connection.value = state
    }

    private suspend fun runLive(c: ConclaveClient) = coroutineScope {
        c.live(
            startSeq = lastSeq,
            active = visible,
            backoffMs = { a -> if (visible.value) ConclaveClient.defaultBackoff(a) else ConclaveClient.backgroundBackoff(a) },
            map = mapWanted,
        ).collect { ev ->
            when (ev) {
                is LiveEvent.Status -> {
                    setConnection(ev.state)
                    when (ev.state) {
                        ConnectionState.OPEN -> {
                            if (problem.value !is HubProblem.NoNetwork) problem.value = null
                            if (lastSeq == 0L) launch { refreshAll(c) } else launch { loadRemote(c) }
                        }
                        ConnectionState.CLOSED -> recover(c)
                        ConnectionState.CONNECTING -> Unit
                    }
                }
                is LiveEvent.Event -> {
                    if (ev.envelope.seq > lastSeq) lastSeq = ev.envelope.seq
                    apply(ev.envelope.event, c)
                    _events.emit(ev.envelope.event)
                }
                // no event seen yet: the next connect still replays what it missed
                is LiveEvent.Hello -> if (lastSeq == 0L) lastSeq = ev.seq
                is LiveEvent.Resync -> {
                    lastSeq = ev.seq
                    launch { refreshAll(c) }
                    _events.emit(EngineEvent.ConfigUpdated())
                }
                is LiveEvent.Rejected -> {
                    val text = RemoteWords.refusal(ev.status, ev.message, ev.retryAfterSeconds)
                    problem.value = if (ev.status == 401) HubProblem.Rejected(text) else HubProblem.Refused(text)
                }
                // nothing with the token went there: say so, with another address or pairing again as the way out
                is LiveEvent.NotYourHub -> problem.value = HubProblem.NotYourHub(ev.address, ev.message)
            }
        }
    }

    private fun apply(e: EngineEvent, c: ConclaveClient) {
        when (e) {
            is EngineEvent.SessionCreated -> putSession(e.session)
            is EngineEvent.SessionUpdated -> putSession(e.session)
            is EngineEvent.SessionDeleted -> {
                lastActive.remove(e.sessionId)
                sessions.update { list -> list.filterNot { it.id == e.sessionId } }
            }
            is EngineEvent.MessageDelta, is EngineEvent.ToolStarted, is EngineEvent.ToolProgress, is EngineEvent.ToolCompleted -> e.sessionKey?.let { lastActive[it] = System.currentTimeMillis() }
            is EngineEvent.ApprovalRequested -> approvals.update { list -> list.filterNot { it.id == e.approval.id } + e.approval }
            is EngineEvent.ApprovalResolved -> approvals.update { list -> list.filterNot { it.id == e.id } }
            is EngineEvent.QuestionAsked -> questions.update { list -> list.filterNot { it.id == e.question.id } + e.question }
            is EngineEvent.QuestionAnswered -> questions.update { list -> list.filterNot { it.id == e.id } }
            is EngineEvent.AlertRaised -> alerts.update { list -> list.filterNot { it.id == e.alert.id } + e.alert }
            is EngineEvent.AlertCleared -> alerts.update { list -> list.filterNot { it.id == e.id } }
            is EngineEvent.LimitUpdated -> limits.update { list -> list.filterNot { it.key == e.limit.key } + e.limit }
            is EngineEvent.UsageRecorded -> usageRecorded.update { it + 1 }
            is EngineEvent.DeviceUpdated -> {
                devices.update { list -> list.filterNot { it.id == e.device.id } + e.device }
                // the hub device's name is the hub's name everywhere ("homelab · online")
                if (e.device.id == "local" && e.device.name.isNotBlank()) hubInfo.update { it?.copy(name = e.device.name) }
            }
            is EngineEvent.DeviceDeleted -> devices.update { list -> list.filterNot { it.id == e.deviceId } }
            is EngineEvent.ProjectUpdated -> projects.update { list -> list.filterNot { it.id == e.project.id } + e.project }
            is EngineEvent.TaskUpdated -> tasks.update { list -> list.filterNot { it.id == e.task.id } + e.task }
            is EngineEvent.TaskDeleted -> tasks.update { list -> list.filterNot { it.id == e.taskId } }
            is EngineEvent.RemoteUpdated -> onRemote(e.remote, c)
            is EngineEvent.FriendUpdated -> {
                val was = friends.value.firstOrNull { it.id == e.friend.id }
                putFriend(e.friend)
                // a friend's read mark moved, here or on another device: the share cards' read flags follow it
                if (was != null && (was.readAt != e.friend.readAt || was.unreadShares != e.friend.unreadShares)) scope.launch { load { receivedShares.value = c.receivedShares() } }
                // they accepted our request, or we accepted theirs on another device: the knot ties by their name
                if (was?.isPending == true && e.friend.isActive) FriendMoments.friendAdded(e.friend.id)
            }
            is EngineEvent.FriendMessage -> putFriendNote(e.message)
            is EngineEvent.FriendShare -> {
                putReceivedShare(e.share)
                // a share came in, or a new revision of one: its card ties the rope in
                if (e.change == "received" || e.change == "updated") FriendMoments.shareArrived(e.share.id)
            }
            is EngineEvent.FriendShareSent -> putSentShare(e.share)
            is EngineEvent.ConfigUpdated -> scope.launch { _client.value?.let { refreshCatalog(it) } }
            else -> Unit
        }
    }

    // ------------------------------------------------------------ refresh

    suspend fun refreshAll() {
        _client.value?.let { refreshAll(it) }
    }

    private suspend fun refreshAll(c: ConclaveClient) = coroutineScope {
        launch {
            load {
                sessions.value = c.listSessions(archived = false, limit = 500)
                syncedAt.value = System.currentTimeMillis()
            }
        }
        launch { load { approvals.value = c.approvals() } }
        launch { load { questions.value = c.questions() } }
        launch { load { alerts.value = c.alerts() } }
        // friends and shares: a hub without them answers 404, which is not an error here
        launch { optional { friends.value = c.friends().filterNot { it.isRemoved } } }
        launch { optional { friendNotes.value = c.friendInbox() } }
        launch { optional { receivedShares.value = c.receivedShares() } }
        launch { optional { sentShares.value = c.sentShares() } }
        launch { load { limits.value = c.limits() } }
        launch { load { devices.value = c.devices() } }
        launch { optional { projects.value = c.projects() } }
        launch { load { tasks.value = c.tasks() } }
        launch { load { hubInfo.value = c.info() } }
        launch { loadRemote(c) }
        launch { refreshCatalog(c) }
    }

    private suspend fun refreshCatalog(c: ConclaveClient) = coroutineScope {
        launch { load { agents.value = c.agents() } }
        launch { load { models.value = c.models() } }
        // config changes (config.updated) can rename the owner too
        launch {
            load {
                val ui = c.config().config.obj("ui")
                ownerName.value = ui?.string("name")?.trim()?.ifBlank { null }
                limitWarn.value = (ui?.get("limitWarn") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: 70
            }
        }
    }

    /** Like [load], for a feature an older hub does not have: a 404 or 501 leaves the list as it is. */
    private suspend fun optional(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: ConclaveApiException) {
            if (e.status != 404 && e.status != 501) lastError.value = if (e.status == 401) "The hub rejected this device. Pair again." else e.message
        } catch (e: IOException) {
            lastError.value = e.message ?: "Network error"
        } catch (_: kotlinx.serialization.SerializationException) {
            // a newer hub's shape: keep what the app shows
        }
    }

    private suspend fun load(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: ConclaveApiException) {
            lastError.value = if (e.status == 401) "The hub rejected this device. Pair again." else e.message
        } catch (e: IOException) {
            lastError.value = e.message ?: "Network error"
        } catch (e: kotlinx.serialization.SerializationException) {
            lastError.value = "Unexpected reply from the hub"
        }
    }

    // ------------------------------------------------------------ helpers used by several screens

    /** What the hub knows about a model ref, or null. */
    fun modelInfo(ref: String?): ModelInfo? =
        if (ref.isNullOrBlank()) null else models.value.flatMap { it.models }.firstOrNull { it.fullRef == ref }

    /** Puts a session into the shared list (an event, or one the app just changed or created); an archived one leaves it. */
    fun putSession(s: Session) {
        sessions.update { list ->
            val rest = list.filterNot { it.id == s.id }
            if (s.archived) rest else rest + s
        }
    }

    suspend fun resolveApproval(id: String, response: ApprovalResponse) {
        api { it.resolveApproval(id, response) }
        approvals.update { list -> list.filterNot { it.id == id } }
    }

    /** A friend changed (an event, or a call's answer). A removed one leaves the list. */
    fun putFriend(f: FriendDto) {
        friends.update { list -> list.filterNot { it.id == f.id } + listOfNotNull(f.takeUnless { it.isRemoved }) }
    }

    /** A friend left: their notes stay on the hub, but nothing of them is listed here. */
    fun dropFriend(id: String) {
        friends.update { list -> list.filterNot { it.id == id } }
    }

    fun putFriendNote(n: InboxItemDto) {
        friendNotes.update { list -> (list.filterNot { it.id == n.id } + n).sortedBy { it.receivedAt }.takeLast(500) }
    }

    fun putReceivedShare(s: ReceivedShareDto) {
        receivedShares.update { list -> list.filterNot { it.id == s.id } + s }
    }

    fun putSentShare(s: SentShareDto) {
        sentShares.update { list -> list.filterNot { it.id == s.id } + s }
    }

    /** Fetch the share cards again: their read flags follow the friend's read mark. */
    suspend fun reloadReceivedShares() {
        val c = _client.value ?: return
        optional { receivedShares.value = c.receivedShares() }
    }

    /** Stop or Keep waiting on a stuck turn, Dismiss a file conflict; the row leaves at once. */
    suspend fun actOnAlert(id: String, action: AlertAction) {
        api { it.alertAction(id, action) }
        alerts.update { list -> list.filterNot { it.id == id } }
    }
}
