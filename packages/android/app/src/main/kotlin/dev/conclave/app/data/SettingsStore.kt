package dev.conclave.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.conclave.app.ui.theme.ThemeMode
import dev.conclave.client.logic.GroupBy
import dev.conclave.client.logic.SessionGrouping
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.TextSize
import dev.conclave.client.model.PermissionMode
import dev.conclave.client.model.ThinkingLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** Non-secret settings. The hub token lives in [SecureTokenStore], never here. */
private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

data class AppSettings(
    /** The address in use. */
    val hubUrl: String? = null,
    /** Every address of the hub, best first (RemoteStatus.addresses). Tried in order when [hubUrl] stops answering. */
    val hubAddresses: List<String> = emptyList(),
    val hubName: String? = null,
    val clientId: String? = null,
    /** Public hosts the user explicitly allowed for plain http. Private networks need no approval. */
    val cleartextHosts: Set<String> = emptySet(),
    val theme: ThemeMode = ThemeMode.SYSTEM,
    /** Appearance, Text size: the transcripts' text, Small to Larger, on this phone. */
    val textSize: TextSize = TextSize.DEFAULT,
    val biometricLock: Boolean = false,
    val secureScreen: Boolean = false,
    /** Notify this device: the background connection runs and turns the hub's notices into notifications. */
    val notifyDevice: Boolean = true,
    val grouping: SessionGrouping = SessionGrouping.DATE,
    val askedNotificationPermission: Boolean = false,
    /** The switches a new chat starts with: the ones the owner used last on this phone. */
    val chatDefaults: ChatDefaults = ChatDefaults(),
    /** What a new Code session starts with: the setup used last on this phone. */
    val codeDefaults: CodeDefaults = CodeDefaults(),
    /** Inbox, Clear done: finished work up to this time is no longer listed. */
    val inboxClearedAt: Long = 0,
    /** The Map's streams: full, quiet or lines (docs/DESIGN.md 29), remembered on this phone. */
    val mapStreams: String = "full",
    /** Chat, Assistant or Code: the switch at the top, remembered on this phone (StartMode.wire). */
    val startMode: String? = null,
    /** Group by in the side panel: project, device or time. */
    val drawerGroup: GroupBy = GroupBy.PROJECT,
    /** Skip this version: the app's update that no longer asks, until a newer one. */
    val updateSkipped: String? = null,
    /** The update dialog at app start. Off (Don't show at startup): a dot on the account row and Settings, About. */
    val updateAtStartup: Boolean = true,
    /** A model switch in a big chat starts on Short handover: the owner picked it on this phone (docs/DESIGN.md 44). */
    val switchBrief: Boolean = false,
)

/** A new chat's model and switches (CHAT-AND-MOTION 2.5). Null model: the hub's default. */
data class ChatDefaults(
    val model: String? = null,
    val webSearch: Boolean = true,
    val memory: Boolean = true,
    val thinking: ThinkingLevel? = null,
)

/**
 * What was picked for a new Code (and Assistant) session on this phone
 * (docs/DESIGN.md 40). Null fields follow the last Code session and the hub
 * (Start.code): the agent is the coding agent, the device the last computer
 * used. With no folder known, Code asks for one on the first send.
 */
data class CodeDefaults(
    val agent: String? = null,
    val model: String? = null,
    /** A device picked by hand on this phone. Null: Code starts where Start.startDevice says (the hub unless Settings names one). */
    val device: String? = null,
    val cwd: String? = null,
    /** The device [cwd] is on: picking a folder is not picking a device. */
    val cwdDevice: String? = null,
    val permissionMode: PermissionMode = PermissionMode.DEFAULT,
    val ultra: Boolean = false,
    /** From GitHub (docs/DESIGN.md 30): owner/name. Set, the session gets its own worktree and needs no folder. */
    val repo: String? = null,
    /** The branch a repo session starts from. Null: the repository's default branch. */
    val base: String? = null,
    /** Effort for the next Assistant or Code session. Null runs at the agent's level. */
    val thinking: ThinkingLevel? = null,
    /** The model the Assistant switch starts with. Null: the assistant agent's own. */
    val assistantModel: String? = null,
)

class SettingsStore(context: Context, scope: CoroutineScope) {
    private val store = context.applicationContext.settingsDataStore

