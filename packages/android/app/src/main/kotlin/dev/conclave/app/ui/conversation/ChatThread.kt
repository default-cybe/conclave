@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.chat.ApprovalPrompt
import dev.conclave.app.ui.chat.QuestionPrompt
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.friends.FriendShareLine
import dev.conclave.app.ui.friends.SendToFriendSheet
import dev.conclave.app.ui.motion.GapEntry
import dev.conclave.app.ui.motion.LiveState
import dev.conclave.app.ui.motion.LiveStatus
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.gapItem
import dev.conclave.app.ui.motion.gapRow
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.motion.rememberGapHold
import dev.conclave.app.ui.motion.rememberGapList
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.chatDensity
import dev.conclave.client.logic.CyberAccess
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.ChatList
import dev.conclave.client.logic.ChatLive
import dev.conclave.client.logic.ChatUnit
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.LivePhase
import dev.conclave.client.logic.ModelRefs
import dev.conclave.client.logic.NextModel
import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.model.ApprovalRequest
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.QuestionRequest
import dev.conclave.client.model.QueuedMessage
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.plainText
import dev.conclave.client.model.visibleText
import dev.conclave.client.motion.RimState
import kotlinx.coroutines.launch

/** Edit or Retry, asked first when it removes more than two replies. */
private data class Replace(
    val message: Message,
    val text: String,
    /** Retry this reply (with [model] when one was picked); null: an edit. */
    val reply: ChatUnit.Reply? = null,
    val model: String? = null,
)

/** What the model picker is choosing for. */
private sealed class Pick {
    data object Model : Pick()
    data class Retry(val reply: ChatUnit.Reply) : Pick()
    data class Ask(val reply: ChatUnit.Reply) : Pick()
}

/** One item of the list, newest first (the list is drawn from the bottom). */
private sealed class Row2(val key: String) {
    class Unit2(key: String, val unit: ChatUnit, val index: Int) : Row2(key)
    class PendingBubble(key: String, val p: Pending) : Row2(key)

    /** One you sent while a reply ran, waiting for its turn (docs/design/CHAT-AND-MOTION.md 2.11). */
    class Queued(val item: QueuedMessage) : Row2(PendingQueue.key(item.id))
    class PendingReply(key: String, val startedAt: Long?) : Row2(key)
    class Asking(key: String, val model: String) : Row2(key)
    class Failed(key: String) : Row2(key)
    class Resuming(key: String, val resumeAt: Long?) : Row2(key)

    /** What waits on you at the end, the chat's own or a subagent's (Asks.kt); it stays in place while it confirms. */
    class Approval(val e: GapEntry<ApprovalRequest>) : Row2("a:" + e.key)
    class Question(val e: GapEntry<QuestionRequest>) : Row2("q:" + e.key)
    class Bottom : Row2("bottom")
}

/**
 * One chat (MOBILE-V2 5): the top bar with the title (a tap opens the
 * chat's sheet), your messages in bubbles, replies as plain prose with
 * their tool calls folded into one line, and the composer. What waits on
 * you sits at the end as a prompt: an approval or a question of the chat's
 * own, or of a subagent it started, under "Subagent email asks" (Asks.kt).
 * The view sticks to the bottom while you are there; "Jump to latest" rises
 * when you scroll up while content arrives.
 */
