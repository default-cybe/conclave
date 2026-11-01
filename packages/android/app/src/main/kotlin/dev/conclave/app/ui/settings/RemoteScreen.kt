@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package dev.conclave.app.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LiveStrip
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.RemoteWords
import dev.conclave.client.model.CloudflareZone
import dev.conclave.client.model.RemoteMode
import dev.conclave.client.model.RemoteState
import dev.conclave.client.model.RemoteStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Remote access on the hub: GET and PUT /api/remote and the stable tunnel setup. */
class RemoteViewModel(hub: HubRepository) : HubViewModel(hub) {
    /** Which action runs ("mode", "lan", "restart", "token", "setup", "remove", "find", "save"). */
    val busy = MutableStateFlow<String?>(null)
    val error = MutableStateFlow<String?>(null)
    val zones = MutableStateFlow<List<CloudflareZone>>(emptyList())

    /** A line under the Tailscale address after Find it. */
    val note = MutableStateFlow<String?>(null)

    fun refresh() = viewModelScope.launch {
        try {
            hub.remoteChanged(hub.api { it.remote() })
            error.value = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error.value = if (e is dev.conclave.client.ConclaveApiException && e.status == 404) {
                "This hub has no remote access settings yet. Update Conclave on the hub."
            } else {
                errorText(e)
            }
        }
    }

    private fun run(what: String, done: String? = null, block: suspend () -> RemoteStatus?) = viewModelScope.launch {
        busy.value = what
        try {
            block()?.let { hub.remoteChanged(it) }
            if (done != null) say(done)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        } finally {
            busy.value = null
        }
    }

    fun setMode(m: RemoteMode) {
        run("mode") { hub.api { it.setRemote(mode = m) } }
    }

    fun setOwn(m: RemoteMode, url: String) {
        run("save", "Saved.") { hub.api { it.setRemote(mode = m, url = url.trim()) } }
    }

    fun setLan(on: Boolean) {
        run("lan") { hub.api { it.setRemote(lan = on) } }
    }

    fun restart() {
        run("restart") { hub.api { it.restartRemote() } }
    }

    fun checkToken(token: String) {
        run("token") {
            zones.value = hub.api { it.cloudflareToken(token.trim()) }
            if (zones.value.isEmpty()) say("That token sees no domains. Give it Zone, DNS, Edit on the domain you want.")
            null
        }
    }

    fun loadZones() = viewModelScope.launch {
        try {
            zones.value = hub.api { it.cloudflareZones() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // no token saved yet: the form asks for one
        }
    }

    fun setupStable(zoneId: String, name: String) {
        run("setup") { hub.api { it.setupStableTunnel(zoneId, name.trim().ifBlank { null }) } }
    }

    fun removeStable() {
        run("remove") {
            val s = hub.api { it.removeStableTunnel() }
            s.warning?.let { say(it) }
            zones.value = emptyList()
            s
        }
    }

    fun findTailscale(onUrl: (String) -> Unit) = viewModelScope.launch {
        busy.value = "find"
        note.value = null
        try {
            val ts = hub.api { it.tailscaleInfo() }
            val url = ts.url
            note.value = when {
                url != null -> {
                    onUrl(url)
                    "Found ${ts.dnsName ?: url}. If it does not answer, run ${ts.command} on the hub."
                }
                ts.installed -> "Tailscale is not connected on the hub. Run sudo tailscale up there, then ${ts.command}."
                else -> "Tailscale is not installed on the hub. Install it there, or pick another option."
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note.value = errorText(e)
        } finally {
            busy.value = null
        }
    }
}

/**
 * Settings, Remote access: how phones reach the hub away from its network.
 * The same choices as the web (features/settings/remote.tsx): the quick
 * tunnel (built in), a stable address on your domain, Tailscale, your own
 * URL, or local only; then the same network switch and every address.
 */
@Composable
fun RemoteScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: RemoteViewModel = viewModel { RemoteViewModel(hub) }
    val status by hub.remote.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }

