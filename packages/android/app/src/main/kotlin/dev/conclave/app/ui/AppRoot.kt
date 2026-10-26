package dev.conclave.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dev.conclave.app.ConclaveApp
import dev.conclave.app.data.AuthState
import dev.conclave.app.data.HubProblem
import dev.conclave.app.ui.agents.AgentDetailScreen
import dev.conclave.app.ui.agents.AgentsScreen
import dev.conclave.app.ui.approvals.InboxScreen
import dev.conclave.app.ui.chat.ChatScreen
import dev.conclave.app.ui.common.InboxBadge
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.LocalInbox
import dev.conclave.app.ui.common.LocalNetwork
import dev.conclave.app.ui.common.LocalNewChat
import dev.conclave.app.ui.common.LocalNewWords
import dev.conclave.app.ui.common.LocalOpenPanel
import dev.conclave.app.ui.common.Mark
import dev.conclave.app.ui.common.rememberInboxCount
import dev.conclave.app.ui.common.rememberLocalNetworkAsk
import dev.conclave.app.ui.conversation.ChatStartScreen
import dev.conclave.app.ui.conversation.ChatStarts
import dev.conclave.app.ui.conversation.ChatThreadScreen
import dev.conclave.app.ui.conversation.LocalOpenSession
import dev.conclave.app.ui.conversation.StartModes
import dev.conclave.app.ui.devices.DevicesScreen
import dev.conclave.app.ui.friends.FriendScreen
import dev.conclave.app.ui.friends.FriendsScreen
import dev.conclave.app.ui.friends.ShareScreen
import dev.conclave.app.ui.friends.SharesScreen
import dev.conclave.app.ui.home.HomeScreen
import dev.conclave.app.ui.map.MapScreen
import dev.conclave.app.ui.memory.ImportScreen
import dev.conclave.app.ui.memory.MemoryScreen
import dev.conclave.app.ui.motion.Launch
import dev.conclave.app.ui.motion.LaunchSplash
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.ProvideReducedMotion
import dev.conclave.app.ui.motion.RopeSplash
import dev.conclave.client.motion.RopeMoment
import dev.conclave.app.ui.pairing.FingerprintDialog
import dev.conclave.app.ui.pairing.IdentityScreen
import dev.conclave.app.ui.pairing.PairingScreen
import dev.conclave.app.ui.panel.SidePanel
import dev.conclave.app.ui.routines.RoutinesScreen
import dev.conclave.app.ui.sessions.SessionsScreen
import dev.conclave.app.ui.settings.ReflectScreen
import dev.conclave.app.ui.settings.RemoteScreen
import dev.conclave.app.ui.settings.SettingsPage
import dev.conclave.app.ui.settings.SettingsScreen
import dev.conclave.app.ui.tasks.TasksScreen
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.usage.UsageScreen
import dev.conclave.app.ui.workflows.LocalOpenWorkflowRun
import dev.conclave.app.ui.workflows.WorkflowLibraryScreen
import dev.conclave.app.ui.workflows.WorkflowRunScreen
import dev.conclave.app.ui.workflows.WorkflowRunsScreen
import dev.conclave.app.update.StartupUpdate
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

object Routes {
    /** Home: a new chat, or with Code a task for an agent on a device (MOBILE-V2 3). */
    const val HOME = "home"

    /** One chat, or a chat on its way from Home (a ChatStarts key). */
    const val CHAT = "chat/{id}"

    /** The chats, newest first; with ?archived=true the archive. */
    const val CHATS = "chats?archived={archived}"

    /** Agent sessions on the devices, newest first; with ?archived=true the archive. */
    const val CODE = "code?archived={archived}"

    /** One agent session. */
    const val SESSION = "session/{id}"

    /** Approvals and questions, then what finished earlier. */
    const val INBOX = "inbox"

