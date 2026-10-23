@file:OptIn(ExperimentalLayoutApi::class)

package dev.conclave.app.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.identifyFolder
import dev.conclave.client.logic.BannerAction
import dev.conclave.client.logic.Locations
import dev.conclave.client.logic.MoveOutcome
import dev.conclave.client.model.CloneInput
import dev.conclave.client.model.Device
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.FileEntry
import dev.conclave.client.model.IdentifyResult
import dev.conclave.client.model.MoveInput
import dev.conclave.client.model.MoveResult
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionLocation
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.moveSession
import dev.conclave.client.sessionLocation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * What the Choose folder sheet is for: the device to browse, the move that
 * found nothing (its candidates, a remote to clone, where to start), and
 * whether the owner picks a folder to use or a folder to clone into.
 */
data class ChooserRequest(
    val device: String,
    val result: MoveResult? = null,
    val start: String? = null,
    val clone: Boolean = false,
    val projectName: String? = null,
)

/** States the owner set aside (Wait, Continue, Hide), kept while the app runs so they hold when the session opens again. */
object HiddenLocations {
    val keys = MutableStateFlow<Set<String>>(emptySet())

    fun hide(key: String) = keys.update { (it + key).toList().takeLast(100).toSet() }
}

/**
 * Folders across devices for one session (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 2.4 to 2.6 and 2.13): the session's location for the banner, moving to a
 * device, and the Choose folder sheet's browsing and match check.
 */
class LocationViewModel(hub: HubRepository, val sessionId: String) : HubViewModel(hub) {
    val location = MutableStateFlow<SessionLocation?>(null)

    /** Which action is running ("Moving", "Looking", "Cloning"), for its button. */
    val busy = MutableStateFlow<String?>(null)

    /** The Choose folder sheet, when something asked for it. */
    val chooser = MutableStateFlow<ChooserRequest?>(null)

    private var loading: Job? = null

    init {
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.SessionMoved -> if (e.sessionId == sessionId) load()
                    is EngineEvent.ProjectUpdated -> if (e.project.id == location.value?.projectId) load()
                    is EngineEvent.ConfigUpdated -> load()
                    else -> Unit
                }
            }
        }
    }

    /** Ask the hub what the banner should say. [refresh] reads the device again (Check again). */
    fun load(refresh: Boolean = false) {
        loading?.cancel()
        loading = viewModelScope.launch {
            try {
                location.value = hub.api { it.sessionLocation(sessionId, refresh) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // an older hub has no location route: the banner just stays away
                location.value = null
            }
        }
    }

    fun hide(loc: SessionLocation) = HiddenLocations.hide(Locations.hiddenKey(loc))

    /**
     * Move the session. Moved: the session updates and the sheet closes.
     * Offline: say so. Nothing found: open Choose folder with what the hub
     * found. Returns the answer so the sheet can show a mismatch in place.
     */
    suspend fun move(input: MoveInput, label: String = "Moving"): MoveResult? {
        busy.value = label
        try {
            val r = hub.api { it.moveSession(sessionId, input) }
            when (Locations.outcome(r)) {
                MoveOutcome.MOVED -> {
                    r.session?.let { hub.putSession(it) }
                    val stale = r.freshness?.takeIf { it.stale }?.line
                    say(listOfNotNull(r.line.ifBlank { null }, stale).joinToString(" ").ifBlank { "Moved." })
                    chooser.value = null
                    load()
                }
                MoveOutcome.OFFLINE -> say(listOf(r.line.ifBlank { null }, "Moving needs the device online, to find the folder there.").filterNotNull().joinToString(" "))
                MoveOutcome.CHOOSE -> chooser.value = ChooserRequest(device = input.device, result = r)
                // the sheet shows the line next to Use once and Use and remember
                MoveOutcome.MISMATCH -> Unit
            }
            return r
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
            return null
        } finally {
            busy.value = null
        }
    }

    fun moveTo(device: String, input: MoveInput = MoveInput(device), label: String = "Moving") {
        viewModelScope.launch { move(input.copy(device = device), label) }
    }

    fun openChooser(loc: SessionLocation?, device: String, clone: Boolean = false) {
        chooser.value = ChooserRequest(
            device = device,
            result = loc?.let { l -> l.cloneUrl?.let { url -> MoveResult(resolved = false, line = l.line.orEmpty(), cloneUrl = url, browseFrom = l.browseFrom) } },
            start = loc?.browseFrom,
            clone = clone,
            projectName = loc?.projectName,
        )
    }

    fun closeChooser() {
        chooser.value = null
    }

    /** The folders in [path] on [device], folders and links only, by name. */
    suspend fun browse(device: String, path: String): List<FileEntry> =
        hub.api { it.browse(device, path) }.filter { it.type == "dir" || it.type == "symlink" }.sortedBy { it.name.lowercase() }.take(400)

    suspend fun identify(device: String, path: String): IdentifyResult = hub.api { it.identifyFolder(device, path, sessionId = sessionId) }

    suspend fun clone(device: String, url: String, into: String): MoveResult? =
        move(MoveInput(device = device, clone = CloneInput(url = url, into = into)), "Cloning")
}