    Scaffold(
        topBar = {
            TopBar("Remote access", onBack = onBack)
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OfflineBanner(connection)
            val s = status
            when {
                s == null && error != null -> ErrorBanner(error!!, onRetry = { vm.refresh() })
                s == null -> LoadingBox()
                else -> RemoteBody(s, vm, busy)
            }
        }
    }
}

@Composable
private fun RemoteBody(s: RemoteStatus, vm: RemoteViewModel, busy: String?) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    val context = LocalContext.current
    val current = hub.currentUrl.orEmpty()
    // a change that would cut this phone off asks first
    var confirm by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
    // the row picked here; stable, tailscale and custom need more before the hub switches
    var picked by remember(s.mode) { mutableStateOf(s.mode) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
        Column(Modifier.widthIn(max = 720.dp)) {
            StatusLine(s, busy, onCopy = { copy(context, it) }, onRestart = vm::restart)

            SectionHeader("Reach the hub from anywhere")
            Text(
                "Pairing codes and notification links use the address this gives. This phone follows it when it changes.",
                style = ConclaveType.meta,
                color = c.fg3,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
            )
            RemoteWords.MODES.forEach { m ->
                ModeRow(
                    mode = m,
                    selected = picked == m,
                    enabled = busy == null,
                    onPick = {
                        picked = m
                        val direct = m == RemoteMode.QUICK || m == RemoteMode.OFF || (m == RemoteMode.STABLE && s.stable != null)
                        if (direct && m != s.mode) {
                            val go = { vm.setMode(m) }
                            if (RemoteWords.cutsOff(current, s, m)) {
                                confirm = "This phone reaches the hub through ${HubAddresses.host(current)} now. With Local only it connects only on the hub's network." to go
                            } else {
                                go()
                            }
                        }
                        if (m == RemoteMode.STABLE && s.stable == null) vm.loadZones()
                    },
                ) {
                    when {
                        picked != m -> Unit
                        m == RemoteMode.STABLE -> if (s.stable != null) StableDone(s, vm, busy) else StableSetup(vm, busy)
                        m == RemoteMode.TAILSCALE -> OwnUrl(s, m, vm, busy, "https://hub.tailnet.ts.net", find = true)
                        m == RemoteMode.CUSTOM -> OwnUrl(s, m, vm, busy, "https://hub.example.com", find = false)
                        else -> Unit
                    }
                }
            }

            SectionHeader("Same network")
            val fixed = s.lan.fixedHost != null
            Row(
                Modifier.fillMaxWidth().clickable(enabled = !fixed && busy == null) {
                    val on = !s.lan.on
                    if (!on && RemoteWords.lanOffCutsOff(current, s)) {
                        confirm = "This phone uses the hub's same network address now. Turning this off disconnects it unless an outside address works." to { vm.setLan(false) }
                    } else {
                        vm.setLan(on)
                    }
                }.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Devices on this network", style = ConclaveType.rowTitle, color = c.fg)
                    Text(RemoteWords.lanHelp(s), style = ConclaveType.meta, color = c.fg3)
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = s.lan.on,
                    enabled = !fixed && busy == null,
                    onCheckedChange = { on ->
                        if (!on && RemoteWords.lanOffCutsOff(current, s)) {
                            confirm = "This phone uses the hub's same network address now. Turning this off disconnects it unless an outside address works." to { vm.setLan(false) }
                        } else {
                            vm.setLan(on)
                        }
                    },
                )
            }

            SectionHeader("Addresses")
            if (s.addresses.isEmpty()) {
                Text(
                    "Only the hub's own computer reaches it. Turn on the quick tunnel, or devices on this network, to use this phone.",
                    style = ConclaveType.meta,
                    color = c.fg3,
                    modifier = Modifier.padding(16.dp),
                )
            } else {
                s.addresses.forEach { a ->
                    val inUse = HubAddresses.same(a.url, current)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(a.label.ifBlank { a.kind }, style = ConclaveType.rowTitle, color = c.fg)
                            Text(a.url, style = CodeStyle, color = c.fg2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (inUse) {
                            Spacer(Modifier.width(12.dp))
                            Text("this phone", style = ConclaveType.meta, color = c.ok)
                        }
                    }
                    HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 16.dp))
                }
                Text(
                    "This phone keeps every address and moves to the next when one stops answering.",
                    style = ConclaveType.meta,
                    color = c.fg3,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
                )
            }
        }
    }

    confirm?.let { (text, go) ->
        ConfirmDialog(
            title = "This phone may lose the hub",
            text = text,
            confirmLabel = "Change it",
            destructive = true,
            onConfirm = {
                confirm = null
                go()
            },
            onDismiss = { confirm = null },
        )
    }
}