    // the pages Settings opens (the side panel lists only the conversations), and Settings
    const val TASKS = "tasks"
    const val USAGE = "usage"
    const val AGENTS = "agents"
    const val AGENT = "agent/{name}"
    const val ROUTINES = "routines"
    const val MEMORY = "memory"
    const val REFLECT = "reflect"
    const val DEVICES = "devices"
    const val SETTINGS = "settings"
    const val REMOTE = "remote"

    /** Workflow runs, newest first; with ?session= only that session's runs. */
    const val WORKFLOW_RUNS = "workflow-runs?session={session}"

    /** The workflow library and its launch form. */
    const val WORKFLOW_LIBRARY = "workflow-library"

    /** One workflow run: phases, agents, the result. */
    const val WORKFLOW_RUN = "workflow-run/{id}"

    /** Memory, Import past chats. */
    const val IMPORT = "memory/import"

    /** Scan a new code while paired (a new tunnel address, or pair again). */
    const val PAIR = "pair"

    /** The day plan, today's calendar and the proposals waiting (docs/DESIGN.md, Calendar and mail). */
    const val TODAY = "today"

    /** The Map: every device, project and agent as one picture (docs/DESIGN.md 29). */
    const val MAP = "map"

    /** Friends; with ?link= a friend's invite that opened the app, ready to use. */
    const val FRIENDS = "friends?link={link}"

    /** One friend: notes and shares both ways. */
    const val FRIEND = "friend/{id}"

    /** Shares both ways, under Friends. */
    const val SHARES = "shares"

    /** One share from a friend. */
    const val SHARE = "share/{id}"

    fun chat(id: String) = "chat/${android.net.Uri.encode(id)}"
    fun session(id: String) = "session/${android.net.Uri.encode(id)}"
    fun chats(archived: Boolean = false) = if (archived) "chats?archived=true" else "chats"
    fun code(archived: Boolean = false) = if (archived) "code?archived=true" else "code"
    fun agent(name: String) = "agent/${android.net.Uri.encode(name)}"
    fun workflowRuns(sessionId: String? = null) = if (sessionId == null) "workflow-runs" else "workflow-runs?session=${android.net.Uri.encode(sessionId)}"
    fun workflowRun(id: String) = "workflow-run/${android.net.Uri.encode(id)}"
    fun friends(link: String? = null) = if (link == null) "friends" else "friends?link=${android.net.Uri.encode(link)}"
    fun friend(id: String) = "friend/${android.net.Uri.encode(id)}"
    fun share(id: String) = "share/${android.net.Uri.encode(id)}"
}

/**
 * A page from Settings: the Inbox and the lists on top of Home ([top]), as
 * the side panel's places were; the rest over Settings ([push]), so Back
 * goes to it.
 */
private fun openPage(page: SettingsPage, top: (String) -> Unit, push: (String) -> Unit) = when (page) {
    SettingsPage.INBOX -> top(Routes.INBOX)
    SettingsPage.CHATS -> top(Routes.chats())
    SettingsPage.SESSIONS -> top(Routes.code())
    SettingsPage.TASKS -> push(Routes.TASKS)
    SettingsPage.ROUTINES -> push(Routes.ROUTINES)
    SettingsPage.WORKFLOWS -> push(Routes.workflowRuns())
    SettingsPage.AGENTS -> push(Routes.AGENTS)
    SettingsPage.MEMORY -> push(Routes.MEMORY)
    SettingsPage.REFLECT -> push(Routes.REFLECT)
    SettingsPage.USAGE -> push(Routes.USAGE)
    SettingsPage.DEVICES -> push(Routes.DEVICES)
    SettingsPage.MAP -> push(Routes.MAP)
}

