package dev.conclave.app.ui.conversation

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.ChatDefaults
import dev.conclave.app.data.CodeDefaults
import dev.conclave.app.data.HubRepository
import dev.conclave.app.data.SettingsStore
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.Motion
import dev.conclave.client.createRepoSession
import dev.conclave.client.createWorktreeSession
import dev.conclave.client.folderGit
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.Attach
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.ChatList
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.ChatUnits
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.ChatSettingsPatch
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.CreateSessionInput
import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.RepoSessionInput
import dev.conclave.client.model.WorktreeSessionInput
import dev.conclave.client.model.Role
import dev.conclave.client.model.SecondOpinionInput
import dev.conclave.client.model.SendInput
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.visibleText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What you just sent, shown at once until the hub has it (CHAT-AND-MOTION 1.4 Send). */
data class Pending(
    val text: String,
    val attachments: List<Attachment>,
    /** Message ids that existed before the send: the first new user message replaces this. */
    val known: Set<String>,
    /** When it was sent, for "Thinking 4s". */
    val at: Long,
    /** The list key its bubble takes. An edit or retry keeps the key of the message it replaces, so the bubble stays put. */
    val key: String = "u:$at",
    /** It replaces a bubble already on screen: no rise. */
    val inPlace: Boolean = false,
)

/** Hands the first message of a new chat to its thread, so the thread shows it before the hub answers. */
internal object ChatHandoff {
    private val pending = HashMap<String, Pending>()
    private val notes = HashMap<String, Pair<String, String?>>()

    @Synchronized
    fun put(sessionId: String, p: Pending) {
        pending[sessionId] = p
    }

    @Synchronized
    fun take(sessionId: String): Pending? = pending.remove(sessionId)

    /** A line the next screen of [sessionId] shows once ("Branched. The original is in Today."), with the chat Open goes to. */
    @Synchronized
    fun note(sessionId: String, text: String, open: String?) {
        notes[sessionId] = text to open
    }

    @Synchronized
    fun takeNote(sessionId: String): Pair<String, String?>? = notes.remove(sessionId)
}

/**
 * A chat on its way from Home: the chat screen opens at once under a start
 * key ("new-3") with your message and the thinking mark, and binds to the
 * chat once the hub has made it. If you went back meanwhile, nothing moves:
 * the chat just shows up in Recent chats.
 */
internal object ChatStarts {
    const val PREFIX = "new-"

    data class Start(
        val pending: Pending,
        val model: String?,
        /** Set when the hub made the chat. */
        val chatId: String? = null,
        /** Set when making it failed; the words went back into Home's box. */
        val error: String? = null,
    )

    private val _all = MutableStateFlow<Map<String, Start>>(emptyMap())
    val all: StateFlow<Map<String, Start>> = _all

    private var next = 0

    fun isStart(id: String): Boolean = id.startsWith(PREFIX)

    @Synchronized
    fun begin(p: Pending, model: String?): String {
        val key = PREFIX + (++next)
        // a start nobody watches any more (Back, then a new send) is not kept for long
        _all.update { (it + (key to Start(p, model))).entries.toList().takeLast(8).associate { e -> e.key to e.value } }
        return key
    }

    fun created(key: String, chatId: String) = _all.update { m -> m[key]?.let { m + (key to it.copy(chatId = chatId)) } ?: m }

    fun failed(key: String, error: String) = _all.update { m -> m[key]?.let { m + (key to it.copy(error = error)) } ?: m }

    fun done(key: String) = _all.update { it - key }
}

/** The attachments a message was sent with, so Edit and Retry send them again. */
fun attachmentsOf(m: Message): List<Attachment> = m.content.mapNotNull { b ->
    when (b) {
        is ImageBlock -> b.data?.let { Attachment(mediaType = b.mediaType, data = it, name = "image") }
        is DocumentBlock -> b.data?.let { Attachment(mediaType = b.mediaType, data = it, name = b.title ?: "document") }
        else -> null
    }
}