/** "On. Phones and computers reach the hub at https://...", with Copy address and New address or Try again. */
@Composable
private fun StatusLine(s: RemoteStatus, busy: String?, onCopy: (String) -> Unit, onRestart: () -> Unit) {
    val c = Conclave.colors
    val line = RemoteWords.state(s)
    val tone = when (line.tone) {
        RemoteWords.Tone.OK -> c.ok
        RemoteWords.Tone.FAULT -> c.fault
        RemoteWords.Tone.LIVE -> c.signal
        RemoteWords.Tone.DIM -> c.fg3
    }
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = tone, fontWeight = FontWeight.Medium)) { append(line.word) }
                append(" ")
                append(line.rest)
            },
            style = ConclaveType.body,
            color = c.fg,
        )
        if (s.state == RemoteState.STARTING || s.state == RemoteState.INSTALLING) {
            Spacer(Modifier.height(8.dp))
            LiveStrip(word = if (s.state == RemoteState.INSTALLING) "Downloading" else "Waiting for Cloudflare", startedAt = s.since.takeIf { it > 0 })
        }
        val out = RemoteWords.outside(s)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            if (s.state == RemoteState.ON && out != null) {
                OutlinedButton(onClick = { onCopy(out.url) }, shape = RoundedCornerShape(5.dp)) { Text("Copy address") }
            }
            val tunnel = s.mode == RemoteMode.QUICK || s.mode == RemoteMode.STABLE
            if (tunnel && (s.state == RemoteState.ON || s.state == RemoteState.ERROR)) {
                TextButton(onClick = onRestart, enabled = busy == null, shape = RoundedCornerShape(5.dp)) {
                    Text(
                        when {
                            busy == "restart" -> "Asking the hub"
                            s.state == RemoteState.ERROR -> "Try again"
                            s.mode == RemoteMode.QUICK -> "New address"
                            else -> "Restart the tunnel"
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun ModeRow(mode: RemoteMode, selected: Boolean, enabled: Boolean, onPick: () -> Unit, extra: @Composable () -> Unit) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onPick).padding(start = 4.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Top,
        ) {
            RadioButton(selected = selected, onClick = onPick, enabled = enabled)
            Column(Modifier.weight(1f).padding(top = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(RemoteWords.label(mode), style = ConclaveType.rowTitle, color = c.fg)
                    if (mode == RemoteMode.QUICK) {
                        Spacer(Modifier.width(8.dp))
                        Text("suggested", style = ConclaveType.meta, color = c.fg3)
                    }
                }
                Text(RemoteWords.help(mode), style = ConclaveType.meta, color = c.fg3)
            }
        }
        Column(Modifier.padding(start = 52.dp, end = 16.dp)) { extra() }
    }
}

@Composable
private fun OwnUrl(s: RemoteStatus, mode: RemoteMode, vm: RemoteViewModel, busy: String?, placeholder: String, find: Boolean) {
    val c = Conclave.colors
    val own = s.addresses.firstOrNull { it.kind == "own" }?.url.orEmpty()
    var url by remember(own) { mutableStateOf(own) }
    val note by vm.note.collectAsStateWithLifecycle()
    Column(Modifier.padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text(if (mode == RemoteMode.TAILSCALE) "Tailscale address" else "Your address") },
            placeholder = { Text(placeholder) },
            singleLine = true,
            textStyle = CodeStyle,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        if (find && note != null) Text(note!!, style = ConclaveType.meta, color = c.fg3)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (find) {
                OutlinedButton(onClick = { vm.findTailscale { url = it } }, enabled = busy == null, shape = RoundedCornerShape(5.dp)) {
                    Text(if (busy == "find") "Looking" else "Find it")
                }
            }
            val dirty = url.trim() != own || s.mode != mode
            FilledTonalButton(onClick = { vm.setOwn(mode, url) }, enabled = busy == null && url.isNotBlank() && dirty, shape = RoundedCornerShape(5.dp)) {
                Text(if (busy == "save") "Saving" else "Use this address")
            }
        }
    }
}

