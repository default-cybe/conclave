@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.AuthState
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.clockTime
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.friends.InviteQr
import dev.conclave.app.ui.friends.copyText
import dev.conclave.app.ui.motion.KnotRope
import dev.conclave.app.ui.motion.LiveState
import dev.conclave.app.ui.motion.LiveStatus
import dev.conclave.app.ui.motion.RollDirection
import dev.conclave.app.ui.motion.RollText
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.HubKeys
import dev.conclave.client.logic.JustPaired
import dev.conclave.client.logic.PairKind
import dev.conclave.client.logic.PairWatch
import dev.conclave.client.logic.PairingWords
import dev.conclave.client.model.AppDto
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.PairingInfo
import dev.conclave.client.motion.Roll
import dev.conclave.client.motion.RopeMoment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Devices, Pair a device (the web's PairDialog and PairingPanel): a code
 * for an app or for a computer's command line, with its QR code, the hub's
 * fingerprint, the time left, and for a computer what to run there. The
 * code is the signed in person's, owner or member, so what pairs is theirs.
 * The new computer shows in hub.devices; a new app comes as app.updated.
 */
class PairViewModel(hub: HubRepository) : HubViewModel(hub) {
    val kind = MutableStateFlow(PairKind.APP)
    val info = MutableStateFlow<PairingInfo?>(null)
    val error = MutableStateFlow<String?>(null)
    val paired = MutableStateFlow<JustPaired?>(null)
    private val apps = MutableStateFlow<List<AppDto>>(emptyList())
    private var watch: PairWatch? = null
    private var making: Job? = null

    init {
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.AppUpdated -> {
                        apps.update { PairingWords.withApp(it, e.app) }
                        spot()
                    }
                    // after a resync an app.updated may be missed: read the apps again
                    is EngineEvent.ConfigUpdated -> if (watch?.kind == PairKind.APP && paired.value == null) {
                        launch {
                            readApps()
                            spot()
                        }
                    }
                    else -> Unit
                }
            }
        }
        viewModelScope.launch { hub.devices.collect { spot() } }
    }

    /** A new code of [k]. What is there first, so the one that pairs with it stands out. */
    fun make(k: PairKind = kind.value) {
        clear()
        kind.value = k
        making = viewModelScope.launch {
            try {
                val seen = if (k == PairKind.APP) readApps() else null
                val w = PairWatch.start(k, hub.devices.value, seen)
                val made = hub.api { it.createPairing(k.wire) }
                watch = w
                info.value = made
                spot()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = errorText(e)
            }
        }
    }

    /** The sheet opened: a code, unless one is shown or on its way (after a rotation). */
    fun open() {
        if (making?.isActive == true || info.value != null || error.value != null || paired.value != null) return
        make()
    }

    /** The sheet closed: the code is let go (it runs out by itself). */
    fun clear() {
        making?.cancel()
        making = null
        watch = null
        info.value = null
        error.value = null
        paired.value = null
    }

    /** The account's apps, or null when they cannot be read. */
    private suspend fun readApps(): List<AppDto>? = try {
        hub.api { it.apps() }.also { apps.value = it }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private fun spot() {
        val w = watch ?: return
        if (paired.value != null) return
        paired.value = w.paired(hub.devices.value, apps.value)
    }
}

/** A sheet: what to pair, then the code, or what paired. */
@Composable
fun PairSheet(vm: PairViewModel, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val hub = LocalAppContainer.current.hub
    val kind by vm.kind.collectAsStateWithLifecycle()
    val info by vm.info.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val paired by vm.paired.collectAsStateWithLifecycle()
    val auth by hub.auth.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.open() }
    val close = {
        vm.clear()
        onDismiss()
    }
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = close, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text("Pair a device", style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("What to pair", style = ConclaveType.meta, color = c.fg3)
                    Segmented(kind, PairKind.entries.map { it to it.label }, onChange = { if (it != kind) vm.make(it) }, modifier = Modifier.fillMaxWidth())
                }
                Text(PairingWords.help(kind), style = ConclaveType.body, color = c.fg2)
                val p = paired
                val i = info
                val e = error
                when {
                    e != null -> {
                        Text("Could not make a pairing code. $e", style = ConclaveType.body, color = c.fault)
                        OutlinedButton(onClick = { vm.make() }, colors = outlineButtonColors(), border = outlineButtonBorder(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
                    }
                    p != null -> PairedPart(p, kind)
                    i == null -> LiveStatus(LiveState.TOOL, label = "Making a code")
                    else -> CodePart(i, kind, (auth as? AuthState.Paired)?.url, onNew = { vm.make() })
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), horizontalArrangement = Arrangement.End) {
                if (paired != null) {
                    Button(onClick = close, colors = solidButtonColors(), modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") }
                } else {
                    TextButton(onClick = close, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel", color = c.fg2) }
                }
            }
        }
    }
}

