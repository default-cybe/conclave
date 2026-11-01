package dev.conclave.app.ui.chat

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ComposerDraft
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.conversation.attachmentsOf
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.logic.AgentResults
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.Attach
import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.DraftStore
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.ShareIn
import dev.conclave.client.logic.Transcript
import dev.conclave.client.logic.RunReducer
import dev.conclave.client.logic.TranscriptReducer
import dev.conclave.client.logic.Unread
import dev.conclave.client.model.ApprovalResponse
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.ChatSettingsPatch
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.Role
import dev.conclave.client.model.SecondOpinionInput
import dev.conclave.client.model.SendInput
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionPatch
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.SwitchEstimate
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.visibleText
import dev.conclave.client.moveToHub
import dev.conclave.client.workflowRuns
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ChatViewModel(hub: HubRepository, val sessionId: String, drafts: DraftStore) : HubViewModel(hub) {
    private val transcript = MutableStateFlow(Transcript(sessionId))
    private val _session = MutableStateFlow(hub.sessions.value.firstOrNull { it.id == sessionId })
    val session: StateFlow<Session?> = _session

    val loading = MutableStateFlow(true)
    val error = MutableStateFlow<String?>(null)

    /** Composer draft lives here so it survives configuration changes, and on disk ([DraftStore]) so it survives Android closing the app. */
    val draft = MutableStateFlow("")
    val attachments = MutableStateFlow<List<Attachment>>(emptyList())
    private val saved = ComposerDraft(viewModelScope, drafts, sessionId, draft, attachments) { say(it) }
    val sending = MutableStateFlow(false)

    /** A file the hub could not read: its words, while the owner chooses to send without it. */
    val lossAsk = MutableStateFlow<String?>(null)

    val items: StateFlow<List<ChatItem>> = transcript
        .map { ChatItems.build(it.messages) }
        .flowOn(Dispatchers.Default)
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Tool results, progress and pending cards: everything the list needs besides items. */
    val live: StateFlow<Transcript> = transcript

    /** The session's workflow runs, newest first, kept live from workflow.run events: its Workflow rows and its running tasks. */
    val runs = MutableStateFlow<List<WorkflowRun>>(emptyList())

    val running: StateFlow<Boolean> = combine(_session, transcript) { s, t ->
        s?.status == SessionStatus.RUNNING || t.runningTools.isNotEmpty()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    /** What you sent while it works, in the order it will run, until each turn takes it (docs/design/CHAT-AND-MOTION.md 2.11). */
    val pending: StateFlow<List<QueuedMessage>> = transcript
        .map { it.pending }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** The files this app sent with a waiting message, so its bubble shows the pictures before the hub has stored them. */
    val previews = MutableStateFlow<Map<String, List<Attachment>>>(emptyMap())

    init {
        // Subscribe first so nothing streamed during the initial load is lost.
        viewModelScope.launch {
            hub.events.collect { e -> onEvent(e) }
        }
        load()
    }

    override fun onCleared() {
        saved.flush()
        super.onCleared()
    }

    private fun onEvent(e: EngineEvent) {
        when (e) {
            is EngineEvent.SessionUpdated -> if (e.session.id == sessionId) {
                _session.value = e.session
                seen(e.session)
            }
            is EngineEvent.SessionDeleted -> if (e.sessionId == sessionId) {
                saved.forget()
                error.value = "This chat was deleted"
            }
            // moved to another device or folder: the session (and the move line in the transcript) come again
            is EngineEvent.SessionMoved -> if (e.sessionId == sessionId) load(quiet = true)
            is EngineEvent.ConfigUpdated -> load(quiet = true)
            is EngineEvent.WorkflowRunUpdated -> if (e.run.sessionId == sessionId) runs.update { RunReducer.upsertRun(it, e.run, sessionId) }
            else -> Unit
        }
        // an approval or a question shows here when this session or one under it asks (Asks.kt); the reducer decides
        if (e.sessionKey == sessionId || Asks.isAskEvent(e)) {
            transcript.update { TranscriptReducer.apply(it, e) }
        }
    }

    fun load(quiet: Boolean = false) {
        viewModelScope.launch {
            if (!quiet) loading.value = true
            try {
                val s = hub.api { it.getSession(sessionId) }
                _session.value = s
                seen(s)
                // after a reconnect: what is new, and the reply that was still streaming (it may have ended meanwhile)
                val after = if (quiet) TranscriptReducer.reloadAfter(transcript.value) else null
                val askedAt = System.currentTimeMillis()
                val version = transcript.value.queueVersion
                val msgs = hub.api { it.messages(sessionId, afterSeq = after) }
                transcript.update { TranscriptReducer.merge(it, msgs) }
                // what waits while it works; a hub from before the queue has none to say
                runCatching { hub.api { it.queue(sessionId) } }.getOrNull()?.let { list ->
                    transcript.update { TranscriptReducer.loadedQueue(it, list, askedAt, version) }
                }
                val todos = runCatching { hub.api { it.todos(sessionId) } }.getOrNull()
                // its own, and its subagents' and workflow agents'
                val approvals = Asks.of(hub.approvals.value, sessionId)
                val questions = runCatching { hub.api { it.questions() } }.getOrNull()?.let { Asks.of(it, sessionId) }
                runCatching { hub.api { it.workflowRuns(sessionId = sessionId, limit = 50) } }.getOrNull()?.let { runs.value = it }
                transcript.update { t ->
                    t.copy(
                        todos = todos ?: t.todos,
                        approvals = approvals,
                        questions = questions ?: t.questions,
                    )
                }
                error.value = null
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                loading.value = false
            }
        }
    }

    /** Open here: a reply that came clears its bold title in the lists, on the hub so the web agrees (logic/Unread.kt). */
    private fun seen(s: Session) {
        if (!Unread.isUnread(s)) return
        viewModelScope.launch { runCatching { hub.api { it.markSeen(sessionId) } } }
    }

    fun send() {
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
        // a turn runs or waits on you: the message shows at once, Queued, until its turn takes it
        val status = _session.value?.status
        if (running.value || status == SessionStatus.WAITING_APPROVAL || status == SessionStatus.WAITING_INPUT) return sendQueued(text, files)
        sending.value = true
        viewModelScope.launch {
            try {
                val busy = running.value
                hub.api {
                    it.send(sessionId, SendInput(text = text, attachments = files.ifEmpty { null }, whenBusy = if (busy) "queue" else null))
                }
                draft.value = ""
                attachments.value = emptyList()
            } catch (e: Exception) {
                val msg = errorText(e)
                // the hub will not drop a file on its own: the choice is the owner's
                val lost = Attach.lostWords(msg)
                if (lost != null) lossAsk.value = lost else say(msg)
            } finally {
                sending.value = false
            }
        }
    }

    /** The owner chose to send the message without the file the hub could not read. */
    fun sendWithoutLost() {
        val text = draft.value.trim()
        val files = attachments.value
        lossAsk.value = null
        if (text.isEmpty() && files.isEmpty()) return
        sending.value = true
        viewModelScope.launch {
            try {
                hub.api {
                    it.send(sessionId, SendInput(text = text, attachments = files.ifEmpty { null }, attachmentLoss = "drop"))
                }
                draft.value = ""
                attachments.value = emptyList()
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                sending.value = false
            }
        }
    }

    fun dismissLossAsk() {
        lossAsk.value = null
    }

    private fun sendQueued(text: String, files: List<Attachment>) {
        val id = PendingQueue.newId()
        transcript.update { TranscriptReducer.sent(it, PendingQueue.item(id, text, files, "queue", System.currentTimeMillis())) }
        if (files.isNotEmpty()) previews.update { it + (id to files) }
        // the box clears in the same frame; if the hub refuses, the words come back
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

    /** Take a waiting message off before it runs. It leaves at once; if the hub refuses, it comes back and a line says why. */
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
                // its turn started (it is in the transcript now), or it is gone already
                if (e is ConclaveApiException && (e.status == 404 || e.status == 409)) return@launch
                transcript.update { TranscriptReducer.unremoved(it, before, id) }
                say(errorText(e))
            }
        }
    }

    /**
     * One of the hub's "/" commands ("/compact", "/model opus", a custom
     * one): the hub runs it, and what it says comes back as a line. On a
     * failure the words go back in the box.
     */
    fun runCommand(line: String) {
        val text = line.trim()
        if (text.isEmpty() || sending.value) return
        draft.value = ""
        sending.value = true
        viewModelScope.launch {
            try {
                val r = hub.api { it.command(sessionId, text) }
                r.output?.trim()?.ifEmpty { null }?.let { say(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (draft.value.isEmpty()) draft.value = text
                say(errorText(e))
            } finally {
                sending.value = false
            }
        }
    }

    /** 15 at most (Attach.MAX): the composer says so before it gets here, this keeps it true. */
    fun addAttachment(a: Attachment) = attachments.update { if (Attach.refusal(it, a) == null) it + a else it }
    fun removeAttachment(a: Attachment) = attachments.update { list -> list.filterNot { it === a } }

    /** Text and files shared from another app into this session, once its saved draft is read so neither is lost; the line for files left out, or null. */
    suspend fun addShared(text: String, files: List<Attachment>): String? {
        saved.ready.first { it }
        draft.value = ShareIn.draft(draft.value, text)
        val (all, refused) = ShareIn.merge(attachments.value, files)
        attachments.value = all
        return refused
    }

    fun stop() = action { hub.api { it.abort(sessionId) } }

    fun resolveApproval(id: String, response: ApprovalResponse) = action {
        hub.resolveApproval(id, response)
        transcript.update { t -> t.copy(approvals = t.approvals.filterNot { it.id == id }) }
    }

    fun answer(questionId: String, answers: Map<String, String>) = action {
        hub.api { it.answerQuestion(questionId, answers) }
        transcript.update { t -> t.copy(questions = t.questions.filterNot { it.id == questionId }) }
    }

    fun secondOpinion(message: Message, reviewer: String) = action("Asked ${reviewer.substringAfter('/')}") {
        hub.api { it.secondOpinion(sessionId, SecondOpinionInput(reviewer = reviewer, messageId = message.id)) }
    }

    fun fork(message: Message, onForked: (String) -> Unit) = action {
        val s = hub.api { it.forkSession(sessionId, fromSeq = message.seq) }
        onForked(s.id)
    }

    fun rewind(message: Message, restoreFiles: Boolean) = action("Rewound") {
        val s = hub.api { it.rewind(sessionId, message.seq, restoreFiles) }
        _session.value = s
        transcript.value = Transcript(sessionId)
        load(quiet = true)
    }

    /** A switch waiting on the owner's choice: the price step (SwitchSheet, docs/DESIGN.md 44). */
    data class SwitchStep(val model: String, val estimate: SwitchEstimate)

    val switchStep = MutableStateFlow<SwitchStep?>(null)

    /** A model picked for this session: a big chat shows the price first; anything else switches at once with the full history. */
    fun pickModel(model: String) = action {
        if (model == _session.value?.model) return@action
        val estimate = try {
            hub.api { it.switchEstimate(sessionId, model) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null // an older hub: switch as before
        }
        if (estimate?.confirm == true) switchStep.value = SwitchStep(model, estimate) else switchTo(model, brief = false)
    }

    /** Switch the model; [brief] is the short handover the owner picked. */
    fun switchTo(model: String, brief: Boolean) = action("Switched to ${ModelRefs.displayName(model)}${if (brief) " with a short handover" else ""}") {
        switchStep.value = null
        _session.value = hub.api { it.handoff(sessionId, model, brief) }
    }

    /** One second opinion from [model] instead of a switch: the current model and its cache stay. */
    fun askOnce(model: String) = action("Asked ${ModelRefs.displayName(model)} once") {
        switchStep.value = null
        hub.api { it.secondOpinion(sessionId, SecondOpinionInput(reviewer = model, includeTranscript = true)) }
    }

    fun setMode(mode: SessionMode) = patch(SessionPatch(mode = mode))
    fun setAgent(agent: String) = patch(SessionPatch(agent = agent))
    fun setPermissionMode(mode: PermissionMode) = patch(SessionPatch(permissionMode = mode))

    /** Effort for this session (chat.thinking); null goes back to the agent's level. */
    fun setEffort(level: ThinkingLevel?) =
        patch(SessionPatch(chat = if (level == null) ChatSettingsPatch(agentThinking = true) else ChatSettingsPatch(thinking = level)))

    /** Cyber access for this session (chat.cyber); null goes back to Default, which sends nothing. */
    fun setCyber(program: String?) =
        patch(SessionPatch(chat = if (program == null) ChatSettingsPatch(defaultCyber = true) else ChatSettingsPatch(cyber = program)))

    /** Ultra: the agent plans and runs workflows for real tasks (docs/WORKFLOWS.md). The hub refuses it on chats. */
    fun setUltra(on: Boolean) = patch(SessionPatch(ultra = on))
    fun togglePin() = patch(SessionPatch(pinned = !(_session.value?.pinned ?: false)))
    fun rename(title: String) = patch(SessionPatch(title = title))
    fun archive() = patch(SessionPatch(archived = true))

    fun delete(onDeleted: () -> Unit) = action {
        hub.api { it.deleteSession(sessionId) }
        saved.forget()
        hub.sessions.update { list -> list.filterNot { it.id == sessionId } }
        onDeleted()
    }

    private fun patch(p: SessionPatch) = action {
        _session.value = hub.api { it.updateSession(sessionId, p) }
    }

    fun compact() = action("Compacting") { hub.api { it.compact(sessionId) } }

    /** Move to hub (copy folder): the hub copies the whole folder, then the session runs there; progress lands in the session. */
    fun moveToHub() = action("Copying the folder to the hub") { hub.api { it.moveToHub(sessionId) } }

    /** Move to Chat: the session becomes a chat and opens where chats are. */
    fun moveToChat() = patch(SessionPatch(kind = SessionKind.CHAT))

    /** Move to main list: delegated work becomes a normal session of its kind; its parentId stays (docs/DESIGN.md 43). */
    fun moveToMainList() = action("Moved to the main list.") {
        _session.value = hub.api { it.moveToMainList(sessionId) }
    }

    /** Retry the last turn: the hub drops it, and your last message goes again. */
    fun retryLast() = action {
        check(dev.conclave.client.logic.NextModel.providerFailure(transcript.value.messages) == null) { "Use Retry with another model. Replaying this turn could repeat completed operations." }
        val user = transcript.value.messages.lastOrNull { it.role == Role.USER && it.kind == MessageKind.NORMAL && !ChatItems.isToolResultsOnly(it) && !AgentResults.isContextOnly(it) } ?: return@action
        retryFrom(user)
    }

    /** Retry under an earlier turn: the message it answers goes again, and the turns after it leave. [first]: the turn's first message. */
    fun retryBefore(first: Message) = action {
        check(dev.conclave.client.logic.NextModel.providerFailure(transcript.value.messages) == null) { "Use Retry with another model. Replaying this turn could repeat completed operations." }
        val user = transcript.value.messages.lastOrNull { it.seq < first.seq && it.role == Role.USER && it.kind == MessageKind.NORMAL && !ChatItems.isToolResultsOnly(it) && !AgentResults.isContextOnly(it) } ?: return@action
        retryFrom(user)
    }

    private suspend fun retryFrom(user: Message) {
        if (running.value) hub.api { it.abort(sessionId) }
        // the hub keeps messages up to the seq it is given and drops the rest
        _session.value = hub.api { it.rewind(sessionId, user.seq - 1) }
        transcript.value = Transcript(sessionId)
        load(quiet = true)
        hub.api { it.send(sessionId, SendInput(text = user.content.visibleText(), attachments = attachmentsOf(user).ifEmpty { null })) }
    }

    /** The refused reply sent to the next model: its button reads "Trying" until the hub drops the reply. */
    val nextFor = MutableStateFlow<String?>(null)

    /**
     * "Try the next model" on a refused turn (NextModel): the hub drops the
     * reply and runs the turn on the next model of Refusal fallback. Its
     * notices and the new reply come as events.
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

    /** "Resume now" on a limit notice: try the turn again with the usual resume prompt. */
    fun resumeNow() = action {
        hub.api { it.send(sessionId, SendInput(text = "The usage limit has reset. Continue where you left off.")) }
    }
}
