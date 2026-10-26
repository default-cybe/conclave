@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.conversation.ChatComposer
import dev.conclave.app.ui.conversation.ChatHandoff
import dev.conclave.app.ui.conversation.ChoiceRow
import dev.conclave.app.ui.conversation.ComposerModel
import dev.conclave.app.ui.conversation.ConversationSheet
import dev.conclave.app.ui.conversation.NextModelAct
import dev.conclave.app.ui.conversation.OptionLabel
import dev.conclave.app.ui.conversation.OptionRow
import dev.conclave.app.ui.conversation.PermissionChip
import dev.conclave.app.ui.conversation.QuietChip
import dev.conclave.app.ui.conversation.RunningTasksLine
import dev.conclave.app.ui.conversation.SessionWork
import dev.conclave.app.ui.conversation.SheetAction
import dev.conclave.app.ui.conversation.SheetRow
import dev.conclave.app.ui.conversation.SwitchRow
import dev.conclave.app.ui.conversation.ULTRA_LINE
import dev.conclave.app.ui.conversation.deviceLabel
import dev.conclave.app.ui.conversation.folderLabel
import dev.conclave.app.ui.friends.FriendShareLine
import dev.conclave.app.ui.friends.SendToFriendSheet
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.gapItem
import dev.conclave.app.ui.motion.gapRow
import dev.conclave.app.ui.motion.rememberGapHold
import dev.conclave.app.ui.motion.rememberGapList
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.chatDensity
import dev.conclave.client.ConnectionState
import dev.conclave.client.logic.CyberAccess
import dev.conclave.client.logic.Asks
import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.Delegated
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.NextModel
import dev.conclave.client.logic.PendingQueue
import dev.conclave.client.logic.RepoAction
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.logic.SessionLive
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.logic.Tasks
import dev.conclave.client.model.AgentDef
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionMode
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.TodoStatus
import dev.conclave.client.model.plainText
import dev.conclave.client.model.repo
import dev.conclave.client.model.visibleText
import dev.conclave.client.motion.RimState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the model picker is choosing a model for: a second opinion, or the model to switch to (a limit notice's Switch model). */
private enum class PickFor { SECOND_OPINION, SWITCH }

/**
 * One agent session (MOBILE-V2 5): the top bar with its title (a tap opens
 * its sheet), your messages in bubbles, the agent's turns as plain text
 * with each stretch of thoughts and tool calls as one row and a workflow or
 * subagent as a compact row of its own, "2 running tasks" above the
 * composer while they work, the working line while it works, and an
 * approval or a question inline at the end, a subagent's or a workflow
 * agent's too, under "Subagent email asks" (Asks.kt). Tokens, cost and
 * where it runs are in the sheet. Under the composer (docs/DESIGN.md 40)
 * the permission mode and Code's folder at the left, the model with its
 * effort and the context ring at the right; the agent (custom ones only),
 * the computer, the mode and Ultra are under "+", the hub's commands
 * behind "/".
 */
@Composable
fun ChatScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenChat: (String) -> Unit,
    onIsChat: () -> Unit = {},
    onOpenWorkflowRuns: (String) -> Unit = {},
    onOpenFriend: ((String) -> Unit)? = null,
    onOpenShare: ((String) -> Unit)? = null,
    onOpenUsage: (() -> Unit)? = null,
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val vm: ChatViewModel = viewModel(key = "chat:$sessionId") { ChatViewModel(hub, sessionId, container.drafts) }
    val session by vm.session.collectAsStateWithLifecycle()
    val items by vm.items.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val queued by vm.pending.collectAsStateWithLifecycle()
    val previews by vm.previews.collectAsStateWithLifecycle()
    val running by vm.running.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val attachments by vm.attachments.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val nextFor by vm.nextFor.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val models by hub.models.collectAsStateWithLifecycle()
    val agents by hub.agents.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val runs by vm.runs.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    // folders across devices: the banner above the composer, moving, and Choose folder
    val locVm: LocationViewModel = viewModel(key = "loc:$sessionId") { LocationViewModel(hub, sessionId) }
    val chooser by locVm.chooser.collectAsStateWithLifecycle()
    var pickDevice by remember { mutableStateOf(false) }
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    MessagesEffect(locVm.messages, snackbar)
    // a repo session: its state from the hub, on open, when its summary changes, and after each turn
    val repoVm: RepoViewModel = viewModel(key = "repo:$sessionId") { RepoViewModel(hub, sessionId) }
    val repoLive by repoVm.repo.collectAsStateWithLifecycle()
    val repoBusy by repoVm.busy.collectAsStateWithLifecycle()
    var repoAsk by remember { mutableStateOf<RepoAsk?>(null) }
    var sendingToFriend by remember { mutableStateOf(false) }
    MessagesEffect(repoVm.messages, snackbar)
    val repoMeta = session?.repo
    LaunchedEffect(repoMeta, running) { if (repoMeta != null) repoVm.reload() }
    val repoAction: (RepoAction) -> Unit = { a ->
        when (a) {
            RepoAction.PUSH -> if ((repoLive?.dirty ?: 0) > 0) repoAsk = RepoAsk.COMMIT else repoVm.push(null)
            RepoAction.OPEN_PR -> repoVm.startPr()
            RepoAction.CLEAN_UP -> repoAsk = RepoAsk.CLEAN
        }
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    var actionsFor by remember { mutableStateOf<Message?>(null) }
    var pickFor by remember { mutableStateOf<Pair<PickFor, Message?>?>(null) }
    var rewindFor by remember { mutableStateOf<Message?>(null) }
    /** An earlier turn to run again: it and what came after it go, so it asks first. */
    var retryFor by remember { mutableStateOf<Message?>(null) }
    var showTodos by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }

    // a chat opened as a session goes where chats are (CHAT-AND-MOTION 2.2)
    LaunchedEffect(session?.kind) {
        if (session?.isChat == true) onIsChat()
    }
    // a line handed over by the screen that started this one (what a "/" command said)
    LaunchedEffect(sessionId) {
        val (text, _) = ChatHandoff.takeNote(sessionId) ?: return@LaunchedEffect
        snackbar.showSnackbar(text)
    }
    // "/" in the box lists the hub's commands
    var commands by remember { mutableStateOf<List<CommandDef>>(emptyList()) }
    LaunchedEffect(connection) {
        if (connection == ConnectionState.OPEN) commands = runCatching { hub.api { it.commands() } }.getOrDefault(commands)
    }

    val latestNoticeId = live.messages.lastOrNull { it.kind == MessageKind.NOTICE }?.id
    // an assistant turn is one item, so its tool calls fold into one line
    val rows = remember(items) { ChatItems.turns(items) }
    val lastTurnKey = rows.lastOrNull { it is ChatItem.Turn }?.key

    // the turn's live line and the composer's Rim say the same thing (CHAT-AND-MOTION 1.9)
    val status = session?.status
    // a subagent or a workflow agent under this session waits on you: so does the turn that started it (Asks.kt)
    val childWaits = status == SessionStatus.RUNNING && Asks.below(live.approvals + live.questions, sessionId)
    val waitingOnYou = status == SessionStatus.WAITING_APPROVAL || status == SessionStatus.WAITING_INPUT || childWaits
    val resuming = status == SessionStatus.WAITING_RESET
    val turnLive = running || waitingOnYou || resuming
    // a refused turn whose notice offers the next model of Refusal fallback: on the notice and in the turn's row
    val nextModel = remember(live.messages, status) { NextModel.of(live.messages, status) }
    val tryingNext = nextModel != null && nextFor == nextModel.reply.id
    val turn = remember(sessionId) { TurnClock() }
    val turnStart = live.messages.lastOrNull { it.role == Role.USER }?.createdAt?.takeIf { it in 1..System.currentTimeMillis() }
    turn.update(turnLive, turnStart, System.currentTimeMillis())
    val activity = remember(live.messages, live.runningTools) { SessionLive.activity(live.messages, live.runningTools) }
    // workflows and subagents: their rows in the turns, and "2 running tasks" above the composer
    val work = SessionWork(session, runs, live.toolProgress)
    val tasks = remember(session, live.messages, live.toolResults, runs, sessions) { Tasks.running(session, live.messages, live.toolResults, runs, sessions) }
    val rim = when {
        waitingOnYou -> RimState.WAITING
        running || sending -> RimState.LIVE
        status == SessionStatus.ERROR -> RimState.FAILED
        resuming || session == null -> RimState.IDLE
        else -> RimState.DONE
    }

    Scaffold(
        topBar = {
            Column {
                TopBar(title = session?.title?.ifBlank { null } ?: "New session", onTitle = if (session != null) ({ sheet = true }) else null)
                // made from a friend's share: whose turns are quoted here
                session?.let { FriendShareLine(it, onOpenShare) }
            }
        },
        bottomBar = {
            // over the keyboard; the composer's own bar padding gives way to it
            Column(Modifier.imePadding()) {
                session?.repo?.let { RepoRow(it, live = repoLive, busy = repoBusy, onAction = repoAction) }
                session?.let { s -> LocationBanner(s, locVm, devices, onPickDevice = { pickDevice = true }) }
                RunningTasksLine(tasks, work, live.toolResults)
                RetryProvider(session, live.messages, models)
                val s = session
                val info = hub.modelInfo(s?.model)
                val coding = s != null && Start.modeOf(s) == StartMode.CODE
                // Code's computer says itself only when there is more than one (docs/DESIGN.md 40); the assistant runs on the hub
                val showComputer = coding && s?.parentId == null && Start.showsComputer(devices, repo = s?.repo != null)
                val command = if (attachments.isEmpty()) Start.commandOf(draft, commands) else null
                ChatComposer(
                    ComposerModel(
                        draft = draft,
                        onDraft = { vm.draft.value = it },
                        attachments = attachments,
                        onAttach = vm::addAttachment,
                        onRemove = vm::removeAttachment,
                        model = s?.model?.ifBlank { null },
                        onModel = { vm.pickModel(it) },
                        running = running,
                        busy = sending,
                        placeholder = if (running) "Queue a message" else Start.placeholder(StartMode.CODE),
                        // a message that is one of the hub's commands runs as that command
                        onSend = { if (command != null) vm.runCommand(draft) else vm.send() },
                        onStop = vm::stop,
                        rim = rim,
                        effort = info?.effort,
                        effortValue = s?.chat?.thinking,
                        follow = s?.let { ss -> Effort.follow(ss.agent, agents.firstOrNull { it.name == ss.agent }?.thinking, ss.model) },
                        onEffort = vm::setEffort,
                        cyberChoices = CyberAccess.choices(info),
                        cyberValue = s?.chat?.cyber,
                        onCyber = vm::setCyber,
                        context = ContextUse.of(live.messages, s, info),
                        onUsage = onOpenUsage,
                        left = {
                            if (s != null) {
                                if (s.mode != SessionMode.CHAT) PermissionChip(s.permissionMode, onChange = vm::setPermissionMode)
                                if (coding && s.repo == null) {
                                    QuietChip(folderLabel(s.cwd), onClickLabel = "Change the folder", onClick = { locVm.openChooser(locVm.location.value, s.device) })
                                }
                                if (showComputer) {
                                    QuietChip("on " + deviceLabel(s.device, devices), onClickLabel = "Change the computer", onClick = { pickDevice = true })
                                }
                            }
                        },
                        plus = { dismiss ->
                            if (s != null) {
                                SessionPlus(
                                    session = s,
                                    customs = if (coding) Start.customAgents(agents, s.agent) else emptyList(),
                                    deviceName = if (showComputer) deviceLabel(s.device, devices) else null,
                                    onAgent = vm::setAgent,
                                    onMode = vm::setMode,
                                    onUltra = vm::setUltra,
                                    onDevice = {
                                        dismiss()
                                        pickDevice = true
                                    },
                                )
                            }
                        },
                        commands = commands,
                    ),
                    groups = models,
                    onError = { msg -> scope.launch { snackbar.showSnackbar(msg) } },
                )
            }
        },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = Conclave.colors.bg,
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                OfflineBanner(connection)
                error?.let { ErrorBanner(it, onRetry = { vm.load() }) }
                // allow and close the gap: a decided prompt confirms in place, then slides away
                val approvalHold = rememberGapHold()
                val approvalRows = rememberGapList(live.approvals, { it.id }, approvalHold)
                val questionRows = rememberGapList(live.questions, { it.id })
                if (loading && items.isEmpty()) {
                    LoadingBox()
                } else {
                    // tool rows name files relative to the session's folder; the text is at the Text size of Settings, Appearance
                    CompositionLocalProvider(LocalSessionCwd provides session?.cwd, LocalDensity provides chatDensity()) {
                        LazyColumn(
                            state = listState,
                            reverseLayout = true,
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            items(questionRows, key = { "q:" + it.key }) { e ->
                                QuestionPrompt(e.item, onAnswer = { vm.answer(e.item.id, it) }, modifier = gapItem().gapRow(e.leaving).padding(horizontal = 20.dp, vertical = 6.dp), viewing = sessionId)
                            }
                            items(approvalRows, key = { "a:" + it.key }) { e ->
                                val a = e.item
                                ApprovalPrompt(
                                    a,
                                    onDecide = { vm.resolveApproval(a.id, it) },
                                    cwd = session?.cwd,
                                    onConfirm = approvalHold::confirm,
                                    modifier = gapItem().gapRow(e.leaving).padding(horizontal = 20.dp, vertical = 6.dp),
                                    // a subagent's request says who asks, above it
                                    viewing = sessionId,
                                )
                            }
                            // while it works, the last line: the animated mark and the step in words
                            if (turnLive && status != SessionStatus.ERROR) {
                                item(key = "live") {
                                    SessionLiveLine(
                                        status = if (childWaits) SessionStatus.WAITING_APPROVAL else status,
                                        running = running && !childWaits,
                                        activity = activity,
                                        turn = turn,
                                        resumeAt = session?.resumeAt,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                                    )
                                }
                            }
                            // what you sent while it works waits after the turn, in the order it will run (CHAT-AND-MOTION 2.11)
                            // never one whose message is in the list already: a key twice would end the screen
                            val taken = rows.flatMapTo(HashSet()) { r -> (r as? ChatItem.User)?.let { PendingQueue.pendingIds(it.message) }.orEmpty() }
                            items(queued.filter { it.id !in taken }.asReversed(), key = { PendingQueue.key(it.id) }) { p ->
                                PendingUserMessage(p, local = previews[p.id], onRemove = { vm.removeQueued(p.id) }, onSend = { vm.sendHeld(p.id) })
                            }
                            // a message that took a waiting one's place keeps its row (the same key), so nothing moves or rises
                            items(rows.asReversed(), key = { (it as? ChatItem.User)?.let { u -> PendingQueue.keyOf(u.message) } ?: it.key }) { item ->
                                when (item) {
                                    // a tap opens your message's actions; a long press selects its text
                                    is ChatItem.User -> UserMessage(item.message, onTap = { actionsFor = item.message })
                                    is ChatItem.Turn -> {
                                        val last = item.key == lastTurnKey
                                        TurnView(
                                            messages = item.messages,
                                            live = live,
                                            running = last && turnLive,
                                            cwd = session?.cwd,
                                            work = work,
                                            // every turn ends with its icons once it is done; earlier ones quieter
                                            foot = if (!(last && turnLive)) {
                                                {
                                                    TurnFoot(
                                                        text = item.messages.filter { it.role == Role.ASSISTANT }.joinToString("\n\n") { it.content.plainText() }.trim(),
                                                        // the last turn goes again at once; an earlier one asks first, as what follows it goes
                                                        onRetry = if (NextModel.providerFailure(live.messages) != null) null else {
                                                            { if (last) vm.retryLast() else retryFor = item.messages.first() }
                                                        },
                                                        onMore = { actionsFor = item.messages.last() },
                                                        quiet = !last,
                                                        extra = nextModel?.takeIf { o -> item.messages.any { it.id == o.reply.id } }?.let { o ->
                                                            { NextModelAct(busy = tryingNext, onClick = { vm.tryNextModel(o.reply) }) }
                                                        },
                                                    )
                                                }
                                            } else {
                                                null
                                            },
                                        )
                                    }
                                    // turns() joins these; one alone reads as a turn of its own
                                    is ChatItem.Assistant -> TurnView(listOf(item.message), live, running = false, cwd = session?.cwd, work = work)
                                    is ChatItem.Aside -> AsideMessage(item.message, live)
                                    is ChatItem.Jury -> JuryView(item.answers, item.verdict, live)
                                    is ChatItem.Notice -> NoticeLine(
                                        message = item.message,
                                        session = session,
                                        isLatestNotice = item.message.id == latestNoticeId,
                                        onResume = { vm.resumeNow() },
                                        onSwitchModel = { pickFor = PickFor.SWITCH to null },
                                        onTryNext = nextModel?.takeIf { it.notice.id == item.message.id }?.let { o -> { vm.tryNextModel(o.reply) } },
                                        tryingNext = tryingNext,
                                        result = item.result,
                                    )
                                    is ChatItem.Summary -> SummaryLine(item.message)
                                }
                            }
                        }
                    }
                }
            }
            if (listState.firstVisibleItemIndex > 2) {
                SmallFloatingActionButton(
                    onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    containerColor = Conclave.colors.bgRaise,
                    contentColor = Conclave.colors.fg2,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                ) { Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = "Jump to latest") }
            }
        }
    }

    val s = session
    if (sheet && s != null) {
        fun then(block: () -> Unit): () -> Unit = {
            sheet = false
            block()
        }
        val done = live.todos.count { it.status == TodoStatus.COMPLETED }
        ConversationSheet(
            s,
            deviceName = deviceLabel(s.device, devices),
            onDismiss = { sheet = false },
            actions = buildList {
                if (running) add(SheetAction("Stop", onClick = then { vm.stop() }))
                // delegated work (docs/DESIGN.md 43): a normal session of its kind from now on
                if (Delegated.isDelegated(s)) add(SheetAction(Delegated.MOVE, onClick = then { vm.moveToMainList() }))
                add(SheetAction("Rename", onClick = then { renaming = true }))
                if (ShareWords.canSend(s)) add(SheetAction("Send to friend", onClick = then { sendingToFriend = true }))
                // a repo session: Push, Open pull request, View pull request, Check now, Clean up (docs/DESIGN.md 30)
                val r = repoLive
                if (s.repo != null && r != null) {
                    val can = RepoWords.actions(r)
                    if (can.push) add(SheetAction("Push", onClick = then { repoAction(RepoAction.PUSH) }))
                    if (can.openPr) add(SheetAction("Open pull request", onClick = then { repoAction(RepoAction.OPEN_PR) }))
                    val prUrl = r.pr?.url
                    if (can.viewPr && prUrl != null) add(SheetAction("View pull request", onClick = then { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(prUrl))) } }))
                    if (RepoWords.canCheck(r)) add(SheetAction("Check now", onClick = then { repoVm.reload(refresh = true) }))
                    if (can.cleanUp) add(SheetAction("Clean up", onClick = then { repoAction(RepoAction.CLEAN_UP) }))
                    // a folder worktree ("Run in a worktree"): Merge into its base, Discard
                    if (RepoWords.canMerge(r)) add(SheetAction("Merge into ${r.base}", onClick = then { repoAsk = RepoAsk.MERGE }))
                    if (RepoWords.canDiscard(r)) add(SheetAction("Discard", onClick = then { repoAsk = RepoAsk.DISCARD }))
                }
                add(
                    SheetAction("Archive", onClick = then {
                        // a repo session whose worktree is still there asks whether to clean up too
                        if (s.repo?.cleaned == false) {
                            repoAsk = RepoAsk.ARCHIVE
                        } else {
                            vm.archive()
                            onBack()
                        }
                    }),
                )
                add(SheetAction("Move to Chat", onClick = then { vm.moveToChat() }))
                add(SheetAction(if (s.pinned) "Unpin" else "Pin", onClick = then { vm.togglePin() }))
                if (live.todos.isNotEmpty()) add(SheetAction("Todo list, $done of ${live.todos.size} done", onClick = then { showTodos = true }))
                add(SheetAction("Workflow runs", onClick = then { onOpenWorkflowRuns(sessionId) }))
                add(SheetAction("Compact context", onClick = then { vm.compact() }))
                if (!s.isChat) add(SheetAction("Move to hub (copy folder)", onClick = then { vm.moveToHub() }))
            },
        )
    }

    session?.let { s0 ->
        RepoDialogs(s0, repoVm, repoAsk, onAsk = { repoAsk = it }, onArchive = {
            vm.archive()
            onBack()
        })
        if (sendingToFriend) {
            SendToFriendSheet(sessionId = s0.id, title = s0.title, chat = s0.isChat, onDismiss = { sendingToFriend = false }, onOpenFriend = onOpenFriend)
        }
    }

    actionsFor?.let { m ->
        MessageActionsSheet(
            message = m,
            onDismiss = { actionsFor = null },
            onSendToFriend = if (session?.let { ShareWords.canSend(it) } == true) ({
                actionsFor = null
                sendingToFriend = true
            }) else null,
            onCopy = {
                copyToClipboard(context, if (m.role == Role.USER) m.content.visibleText() else m.content.plainText())
                actionsFor = null
            },
            onAskAnother = {
                actionsFor = null
                pickFor = PickFor.SECOND_OPINION to m
            },
            onFork = {
                actionsFor = null
                vm.fork(m) { id -> onOpenChat(id) }
            },
            onRewind = {
                actionsFor = null
                rewindFor = m
            },
        )
    }

    pickFor?.let { (purpose, message) ->
        ModelPickerSheet(
            title = if (purpose == PickFor.SECOND_OPINION) "Ask another model" else "Switch to",
            groups = models,
            current = if (purpose == PickFor.SWITCH) session?.model else null,
            extra = if (purpose == PickFor.SECOND_OPINION) agents.map { "@" + it.name to it.name } else emptyList(),
            onPick = { ref ->
                pickFor = null
                if (purpose == PickFor.SECOND_OPINION && message != null) vm.secondOpinion(message, ref) else vm.pickModel(ref)
            },
            onDismiss = { pickFor = null },
        )
    }

    // a big chat's switch: the price, Full history or Short handover, and Ask once
    val step by vm.switchStep.collectAsStateWithLifecycle()
    step?.let { st ->
        SwitchSheet(
            model = st.model,
            estimate = st.estimate,
            onSwitch = { brief -> vm.switchTo(st.model, brief) },
            onAskOnce = { vm.askOnce(st.model) },
            onDismiss = { vm.switchStep.value = null },
        )
    }

    rewindFor?.let { m ->
        var restoreFiles by remember(m.id) { mutableStateOf(false) }
        ConfirmDialog(
            title = "Rewind here?",
            text = "Messages after this point are removed from the chat.",
            confirmLabel = "Rewind",
            destructive = true,
            onConfirm = {
                vm.rewind(m, restoreFiles)
                rewindFor = null
            },
            onDismiss = { rewindFor = null },
            extra = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = restoreFiles, onCheckedChange = { restoreFiles = it })
                    Text("Also restore files from the checkpoint")
                }
            },
        )
    }

    retryFor?.let { m ->
        ConfirmDialog(
            title = "Run your message again?",
            text = "This turn and what came after it leave the session, then your message goes again.",
            confirmLabel = "Retry",
            onConfirm = {
                vm.retryBefore(m)
                retryFor = null
            },
            onDismiss = { retryFor = null },
        )
    }

    if (showTodos) TodoSheet(live.todos, onDismiss = { showTodos = false })

    if (pickDevice) {
        session?.let { ss ->
            MoveToDeviceDialog(
                session = ss,
                devices = devices,
                onPick = { d ->
                    pickDevice = false
                    locVm.moveTo(d.id)
                },
                onDismiss = { pickDevice = false },
            )
        }
    }

    val req = chooser
    val current = session
    if (req != null && current != null) {
        key(req) {
            FolderPickerSheet(req, current, locVm, devices, onDismiss = { locVm.closeChooser() })
        }
    }

    if (renaming) {
        var title by remember { mutableStateOf(session?.title.orEmpty()) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text("Rename session") },
            text = { OutlinedTextField(value = title, onValueChange = { title = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    vm.rename(title.trim())
                    renaming = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
        )
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Conclave message", text))
}

/**
 * Under each turn once it is done (MOBILE-V2 5, as Claude's apps): Copy,
 * Retry, [extra] and More, always in view; fg-3 under the last turn, fg-4
 * under earlier ones ([quiet]). [extra]: one more action when it applies
 * ("Try the next model" on a refused turn).
 */
@Composable
private fun TurnFoot(text: String, onRetry: (() -> Unit)?, onMore: () -> Unit, quiet: Boolean = false, extra: (@Composable () -> Unit)? = null) {
    val c = Conclave.colors
    val tint = if (quiet) c.fg4 else c.fg3
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    // the icons line up with the text: their own padding is taken back
    Row(Modifier.offset(x = (-12).dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        if (text.isNotBlank()) {
            IconButton(onClick = { copyToClipboard(context, text); copied = true }, modifier = Modifier.size(48.dp)) {
                Swap(on = copied, off = { Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(18.dp), tint = tint) }) {
                    Icon(Icons.Outlined.Check, contentDescription = "Copied", modifier = Modifier.size(18.dp), tint = c.fg2)
                }
            }
        }
        if (onRetry != null) IconButton(onClick = onRetry, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Outlined.Refresh, contentDescription = "Retry", modifier = Modifier.size(18.dp), tint = tint)
        }
        extra?.invoke()
        IconButton(onClick = onMore, modifier = Modifier.size(48.dp)) {
            Icon(Icons.Outlined.MoreHoriz, contentDescription = "More actions", modifier = Modifier.size(18.dp), tint = tint)
        }
    }
}

/**
 * A message's actions: a sheet of plain rows, from a tap on your message or
 * "..." under a turn (Copy is in the turn's row, so the sheet has it for
 * your message only). The model picker under the composer switches models.
 */
@Composable
private fun MessageActionsSheet(
    message: Message,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
    onAskAnother: () -> Unit,
    onFork: () -> Unit,
    onRewind: () -> Unit,
    onSendToFriend: (() -> Unit)? = null,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Conclave.colors.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            if (message.role == Role.USER) SheetRow("Copy", onClick = onCopy)
            if (message.role == Role.ASSISTANT) SheetRow("Ask another model", onClick = onAskAnother)
            SheetRow("Fork from here", onClick = onFork)
            SheetRow("Rewind to here", onClick = onRewind)
            if (onSendToFriend != null) SheetRow("Send to friend", onClick = onSendToFriend)
        }
    }
}