@Composable
fun ChatThreadScreen(
    sessionId: String,
    onOpenChat: (String) -> Unit,
    onNewChat: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenMemory: () -> Unit,
    onOpenFriend: ((String) -> Unit)? = null,
    onOpenShare: ((String) -> Unit)? = null,
    onOpenUsage: (() -> Unit)? = null,
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val vm: ChatThreadViewModel = viewModel(key = "chat-thread:$sessionId") { ChatThreadViewModel(hub, container.settings, sessionId) }
    val session by vm.session.collectAsStateWithLifecycle()
    val units by vm.units.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val running by vm.running.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val attachments by vm.attachments.collectAsStateWithLifecycle()
    val pending by vm.pending.collectAsStateWithLifecycle()
    val startedAt by vm.turnStartedAt.collectAsStateWithLifecycle()
    val queued by vm.queued.collectAsStateWithLifecycle()
    val previews by vm.previews.collectAsStateWithLifecycle()
    val asking by vm.asking.collectAsStateWithLifecycle()
    val leaving by vm.leaving.collectAsStateWithLifecycle()
    val settled by vm.settledAsides.collectAsStateWithLifecycle()
    val aliases by vm.aliases.collectAsStateWithLifecycle()
    val thoughtMs by vm.thoughtMs.collectAsStateWithLifecycle()
    val nextFor by vm.nextFor.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val groups by hub.models.collectAsStateWithLifecycle()
    val c = Conclave.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)

    var sheet by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var sendingToFriend by remember { mutableStateOf(false) }
    var continuing by remember { mutableStateOf(false) }
    var pick by remember { mutableStateOf<Pick?>(null) }
    var editing by remember { mutableStateOf<String?>(null) }
    var confirmReplace by remember { mutableStateOf<Replace?>(null) }
    var userSheet by remember { mutableStateOf<Message?>(null) }

    // a session that is not a chat opens in Sessions, once
    var redirected by remember { mutableStateOf(false) }
    LaunchedEffect(session?.kind, session?.id, loading) {
        val s = session ?: return@LaunchedEffect
        if (!s.isChat && !loading && !redirected) {
            redirected = true
            onOpenSession(s.id)
        }
    }
    // a line handed over by the screen that opened this one ("Branched. The original is in Today.")
    LaunchedEffect(sessionId) {
        val (text, open) = ChatHandoff.takeNote(sessionId) ?: return@LaunchedEffect
        val r = snackbar.showSnackbar(text, actionLabel = if (open != null) "Open" else null)
        if (r == SnackbarResult.ActionPerformed && open != null) onOpenChat(open)
    }

    val s = session
    val failed = s?.status == SessionStatus.ERROR && !running
    val providerFailure = NextModel.providerFailure(live.messages) != null
    val resuming = s?.status == SessionStatus.WAITING_RESET
    // an approval or a question is open, the chat's own or a subagent's: the reply waits on you
    val childWaits = s?.status == SessionStatus.RUNNING && Asks.below(live.approvals + live.questions, sessionId)
    val waitingOnYou = s?.status == SessionStatus.WAITING_APPROVAL || s?.status == SessionStatus.WAITING_INPUT || childWaits
    val lastReplyIndex = units.indexOfLast { it is ChatUnit.Reply }
    // the reply of the latest turn, if it has one yet: a failure or a limit before any of it arrived
    // belongs to the turn, not to the reply before it
    val turnReplyIndex = lastReplyIndex.takeIf { it > units.indexOfLast { u -> u is ChatUnit.User && !u.queued } } ?: -1
    // the reply being written (none while what you just sent is on its way)
    val liveIndex = if (pending == null) ChatLive.liveIndex(units, running) else -1
    // a reply is on its way but nothing of it has arrived yet
    val awaiting = pending != null || ChatLive.awaiting(units, running)
    // a refused reply whose notice offers the next model of Refusal fallback: on the notice and in the reply's row
    val nextModel = remember(live.messages, s?.status) { NextModel.of(live.messages, s?.status) }

    fun branchFrom(fromSeq: Long?) {
        vm.branch(fromSeq) { fork ->
            // this screen goes away: the branch's screen says it
            val where = ChatList.group(s?.updatedAt ?: System.currentTimeMillis()).second
            ChatHandoff.note(fork.id, "Branched. The original is in $where.", sessionId)
            onOpenChat(fork.id)
        }
    }

    val canSendToFriend = s != null && ShareWords.canSend(s)
    val actions = remember(units, canSendToFriend) {
        ReplyActions(
            retry = { r ->
                val after = r.user?.let { ChatList.repliesAfter(units, it) } ?: 0
                val u = r.user
                if (after > 2 && u != null) confirmReplace = Replace(u, u.content.visibleText(), reply = r) else vm.retry(r)
            },
            retryWith = { r -> pick = Pick.Retry(r) },
            branch = { r -> branchFrom(r.lastSeq) },
            askAnother = { r -> pick = Pick.Ask(r) },
            continueAsSession = { continuing = true },
            forgetNote = { id, done -> vm.forgetNote(id, done) },
            openMemory = onOpenMemory,
            switchModel = { pick = Pick.Model },
            sendToFriend = if (canSendToFriend) ({ sendingToFriend = true }) else null,
        )
    }

    // allow and close the gap: a decided prompt confirms in place, then slides away
    val approvalHold = rememberGapHold()
    val approvalRows = rememberGapList(live.approvals, { it.id }, approvalHold)
    val questionRows = rememberGapList(live.questions, { it.id })
    val rows = remember(units, pending, awaiting, asking, failed, resuming, s?.resumeAt, startedAt, aliases, queued, approvalRows, questionRows) {
        // a message that took a waiting one's place keeps that row's key, so it stays where it was and does not fade in
        val unitRows = units.indices.reversed().map { i ->
            val u = units[i]
            Row2.Unit2(aliases[u.key] ?: (u as? ChatUnit.User)?.let { PendingQueue.keyOf(it.message) } ?: u.key, u, i)
        }
        val keys = unitRows.map { it.key }.toHashSet()
        val out = ArrayList<Row2>()
        out.add(Row2.Bottom())
        // what waits on you, last, like a permission prompt
        questionRows.forEach { out.add(Row2.Question(it)) }
        approvalRows.forEach { out.add(Row2.Approval(it)) }
        // what you sent while it replies waits at the end, in the order it will go
        queued.asReversed().forEach { if (PendingQueue.key(it.id) !in keys) out.add(Row2.Queued(it)) }
        // a failure shows once: on the hub's error notice when there is one, else on its own line
        if (failed && pending == null && !isErrorNotice(units.lastOrNull())) out.add(Row2.Failed("failed"))
        // a limit: still, with the time it resumes
        if (resuming && pending == null) out.add(Row2.Resuming("resuming", s?.resumeAt))
        asking?.let { (_, model) -> out.add(Row2.Asking("asking", model)) }
        val p = pending
        val at = p?.at ?: startedAt ?: 0L
        // what shows before the hub has it; never twice once it has
        if (awaiting && "r:$at" !in keys) out.add(Row2.PendingReply("r:$at", p?.at ?: startedAt))
        if (p != null && p.key !in keys) out.add(Row2.PendingBubble(p.key, p))
        out.addAll(unitRows)
        out
    }

    val listState = rememberLazyListState()
    val reduced = reducedMotion()
    // sending brings you back to the bottom
    LaunchedEffect(pending?.at) {
        if (pending != null) {
            if (reduced) listState.scrollToItem(0) else listState.animateScrollToItem(0)
        }
    }
    val density = LocalDensity.current
    val away by remember { derivedStateOf { listState.firstVisibleItemIndex > 1 || listState.firstVisibleItemScrollOffset > with(density) { 120.dp.toPx() } } }

    Column(Modifier.fillMaxSize().imePadding()) {
        // the top bar: the menu, the title (a tap opens the chat's sheet) and New chat
        TopBar(title = s?.title?.ifBlank { null } ?: "New chat", onTitle = if (s != null) ({ sheet = true }) else null)
        // made from a friend's share: whose turns are quoted here
        s?.let { FriendShareLine(it, onOpenShare) }
        OfflineBanner(connection)
        dev.conclave.app.ui.chat.RetryProvider(s, live.messages, groups)
        error?.let { ErrorBanner(it, onRetry = { vm.load() }) }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            if (loading && units.isEmpty() && pending == null) {
                LoadingBox()
            } else {
                // one column of at most 720dp, centered on tablets; its text at the Text size of Settings, Appearance
                CompositionLocalProvider(LocalDensity provides chatDensity()) {
                    LazyColumn(
                        state = listState,
                        reverseLayout = true,
                        modifier = Modifier.fillMaxHeight().widthIn(max = 752.dp).fillMaxWidth().align(Alignment.TopCenter),
                    ) {
                        items(rows, key = { it.key }) { row ->
                            val itemMod = Modifier.animateItem(fadeInSpec = tween(Motion.DUR_2, easing = Motion.Ease), placementSpec = null, fadeOutSpec = null)
                            when (row) {
                                is Row2.Bottom -> Spacer(Modifier.height(12.dp))
                                is Row2.Question -> QuestionPrompt(
                                    row.e.item,
                                    onAnswer = { vm.answer(row.e.item.id, it) },
                                    modifier = gapItem().gapRow(row.e.leaving).padding(horizontal = 20.dp, vertical = 6.dp),
                                    viewing = sessionId,
                                )
                                is Row2.Approval -> ApprovalPrompt(
                                    row.e.item,
                                    onDecide = { vm.resolveApproval(row.e.item.id, it) },
                                    onConfirm = approvalHold::confirm,
                                    modifier = gapItem().gapRow(row.e.leaving).padding(horizontal = 20.dp, vertical = 6.dp),
                                    viewing = sessionId,
                                )
                                is Row2.Failed -> Box(itemMod.padding(horizontal = 20.dp)) {
                                    FailedLine(reason = s?.error, onRetry = if (providerFailure) null else vm::retryLast, onSwitch = { pick = Pick.Model }, mark = turnReplyIndex < 0)
                                }
                                is Row2.Resuming -> Box(itemMod.padding(horizontal = 20.dp, vertical = 6.dp)) {
                                    // the reply's Knot is the grey stub above; it writes on from there when the limit resets
                                    LiveStatus(LiveState.RESUMING, resumeAt = row.resumeAt, countdown = row.resumeAt != null, label = if (row.resumeAt == null) "Resumes when the limit resets" else null, mark = turnReplyIndex < 0)
                                }
                                // one mark moves per chat: while a reply is written, the reply has it
                                is Row2.Asking -> Box(itemMod.padding(horizontal = 20.dp, vertical = 4.dp)) {
                                    LiveStatus(LiveState.THINKING, label = "Asking " + ModelRefs.displayName(row.model).ifBlank { row.model }, startedAt = vm.askedAt, mark = liveIndex < 0 && !awaiting)
                                }
                                is Row2.PendingReply -> Box(itemMod.padding(horizontal = 20.dp, vertical = 6.dp)) {
                                    PendingReplyLine(row.startedAt)
                                }
                                is Row2.PendingBubble -> Rise(row.key, itemMod.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 6.dp), animate = !row.p.inPlace) {
                                    UserBubble(
                                        message = null,
                                        text = row.p.text,
                                        images = row.p.attachments.filter { it.mediaType.startsWith("image/") && it.data != null }.map { ImageBlock(mediaType = it.mediaType, data = it.data) },
                                        files = row.p.attachments.filterNot { it.mediaType.startsWith("image/") }.map { it.name ?: "File" },
                                        onTap = {},
                                    )
                                }
                                is Row2.Queued -> Rise(row.key, itemMod.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 6.dp)) {
                                    val local = previews[row.item.id]
                                    UserBubble(
                                        message = null,
                                        text = row.item.text,
                                        images = local.orEmpty().filter { it.mediaType.startsWith("image/") && it.data != null }.map { ImageBlock(mediaType = it.mediaType, data = it.data) },
                                        files = if (local != null) local.filterNot { it.mediaType.startsWith("image/") }.map { it.name ?: "File" } else row.item.attachments.map { it.name ?: "File" },
                                        onTap = {},
                                        label = PendingQueue.pendingWord(row.item.whenBusy, row.item.held),
                                        onRemove = { vm.removeQueued(row.item.id) },
                                        onSend = if (row.item.held) ({ vm.sendHeld(row.item.id) }) else null,
                                    )
                                }
                                is Row2.Unit2 -> {
                                    val fade by animateFloatAsState(
                                        if (row.unit is ChatUnit.Reply && row.unit.messages.any { it.id in leaving } || row.unit is ChatUnit.User && row.unit.message.id in leaving) 0f else 1f,
                                        tween(Motion.DUR_1, easing = Motion.EaseIn),
                                        label = "leave",
                                    )
                                    Box(itemMod.graphicsLayer { alpha = fade }.padding(horizontal = 20.dp)) {
                                        UnitView(
                                            unit = row.unit,
                                            isLastReply = row.index == lastReplyIndex,
                                            isTurnReply = row.index == turnReplyIndex,
                                            failedMark = turnReplyIndex < 0,
                                            live = row.index == liveIndex,
                                            startedAt = startedAt,
                                            results = live.toolResults,
                                            thoughtMs = thoughtMs,
                                            failed = failed,
                                            waiting = waitingOnYou,
                                            resuming = resuming,
                                            isLastUnit = row.index == units.lastIndex,
                                            onRetryLast = if (providerFailure) null else vm::retryLast,
                                            actions = actions,
                                            editing = editing,
                                            settled = settled,
                                            onCancelEdit = { editing = null },
                                            onSendEdit = { m, text ->
                                                editing = null
                                                val after = ChatList.repliesAfter(units, m)
                                                if (after > 2) confirmReplace = Replace(m, text) else vm.edit(m, text)
                                            },
                                            onUserTap = { m -> userSheet = m },
                                            onContinueAside = vm::continueWith,
                                            onDismissAside = vm::dismissAside,
                                            nextModel = nextModel,
                                            tryingNext = nextModel != null && nextFor == nextModel.reply.id,
                                            onTryNext = vm::tryNextModel,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Jump to latest: rises 4dp in 180ms when you are away from the bottom
            JumpToLatest(away, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp)) {
                scope.launch { if (reduced) listState.scrollToItem(0) else listState.animateScrollToItem(0) }
            }
            ToastHost(snackbar, Modifier.align(Alignment.BottomCenter))
        }
        val sw = s?.chatSettings ?: dev.conclave.client.model.ChatSettings()
        val info = hub.modelInfo(s?.model)
        ChatComposer(
            ComposerModel(
                draft = draft,
                onDraft = { vm.draft.value = it },
                attachments = attachments,
                onAttach = vm::addAttachment,
                onRemove = vm::removeAttachment,
                model = s?.model?.ifBlank { null },
                onModel = vm::setModel,
                effort = info?.effort,
                effortValue = sw.thinking,
                onEffort = vm::setThinking,
                cyberChoices = CyberAccess.choices(info),
                cyberValue = s?.chat?.cyber,
                onCyber = vm::setCyber,
                switches = sw,
                // the quiet row: no device or folder in a chat, the model with its effort and the ring at the right
                context = ContextUse.of(live.messages, s, info),
                onUsage = onOpenUsage,
                plus = { _ -> ChatSwitches(sw, onWeb = vm::setWeb, onMemory = vm::setMemory) },
                running = running,
                busy = false,
                rim = when {
                    waitingOnYou -> RimState.WAITING
                    running || pending != null -> RimState.LIVE
                    failed -> RimState.FAILED
                    // a limit is not the end of the reply: the light goes out without settling
                    resuming -> RimState.IDLE
                    s != null -> RimState.DONE
                    else -> RimState.IDLE
                },
                placeholder = if (running) "Reply, it will be sent when this one finishes" else "Reply",
                onSend = vm::send,
                onStop = vm::stop,
            ),
            groups = groups,
            onError = { msg -> scope.launch { snackbar.showSnackbar(msg) } },
            modifier = Modifier.align(Alignment.CenterHorizontally).widthIn(max = 752.dp),
        )
    }

    if (sheet && s != null) {
        fun then(block: () -> Unit): () -> Unit = {
            sheet = false
            block()
        }
        val lastReply = units.getOrNull(lastReplyIndex) as? ChatUnit.Reply
        ConversationSheet(
            s,
            deviceName = null,
            onDismiss = { sheet = false },
            actions = buildList {
                if (running) add(SheetAction("Stop", onClick = then { vm.stop() }))
                add(SheetAction("Rename", onClick = then { renaming = true }))
                if (ShareWords.canSend(s)) add(SheetAction("Send to friend", onClick = then { sendingToFriend = true }))
                add(SheetAction("Archive", onClick = then { vm.archive(onDone = onNewChat) }))
                add(SheetAction("Move to Code", onClick = then { continuing = true }))
                if (lastReply != null) add(SheetAction("Branch from the last reply", onClick = then { branchFrom(lastReply.lastSeq) }))
                add(
                    SheetAction("Share as Markdown", onClick = then {
                        vm.export { _, md ->
                            val send = Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_TEXT, md)
                            context.startActivity(Intent.createChooser(send, "Share chat"))
                        }
                    }),
                )
                add(SheetAction("Delete", danger = true, onClick = then { deleting = true }))
            },
        )
    }
    if (sendingToFriend && s != null) {
        SendToFriendSheet(sessionId = s.id, title = s.title, chat = true, onDismiss = { sendingToFriend = false }, onOpenFriend = onOpenFriend)
    }
    if (renaming && s != null) {
        RenameDialog(s.title, onDismiss = { renaming = false }) { title ->
            vm.rename(title)
            renaming = false
        }
    }
    if (deleting && s != null) {
        ConfirmDialog(
            title = "Delete chat?",
            text = "“${s.title.ifBlank { "New chat" }}” and its messages are deleted on the hub.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = false
                vm.delete { onNewChat() }
            },
            onDismiss = { deleting = false },
        )
    }
    if (continuing && s != null) {
        ContinueSheet(s, onDismiss = { continuing = false }, onDone = { moved ->
            continuing = false
            onOpenSession(moved.id)
        })
    }
    pick?.let { p ->
        ModelPickerSheet(
            title = when (p) {
                Pick.Model -> "Model"
                is Pick.Retry -> "Retry with"
                is Pick.Ask -> "Ask another model"
            },
            groups = groups,
            current = if (p is Pick.Ask) null else s?.model,
            onPick = { ref ->
                pick = null
                when (p) {
                    Pick.Model -> vm.setModel(ref)
                    is Pick.Retry -> {
                        val u = p.reply.user
                        val after = u?.let { ChatList.repliesAfter(units, it) } ?: 0
                        if (after > 2 && u != null) confirmReplace = Replace(u, u.content.visibleText(), reply = p.reply, model = ref) else vm.retry(p.reply, ref)
                    }
                    is Pick.Ask -> vm.askAnother(p.reply, ref)
                }
            },
            onDismiss = { pick = null },
        )
    }
    confirmReplace?.let { r ->
        val after = ChatList.repliesAfter(units, r.message)
        val retry = r.reply != null
        val go = { if (r.reply != null) vm.retry(r.reply, r.model) else vm.edit(r.message, r.text) }
        AlertDialog(
            onDismissRequest = { confirmReplace = null },
            title = { Text(if (retry) "Retry this reply?" else "Edit this message?") },
            text = { Text("The $after replies after it go away. Branch first to keep them.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmReplace = null
                    go()
                }) { Text(if (retry) "Retry" else "Edit") }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { confirmReplace = null }) { Text("Cancel") }
                    TextButton(onClick = {
                        confirmReplace = null
                        // the branch keeps the old replies; this chat goes on with the change
                        vm.branch(null) { fork ->
                            go()
                            scope.launch {
                                val res = snackbar.showSnackbar("Branched. The old replies are in ${fork.title.ifBlank { "the branch" }}.", actionLabel = "Open")
                                if (res == SnackbarResult.ActionPerformed) onOpenChat(fork.id)
                            }
                        }
                    }) { Text("Branch") }
                }
            },
        )
    }
    userSheet?.let { m ->
        ModalBottomSheet(onDismissRequest = { userSheet = null }, containerColor = c.bgRaise) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
                SheetRow("Copy") {
                    copyText(context, m.content.visibleText())
                    userSheet = null
                }
                SheetRow("Edit") {
                    editing = m.id
                    userSheet = null
                }
            }
        }
    }
}

