@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.settings

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.AppLock
import dev.conclave.app.BuildConfig
import dev.conclave.app.ConclaveApp
import dev.conclave.app.data.AuthState
import dev.conclave.app.notify.Notifications
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.rememberInboxCount
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.ThemeMode
import dev.conclave.app.ui.theme.chatDensity
import dev.conclave.app.update.UpdateState
import dev.conclave.client.ConnectionState
import dev.conclave.client.HubKeys
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.RemoteWords
import dev.conclave.client.logic.TextSize
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A page Settings opens. The side panel keeps only the conversations, so every other page is here. */
enum class SettingsPage(val label: String) {
    INBOX("Inbox"),
    CHATS("Chats"),
    SESSIONS("Sessions"),
    TASKS("Tasks"),
    ROUTINES("Routines"),
    WORKFLOWS("Workflows"),
    AGENTS("Agents"),
    MEMORY("Memory"),
    REFLECT("Reflect"),
    USAGE("Usage"),
    DEVICES("Devices"),
    MAP("Map"),
}

/** The sections of pages at the top of Settings, under quiet headings, in this order. Devices and Map are under Hub. */
private val PAGE_SECTIONS = listOf(
    "Conversations" to listOf(SettingsPage.INBOX, SettingsPage.CHATS, SettingsPage.SESSIONS),
    "Automation" to listOf(SettingsPage.TASKS, SettingsPage.ROUTINES, SettingsPage.WORKFLOWS, SettingsPage.AGENTS),
    "Memory and usage" to listOf(SettingsPage.MEMORY, SettingsPage.REFLECT, SettingsPage.USAGE),
)