/**
 * The location banner: one line above the composer, only when the
 * session's folder needs the owner (offline device, missing folder, a copy
 * that is behind, another history), with its actions. The main action comes
 * first and the buttons wrap on a narrow phone.
 */
@Composable
fun LocationBanner(
    session: Session,
    vm: LocationViewModel,
    devices: List<Device>,
    onPickDevice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val loc by vm.location.collectAsStateWithLifecycle()
    val hidden by HiddenLocations.keys.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    // chats have no folder, and a subagent runs where its parent runs (the parent moves, not it)
    if (session.isChat || session.parentId != null) return
    val online = devices.firstOrNull { it.id == session.device }?.online
    // what the hub says changes with the device, the folder, the device coming and going, and a turn parked for its device
    val parked = session.status == SessionStatus.WAITING_INPUT
    LaunchedEffect(session.id, session.device, session.cwd, online, parked) { vm.load() }

    val l = loc
    if (l == null || !Locations.shows(l, session.id, hidden)) return
    val c = Conclave.colors
    val others = Locations.moveTargets(devices, session.device).size
    val actions = Locations.bannerActions(l, others)
    // the button the owner pressed says "Moving" while the move runs, not every button that moves
    var pressed by remember { mutableStateOf<BannerAction?>(null) }
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Text(
            Locations.bannerLine(l),
            style = ConclaveType.body,
            color = c.fg,
            modifier = Modifier.padding(top = 10.dp, bottom = 6.dp),
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.padding(bottom = 8.dp),
        ) {
            actions.forEachIndexed { i, a ->
                val label = Locations.actionLabel(a, l)
                val running = busy != null
                val onClick: () -> Unit = {
                    pressed = a
                    when (a) {
                        BannerAction.RUN_ON_SUGGESTION -> l.suggestion?.let { vm.moveTo(it.device) }
                        BannerAction.RUN_ON_OTHER -> onPickDevice()
                        BannerAction.WAIT, BannerAction.CONTINUE, BannerAction.HIDE -> vm.hide(l)
                        BannerAction.CHOOSE_FOLDER -> vm.openChooser(l, session.device)
                        BannerAction.CLONE_HERE -> vm.openChooser(l, session.device, clone = true)
                        BannerAction.CONTINUE_WITHOUT_FILES -> vm.moveTo(session.device, MoveInput(session.device, withoutFiles = true))
                        BannerAction.LOOK_AGAIN -> vm.moveTo(session.device, label = "Looking")
                        BannerAction.CHECK_AGAIN -> vm.load(refresh = true)
                    }
                }
                val text = if (running && pressed == a) busy ?: label else label
                when {
                    i == 0 -> Button(onClick = onClick, enabled = !running, modifier = Modifier.heightIn(min = 40.dp)) { Text(text, maxLines = 1) }
                    a.hides -> TextButton(onClick = onClick) { Text(text, maxLines = 1) }
                    else -> OutlinedButton(onClick = onClick, enabled = !running, modifier = Modifier.heightIn(min = 40.dp)) { Text(text, maxLines = 1) }
                }
            }
        }
    }
}

/** Pick a computer to run the session on: online, not a phone, not the one it is on. */
@Composable
fun MoveToDeviceDialog(session: Session, devices: List<Device>, onPick: (Device) -> Unit, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val targets = Locations.moveTargets(devices, session.device)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Run on another device") },
        text = {
            if (targets.isEmpty()) {
                Text("No other computer is online. Start the Conclave daemon on one, then try again.", style = ConclaveType.body, color = c.fg2)
            } else {
                Column {
                    Text(
                        "Conclave looks for this session's folder there: the same path, a pinned folder, Syncthing, a learned path pair, then a search.",
                        style = ConclaveType.meta,
                        color = c.fg3,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                    LazyColumn(Modifier.heightIn(max = 320.dp)) {
                        items(targets, key = { it.id }) { d ->
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { onPick(d) }.padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(d.name.ifBlank { if (d.id == "local") "The hub" else d.id }, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    val sub = listOfNotNull(d.info?.hostname?.ifBlank { null }, d.info?.platform?.ifBlank { null }).joinToString(", ")
                                    if (sub.isNotEmpty()) Text(sub, style = ConclaveType.meta, color = c.fg3, maxLines = 1)
                                }
                                Text("online", style = ConclaveType.meta, color = c.ok)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
