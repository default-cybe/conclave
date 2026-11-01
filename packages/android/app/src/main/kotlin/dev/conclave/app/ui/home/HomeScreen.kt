package dev.conclave.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.CodeDefaults
import dev.conclave.app.data.HubProblem
import dev.conclave.app.data.SharePayload
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.Mark
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.hubName
import dev.conclave.app.ui.conversation.ChatComposer
import dev.conclave.app.ui.conversation.ChatHomeViewModel
import dev.conclave.app.ui.conversation.ChatSwitches
import dev.conclave.app.ui.conversation.CodePlus
import dev.conclave.app.ui.conversation.CodeWhereSheet
import dev.conclave.app.ui.conversation.ComposerModel
import dev.conclave.app.ui.conversation.PermissionChip
import dev.conclave.app.ui.conversation.QuietChip
import dev.conclave.app.ui.conversation.StartModes
import dev.conclave.app.ui.conversation.deviceLabel
import dev.conclave.app.ui.conversation.folderLabel
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.ConnectionState
import dev.conclave.client.logic.ChatList
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.logic.ShareIn
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.logic.TodayWords
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.model.string
import dev.conclave.client.today
import java.time.LocalTime
import kotlinx.coroutines.launch

/**
 * Home is a new conversation (docs/DESIGN.md 15 and 40, MOBILE-V2 3): the
 * Chat, Assistant and Code switch is the title of the bar; the mark and the
 * greeting sit in the middle, with one accent line under them only when
 * something waits on you ("2 need you", to the Inbox); the composer is at
 * the foot. Chat sending opens the chat at once with your message;
 * Assistant starts the assistant on the hub, with no device or folder; Code
 * starts the coding agent on the last computer used, and asks where to work
 * when no folder is known yet.
 */