@Composable
private fun StableSetup(vm: RemoteViewModel, busy: String?) {
    val c = Conclave.colors
    val zones by vm.zones.collectAsStateWithLifecycle()
    var token by remember { mutableStateOf("") }
    var zone by remember(zones) { mutableStateOf(zones.singleOrNull()?.id) }
    var name by remember { mutableStateOf("conclave") }
    Column(Modifier.padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (zones.isEmpty()) {
            Text(
                "Make an API token in Cloudflare with Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit. The hub keeps it in its secrets.",
                style = ConclaveType.meta,
                color = c.fg3,
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Cloudflare API token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            FilledTonalButton(onClick = { vm.checkToken(token) }, enabled = busy == null && token.isNotBlank(), shape = RoundedCornerShape(5.dp)) {
                Text(if (busy == "token") "Checking" else "Check the token")
            }
        } else {
            Text("Domain", style = ConclaveType.meta, color = c.fg3)
            zones.forEach { z ->
                Row(Modifier.fillMaxWidth().clickable { zone = z.id }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = zone == z.id, onClick = { zone = z.id })
                    Text(z.name, style = ConclaveType.body, color = c.fg, modifier = Modifier.weight(1f))
                    z.accountName?.let { Text(it, style = ConclaveType.meta, color = c.fg3) }
                }
            }
            val zoneName = zones.firstOrNull { it.id == zone }?.name
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.lowercase().trim() },
                label = { Text("Name in front of the domain") },
                suffix = { if (zoneName != null) Text(".$zoneName", style = CodeStyle, color = c.fg3) },
                singleLine = true,
                textStyle = CodeStyle,
                modifier = Modifier.fillMaxWidth(),
            )
            FilledTonalButton(onClick = { zone?.let { vm.setupStable(it, name) } }, enabled = busy == null && zone != null && name.isNotBlank(), shape = RoundedCornerShape(5.dp)) {
                Text(if (busy == "setup") "Setting up" else "Set up the address")
            }
            Text("Makes a tunnel and a DNS name on that domain. Nothing else changes.", style = ConclaveType.meta, color = c.fg3)
        }
    }
}

@Composable
private fun StableDone(s: RemoteStatus, vm: RemoteViewModel, busy: String?) {
    val c = Conclave.colors
    var removing by remember { mutableStateOf(false) }
    val st = s.stable ?: return
    Column(Modifier.padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("https://${st.hostname}", style = CodeStyle, color = c.fg)
        Text("On ${st.zone}, through your Cloudflare account.", style = ConclaveType.meta, color = c.fg3)
        OutlinedButton(onClick = { removing = true }, enabled = busy == null, shape = RoundedCornerShape(5.dp)) {
            Text(if (busy == "remove") "Removing" else "Remove", color = c.fault)
        }
    }
    if (removing) {
        ConfirmDialog(
            title = "Remove the stable address?",
            text = "The hub deletes the tunnel and the DNS name at Cloudflare and forgets the token. Remote access turns off; paired apps can still use the same network.",
            confirmLabel = "Remove",
            destructive = true,
            onConfirm = {
                removing = false
                vm.removeStable()
            },
            onDismiss = { removing = false },
        )
    }
}

private fun copy(context: Context, text: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Hub address", text))
}