/** One chat on the Chat tab. */
class ChatThreadViewModel(
    hub: HubRepository,
    private val settings: SettingsStore,
    val sessionId: String,
) : HubViewModel(hub) {
    private val transcript = MutableStateFlow(Transcript(sessionId))
    private val _session = MutableStateFlow(hub.sessions.value.firstOrNull { it.id == sessionId })
    val session: StateFlow<Session?> = _session

    val loading = MutableStateFlow(true)
    val error = MutableStateFlow<String?>(null)
    val draft = MutableStateFlow("")
    val attachments = MutableStateFlow<List<Attachment>>(emptyList())

    /** A file the hub could not read: its words, while the owner chooses to send without it. */
    val lossAsk = MutableStateFlow<String?>(null)

    /** Messages an edit or retry is replacing: hidden until the hub drops them. */
    private val hidden = MutableStateFlow<Set<String>>(emptySet())

    /** Messages fading out (120ms) before they hide. */
    val leaving = MutableStateFlow<Set<String>>(emptySet())

    /** Second opinions whose Continue and Dismiss were answered. */
    val settledAsides = MutableStateFlow<Set<String>>(emptySet())
    val pending = MutableStateFlow<Pending?>(ChatHandoff.take(sessionId))

    /** When the running turn started, for "Thinking 4s" and the mark's phase. */
    val turnStartedAt = MutableStateFlow<Long?>(pending.value?.at)

    /** What you sent while a reply runs, in the order it will go, until each turn takes it (docs/design/CHAT-AND-MOTION.md 2.11). */
    val queued: StateFlow<List<QueuedMessage>> = transcript
        .map { it.pending }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** The files this app sent with a waiting message, so its bubble shows the pictures before the hub has stored them. */
    val previews = MutableStateFlow<Map<String, List<Attachment>>>(emptyMap())

    /** The model asked for a second opinion, until its aside arrives. */
    val asking = MutableStateFlow<Pair<String, String>?>(null)

    /** When the second opinion was asked, for "Asking Sonnet 5.5 4s". */
    var askedAt: Long = 0L
        private set

    /**
     * How long a reply thought, measured here (request to first text) until
     * the hub stores durationMs on the block when the message ends.
     */
    val thoughtMs = MutableStateFlow<Map<String, Long>>(emptyMap())

    val live: StateFlow<Transcript> = transcript

    /**
     * List keys for messages that took over from what showed before them:
     * your message replaces the bubble shown at send, the reply replaces the
     * thinking line. Same key, so nothing fades in twice and the mark goes on.
     */
    val aliases = MutableStateFlow<Map<String, String>>(emptyMap())

    /** The send whose reply has not started yet. */
    private var awaitingReply: Long? = pending.value?.at

    /** Second opinions and the reply each answers (the hub does not store it on the aside). */
    private val asideTargets = MutableStateFlow<Map<String, String>>(emptyMap())

    val units: StateFlow<List<ChatUnit>> = combine(transcript, hidden, asideTargets) { t, h, a -> ChatUnits.build(t.messages, h, a) }
        .flowOn(Dispatchers.Default)
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val running: StateFlow<Boolean> = _session
        .map { it?.status == SessionStatus.RUNNING }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    init {
        viewModelScope.launch { hub.events.collect { onEvent(it) } }
        load()
    }

    private fun onEvent(e: EngineEvent) {
        when (e) {
            is EngineEvent.SessionUpdated -> if (e.session.id == sessionId) onSession(e.session)
            is EngineEvent.SessionDeleted -> if (e.sessionId == sessionId) error.value = "This chat was deleted. Start a new one from Chats."
            is EngineEvent.ConfigUpdated -> load(quiet = true)
            is EngineEvent.MessageCreated -> if (e.message.sessionId == sessionId) onMessage(e.message)
            is EngineEvent.MessageDeleted -> if (e.sessionId == sessionId) onDeleted(e.messageId)
            else -> Unit
        }
        if (e is EngineEvent.MessageDelta && e.sessionId == sessionId && e.kind == dev.conclave.client.model.DeltaKind.TEXT && e.messageId !in thoughtMs.value) {
            val msg = transcript.value.messages.firstOrNull { it.id == e.messageId }
            val start = turnStartedAt.value
            if (msg != null && start != null && msg.content.any { it is dev.conclave.client.model.ThinkingBlock }) {
                thoughtMs.update { it + (e.messageId to System.currentTimeMillis() - start) }
            }
        }
        // an approval or a question shows here when this chat or a subagent under it asks (Asks.kt); the reducer decides
        if (e.sessionKey == sessionId || Asks.isAskEvent(e)) transcript.update { TranscriptReducer.apply(it, e) }
    }

    /** The hub started the turn for what is pending (it went running after the send). */
    private var pendingRan = false

    private fun onSession(s: Session) {
        val was = _session.value?.status
        _session.value = s
        val p = pending.value
        if (s.status == SessionStatus.RUNNING) {
            if (p != null) pendingRan = true
            // what you sent is still on its way: its turn counts from the send, and keeps its keys
            if (was != SessionStatus.RUNNING && turnStartedAt.value == null) startTurn(p?.at ?: System.currentTimeMillis())
            return
        }
        if (s.status != SessionStatus.IDLE && s.status != SessionStatus.ERROR) return
        when {
            // an edit's rewind ends the old turn before the new message goes out: keep waiting
            p != null && !pendingRan -> Unit
            // the turn ended before the hub kept your message (a hook stopped it, or it failed): the words go back in the box
            p != null -> {
                pending.value = null
                pendingRan = false
                turnStartedAt.value = null
                awaitingReply = null
                if (draft.value.isEmpty()) draft.value = p.text
                if (attachments.value.isEmpty()) attachments.value = p.attachments
            }
            else -> turnStartedAt.value = null
        }
    }

    /**
     * A turn starts: "Thinking 4s" counts from [at], and the reply that
     * answers it takes over the thinking line shown until then (same key).
     */
    private fun startTurn(at: Long) {
        turnStartedAt.value = at
        awaitingReply = at
    }

    private fun onMessage(m: Message) {
        val p = pending.value
        if (m.role == Role.USER && m.kind == MessageKind.NORMAL && p != null && m.id !in p.known && !m.content.all { it is dev.conclave.client.model.ToolResultBlock }) {
            aliases.update { it + (m.id to p.key) }
            pending.value = null
            pendingRan = false
            if (turnStartedAt.value == null) turnStartedAt.value = p.at
        }
        val waiting = awaitingReply
        if (m.role == Role.ASSISTANT && m.kind == MessageKind.NORMAL && waiting != null && pending.value == null) {
            aliases.update { it + (m.id to "r:$waiting") }
            awaitingReply = null
        }
        if (m.role == Role.USER && m.kind == MessageKind.NORMAL && !ChatItems.isToolResultsOnly(m) && p == null) {
            // a queued message goes out: its reply is timed from now
            startTurn(System.currentTimeMillis())
        }
        if (m.kind == MessageKind.ASIDE) {
            asking.value?.let { (target, _) -> asideTargets.update { it + (m.id to target) } }
            asking.value = null
        }
    }

    /**
     * A reply left the chat (Refusal fallback dropped a refused one). In the
     * middle of a turn the thinking line shows again, and the reply that
     * comes next takes it over, as the first one did.
     */
    private fun onDeleted(id: String) {
        if (id !in aliases.value) return
        aliases.update { it - id }
        turnStartedAt.value?.let { awaitingReply = it }
    }

    fun load(quiet: Boolean = false) {
        viewModelScope.launch {
            if (!quiet) loading.value = true
            try {
                val s = hub.api { it.getSession(sessionId) }
                onSession(s)
                // after a reconnect: what is new, and the reply that was still streaming (it may have ended meanwhile)
                val after = if (quiet) TranscriptReducer.reloadAfter(transcript.value) else null
                val askedAt = System.currentTimeMillis()
                val version = transcript.value.queueVersion
                val msgs = hub.api { it.messages(sessionId, afterSeq = after) }
                transcript.update { TranscriptReducer.merge(it, msgs) }
                // what waits behind the reply; a hub from before the queue has none to say
                runCatching { hub.api { it.queue(sessionId) } }.getOrNull()?.let { list ->
                    transcript.update { TranscriptReducer.loadedQueue(it, list, askedAt, version) }
                }
                // what waits on you: a hook can ask even in a chat, and so can a subagent (Asks.kt)
                val approvals = Asks.of(hub.approvals.value, sessionId)
                val questions = runCatching { hub.api { it.questions() } }.getOrNull()?.let { Asks.of(it, sessionId) }
                transcript.update { t -> t.copy(approvals = approvals, questions = questions ?: t.questions) }
                // opened while a reply runs: time it from the message that asked
                if (s.status == SessionStatus.RUNNING && turnStartedAt.value == null) {
                    val all = transcript.value.messages
                    val asked = all.lastOrNull { it.role == Role.USER && it.kind == MessageKind.NORMAL && !ChatItems.isToolResultsOnly(it) }
                    startTurn(asked?.createdAt?.takeIf { it > 0 }?.coerceAtMost(System.currentTimeMillis()) ?: System.currentTimeMillis())
                    // a reply already under way keeps its own key
                    if (asked != null && all.any { it.role == Role.ASSISTANT && it.kind == MessageKind.NORMAL && it.seq > asked.seq }) awaitingReply = null
                }
                val p = pending.value
                val sent = p?.let { pp ->
                    msgs.firstOrNull { it.role == Role.USER && it.kind == MessageKind.NORMAL && it.id !in pp.known && !ChatItems.isToolResultsOnly(it) }
                }
                if (p != null && sent != null) {
                    aliases.update { it + (sent.id to p.key) }
                    val reply = msgs.firstOrNull { it.role == Role.ASSISTANT && it.kind == MessageKind.NORMAL && it.seq > sent.seq }
                    if (reply != null) {
                        aliases.update { it + (reply.id to "r:" + p.at) }
                        awaitingReply = null
                    }
                    pending.value = null
                }
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                loading.value = false
            }
        }
    }

    /** Answer an approval at the end of the chat, its own or a subagent's: the hub resolves it where it was asked. */
    fun resolveApproval(id: String, response: ApprovalResponse) = action {
        hub.resolveApproval(id, response)
        transcript.update { t -> t.copy(approvals = t.approvals.filterNot { it.id == id }) }
    }

    fun answer(questionId: String, answers: Map<String, String>) = action {
        hub.api { it.answerQuestion(questionId, answers) }
        transcript.update { t -> t.copy(questions = t.questions.filterNot { it.id == questionId }) }
    }

    private fun knownIds(): Set<String> = transcript.value.messages.map { it.id }.toSet()

    /** Sends the draft. While a reply runs it queues: it shows at once, Queued, and goes out when that reply ends. */
    fun send() = send(loss = null)

    /** The owner chose to send the message without the file the hub could not read. */
    fun sendWithoutLost() {
        lossAsk.value = null
        send(loss = "drop")
    }

    fun dismissLossAsk() {
        lossAsk.value = null
    }

    private fun send(loss: String?) {
        val text = draft.value.trim()
        val files = attachments.value
        if (text.isEmpty() && files.isEmpty()) return
        // /btw: a side question, never the turn or the queue; the answer shows as a line
        val btw = if (files.isEmpty()) PendingQueue.btwQuestion(text) else null
        if (btw != null) {
            draft.value = ""
            action { say("btw: " + hub.api { it.btw(sessionId, btw) }.answer) }
            return
        }
        // a reply runs (or waits on you), or the last send has not reached the hub yet: this one waits its turn
        val status = _session.value?.status
        val busy = running.value || pending.value != null || status == SessionStatus.WAITING_APPROVAL || status == SessionStatus.WAITING_INPUT
        if (busy) return sendQueued(text, files)
        val p = Pending(text, files, knownIds(), System.currentTimeMillis())
        pendingRan = false
        pending.value = p
        startTurn(p.at)
        // the composer clears in the same frame
        draft.value = ""
        attachments.value = emptyList()
        viewModelScope.launch {
            try {
                val r = hub.api { it.send(sessionId, SendInput(text = text, attachments = files.ifEmpty { null }, attachmentLoss = loss)) }
                // the hub was busy after all: it waits there, listed by session.queue, not as the bubble shown at send
                if (r.queued && pending.value?.text == text) {
                    pending.value = null
                    turnStartedAt.value = null
                    awaitingReply = null
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                pending.value = null
                turnStartedAt.value = null
                if (draft.value.isEmpty()) draft.value = text
                if (attachments.value.isEmpty()) attachments.value = files
                val msg = errorText(e)
                // the hub will not drop a file on its own: the choice is the owner's
                val lost = Attach.lostWords(msg)
                if (lost != null) lossAsk.value = lost else say(msg + " Your message is back in the box.")
            }
        }
    }

    private fun sendQueued(text: String, files: List<Attachment>) {
        val id = PendingQueue.newId()
        transcript.update { TranscriptReducer.sent(it, PendingQueue.item(id, text, files, "queue", System.currentTimeMillis())) }
        if (files.isNotEmpty()) previews.update { it + (id to files) }
        // the composer clears in the same frame; if the hub refuses, the words come back
        draft.value = ""
        attachments.value = emptyList()
        viewModelScope.launch {
            val r = try {
                hub.api { it.send(sessionId, SendInput(text = text, attachments = files.ifEmpty { null }, whenBusy = "queue", pendingId = id)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (draft.value.isEmpty()) draft.value = text
                if (attachments.value.isEmpty()) attachments.value = files
                say(errorText(e) + " Your message is back in the box.")
                null
            }
            transcript.update { TranscriptReducer.answered(it, id, r) }
            if (r?.queued != true) previews.update { it - id }
        }
    }

    /** Send on one Stop held: the hub runs it in its place, and its session.queue updates the row. */
    fun sendHeld(id: String) = action { hub.api { it.sendQueued(sessionId, id) } }

    /** Take a waiting message off before it goes. It leaves at once; if the hub refuses, it comes back and a line says why. */
    fun removeQueued(id: String) {
        val before = transcript.value
        transcript.update { TranscriptReducer.removed(it, id) }
        viewModelScope.launch {
            try {
                hub.api { it.unqueue(sessionId, id) }
                previews.update { it - id }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // it went out already (it is in the chat now), or it is gone
                if (e is dev.conclave.client.ConclaveApiException && (e.status == 404 || e.status == 409)) return@launch
                transcript.update { TranscriptReducer.unremoved(it, before, id) }
                say(errorText(e))
            }
        }
    }

    /** 15 at most (Attach.MAX): the composer says so before it gets here, this keeps it true. */
    fun addAttachment(a: Attachment) = attachments.update { if (Attach.refusal(it, a) == null) it + a else it }
    fun removeAttachment(a: Attachment) = attachments.update { list -> list.filterNot { it === a } }

    fun stop() = action { hub.api { it.abort(sessionId) } }
    fun pause() = action { hub.api { it.pauseSession(sessionId) } }
    fun resume() = action { hub.api { it.resumeSession(sessionId) } }

    /**
     * Replaces [from] and everything after it with a new message (Edit and
     * Retry): the replies after it fade out together (120ms), then your
     * message stays where it was with the new text and the thinking mark takes
     * the replies' place, while the hub drops the old ones and runs the new one.
     */
    fun replaceFrom(from: Message, text: String, files: List<Attachment>) = viewModelScope.launch {
        val after = transcript.value.messages.filter { it.seq > from.seq }.map { it.id }.toSet()
        leaving.value = after
        var rewound = false
        try {
            if (running.value) hub.api { it.abort(sessionId) }
            delay(Motion.DUR_1.toLong())
            // the bubble keeps its place in the list: same key, no rise
            val p = Pending(text, files, knownIds(), System.currentTimeMillis(), key = aliases.value[from.id] ?: from.id, inPlace = true)
            pendingRan = false
            pending.value = p
            startTurn(p.at)
            hidden.value = after + from.id
            leaving.value = emptySet()
            // the hub keeps messages up to the seq it is given and drops the rest
            val s = hub.api { it.rewind(sessionId, from.seq - 1) }
            rewound = true
            onSession(s)
            val msgs = hub.api { it.messages(sessionId) }
            transcript.value = TranscriptReducer.merge(Transcript(sessionId), msgs)
            hidden.value = emptySet()
            hub.api { it.send(sessionId, SendInput(text = text, attachments = files.ifEmpty { null })) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            leaving.value = emptySet()
            hidden.value = emptySet()
            pending.value = null
            turnStartedAt.value = null
            awaitingReply = null
            if (rewound) {
                // the old messages are gone on the hub: keep the words
                if (draft.value.isEmpty()) draft.value = text
                if (attachments.value.isEmpty()) attachments.value = files
                transcript.value = Transcript(sessionId)
                load()
                say(errorText(e) + " Your message is back in the box.")
            } else {
                say(errorText(e))
            }
        }
    }

    /** Retry a reply: send the message that asked for it again, optionally with another model. */
    fun retry(reply: ChatUnit.Reply, model: String? = null) {
        if (dev.conclave.client.logic.NextModel.providerFailure(transcript.value.messages) != null) {
            say("Use Retry with another model. Replaying this turn could repeat completed operations.")
            return
        }
        val user = reply.user ?: return
        viewModelScope.launch {
            if (model != null && model != _session.value?.model) {
                try {
                    patchNow(SessionPatch(model = model))
                } catch (e: Exception) {
                    say(errorText(e))
                    return@launch
                }
            }
            replaceFrom(user, user.content.visibleText(), attachmentsOf(user))
        }
    }

    fun edit(message: Message, text: String) = replaceFrom(message, text.trim(), attachmentsOf(message))

    /** Retry after a failure: send your last message again. */
    fun retryLast() {
        if (dev.conclave.client.logic.NextModel.providerFailure(transcript.value.messages) != null) {
            say("Use Retry with another model. Replaying this turn could repeat completed operations.")
            return
        }
        val user = transcript.value.messages.lastOrNull { it.role == Role.USER && it.kind == MessageKind.NORMAL && !ChatItems.isToolResultsOnly(it) } ?: return
        replaceFrom(user, user.content.visibleText(), attachmentsOf(user))
    }

    /** The refused reply sent to the next model: its button reads "Trying" until the hub drops the reply. */
    val nextFor = MutableStateFlow<String?>(null)

    /**
     * "Try the next model" on a refused reply (NextModel): the hub drops it
     * and runs the turn on the next model of Refusal fallback. Its notices
     * and the new reply come as events.
     */
    fun tryNextModel(reply: Message) {
        if (nextFor.value == reply.id) return
        nextFor.value = reply.id
        viewModelScope.launch {
            try {
                hub.api { it.tryNextModel(sessionId, reply.id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                nextFor.value = null
                say(errorText(e))
            }
        }
    }

    /** Branch: a new chat with everything up to [fromSeq], named "<title>, branch". */
    fun branch(fromSeq: Long?, onBranched: (Session) -> Unit) = action {
        val title = ChatList.branchTitle(_session.value?.title.orEmpty())
        val fork = hub.api { it.forkSession(sessionId, fromSeq) }
        val named = runCatching { hub.api { it.updateSession(fork.id, SessionPatch(title = title)) } }.getOrDefault(fork)
        hub.putSession(named)
        onBranched(named)
    }

    /** Ask another model about a reply; the aside arrives under it. */
    fun askAnother(reply: ChatUnit.Reply, reviewer: String) = viewModelScope.launch {
        val target = reply.last.id
        askedAt = System.currentTimeMillis()
        asking.value = target to reviewer
        try {
            hub.api { it.secondOpinion(sessionId, SecondOpinionInput(reviewer = reviewer, messageId = target)) }
            // the hub answers once the aside is written; if none came, stop waiting
            delay(2_000)
            if (asking.value?.first == target) asking.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            asking.value = null
            say(errorText(e))
        }
    }

    /** "Continue with GPT-5.5" under a second opinion. */
    fun continueWith(aside: Message) {
        settledAsides.update { it + aside.id }
        aside.model?.let { setModel(it) }
    }

    fun dismissAside(aside: Message) = settledAsides.update { it + aside.id }

    private suspend fun patchNow(p: SessionPatch): Session {
        val s = hub.api { it.updateSession(sessionId, p) }
        _session.value = s
        hub.putSession(s)
        return s
    }

    private fun patch(p: SessionPatch) = action { patchNow(p) }

    private fun rememberDefaults(s: Session?) {
        val sw = s?.chatSettings ?: return
        viewModelScope.launch {
            settings.setChatDefaults(ChatDefaults(model = s.model.ifBlank { null }, webSearch = sw.webSearch, memory = sw.memory, thinking = sw.thinking))
        }
    }

    fun setModel(ref: String) = action {
        rememberDefaults(patchNow(SessionPatch(model = ref)))
    }

    fun setThinking(level: ThinkingLevel?) = action {
        val patch = if (level == null) ChatSettingsPatch(agentThinking = true) else ChatSettingsPatch(thinking = level)
        rememberDefaults(patchNow(SessionPatch(chat = patch)))
    }

    fun setCyber(program: String?) = action {
        patchNow(SessionPatch(chat = if (program == null) ChatSettingsPatch(defaultCyber = true) else ChatSettingsPatch(cyber = program)))
    }

    fun setWeb(on: Boolean) = action { rememberDefaults(patchNow(SessionPatch(chat = ChatSettingsPatch(webSearch = on)))) }
    fun setMemory(on: Boolean) = action { rememberDefaults(patchNow(SessionPatch(chat = ChatSettingsPatch(memory = on)))) }

    fun rename(title: String) {
        if (title.isNotBlank()) patch(SessionPatch(title = title.trim()))
    }

    fun delete(onDeleted: () -> Unit) = action {
        hub.api { it.deleteSession(sessionId) }
        hub.sessions.update { list -> list.filterNot { it.id == sessionId } }
        onDeleted()
    }

    /** Archive: the chat leaves the panel and the list; Chats keeps it under Archived. */
    fun archive(onDone: () -> Unit) = action("Archived.") {
        hub.putSession(hub.api { it.updateSession(sessionId, SessionPatch(archived = true)) })
        onDone()
    }

    /** Undo on a "Saved to memory" row: the note leaves memory. */
    fun forgetNote(id: String, onDone: () -> Unit) = action("Removed from memory.") {
        hub.api { it.deleteMemory(id) }
        onDone()
    }

    /** Markdown of the whole chat, for sharing. */
    fun export(onReady: (String, String) -> Unit) = action {
        val r = hub.api { it.exportSession(sessionId, "md") }
        onReady(r.filename.ifBlank { "chat.md" }, r.content)
    }
}

/**
 * Which of Chat, Assistant and Code the switch is on (docs/DESIGN.md 15,
 * logic/Start.kt). New sets it, so it holds while Home is away; the app
 * keeps it in its settings (AppRoot) and puts it back once at the start.
 */
object StartModes {
    val mode = MutableStateFlow(StartMode.CHAT)

    /** Set once a mode was picked or the remembered one was read: a link or a press before the read wins. */
    @Volatile
    private var settled = false

    /** The switch, a New or a link. */
    fun set(m: StartMode) {
        settled = true
        mode.value = m
    }

    /** The mode remembered on this phone, put back unless one was set first. */
    fun restore(saved: StartMode?) {
        if (settled) return
        settled = true
        if (saved != null) mode.value = saved
    }
}

/** The new conversation page: the greeting and the composer, for a chat, the assistant or Code. */
class ChatHomeViewModel(hub: HubRepository, private val settings: SettingsStore) : HubViewModel(hub) {
    val draft = MutableStateFlow("")

    /** What a new Code (and Assistant) session starts with: what was picked on this phone. */
    val code = MutableStateFlow(CodeDefaults())

    /** Why the last start failed, until Home has shown it. */
    val failure = MutableStateFlow<String?>(null)
    val attachments = MutableStateFlow<List<Attachment>>(emptyList())
    val sending = MutableStateFlow(false)
    val model = MutableStateFlow<String?>(null)
    val switches = MutableStateFlow(ChatSettings())

    /** The defaults this page asked to save, in order (one writer, so a quick second change never lands first). */
    private val wanted = MutableStateFlow<ChatDefaults?>(null)

    /** The Code setup this page asked to save, in order. */
    private val wantedCode = MutableStateFlow<CodeDefaults?>(null)

    init {
        // the next new chat starts with what was used last on this phone, here or in a chat
        viewModelScope.launch {
            settings.state.filterNotNull().map { it.chatDefaults }.distinctUntilChanged().collect { d ->
                model.value = d.model
                switches.value = ChatSettings(webSearch = d.webSearch, memory = d.memory, thinking = d.thinking)
            }
        }
        viewModelScope.launch { wanted.filterNotNull().collect { settings.setChatDefaults(it) } }
        viewModelScope.launch {
            settings.state.filterNotNull().map { it.codeDefaults }.distinctUntilChanged().collect { code.value = it }
        }
        viewModelScope.launch { wantedCode.filterNotNull().collect { settings.setCodeDefaults(it) } }
    }

    fun setCode(d: CodeDefaults) {
        code.value = d
        wantedCode.value = d
    }

    /**
     * Starts Code with the draft as its first message: the agent, model,
     * device and folder of [setup] (Start.code), the permission mode, Effort
     * and Ultra picked here, and opens it once the hub made it. With Ultra
     * on, the session is switched before the message goes. A message that
     * is one of the hub's [commands] runs as that command in the new session.
     */
    fun startCode(setup: Start.Setup, commands: List<CommandDef>, onOpen: (String) -> Unit) {
        val text = draft.value.trim()
        val files = attachments.value
        if ((text.isEmpty() && files.isEmpty()) || sending.value) return
        val d = code.value
        val command = if (files.isEmpty()) Start.commandOf(text, commands) else null
        val chat = Effort.clamp(d.thinking, hub.modelInfo(setup.model)?.effort)?.let { ChatSettingsPatch(thinking = it) }
        sending.value = true
        viewModelScope.launch {
            try {
                val later = files.isNotEmpty() || d.ultra
                val prompt = if (later || command != null) null else text
                val repo = d.repo
                val cwd = setup.cwd
                // "Run in a worktree": only when the folder is in a git repository; otherwise the folder itself
                val inWorktree = repo == null && d.worktree && cwd != null &&
                    try {
                        hub.api { it.folderGit(setup.device, cwd) }.git
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        false
                    }
                var s = if (repo != null) {
                    // from GitHub (docs/DESIGN.md 30): a fresh worktree on a new branch, the prompt once it is ready
                    hub.api {
                        it.createRepoSession(
                            RepoSessionInput(
                                repo = repo,
                                base = d.base,
                                device = setup.device,
                                agent = setup.agent,
                                model = setup.model,
                                prompt = prompt,
                                permissionMode = d.permissionMode,
                                chat = chat,
                            ),
                        )
                    }
                } else if (inWorktree && cwd != null) {
                    hub.api {
                        it.createWorktreeSession(
                            WorktreeSessionInput(
                                folder = cwd,
                                device = setup.device,
                                agent = setup.agent,
                                model = setup.model,
                                prompt = prompt,
                                permissionMode = d.permissionMode,
                                chat = chat,
                            ),
                        )
                    }
                } else {
                    val input = CreateSessionInput(
                        agent = setup.agent,
                        model = setup.model,
                        permissionMode = d.permissionMode,
                        device = setup.device,
                        cwd = setup.cwd,
                        prompt = prompt,
                        chat = chat,
                    )
                    hub.api { it.createSession(input) }
                }
                if (d.ultra) s = hub.api { it.updateSession(s.id, SessionPatch(ultra = true)) }
                hub.putSession(s)
                if (command != null) {
                    runCommand(s.id, command, text)
                } else if (later) {
                    hub.api { it.send(s.id, SendInput(text = text, attachments = files.ifEmpty { null })) }
                }
                draft.value = ""
                attachments.value = emptyList()
                onOpen(s.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                sending.value = false
            }
        }
    }

    /**
     * Starts the assistant on the hub with the draft as its first message,
     * on [model], with the permission mode and Effort picked here: no device
     * or folder to ask for. Opens it once the hub made it.
     */
    fun startAssistant(model: String?, commands: List<CommandDef>, onOpen: (String) -> Unit) {
        val text = draft.value.trim()
        val files = attachments.value
        if ((text.isEmpty() && files.isEmpty()) || sending.value) return
        val d = code.value
        val command = if (files.isEmpty()) Start.commandOf(text, commands) else null
        val chat = Effort.clamp(d.thinking, hub.modelInfo(model)?.effort)?.let { ChatSettingsPatch(thinking = it) }
        sending.value = true
        viewModelScope.launch {
            try {
                // the one Assistant thread; an older hub without it (null) gets a new session, as before
                val home = hub.api { it.assistantHome() }
                val s = if (home != null) {
                    if (model != null && model != home.model) hub.api { it.updateSession(home.id, SessionPatch(model = model)) } else home
                } else {
                    val input = CreateSessionInput(
                        agent = Start.ASSISTANT_AGENT,
                        model = model,
                        device = "local",
                        permissionMode = d.permissionMode,
                        prompt = if (files.isEmpty() && command == null) text else null,
                        chat = chat,
                    )
                    hub.api { it.createSession(input) }
                }
                hub.putSession(s)
                if (command != null) {
                    runCommand(s.id, command, text)
                } else if (home != null || files.isNotEmpty()) {
                    hub.api { it.send(s.id, SendInput(text = text, attachments = files.ifEmpty { null })) }
                }
                draft.value = ""
                attachments.value = emptyList()
                onOpen(s.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                sending.value = false
            }
        }
    }

    /** A command in a session just made: what it says shows once the session is in front (ChatHandoff). */
    private suspend fun runCommand(sessionId: String, name: String, line: String) {
        val r = hub.api { it.command(sessionId, line) }
        r.output?.trim()?.ifEmpty { null }?.let { ChatHandoff.note(sessionId, "/$name: $it", null) }
    }

    private fun save() {
        val sw = switches.value
        wanted.value = ChatDefaults(model.value, sw.webSearch, sw.memory, sw.thinking)
    }

    fun setModel(ref: String) {
        model.value = ref
        save()
    }

    fun setThinking(level: ThinkingLevel?) {
        switches.update { it.copy(thinking = level) }
        save()
    }

    fun setWeb(on: Boolean) {
        switches.update { it.copy(webSearch = on) }
        save()
    }

    fun setMemory(on: Boolean) {
        switches.update { it.copy(memory = on) }
        save()
    }

    /** 15 at most (Attach.MAX): the composer says so before it gets here, this keeps it true. */
    fun addAttachment(a: Attachment) = attachments.update { if (Attach.refusal(it, a) == null) it + a else it }
    fun removeAttachment(a: Attachment) = attachments.update { list -> list.filterNot { it === a } }

    /**
     * Starts a plain chat: [onOpen] gets a start key at once, so the chat
     * screen shows your message and the thinking mark before the hub
     * answers (ChatStarts). One call makes the chat and sends the message;
     * with files the chat is made first and the message follows.
     */
    fun start(onOpen: (String) -> Unit) {
        val text = draft.value.trim()
        val files = attachments.value
        if ((text.isEmpty() && files.isEmpty()) || sending.value) return
        sending.value = true
        val sw = switches.value
        val p = Pending(text, files, emptySet(), System.currentTimeMillis())
        val key = ChatStarts.begin(p, model.value ?: hub.hubInfo.value?.defaultModel?.ifBlank { null })
        // the box clears in the same frame the chat opens
        draft.value = ""
        attachments.value = emptyList()
        onOpen(key)
        viewModelScope.launch {
            try {
                val input = CreateSessionInput(
                    kind = SessionKind.CHAT,
                    model = model.value,
                    chat = ChatSettingsPatch(webSearch = sw.webSearch, memory = sw.memory, thinking = sw.thinking),
                    prompt = if (files.isEmpty()) text else null,
                )
                val s = hub.api { it.createSession(input) }
                hub.putSession(s)
                if (files.isNotEmpty()) {
                    hub.api { it.send(s.id, SendInput(text = text, attachments = files)) }
                }
                ChatStarts.created(key, s.id)
            } catch (e: CancellationException) {
                ChatStarts.done(key)
                throw e
            } catch (e: Exception) {
                ChatStarts.failed(key, errorText(e))
                if (draft.value.isEmpty()) draft.value = text
                if (attachments.value.isEmpty()) attachments.value = files
                // kept until Home shows it: the chat screen may be in front right now
                failure.value = errorText(e) + " Your message is back in the box."
            } finally {
                sending.value = false
            }
        }
    }
}

/** Continue as a session (CHAT-AND-MOTION 2.9): the chat moves to Code with an agent that can work on a device. */
suspend fun continueAsSession(
    hub: HubRepository,
    chat: Session,
    agent: String?,
    device: String,
    cwd: String,
    permissionMode: PermissionMode,
    keepChat: Boolean,
): Session {
    // keep this chat: the copy moves and takes the chat's title
    val target = if (keepChat) hub.api { it.forkSession(chat.id, null) } else chat
    val moved = hub.api {
        it.updateSession(
            target.id,
            SessionPatch(
                kind = SessionKind.AGENT,
                agent = agent,
                device = device,
                cwd = cwd.ifBlank { "~" },
                permissionMode = permissionMode,
                title = if (keepChat) chat.title else null,
            ),
        )
    }
    hub.putSession(moved)
    return moved
}