@Composable
fun HomeScreen(
    onOpenChat: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenInbox: () -> Unit,
    onScanCode: () -> Unit,
    onOpenToday: () -> Unit = {},
    onOpenUsage: (() -> Unit)? = null,
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val chat: ChatHomeViewModel = viewModel(key = "chat-home") { ChatHomeViewModel(hub, container.settings) }
    val mode by StartModes.mode.collectAsStateWithLifecycle()
    val draft by chat.draft.collectAsStateWithLifecycle()
    val attachments by chat.attachments.collectAsStateWithLifecycle()
    val sending by chat.sending.collectAsStateWithLifecycle()
    val model by chat.model.collectAsStateWithLifecycle()
    val switches by chat.switches.collectAsStateWithLifecycle()
    val code by chat.code.collectAsStateWithLifecycle()
    val failure by chat.failure.collectAsStateWithLifecycle()
    val name by hub.ownerName.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val groups by hub.models.collectAsStateWithLifecycle()
    val agents by hub.agents.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val approvals by hub.approvals.collectAsStateWithLifecycle()
    val questions by hub.questions.collectAsStateWithLifecycle()
    val problem by hub.problem.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    val scope = rememberCoroutineScope()
    MessagesEffect(chat.messages, snackbar)
    // where Code works: the sheet, on GitHub when asked; [held] when a send waits for it
    var where by remember { mutableStateOf(false) }
    var whereGithub by remember { mutableStateOf(false) }
    var held by remember { mutableStateOf(false) }
    val c = Conclave.colors

    // a start that failed while the chat screen was in front: say it here, where the words are
    LaunchedEffect(failure) {
        val f = failure ?: return@LaunchedEffect
        chat.failure.value = null
        snackbar.showSnackbar(f)
    }
    // the hub moved (a new tunnel address, a fallback): one quiet line
    LaunchedEffect(Unit) {
        hub.moved.collect { url -> snackbar.showSnackbar("Connected through ${HubAddresses.host(url)}.") }
    }
    // text or files shared to Conclave, sent to a new conversation in the "Share to" picker: in the box, not sent
    LaunchedEffect(Unit) {
        hub.pendingShare.collect { s ->
            if (s != null && s.to == SharePayload.HOME && hub.pendingShare.compareAndSet(s, null)) {
                chat.draft.value = ShareIn.draft(chat.draft.value, s.text)
                // 15 at most and 45 MB together in one message: the rest stays out, and the line says why
                val (all, refused) = ShareIn.merge(chat.attachments.value, s.attachments)
                chat.attachments.value = all
                if (refused != null) snackbar.showSnackbar(refused)
            }
        }
    }
    // "/" in the box lists the hub's commands (Assistant and Code)
    var commands by remember { mutableStateOf<List<CommandDef>>(emptyList()) }
    LaunchedEffect(connection) {
        if (connection == ConnectionState.OPEN) commands = runCatching { hub.api { it.commands() } }.getOrDefault(commands)
    }

    val p = problem
    val noNetwork = p == HubProblem.NoNetwork
    val needYou = Panel.needYou(approvals.size + questions.size)
    // the calendar (docs/DESIGN.md, Calendar and mail): proposals to approve and what is next, two quiet lines to Today
    var today by remember { mutableStateOf<dev.conclave.client.model.Today?>(null) }
    LaunchedEffect(connection) {
        if (connection == ConnectionState.OPEN) today = runCatching { hub.api { it.today() } }.getOrNull()
    }
    // the default device set in Settings: Code starts there unless a device was picked on this phone
    var hubDefault by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(connection) {
        if (connection == ConnectionState.OPEN) hubDefault = runCatching { hub.api { it.config() }.config.string("defaultDevice")?.ifBlank { null } }.getOrDefault(hubDefault)
    }
    val hour = remember { LocalTime.now().hour }
    val coding = mode == StartMode.CODE
    val assisting = mode == StartMode.ASSISTANT

    // the models of providers that are off (a harness) are not carried over from the last session
    val off = remember(groups) { groups.filter { !it.enabled }.map { it.provider }.toSet() }
    // the last Code session, read once the sessions are in, so where Code starts does not move while you look
    val lastCode = remember(sessions.isNotEmpty()) { Start.lastOwn(sessions, StartMode.CODE) }
    val defaultModel = info?.defaultModel?.ifBlank { null }
    fun setupOf(d: CodeDefaults): Start.Setup =
        Start.code(Start.CodeInput(d.agent, d.model, d.device, d.cwd, lastCode, agents, defaultModel, devices, off, hubDefault, d.cwdDevice))
    val setup = setupOf(code)
    val assistantModel = Start.assistantModel(code.assistantModel, agents, defaultModel, off)
    val chatModel = model ?: defaultModel
    fun send() {
        when {
            assisting -> chat.startAssistant(assistantModel, commands, onOpenSession)
            !coding -> chat.start(onOpenChat)
            // no folder known yet: where it works, then it starts
            code.repo == null && setup.cwd == null -> {
                whereGithub = false
                held = true
                where = true
            }
            else -> chat.startCode(setup, commands, onOpenSession)
        }
    }
    // Assistant and Code share the permission mode and Effort picked here (web picks)
    fun pickModel(ref: String, assistant: Boolean) {
        val now = chat.code.value
        val thinking = Effort.clamp(now.thinking, hub.modelInfo(ref)?.effort)
        chat.setCode(if (assistant) now.copy(assistantModel = ref, thinking = thinking) else now.copy(model = ref, thinking = thinking))
    }
    val pickEffort: (ThinkingLevel?) -> Unit = { level -> chat.setCode(chat.code.value.copy(thinking = level)) }
    val permission: @Composable RowScope.() -> Unit = {
        PermissionChip(code.permissionMode, onChange = { pm -> chat.setCode(chat.code.value.copy(permissionMode = pm)) })
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().imePadding()) {
            TopBar(title = "", newChat = false, titleContent = { ModeSwitch(mode, onChange = { StartModes.set(it) }) })
            // something the owner can fix: say it in full, with the way out
            if (p is HubProblem.Rejected || (p is HubProblem.Lost && p.newCode)) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).background(c.surface2, RoundedCornerShape(20.dp)).padding(16.dp)) {
                    Text(p.text, style = ConclaveType.body, color = c.fg)
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(onClick = onScanCode) { Text(if (p is HubProblem.Rejected) "Pair again" else "Scan a new code") }
                }
            } else if (connection == ConnectionState.CLOSED && !noNetwork) {
                // the hub does not answer: try now instead of waiting for the next round
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(p?.text ?: "Can't reach ${hubName() ?: "your hub"}.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
                    TextButton(onClick = { hub.retry() }) { Text("Retry", style = ConclaveType.button, color = c.fg) }
                }
            } else if (p != null && connection != ConnectionState.OPEN) {
                Text(p.text, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp))
            }
            // the empty canvas: the mark and the greeting in the middle
            Column(
                Modifier.fillMaxWidth().weight(1f).padding(horizontal = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Mark(size = 64.dp, label = "Conclave")
                Spacer(Modifier.height(16.dp))
                Text(
                    ChatList.greeting(name, hour),
                    style = ConclaveType.greeting.copy(fontSize = 28.sp, lineHeight = 34.sp),
                    color = c.fg,
                    textAlign = TextAlign.Center,
                )
                if (needYou != null) {
                    Box(
                        Modifier
                            .padding(top = 6.dp)
                            .heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(onClickLabel = "Open the Inbox", onClick = onOpenInbox)
                            .padding(horizontal = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(needYou, style = ConclaveType.body.copy(fontSize = 16.sp), color = c.warn)
                    }
                }
                val t = today
                val waiting = t?.let { TodayWords.waiting(it) }
                val next = t?.let { TodayWords.nextLine(it, System.currentTimeMillis()) }
                listOfNotNull(waiting?.let { it to c.warn }, next?.let { it to c.fg3 }).forEach { (line, color) ->
                    Box(
                        Modifier
                            .heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(onClickLabel = "Open Today", onClick = onOpenToday)
                            .padding(horizontal = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(line, style = ConclaveType.body.copy(fontSize = 16.sp), color = color)
                    }
                }
            }
            Column(Modifier.widthIn(max = 784.dp).fillMaxWidth().align(Alignment.CenterHorizontally)) {
                val m = if (assisting) {
                    val effort = hub.modelInfo(assistantModel)?.effort
                    ComposerModel(
                        draft = draft,
                        onDraft = { chat.draft.value = it },
                        attachments = attachments,
                        onAttach = chat::addAttachment,
                        onRemove = chat::removeAttachment,
                        model = assistantModel,
                        onModel = { pickModel(it, assistant = true) },
                        running = false,
                        busy = sending,
                        placeholder = Start.placeholder(StartMode.ASSISTANT),
                        onSend = ::send,
                        onStop = {},
                        effort = effort,
                        effortValue = code.thinking,
                        follow = Effort.follow(Start.ASSISTANT_AGENT, agents.firstOrNull { it.name == Start.ASSISTANT_AGENT }?.thinking, assistantModel),
                        onEffort = pickEffort,
                        context = ContextUse.of(emptyList(), null, hub.modelInfo(assistantModel)),
                        onUsage = onOpenUsage,
                        // the assistant runs on the hub: no device or folder, only the permission mode
                        left = permission,
                        commands = commands,
                        note = if (sending) "Starting the session on the hub" else null,
                    )
                } else if (coding) {
                    val r = code.repo
                    // the computer says itself only when there is more than one to choose from
                    val showDevice = Start.showsComputer(devices, repo = r != null)
                    ComposerModel(
                        draft = draft,
                        onDraft = { chat.draft.value = it },
                        attachments = attachments,
                        onAttach = chat::addAttachment,
                        onRemove = chat::removeAttachment,
                        model = setup.model,
                        onModel = { pickModel(it, assistant = false) },
                        running = false,
                        busy = sending,
                        placeholder = Start.placeholder(StartMode.CODE),
                        onSend = ::send,
                        onStop = {},
                        effort = hub.modelInfo(setup.model)?.effort,
                        effortValue = code.thinking,
                        follow = Effort.follow(setup.agent, agents.firstOrNull { it.name == setup.agent }?.thinking, setup.model),
                        onEffort = pickEffort,
                        context = ContextUse.of(emptyList(), null, hub.modelInfo(setup.model)),
                        onUsage = onOpenUsage,
                        left = {
                            permission()
                            if (r != null) {
                                QuietChip(RepoWords.startWords(r, code.base), onClickLabel = "Change the repository", onClick = {
                                    whereGithub = true
                                    where = true
                                })
                            } else {
                                val cwd = setup.cwd
                                QuietChip(if (cwd == null) "Choose folder" else folderLabel(cwd), onClickLabel = "Change the folder", strong = cwd == null, onClick = {
                                    whereGithub = false
                                    where = true
                                })
                            }
                            if (showDevice) {
                                QuietChip("on " + deviceLabel(setup.device, devices, info?.name), onClickLabel = "Change the computer", onClick = {
                                    whereGithub = false
                                    where = true
                                })
                            }
                        },
                        plus = { dismiss ->
                            CodePlus(code, setup, onChange = chat::setCode, onWhere = { gh ->
                                whereGithub = gh
                                where = true
                            }, dismiss = dismiss)
                        },
                        commands = commands,
                        note = when {
                            !sending -> null
                            r != null -> "Making a worktree of $r"
                            else -> "Starting the session, ${setup.agent} on ${deviceLabel(setup.device, devices, info?.name)}"
                        },
                    )
                } else {
                    ComposerModel(
                        draft = draft,
                        onDraft = { chat.draft.value = it },
                        attachments = attachments,
                        onAttach = chat::addAttachment,
                        onRemove = chat::removeAttachment,
                        model = chatModel,
                        onModel = chat::setModel,
                        running = false,
                        busy = sending,
                        placeholder = Start.placeholder(StartMode.CHAT),
                        onSend = ::send,
                        onStop = {},
                        effort = hub.modelInfo(chatModel)?.effort,
                        effortValue = switches.thinking,
                        onEffort = chat::setThinking,
                        switches = switches,
                        context = ContextUse.of(emptyList(), null, hub.modelInfo(chatModel)),
                        onUsage = onOpenUsage,
                        // a chat never gets a device or folder: "+" has the web and memory
                        plus = { _ -> ChatSwitches(switches, onWeb = chat::setWeb, onMemory = chat::setMemory) },
                    )
                }
                ChatComposer(m, groups = groups, onError = { msg -> scope.launch { snackbar.showSnackbar(msg) } })
            }
        }
        ToastHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 132.dp))
    }

    if (where) {
        // the computer and folder Code would use, so the sheet marks them; a pick there pins them
        CodeWhereSheet(
            code.copy(device = setup.device, cwd = code.cwd ?: setup.cwd),
            onChange = { n ->
                val now = chat.code.value
                // the sheet shows where Code would run; that is a device pick only once another one is picked there,
                // and a folder keeps the device it is on (web picks)
                val picked = if (now.device == null && n.device == setup.device) null else n.device
                val next = n.copy(device = picked, cwdDevice = if (n.cwd != null) n.device else null)
                // the first repository picked moves the session to the hub; a computer picked after it stays (web SessionStart)
                chat.setCode(if (next.repo != null && now.repo == null) next.copy(device = Start.HUB) else next)
            },
            onDone = {
                where = false
                // a send waited for the place: it goes now; from a chip or "+" the place is only set
                if (held) chat.startCode(setupOf(chat.code.value), commands, onOpenSession)
                held = false
            },
            onDismiss = {
                where = false
                // closed without a pick: the message stays in the box
                held = false
            },
            done = if (held) "Start" else "Done",
            github = true,
            startGithub = whereGithub,
        )
    }
}