/**
 * Settings (MOBILE-V2 7): a plain grouped list, opened from the account row
 * at the foot of the side panel. First the pages the side panel used to
 * list, in sections ([onOpenPage]); then the hub, notifications, security,
 * appearance and about. A group label, then rows: a value on the right, a
 * chevron where a row opens more, a switch where it turns something on. A
 * separator between groups, never round them.
 */
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenRemote: () -> Unit,
    onScanCode: () -> Unit,
    onOpenFriends: () -> Unit = {},
    onOpenPage: (SettingsPage) -> Unit = {},
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val settingsStore = container.settings
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = rememberToasts()
    val settings by settingsStore.state.collectAsStateWithLifecycle()
    val auth by hub.auth.collectAsStateWithLifecycle()
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val problem by hub.problem.collectAsStateWithLifecycle()
    val remote by hub.remote.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val friends by hub.friends.collectAsStateWithLifecycle()
    val waiting = rememberInboxCount()
    var confirmRepair by remember { mutableStateOf(false) }
    var editingName by remember { mutableStateOf(false) }
    var pickingTextSize by remember { mutableStateOf(false) }
    var license by remember { mutableStateOf<String?>(null) }
    // Bumped after returning from system screens so permission state is re-read.
    var refreshTick by remember { mutableIntStateOf(0) }
    val app = context.applicationContext as ConclaveApp
    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        refreshTick++
        scope.launch { app.syncBackground() }
    }
    val c = Conclave.colors
    val s = settings ?: return

    fun say(text: String) {
        scope.launch { snackbar.showSnackbar(text) }
    }

    Scaffold(
        topBar = { TopBar("Settings", onBack = onBack) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            // ---------------------------------------------------------------- pages
            PAGE_SECTIONS.forEachIndexed { i, (label, pages) ->
                Group(label, first = i == 0)
                pages.forEach { page ->
                    PageRow(page.label, count = if (page == SettingsPage.INBOX) waiting else 0, onClick = { onOpenPage(page) })
                }
            }

            // ---------------------------------------------------------------- hub
            Group("Hub")
            val paired = auth as? AuthState.Paired
            val (dot, word) = when (connection) {
                ConnectionState.OPEN -> c.ok to "online"
                ConnectionState.CONNECTING -> c.fg3 to "connecting"
                ConnectionState.CLOSED -> c.fault to "offline"
            }
            InfoRow("Name", info?.name?.ifBlank { null } ?: s.hubName ?: "Unknown") {
                Box(Modifier.size(8.dp).background(dot, CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(word, style = ConclaveType.body, color = c.fg3)
            }
            InfoRow("Address", HubAddresses.host(paired?.url).ifBlank { paired?.url.orEmpty() })
            info?.version?.takeIf { it.isNotBlank() }?.let { InfoRow("Version", it) }
            // the hub's identity, to compare with Settings on the hub
            info?.fingerprint?.takeIf { it.isNotBlank() }?.let { InfoRow("Fingerprint", HubKeys.groups(it)) }
            info?.defaultModel?.takeIf { it.isNotBlank() }?.let { m ->
                InfoRow("Default model", null) { ModelName(m, size = 14.dp, style = ConclaveType.body, color = c.fg2, asModel = true) }
            }
            problem?.let { p -> Note(p.text, color = c.warn) }
            NavRow("Devices", devices.count { it.online }.let { n -> if (n == 1) "1 online" else "$n online" }, onClick = { onOpenPage(SettingsPage.DEVICES) })
            NavRow("Map", "Every device, project and agent", onClick = { onOpenPage(SettingsPage.MAP) })
            NavRow(
                "Remote access",
                remote?.let { r -> RemoteWords.label(r.mode) },
                onClick = onOpenRemote,
            )
            // other owners' hubs this hub trades notes, chats and sessions with (docs/DESIGN.md 27)
            val friendCount = friends.count { it.isActive }
            NavRow("Friends", if (friendCount == 0) "None yet" else if (friendCount == 1) "1 friend" else "$friendCount friends", onClick = onOpenFriends)
            NavRow("Scan a new code", "Another hub, or a new address", onClick = onScanCode)
            NavRow("Refresh", null, chevron = false, onClick = { scope.launch { hub.refreshAll() } })
            NavRow("Sign out", null, chevron = false, danger = true, onClick = { confirmRepair = true })

            // ---------------------------------------------------------------- notifications
            Group("Notifications")
            val canPost = remember(refreshTick, s) { Notifications.canPost(context) }
            ToggleRow(
                title = "Notify this device",
                help = "Conclave stays connected to your hub in the background and shows its notices here: finished work, approvals with Approve and Deny, limits. No other app or service is involved.",
                checked = s.notifyDevice,
                onChange = { on ->
                    scope.launch {
                        settingsStore.setNotifyDevice(on)
                        app.syncBackground()
                    }
                },
            )
            if (s.notifyDevice && !canPost) {
                NavRow("Notifications are off for Conclave", "Allow them, or approvals cannot reach you.", onClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    }
                })
            }
            if (s.notifyDevice) {
                val ignoring = remember(refreshTick) {
                    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) == true
                }
                if (!ignoring) {
                    NavRow("Battery optimization is on", "If notifications come late, turn it off for Conclave.", onClick = {
                        runCatching { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                    })
                }
                NavRow("Hide the ongoing notice", "Its category, in system settings. Notifications still arrive.", onClick = {
                    runCatching { context.startActivity(Notifications.channelSettings(context, Notifications.CHANNEL_LIVE)) }
                })
            }
            NavRow("Send a test", null, chevron = false, onClick = {
                if (Notifications.showTest(context)) say("Sent. Check the notification shade.") else say("Allow notifications for Conclave first.")
            })
            Note("Which notices you get is set on the hub, in the web app under Settings, Notifications. While you use Conclave on another device, the hub holds the rest.")

            // ---------------------------------------------------------------- security
            Group("Security")
            ToggleRow(
                title = "Lock with biometrics",
                help = "Ask for fingerprint, face or screen lock when opening the app.",
                checked = s.biometricLock,
                onChange = { on ->
                    if (on) {
                        val can = BiometricManager.from(context).canAuthenticate(
                            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                        )
                        if (can != BiometricManager.BIOMETRIC_SUCCESS) {
                            say("Set up a screen lock on this device first")
                            return@ToggleRow
                        }
                        AppLock.unlocked.value = true
                    }
                    scope.launch { settingsStore.setBiometricLock(on) }
                },
            )
            ToggleRow(
                title = "Hide content",
                help = "Block screenshots and blank the app in the recent apps screen.",
                checked = s.secureScreen,
                onChange = { on -> scope.launch { settingsStore.setSecureScreen(on) } },
            )
            Note("The hub token is encrypted with a key kept in the Android Keystore and is never included in backups.")

            // ---------------------------------------------------------------- appearance
            Group("Appearance")
            // System follows the phone, as the web app does
            ThemeMode.entries.forEach { m ->
                CheckRow(m.label, selected = s.theme == m, onClick = { scope.launch { settingsStore.setTheme(m) } })
            }
            // the transcripts' text only (CHAT-AND-MOTION 6.5); the rest of the app stays as it is
            NavRow("Text size", s.textSize.label, onClick = { pickingTextSize = true })
            // Home greets the owner by this name (hub config ui.name)
            val ownerName by hub.ownerName.collectAsStateWithLifecycle()
            NavRow("Your name", ownerName ?: "Not set", onClick = { editingName = true })

            // ---------------------------------------------------------------- about
            Group("About")
            InfoRow("App version", BuildConfig.VERSION_NAME)
            // the app's own update from the public releases (update/AppUpdater.kt)
            val update by container.updates.state.collectAsStateWithLifecycle()
            when (val u = update) {
                is UpdateState.Available -> NavRow("Update available", "Conclave ${u.version}. Download and install it.", chevron = false, onClick = { container.updates.install(u.version, u.apk) })
                is UpdateState.Downloading -> InfoRow("Downloading Conclave ${u.version}", "${u.percent}%")
                is UpdateState.Ready -> NavRow("Install Conclave ${u.version}", "Android asks you to tap Install.", chevron = false, onClick = {
                    if (!container.updates.openInstaller(u.file)) say("Allow Conclave to install apps, then tap Install again.")
                })
                is UpdateState.Failed -> NavRow("Update failed", u.why, chevron = false, onClick = {
                    val apk = u.apk
                    if (apk != null) container.updates.install(u.version, apk) else container.updates.check()
                })
                is UpdateState.ByHand -> Note("Conclave ${u.version} is out. ${u.why}")
                is UpdateState.Off -> Note(u.why)
                UpdateState.Idle -> NavRow("Check for updates", null, chevron = false, onClick = {
                    container.updates.check()
                    say("Checking for updates.")
                })
            }
            // the dialog at app start; off, a new version shows as a dot on the account row (update/UpdateDialog.kt)
            ToggleRow(
                title = "Show updates at startup",
                help = "When a new version is ready, a dialog asks at app start. Off, a dot on your account row shows it.",
                checked = s.updateAtStartup,
                onChange = { on -> scope.launch { settingsStore.setUpdateAtStartup(on) } },
            )
            InfoRow("Package", BuildConfig.APPLICATION_ID)
            NavRow("Mona Sans license", null, onClick = { license = "licenses/mona-sans-OFL.txt" })
            NavRow("JetBrains Mono license", null, onClick = { license = "licenses/jetbrains-mono-OFL.txt" })
            NavRow("LobeHub icons license", null, onClick = { license = "licenses/lobehub-icons-MIT.txt" })
            Note(
                "Fonts: Mona Sans and JetBrains Mono, both under the SIL Open Font License 1.1. " +
                    "Libraries: AndroidX, Jetpack Compose, Material 3, OkHttp, kotlinx, Tink, CameraX, ML Kit, " +
                    "multiplatform-markdown-renderer. Provider and model logos are trademarks of their owners and " +
                    "identify the service only. Icons by LobeHub, MIT license.",
            )
        }
    }

    if (confirmRepair) {
        ConfirmDialog(
            title = "Sign out?",
            text = "This signs the app out of the hub and deletes the stored token. Pair again with a new code.",
            confirmLabel = "Sign out",
            destructive = true,
            onConfirm = {
                confirmRepair = false
                scope.launch { (context.applicationContext as ConclaveApp).signOut() }
            },
            onDismiss = { confirmRepair = false },
        )
    }

    if (editingName) {
        val ownerName by hub.ownerName.collectAsStateWithLifecycle()
        var name by remember { mutableStateOf(ownerName.orEmpty()) }
        AlertDialog(
            onDismissRequest = { editingName = false },
            title = { Text("Your name") },
            text = {
                Column {
                    Text("Home greets you with it. Leave it empty for no name.", style = ConclaveType.meta, color = c.fg3)
                    Spacer(Modifier.size(8.dp))
                    OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    editingName = false
                    scope.launch {
                        try {
                            val value = name.trim()
                            hub.api { it.updateConfig(buildJsonObject { put("ui", buildJsonObject { put("name", value) }) }) }
                            hub.ownerName.value = value.ifBlank { null }
                            say("Saved.")
                        } catch (e: Exception) {
                            say(errorText(e))
                        }
                    }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editingName = false }) { Text("Cancel") } },
        )
    }

    if (pickingTextSize) {
        AlertDialog(
            onDismissRequest = { pickingTextSize = false },
            title = { Text("Text size") },
            text = {
                Column {
                    Text("Replies, your messages, tool rows and code. The rest of the app stays as it is.", style = ConclaveType.meta, color = c.fg3)
                    Spacer(Modifier.size(12.dp))
                    // a reply at the size picked, as a transcript draws it: it changes as you pick
                    CompositionLocalProvider(LocalDensity provides chatDensity()) {
                        Text("A reply reads at this size.", style = ConclaveType.chat, color = c.fg)
                    }
                    Spacer(Modifier.size(8.dp))
                    TextSize.entries.forEach { t ->
                        CheckRow(t.label, selected = s.textSize == t, inset = 0.dp, onClick = { scope.launch { settingsStore.setTextSize(t) } })
                    }
                }
            },
            confirmButton = { TextButton(onClick = { pickingTextSize = false }) { Text("Done") } },
        )
    }

    license?.let { path ->
        val text = remember(path) {
            runCatching { context.assets.open(path).bufferedReader().use { it.readText() } }.getOrDefault("License text not found")
        }
        AlertDialog(
            onDismissRequest = { license = null },
            title = { Text("License") },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                    Text(text, style = CodeStyle)
                }
            },
            confirmButton = { TextButton(onClick = { license = null }) { Text("Close") } },
        )
    }

    // back from a system screen (notifications, battery): read the state again, and start or stop the connection
    LifecycleResumeEffect(Unit) {
        refreshTick++
        scope.launch { app.syncBackground() }
        onPauseOrDispose { }
    }
}