    private object Keys {
        val hubUrl = stringPreferencesKey("hub_url")
        val hubAddresses = stringPreferencesKey("hub_addresses")
        val hubName = stringPreferencesKey("hub_name")
        val clientId = stringPreferencesKey("client_id")
        val cleartextHosts = stringSetPreferencesKey("cleartext_hosts")
        val theme = stringPreferencesKey("theme")
        val textSize = stringPreferencesKey("text_size")
        val biometricLock = booleanPreferencesKey("biometric_lock")
        val secureScreen = booleanPreferencesKey("secure_screen")
        val notifyDevice = booleanPreferencesKey("notify_device")
        val grouping = stringPreferencesKey("grouping")
        val notifiedApprovals = stringSetPreferencesKey("notified_approvals")
        val askedNotifications = booleanPreferencesKey("asked_notifications")
        val chatModel = stringPreferencesKey("chat_model")
        val chatWeb = booleanPreferencesKey("chat_web")
        val chatMemory = booleanPreferencesKey("chat_memory")
        val chatThinking = stringPreferencesKey("chat_thinking")
        val codeAgent = stringPreferencesKey("code_agent")
        val codeModel = stringPreferencesKey("code_model")
        val codeDevice = stringPreferencesKey("code_device")
        val codeCwd = stringPreferencesKey("code_cwd")
        val codeCwdDevice = stringPreferencesKey("code_cwd_device")
        val codePicks = stringPreferencesKey("code_picks")
        val codePermission = stringPreferencesKey("code_permission")
        val codeUltra = booleanPreferencesKey("code_ultra")
        val inboxClearedAt = longPreferencesKey("inbox_cleared_at")
        val mapStreams = stringPreferencesKey("map_streams")
        val codeRepo = stringPreferencesKey("code_repo")
        val codeBase = stringPreferencesKey("code_base")
        val codeThinking = stringPreferencesKey("code_thinking")
        val assistantModel = stringPreferencesKey("assistant_model")
        val startMode = stringPreferencesKey("start_mode")
        val drawerGroup = stringPreferencesKey("drawer_group")
        val updateSkipped = stringPreferencesKey("update_skipped")
        val updateAtStartup = booleanPreferencesKey("update_at_startup")
        val switchBrief = booleanPreferencesKey("switch_brief")
    }

    /** Code's device pick and its folder's device, from picks of any version (Start.savedPlace). */
    private fun place(p: Preferences) = Start.savedPlace(p[Keys.codeDevice], p[Keys.codeCwd], p[Keys.codeCwdDevice], p[Keys.codePicks]?.toIntOrNull())

    private fun read(p: Preferences) = AppSettings(
        hubUrl = p[Keys.hubUrl],
        hubAddresses = p[Keys.hubAddresses]?.split('\n')?.filter { it.isNotBlank() }.orEmpty(),
        hubName = p[Keys.hubName],
        clientId = p[Keys.clientId],
        cleartextHosts = p[Keys.cleartextHosts] ?: emptySet(),
        theme = ThemeMode.from(p[Keys.theme]),
        textSize = TextSize.from(p[Keys.textSize]),
        biometricLock = p[Keys.biometricLock] ?: false,
        secureScreen = p[Keys.secureScreen] ?: false,
        notifyDevice = p[Keys.notifyDevice] ?: true,
        grouping = SessionGrouping.entries.firstOrNull { it.name == p[Keys.grouping] } ?: SessionGrouping.DATE,
        askedNotificationPermission = p[Keys.askedNotifications] ?: false,
        chatDefaults = ChatDefaults(
            model = p[Keys.chatModel],
            webSearch = p[Keys.chatWeb] ?: true,
            memory = p[Keys.chatMemory] ?: true,
            thinking = ThinkingLevel.from(p[Keys.chatThinking]),
        ),
        codeDefaults = CodeDefaults(
            agent = p[Keys.codeAgent],
            model = p[Keys.codeModel],
            device = place(p).first,
            cwd = p[Keys.codeCwd],
            cwdDevice = place(p).second,
            permissionMode = PermissionMode.entries.firstOrNull { it.wire == p[Keys.codePermission] } ?: PermissionMode.DEFAULT,
            ultra = p[Keys.codeUltra] ?: false,
            repo = p[Keys.codeRepo],
            base = p[Keys.codeBase],
            thinking = ThinkingLevel.from(p[Keys.codeThinking]),
            assistantModel = p[Keys.assistantModel],
        ),
        inboxClearedAt = p[Keys.inboxClearedAt] ?: 0L,
        mapStreams = p[Keys.mapStreams] ?: "full",
        startMode = p[Keys.startMode],
        drawerGroup = GroupBy.from(p[Keys.drawerGroup]),
        updateSkipped = p[Keys.updateSkipped],
        updateAtStartup = p[Keys.updateAtStartup] ?: true,
        switchBrief = p[Keys.switchBrief] ?: false,
    )

    /** Null until the first read finishes. */
    val state: StateFlow<AppSettings?> = store.data.map { read(it) }.stateIn(scope, SharingStarted.Eagerly, null)

    suspend fun current(): AppSettings = read(store.data.first())

    private suspend fun edit(block: (MutablePreferences) -> Unit) {
        store.edit { block(it) }
    }

    suspend fun setPairing(url: String, addresses: List<String>, hubName: String?, clientId: String?, allowCleartextHost: String?) = edit { p ->
        p[Keys.hubUrl] = url
        p[Keys.hubAddresses] = addresses.joinToString("\n")
        if (hubName != null) p[Keys.hubName] = hubName else p.remove(Keys.hubName)
        if (clientId != null) p[Keys.clientId] = clientId else p.remove(Keys.clientId)
        if (allowCleartextHost != null) {
            p[Keys.cleartextHosts] = (p[Keys.cleartextHosts] ?: emptySet()) + allowCleartextHost
        }
    }