/** The code: QR, the code with Copy, the time left, the fingerprint, the commands for a computer, and the wait. */
@Composable
private fun CodePart(info: PairingInfo, kind: PairKind, appUrl: String?, onNew: () -> Unit) {
    val c = Conclave.colors
    val context = LocalContext.current
    val now by rememberNow(1_000)
    val expired = PairingWords.expired(info, now)
    // which Copy was pressed, for "Copied" a moment
    var copied by remember(info.code) { mutableStateOf<String?>(null) }
    LaunchedEffect(copied) {
        if (copied != null) {
            delay(1_600)
            copied = null
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!expired) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                InviteQr(info.qrSvg, label = "QR code for pairing code ${info.code}", fallback = "The QR code did not draw. Type the code instead.")
            }
        }
        Column {
            Text("Pairing code", style = ConclaveType.meta, color = c.fg3)
            Row(verticalAlignment = Alignment.CenterVertically) {
                SelectionContainer(Modifier.weight(1f)) {
                    Text(
                        info.code,
                        style = CodeStyle.copy(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.04.em),
                        color = if (expired) c.fg3 else c.fg,
                    )
                }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(
                    onClick = {
                        copyText(context, info.code, "Pairing code")
                        copied = "code"
                    },
                    enabled = !expired,
                    colors = outlineButtonColors(),
                    border = outlineButtonBorder(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (copied == "code") "Copied" else "Copy") }
            }
            if (expired) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Expired.", style = ConclaveType.meta, color = c.fault)
                    TextButton(onClick = onNew, modifier = Modifier.heightIn(min = 48.dp)) { Text("Make a new code", color = c.fg) }
                }
            } else {
                // the seconds roll; a screen reader hears when it ends instead
                val until = clockTime(info.expiresAt)
                Row(
                    Modifier.padding(top = 2.dp).clearAndSetSemantics { contentDescription = "Works until $until" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Expires in ", style = ConclaveType.meta, color = c.fg3)
                    RollText(PairingWords.clock(info, now), ConclaveType.metaNum, c.fg3, direction = RollDirection.DOWN, duration = Roll.CLOCK_MS)
                }
            }
        }
        val fp = info.fingerprint?.takeIf { it.isNotBlank() }
        if (fp != null && !expired) {
            Column {
                Text("Hub fingerprint", style = ConclaveType.meta, color = c.fg3)
                Text(HubKeys.groups(fp), style = CodeStyle.copy(fontSize = 15.sp, lineHeight = 22.sp), color = c.fg, modifier = Modifier.padding(top = 2.dp))
            }
        }
        if (kind == PairKind.COMPUTER && !expired) {
            val commands = PairingWords.commands(info, appUrl).joinToString("\n")
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Run this on the computer. The last line starts it at login.", style = ConclaveType.meta, color = c.fg3)
                CodeBox(commands)
                OutlinedButton(
                    onClick = {
                        copyText(context, commands, "Pairing commands")
                        copied = "commands"
                    },
                    colors = outlineButtonColors(),
                    border = outlineButtonBorder(),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (copied == "commands") "Copied" else "Copy commands") }
            }
        }
        if (!expired) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                KnotRope(RopeMoment.RUN, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                LiveStatus(LiveState.TOOL, label = PairingWords.waiting(kind), startedAt = info.expiresAt - 10 * 60_000, mark = false)
            }
        }
    }
}

/** "Paired Pixel 8." with the knot tied, and where it shows now. */
@Composable
private fun PairedPart(p: JustPaired, kind: PairKind) {
    val c = Conclave.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            KnotRope(RopeMoment.SUCCESS, size = 20.dp, label = "Paired")
            Spacer(Modifier.width(8.dp))
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = c.ok)) { append("Paired") }
                    append(" ${p.name}.")
                },
                style = ConclaveType.body.copy(fontSize = 16.sp),
                color = c.fg,
            )
        }
        Text(PairingWords.pairedNote(kind), style = ConclaveType.meta, color = c.fg3)
    }
}