private val RowText = TextStyle(fontSize = 16.sp)

/** A group's label; every group after the [first] has a separator above it. */
@Composable
private fun Group(label: String, first: Boolean = false) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth()) {
        if (!first) HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        Text(label, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 4.dp))
    }
}

/** A row that tells: the name, and its value on the right. */
@Composable
private fun InfoRow(title: String, value: String?, trailing: (@Composable () -> Unit)? = null) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = ConclaveType.body.merge(RowText), color = c.fg, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        if (value != null) {
            Text(value, style = ConclaveType.body, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
        if (trailing != null) {
            if (value != null) Spacer(Modifier.width(10.dp))
            trailing()
        }
    }
}

/** A row that opens something: the name, a line under it, and a chevron; or an action, without one. */
@Composable
private fun NavRow(title: String, detail: String?, chevron: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConclaveType.body.merge(RowText), color = if (danger) c.fault else c.fg)
            if (detail != null) Text(detail, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (chevron) {
            Spacer(Modifier.width(8.dp))
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
        }
    }
}

/** A row that opens a page: its name, what waits there in the accent ([count] above 0), and a chevron. */
@Composable
private fun PageRow(title: String, count: Int, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 48.dp).padding(start = 20.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = ConclaveType.body.merge(RowText), color = c.fg, modifier = Modifier.weight(1f))
        if (count > 0) {
            Text(if (count > 99) "99+" else count.toString(), style = ConclaveType.metaNum.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), color = c.warn)
            Spacer(Modifier.width(8.dp))
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
    }
}

/** A switch row: the name, what it does in a quiet line, the switch. */
@Composable
private fun ToggleRow(title: String, help: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.heightIn(min = 56.dp).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = ConclaveType.body.merge(RowText), color = c.fg)
            Text(help, style = ConclaveType.meta, color = c.fg3)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** One of a choice's rows, with a check on the chosen one. [inset]: its side padding (none inside a dialog). */
@Composable
private fun CheckRow(title: String, selected: Boolean, inset: Dp = 20.dp, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 48.dp).padding(horizontal = inset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = ConclaveType.body.merge(RowText), color = c.fg, modifier = Modifier.weight(1f))
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = c.fg, modifier = Modifier.size(18.dp))
    }
}

/** A quiet paragraph under a group's rows. */
@Composable
private fun Note(text: String, color: androidx.compose.ui.graphics.Color = Conclave.colors.fg3) {
    Text(text, style = ConclaveType.meta, color = color, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
}