@Composable
fun AppRoot() {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val auth by container.hub.auth.collectAsStateWithLifecycle()
    // the launch, once per cold start, after the system splash; the long one with the name before the first pairing
    var launch by remember { mutableStateOf(Launch.take()) }
    val long = remember(auth is AuthState.Unpaired) { auth is AuthState.Unpaired && !Launch.longSeen(context) }
    // paired just now: the knot plays success before the app
    var paired by remember { mutableStateOf(false) }
    var was by remember { mutableStateOf<AuthState?>(null) }
    LaunchedEffect(auth) {
        if (was is AuthState.Unpaired && auth is AuthState.Paired) paired = true
        was = auth
    }
    Box(Modifier.fillMaxSize()) {
        when (auth) {
            AuthState.Loading -> Unit
            AuthState.Unpaired -> PairingScreen()
            is AuthState.Paired -> MainScaffold()
        }
        if (launch && auth !is AuthState.Loading) {
            LaunchSplash(long = long, ready = true, onPlayed = { if (long) Launch.markLongSeen(context) }, onGone = { launch = false })
        }
        if (paired) RopeSplash(RopeMoment.SUCCESS, onGone = { paired = false })
        // the app's own update, once per start when it asks (update/UpdateDialog.kt): after the splash, never over pairing
        if (!launch && !paired && auth is AuthState.Paired) StartupUpdate()
    }
}