@Composable
private fun RenameDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var title by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename chat") },
        text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
        confirmButton = { TextButton(onClick = { onSave(title.trim()) }, enabled = title.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun JumpToLatest(visible: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Conclave.colors
    val rise = with(LocalDensity.current) { Motion.RISE.roundToPx() }
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(Motion.DUR_2, easing = Motion.Ease)) + slideInVertically(tween(Motion.DUR_2, easing = Motion.Ease)) { rise },
        exit = fadeOut(tween(Motion.DUR_1, easing = Motion.EaseIn)),
        modifier = modifier,
    ) {
        Box(
            Modifier.heightIn(min = 36.dp).background(c.bgRaise, RoundedCornerShape(5.dp)).border(1.dp, c.rule2, RoundedCornerShape(5.dp))
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("Jump to latest", style = ConclaveType.meta, color = c.fg)
        }
    }
}

/** The hub's notice for a failed turn ("Error: ..."). */
private fun isErrorNotice(u: ChatUnit?): Boolean =
    u is ChatUnit.Notice && ((u.message.meta?.get("level") as? kotlinx.serialization.json.JsonPrimitive)?.content == "error" || u.message.content.plainText().startsWith("Error:"))

/** Your message enters at once: opacity 0 to 1 and 4dp up, 180ms. [animate] false: it takes the place of a bubble already there. */
@Composable
internal fun Rise(key: String, modifier: Modifier, animate: Boolean = true, content: @Composable () -> Unit) {
    val reduced = reducedMotion()
    val shown = remember(key) { Animatable(if (reduced || !animate) 1f else 0f) }
    LaunchedEffect(key) { shown.animateTo(1f, tween(Motion.DUR_2, easing = Motion.Ease)) }
    val rise = with(LocalDensity.current) { Motion.RISE.toPx() }
    Box(modifier.graphicsLayer { alpha = shown.value; translationY = (1f - shown.value) * rise }) { content() }
}