/**
 * A session's "+" after the files (docs/DESIGN.md 40, web chat/Composer.tsx):
 * the agent, only when there are custom ones ([customs]), the computer it
 * runs on when there are several ([deviceName]), the mode (jury, debate,
 * loop...) and Ultra. The model and Effort are under the box; the
 * permission mode and the folder too.
 */
@Composable
private fun SessionPlus(
    session: Session,
    customs: List<AgentDef>,
    deviceName: String?,
    onAgent: (String) -> Unit,
    onMode: (SessionMode) -> Unit,
    onUltra: (Boolean) -> Unit,
    onDevice: () -> Unit,
) {
    val c = Conclave.colors
    if (customs.isNotEmpty()) {
        OptionLabel("Agent")
        ChoiceRow("${Start.CODE_AGENT}, the default", selected = session.agent == Start.CODE_AGENT, detail = "Hands work to its subagents itself", onClick = { onAgent(Start.CODE_AGENT) })
        customs.forEach { a -> ChoiceRow(a.name, selected = session.agent == a.name, detail = a.description.ifBlank { null }, onClick = { onAgent(a.name) }) }
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
    }
    if (deviceName != null) {
        OptionRow("Run on", deviceName, onClick = onDevice)
        HorizontalDivider(thickness = 1.dp, color = c.rule)
    }
    OptionLabel("Mode")
    SessionMode.entries.filter { it != SessionMode.CHAT }.forEach { m ->
        ChoiceRow(m.wire.replaceFirstChar { it.uppercaseChar() }, selected = session.mode == m, onClick = { onMode(m) })
    }
    if (session.mode != SessionMode.CHAT) {
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
        SwitchRow("Ultra", ULTRA_LINE, session.ultra == true, onUltra)
    }
}