@Composable
private fun MainScaffold() {
    val container = LocalAppContainer.current
    val hub = container.hub
    val nav = rememberNavController()
    val backStack by nav.currentBackStackEntryAsState()
    val route = backStack?.destination?.route
    val pendingLink by hub.pendingLink.collectAsStateWithLifecycle()
    val problem by hub.problem.collectAsStateWithLifecycle()
    val newSignIn by hub.newSignIn.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val c = Conclave.colors

    // Ask for notification permission once after pairing (Android 13+).
    val settings by container.settings.state.collectAsStateWithLifecycle()
    // granted: the background connection can start now
    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        scope.launch { (context.applicationContext as ConclaveApp).syncBackground() }
    }
    LaunchedEffect(settings?.askedNotificationPermission) {
        val s = settings ?: return@LaunchedEffect
        if (!s.askedNotificationPermission && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            container.settings.setAskedNotificationPermission()
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Android 17: a hub on the home network needs Nearby devices. Pairing asks first; this covers
    // a phone that paired before the update. Allowed: connect again now instead of after the backoff.
    val localNetwork = rememberLocalNetworkAsk()
    LaunchedEffect(Unit) {
        val a = hub.currentUrl?.let { HubAddress.parse(it) }
        if (LocalNetwork.needed(a) && LocalNetwork.missing(context)) {
            localNetwork(a, { hub.problem.value = HubProblem.Refused(LocalNetwork.DENIED) }) { hub.retry() }
        }
    }

    // Chat, Assistant or Code is remembered on this phone (docs/DESIGN.md 40): put back once, then kept as it changes
    val mode by StartModes.mode.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        StartModes.restore(StartMode.from(container.settings.current().startMode))
        StartModes.mode.collect { container.settings.setStartMode(it.wire) }
    }

    // a new conversation from anywhere: Home, in the mode asked for
    val startNew: (StartMode) -> Unit = { m ->
        StartModes.set(m)
        navigateTop(nav, Routes.HOME)
    }

    // Deep links, shortcuts and share intents.
    LaunchedEffect(pendingLink) {
        val link = pendingLink ?: return@LaunchedEffect
        // NavHost sets its graph during layout; wait one frame before navigating.
        withFrameNanos { }
        when (link) {
            is DeepLink.Session -> {
                // a session link that names a chat opens it as a chat
                val chat = hub.sessions.value.firstOrNull { it.id == link.id }?.isChat == true
                nav.navigate(if (chat) Routes.chat(link.id) else Routes.session(link.id)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            is DeepLink.Chat -> {
                nav.navigate(Routes.chat(link.id)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            DeepLink.Approvals -> {
                navigateTop(nav, Routes.INBOX)
                hub.pendingLink.value = null
            }
            is DeepLink.WorkflowRun -> {
                nav.navigate(Routes.workflowRun(link.id)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            DeepLink.NewChat -> {
                // Home set to Chat; a shared text or image waits there in the composer
                startNew(StartMode.CHAT)
                hub.pendingLink.value = null
            }
            // paired already: the pair screen shows the code's address and pairs only when you tap Pair
            is DeepLink.Pair -> if (route != Routes.PAIR) nav.navigate(Routes.PAIR) { launchSingleTop = true }
            // a friend's invite: Friends shows it in Use a friend's link, sent only when you tap Send request
            is DeepLink.FriendInvite -> {
                nav.navigate(Routes.friends(link.link)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            is DeepLink.Friends -> {
                val id = link.id
                if (id == null) navigateTop(nav, Routes.friends()) else nav.navigate(Routes.friend(id)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            is DeepLink.Shares -> {
                val id = link.id
                nav.navigate(if (id == null) Routes.SHARES else Routes.share(id)) { launchSingleTop = true }
                hub.pendingLink.value = null
            }
            DeepLink.MapPage -> {
                navigateTop(nav, Routes.MAP)
                hub.pendingLink.value = null
            }
        }
    }

    val openId = if (route == Routes.CHAT || route == Routes.SESSION) backStack?.arguments?.getString("id") else null
    // New in the bar: an open conversation's own mode, a chat's places Chat, the Code list Code, else the switch's
    fun newMode(): StartMode = Start.newMode(
        remembered = StartModes.mode.value,
        open = openId?.let { id -> hub.sessions.value.firstOrNull { it.id == id } },
        inChats = route == Routes.CHAT || route == Routes.CHATS,
        inCodeList = route == Routes.CODE,
    )
    // a hub with the Assistant home thread: Assistant has no New, Home sends into that one thread
    val hasHome by remember(hub) { hub.sessions.map { Drawer.homeOf(it) != null } }.collectAsStateWithLifecycle(false)
    val newChat: (() -> Unit)? = if (hasHome && newMode() == StartMode.ASSISTANT) null else { { startNew(newMode()) } }
    val newWords = newMode().newWords
    // the Inbox in the top bar, with what waits there: the side panel no longer lists it
    val openInbox: () -> Unit = remember(nav) { { navigateTop(nav, Routes.INBOX) } }
    val inbox = InboxBadge(rememberInboxCount(), openInbox)

    ProvideReducedMotion {
        BoxWithConstraints(Modifier.fillMaxSize().background(c.bg)) {
            val wide = maxWidth >= 840.dp
            val drawer = rememberDrawerState(DrawerValue.Closed)
            fun close(then: () -> Unit) {
                then()
                if (!wide) scope.launch { drawer.close() }
            }
            val panel: @Composable (Modifier) -> Unit = { m ->
                SidePanel(
                    currentId = openId,
                    inSettings = route == Routes.SETTINGS,
                    mode = mode,
                    // another mode lists its conversations, and New starts one in it; the panel stays open
                    onMode = { next -> StartModes.set(next) },
                    onNew = { close { startNew(StartModes.mode.value) } },
                    onOpen = { id, chat -> close { openFromPanel(nav, if (chat) Routes.chat(id) else Routes.session(id)) } },
                    onSettings = { close { navigateTop(nav, Routes.SETTINGS) } },
                    modifier = m,
                    open = wide || drawer.isOpen,
                )
            }
            if (wide) {
                // 840dp and wider: the panel always shows, so no menu button
                CompositionLocalProvider(LocalOpenPanel provides null, LocalNewChat provides newChat, LocalNewWords provides newWords, LocalInbox provides inbox) {
                    Row(Modifier.fillMaxSize()) {
                        Box(Modifier.width(300.dp).fillMaxHeight().background(c.bg)) { panel(Modifier) }
                        Box(Modifier.width(1.dp).fillMaxHeight().background(c.rule))
                        AppNavHost(nav, Modifier.weight(1f))
                    }
                }
            } else {
                // 85% of the width, at most 360dp, over the scrim; a swipe opens it too
                val width = minOf(maxWidth * 0.85f, 360.dp)
                val openPanel: () -> Unit = remember(drawer) { { scope.launch { drawer.open() } } }
                ModalNavigationDrawer(
                    drawerState = drawer,
                    gesturesEnabled = true,
                    scrimColor = c.scrim,
                    drawerContent = {
                        // composed after the screens, so Back closes an open panel before it leaves a screen
                        BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
                        ModalDrawerSheet(
                            modifier = Modifier.width(width),
                            drawerShape = RectangleShape,
                            drawerContainerColor = c.bg,
                            drawerContentColor = c.fg,
                            windowInsets = WindowInsets(0, 0, 0, 0),
                        ) { panel(Modifier) }
                    },
                ) {
                    CompositionLocalProvider(LocalOpenPanel provides openPanel, LocalNewChat provides newChat, LocalNewWords provides newWords, LocalInbox provides inbox) {
                        AppNavHost(nav, Modifier.fillMaxSize())
                    }
                }
            }
            // another machine at the hub's address: nothing was sent; over everything until an address proves the key
            val p = problem
            if (p is HubProblem.NotYourHub && route != Routes.PAIR) {
                IdentityScreen(
                    address = p.address,
                    saved = settings?.hubAddresses.orEmpty(),
                    onUse = { url -> hub.useAddress(url) },
                    onPairAgain = { nav.navigate(Routes.PAIR) { launchSingleTop = true } },
                )
            }
        }
    }

    // after a password login, once: the hub's fingerprint to compare with its Settings
    newSignIn?.let { s -> FingerprintDialog(s, onDone = { hub.newSignIn.value = null }) }
}

/** A place from the side panel, the bar's Inbox or a link: on top of Home, so Back goes Home. */
private fun navigateTop(nav: NavHostController, route: String) {
    nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id)
        launchSingleTop = true
    }
}

/** A chat or session from the panel's recents: on top of Home, a new screen even when one is open. */
private fun openFromPanel(nav: NavHostController, route: String) {
    nav.navigate(route) {
        popUpTo(nav.graph.findStartDestination().id)
    }
}

@Composable
private fun AppNavHost(nav: NavHostController, modifier: Modifier) {
    val hub = LocalAppContainer.current.hub
    // a session id from anywhere (tasks, routines, the Inbox) opens where it belongs: chats as chats
    val openChat: (String) -> Unit = { id ->
        val chat = hub.sessions.value.firstOrNull { it.id == id }?.isChat == true
        nav.navigate(if (chat) Routes.chat(id) else Routes.session(id))
    }
    val back: () -> Unit = { nav.popBackStack() }
    val home: () -> Unit = { if (!nav.popBackStack(Routes.HOME, inclusive = false)) navigateTop(nav, Routes.HOME) }
    val openRun: (String) -> Unit = { id -> nav.navigate(Routes.workflowRun(id)) { launchSingleTop = true } }
    // a page over the one you are on: Usage from the context ring's sheet in a composer, a page from Settings
    val push: (String) -> Unit = { r -> nav.navigate(r) { launchSingleTop = true } }
    val openUsage: () -> Unit = { push(Routes.USAGE) }
    val archived = listOf(
        navArgument("archived") {
            type = NavType.BoolType
            defaultValue = false
        },
    )
    // a Workflow row anywhere opens its run, a subagent's its session
    CompositionLocalProvider(LocalOpenWorkflowRun provides openRun, LocalOpenSession provides openChat) {
        // quiet and fast: screens fade in 180ms and out 120ms, no slides (no motion at all when animations are off)
        NavHost(
            navController = nav,
            startDestination = Routes.HOME,
            modifier = modifier,
            enterTransition = { fadeIn(tween(Motion.DUR_2, easing = Motion.Ease)) },
            exitTransition = { fadeOut(tween(Motion.DUR_1, easing = Motion.EaseIn)) },
            popEnterTransition = { fadeIn(tween(Motion.DUR_2, easing = Motion.Ease)) },
            popExitTransition = { fadeOut(tween(Motion.DUR_1, easing = Motion.EaseIn)) },
        ) {
            composable(Routes.HOME) {
                HomeScreen(
                    onOpenChat = { id -> nav.navigate(Routes.chat(id)) { launchSingleTop = true } },
                    onOpenSession = { id -> nav.navigate(Routes.session(id)) { launchSingleTop = true } },
                    onOpenInbox = { navigateTop(nav, Routes.INBOX) },
                    onScanCode = { nav.navigate(Routes.PAIR) },
                    onOpenToday = { nav.navigate(Routes.TODAY) { launchSingleTop = true } },
                    onOpenUsage = openUsage,
                )
            }
            composable(Routes.TODAY) { dev.conclave.app.ui.home.TodayScreen(onBack = back) }
            composable(
                Routes.CHAT,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
                // a chat sent from Home takes over its start screen in place: nothing fades
                enterTransition = { if (isChatStart(initialState)) EnterTransition.None else fadeIn(tween(Motion.DUR_2, easing = Motion.Ease)) },
                exitTransition = { if (isChatStart(initialState) && targetState.destination.route == Routes.CHAT) ExitTransition.None else fadeOut(tween(Motion.DUR_1, easing = Motion.EaseIn)) },
            ) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                if (ChatStarts.isStart(id)) {
                    ChatStartScreen(
                        startKey = id,
                        onBound = { chatId -> nav.navigate(Routes.chat(chatId)) { popUpTo(Routes.CHAT) { inclusive = true } } },
                        onBack = home,
                    )
                    return@composable
                }
                // a link to another chat can reuse this entry: start fresh (scroll, sheets, edits) for each chat
                key(id) {
                    ChatThreadScreen(
                        sessionId = id,
                        onOpenChat = { newId -> nav.navigate(Routes.chat(newId)) { popUpTo(Routes.CHAT) { inclusive = true } } },
                        onNewChat = home,
                        onOpenSession = { sid ->
                            nav.navigate(Routes.session(sid)) {
                                popUpTo(Routes.CHAT) { inclusive = true }
                                launchSingleTop = true
                            }
                        },
                        onOpenMemory = { nav.navigate(Routes.MEMORY) },
                        onOpenFriend = { fid -> nav.navigate(Routes.friend(fid)) },
                        onOpenShare = { sid -> nav.navigate(Routes.share(sid)) },
                        onOpenUsage = openUsage,
                    )
                }
            }
            composable(Routes.CHATS, arguments = archived) { entry ->
                val inArchive = entry.arguments?.getBoolean("archived") == true
                SessionsScreen(
                    chats = true,
                    archived = inArchive,
                    onOpen = openChat,
                    onOpenArchive = { nav.navigate(Routes.chats(archived = true)) },
                    onBack = if (inArchive) back else null,
                )
            }
            composable(Routes.CODE, arguments = archived) { entry ->
                val inArchive = entry.arguments?.getBoolean("archived") == true
                SessionsScreen(
                    chats = false,
                    archived = inArchive,
                    onOpen = openChat,
                    onOpenArchive = { nav.navigate(Routes.code(archived = true)) },
                    onBack = if (inArchive) back else null,
                )
            }
            composable(Routes.SESSION, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                ChatScreen(
                    sessionId = id,
                    onBack = back,
                    onOpenChat = { newId -> nav.navigate(Routes.session(newId)) { popUpTo(Routes.SESSION) { inclusive = true } } },
                    onIsChat = { nav.navigate(Routes.chat(id)) { popUpTo(Routes.SESSION) { inclusive = true } } },
                    onOpenWorkflowRuns = { sid -> nav.navigate(Routes.workflowRuns(sid)) },
                    onOpenFriend = { fid -> nav.navigate(Routes.friend(fid)) },
                    onOpenShare = { sid -> nav.navigate(Routes.share(sid)) },
                    onOpenUsage = openUsage,
                )
            }
            composable(Routes.INBOX) {
                InboxScreen(
                    onOpenChat = openChat,
                    onOpenFriend = { id -> nav.navigate(Routes.friend(id)) },
                    onOpenShare = { id -> nav.navigate(Routes.share(id)) },
                )
            }
            composable(Routes.TASKS) { TasksScreen(onOpenChat = openChat, onBack = back) }
            composable(Routes.USAGE) { UsageScreen(onBack = back) }
            composable(Routes.REFLECT) { ReflectScreen(onBack = back) }
            composable(Routes.AGENTS) { AgentsScreen(onBack = back, onOpenAgent = { name -> nav.navigate(Routes.agent(name)) }) }
            composable(Routes.AGENT, arguments = listOf(navArgument("name") { type = NavType.StringType })) { entry ->
                AgentDetailScreen(name = entry.arguments?.getString("name").orEmpty(), onBack = back, onOpenChat = openChat)
            }
            composable(Routes.ROUTINES) { RoutinesScreen(onBack = back, onOpenChat = openChat) }
            composable(Routes.MEMORY) { MemoryScreen(onBack = back, onImport = { nav.navigate(Routes.IMPORT) }) }
            composable(Routes.IMPORT) { ImportScreen(onBack = back) }
            composable(
                Routes.WORKFLOW_RUNS,
                arguments = listOf(
                    navArgument("session") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) { entry ->
                WorkflowRunsScreen(sessionId = entry.arguments?.getString("session"), onBack = back, onOpenRun = openRun, onLaunch = { nav.navigate(Routes.WORKFLOW_LIBRARY) })
            }
            composable(Routes.WORKFLOW_RUN, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                WorkflowRunScreen(runId = entry.arguments?.getString("id").orEmpty(), onBack = back, onOpenSession = openChat)
            }
            composable(Routes.WORKFLOW_LIBRARY) { WorkflowLibraryScreen(onBack = back, onOpenRun = openRun) }
            composable(Routes.DEVICES) { DevicesScreen(onBack = back) }
            composable(Routes.SETTINGS) {
                SettingsScreen(
                    onBack = back,
                    onOpenRemote = { nav.navigate(Routes.REMOTE) },
                    onScanCode = { nav.navigate(Routes.PAIR) },
                    onOpenFriends = { nav.navigate(Routes.friends()) },
                    onOpenPage = { page -> openPage(page, top = { r -> navigateTop(nav, r) }, push = push) },
                )
            }
            composable(Routes.REMOTE) { RemoteScreen(onBack = back) }
            composable(Routes.PAIR) { PairingScreen(onDone = back) }
            composable(Routes.MAP) {
                MapScreen(
                    onBack = back,
                    onOpenChat = { id -> nav.navigate(Routes.chat(id)) { launchSingleTop = true } },
                    onOpenSession = { id -> nav.navigate(Routes.session(id)) { launchSingleTop = true } },
                    onOpenRun = openRun,
                )
            }
            composable(
                Routes.FRIENDS,
                arguments = listOf(
                    navArgument("link") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) { entry ->
                FriendsScreen(
                    link = entry.arguments?.getString("link"),
                    onBack = back,
                    onOpenFriend = { id -> nav.navigate(Routes.friend(id)) },
                    onOpenShares = { nav.navigate(Routes.SHARES) },
                    onOpenRemote = { nav.navigate(Routes.REMOTE) },
                )
            }
            composable(Routes.FRIEND, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                key(id) {
                    FriendScreen(id = id, onBack = back, onOpenShare = { sid -> nav.navigate(Routes.share(sid)) }, onOpenSession = openChat)
                }
            }
            composable(Routes.SHARES) {
                SharesScreen(onBack = back, onOpenShare = { sid -> nav.navigate(Routes.share(sid)) }, onOpenSession = openChat)
            }
            composable(Routes.SHARE, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                key(id) { ShareScreen(id = id, onBack = back, onOpenSession = openChat) }
            }
        }
    }
}

@Composable
fun LockScreen(onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Mark(height = 28.dp)
        Spacer(Modifier.height(20.dp))
        Text("Conclave is locked", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onUnlock) { Text("Unlock") }
    }
}

/** The start screen of a chat sent from Home (ChatStarts). */
private fun isChatStart(e: NavBackStackEntry): Boolean =
    e.destination.route == Routes.CHAT && ChatStarts.isStart(e.arguments?.getString("id").orEmpty())