@Composable
private fun UnitView(
    unit: ChatUnit,
    isLastReply: Boolean,
    /** The reply of the latest turn: a failure or a limit shows on its Knot. */
    isTurnReply: Boolean,
    /** The failed line carries its own Knot only when no reply of this turn shows one. */
    failedMark: Boolean,
    live: Boolean,
    startedAt: Long?,
    results: Map<String, dev.conclave.client.model.ToolResultBlock>,
    thoughtMs: Map<String, Long>,
    failed: Boolean,
    waiting: Boolean,
    resuming: Boolean,
    isLastUnit: Boolean,
    onRetryLast: (() -> Unit)?,
    actions: ReplyActions,
    editing: String?,
    settled: Set<String>,
    onCancelEdit: () -> Unit,
    onSendEdit: (Message, String) -> Unit,
    /** A tap on your message: Copy and Edit. A long press selects its text. */
    onUserTap: (Message) -> Unit,
    onContinueAside: (Message) -> Unit,
    onDismissAside: (Message) -> Unit,
    /** "Try the next model": on the notice that offers it and in the refused reply's row (NextModel). */
    nextModel: NextModel.Offer?,
    tryingNext: Boolean,
    onTryNext: (Message) -> Unit,
) {
    val c = Conclave.colors
    when (unit) {
        is ChatUnit.User -> Box(Modifier.padding(top = 12.dp, bottom = 6.dp)) {
            val m = unit.message
            if (editing == m.id) {
                EditBubble(m.content.visibleText(), onCancel = onCancelEdit, onSend = { onSendEdit(m, it) })
            } else {
                UserBubble(
                    message = m,
                    text = m.content.visibleText(),
                    recalled = (m.meta?.get("recalled") as? kotlinx.serialization.json.JsonArray)?.size ?: 0,
                    onOpenMemory = actions.openMemory,
                    images = imagesOf(m.content),
                    files = filesOf(m.content),
                    onTap = { onUserTap(m) },
                    // sent while it worked: "Queued" stays under it (a hub from before the queue stored it early, unit.queued)
                    label = if (unit.queued) PendingQueue.QUEUED else PendingQueue.storedWord(m.meta),
                )
            }
        }
        is ChatUnit.Reply -> Box(Modifier.padding(vertical = 6.dp)) {
            ReplyView(
                reply = unit,
                isLast = isLastReply,
                live = live,
                phase = if (live) ChatLive.phase(unit.messages, results) else LivePhase.BETWEEN,
                startedAt = startedAt ?: unit.user?.createdAt,
                results = results,
                thoughtMs = thoughtMs,
                failed = failed && isTurnReply,
                waiting = waiting && live,
                resuming = resuming && isTurnReply,
                actions = actions,
                extra = nextModel?.takeIf { o -> unit.messages.any { it.id == o.reply.id } }?.let { o ->
                    { NextModelAct(busy = tryingNext, onClick = { onTryNext(o.reply) }) }
                },
            )
        }
        is ChatUnit.Aside -> AsideView(
            unit.message,
            pending = unit.pending && unit.message.id !in settled,
            onContinue = { onContinueAside(unit.message) },
            onDismiss = { onDismissAside(unit.message) },
            streaming = unit.message.stopReason == null && unit.message.content.isEmpty(),
        )
        is ChatUnit.Notice -> {
            val text = unit.message.content.plainText().ifBlank { unit.message.author ?: "Notice" }
            val result = unit.result
            // a background task that reported back: its compact row that opens to the report
            if (result != null) {
                dev.conclave.app.ui.chat.AgentResultLine(result)
            } else if (failed && isLastUnit && isErrorNotice(unit)) {
                FailedLine(reason = text.removePrefix("Error: "), onRetry = onRetryLast, onSwitch = actions.switchModel, mark = failedMark)
            } else if (nextModel != null && nextModel.notice.id == unit.message.id) {
                // a refusal with a next model in Refusal fallback; the action's own padding is taken back so its words line up
                Column(Modifier.fillMaxWidth()) {
                    NoticeText(text)
                    NextModelAct(busy = tryingNext, onClick = { onTryNext(nextModel.reply) }, modifier = Modifier.offset(x = (-8).dp))
                }
            } else {
                NoticeText(text)
            }
        }
        is ChatUnit.Switch -> NoticeText("Switched to ${ModelRefs.displayName(unit.model).ifBlank { unit.model }}.")
    }
}