    suspend fun clearPairing() = edit { p ->
        p.remove(Keys.hubUrl)
        p.remove(Keys.hubAddresses)
        p.remove(Keys.hubName)
        p.remove(Keys.clientId)
        p.remove(Keys.cleartextHosts)
        p.remove(Keys.notifiedApprovals)
    }

    /** The address in use moved (a new tunnel, a fallback). */
    suspend fun setHubUrl(url: String) = edit { it[Keys.hubUrl] = url }

    /** The hub's latest list of addresses, best first. */
    suspend fun setHubAddresses(urls: List<String>) = edit { it[Keys.hubAddresses] = urls.joinToString("\n") }

    /** Forget what UnifiedPush and the old live connection switch left behind. */
    suspend fun dropRetired() = edit { p ->
        for (k in listOf("push_endpoint", "push_status")) p.remove(stringPreferencesKey(k))
        p.remove(booleanPreferencesKey("live_connection"))
    }

    suspend fun setTheme(mode: ThemeMode) = edit { it[Keys.theme] = mode.wire }
    suspend fun setTextSize(size: TextSize) = edit { it[Keys.textSize] = size.wire }
    suspend fun setBiometricLock(on: Boolean) = edit { it[Keys.biometricLock] = on }
    suspend fun setSecureScreen(on: Boolean) = edit { it[Keys.secureScreen] = on }
    suspend fun setNotifyDevice(on: Boolean) = edit { it[Keys.notifyDevice] = on }
    suspend fun setGrouping(g: SessionGrouping) = edit { it[Keys.grouping] = g.name }
    suspend fun setAskedNotificationPermission() = edit { it[Keys.askedNotifications] = true }
    suspend fun setInboxClearedAt(ts: Long) = edit { it[Keys.inboxClearedAt] = ts }
    suspend fun setMapStreams(mode: String) = edit { it[Keys.mapStreams] = mode }
    suspend fun setStartMode(wire: String) = edit { it[Keys.startMode] = wire }
    suspend fun setDrawerGroup(by: GroupBy) = edit { it[Keys.drawerGroup] = by.wire }
    suspend fun setUpdateSkipped(version: String) = edit { it[Keys.updateSkipped] = version }
    suspend fun setUpdateAtStartup(on: Boolean) = edit { it[Keys.updateAtStartup] = on }
    suspend fun setSwitchBrief(on: Boolean) = edit { it[Keys.switchBrief] = on }

    suspend fun setChatDefaults(d: ChatDefaults) = edit { p ->
        if (d.model != null) p[Keys.chatModel] = d.model else p.remove(Keys.chatModel)
        p[Keys.chatWeb] = d.webSearch
        p[Keys.chatMemory] = d.memory
        if (d.thinking != null) p[Keys.chatThinking] = d.thinking.wire else p.remove(Keys.chatThinking)
    }

    suspend fun setCodeDefaults(d: CodeDefaults) = edit { p ->
        if (d.agent != null) p[Keys.codeAgent] = d.agent else p.remove(Keys.codeAgent)
        if (d.model != null) p[Keys.codeModel] = d.model else p.remove(Keys.codeModel)
        if (d.device != null) p[Keys.codeDevice] = d.device else p.remove(Keys.codeDevice)
        if (d.cwd != null) p[Keys.codeCwd] = d.cwd else p.remove(Keys.codeCwd)
        if (d.cwdDevice != null) p[Keys.codeCwdDevice] = d.cwdDevice else p.remove(Keys.codeCwdDevice)
        p[Keys.codePicks] = Start.PICKS_VERSION.toString()
        p[Keys.codePermission] = d.permissionMode.wire
        p[Keys.codeUltra] = d.ultra
        if (d.repo != null) p[Keys.codeRepo] = d.repo else p.remove(Keys.codeRepo)
        if (d.base != null) p[Keys.codeBase] = d.base else p.remove(Keys.codeBase)
        if (d.thinking != null) p[Keys.codeThinking] = d.thinking.wire else p.remove(Keys.codeThinking)
        if (d.assistantModel != null) p[Keys.assistantModel] = d.assistantModel else p.remove(Keys.assistantModel)
    }

    suspend fun notifiedApprovals(): Set<String> = store.data.first()[Keys.notifiedApprovals] ?: emptySet()

    suspend fun setNotifiedApprovals(ids: Set<String>) = edit { it[Keys.notifiedApprovals] = ids }

    /** One approval got a notification: the periodic check does not show it again. */
    suspend fun addNotifiedApproval(id: String) = edit { p ->
        // keep the set small: the hub forgets resolved approvals, so old ids never come back
        p[Keys.notifiedApprovals] = ((p[Keys.notifiedApprovals] ?: emptySet()) + id).toList().takeLast(200).toSet()
    }
}
