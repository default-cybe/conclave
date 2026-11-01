package dev.conclave.app.ui.map

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.rememberClock
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.ConnectionState
import dev.conclave.client.logic.Format
import dev.conclave.client.map.Insets
import dev.conclave.client.map.LayoutOptions
import dev.conclave.client.map.MapLayouts
import dev.conclave.client.map.MapOpen
import dev.conclave.client.map.MapWords
import dev.conclave.client.map.Sides
import dev.conclave.client.map.StreamMode
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import dev.conclave.client.model.MapTool
import kotlinx.coroutines.Job
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The Map (docs/DESIGN.md 29): a live view of everything the hub does. The
 * hub's knot in the middle, devices and projects branching off it, every
 * chat, session, subagent and workflow agent of the last day a node, and
 * streams of light along the links while they work. One sentence over it
 * counts what runs and waits; under it Fit, the streams switch and the
 * scrubber back through the day. A tap opens a node's details from the
 * bottom with Open chat and Stop. It opens on the hub and its busiest
 * project, where labels read; Fit shows it all.
 */
@Composable
fun MapScreen(
    onBack: () -> Unit,
    onOpenChat: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenRun: (String) -> Unit,
) {
    val container = LocalAppContainer.current
    val hub = container.hub
    val vm: MapViewModel = viewModel { MapViewModel(hub, container.settings) }
    val live by vm.live.collectAsStateWithLifecycle()
    val past by vm.past.collectAsStateWithLifecycle()
    val replay by vm.replay.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    val c = Conclave.colors
    val reduced = reducedMotion()
    val online = connection != ConnectionState.CLOSED
    val snap = if (replay != null) past ?: live else live
    val mode = if (reduced) StreamMode.LINES else StreamMode.of(settings?.mapStreams)
    val clock = rememberClock()
    val now by rememberNow(30_000)

    var selected by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableStateOf(MapViewRequest(0, null, false)) }
    var topH by remember { mutableStateOf(0) }
    var bottomH by remember { mutableStateOf(0) }
    var drawerH by remember { mutableStateOf(0) }
    val density = LocalDensity.current

    // a node that left the map closes its details
    val node = selected?.let { id -> snap?.nodes?.firstOrNull { it.id == id } }
    LaunchedEffect(node == null, snap) { if (selected != null && snap != null && node == null) selected = null }
    BackHandler(enabled = node != null) { selected = null }

    Scaffold(
        topBar = { TopBar("Map", onBack = onBack) },
        snackbarHost = { ToastHost(snackbar) },
        containerColor = c.bg,
    ) { padding ->
        BoxWithConstraints(Modifier.padding(padding).fillMaxSize()) {
            val wide = maxWidth >= 600.dp
            val measurer = rememberTextMeasurer(cacheSize = 256)
            val measure = rememberMapMeasure(measurer)
            val top = with(density) { topH.toDp().value.toDouble() } + 8
            val bottom = with(density) { bottomH.toDp().value.toDouble() } + 8
            val drawer = with(density) { drawerH.toDp().value.toDouble() }
            val insets = Insets(top = top, right = 12.0, bottom = if (node != null) max(bottom, drawer + 16) else bottom, left = 12.0)
            // the drawer does not reshape the map: the shape is the room without it
            val roomW = maxWidth.value - 24
            val roomH = (maxHeight.value - top - bottom).coerceAtLeast(120.0).toFloat()
            val aspect = ((roomW / roomH) * 10).roundToInt() / 10.0
            val now30 = now
            val key = snap?.let { MapLayouts.structureKey(it, now30) }
            val layout = remember(key, measure, wide, aspect) {
                snap?.let { MapLayouts.layout(it, LayoutOptions(measure = measure, sides = if (wide) Sides.BOTH else Sides.RIGHT, compact = !wide, aspect = aspect, now = now30)) }
            }
            // a phone opens on the hub and its busiest project where the labels read; taken when the layout changes
            val focus = remember(layout, wide) { if (!wide && layout != null && snap != null) MapLayouts.focusBox(layout, snap.nodes) else null }

            if (snap != null && layout != null) {
                MapCanvas(
                    snap = snap,
                    layout = layout,
                    mode = mode,
                    selected = selected,
                    onSelect = { selected = it },
                    insets = insets,
                    online = online,
                    replay = replay != null,
                    focus = focus,
                    request = request,
                    now = if (replay != null) snap.at else now,
                    measurer = measurer,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    when {
                        error != null -> {
                            Text("The map did not load: $error", style = ConclaveType.body, color = c.fg2)
                            Spacer(Modifier.height(12.dp))
                            OutlinedButton(onClick = vm::load, colors = outlineButtonColors(), border = outlineButtonBorder()) { Text("Try again") }
                        }
                        loading -> Text("Loading the map", style = ConclaveType.body, color = c.fg3)
                    }
                }
            }

            // the sentence: a band like the top bar, so the map passes under it instead of through it
            if (snap != null) {
                Box(Modifier.fillMaxWidth().background(c.bg).onSizeChanged { topH = it.height }.padding(horizontal = 20.dp, vertical = 6.dp)) {
                    Sentence(snap, replay, online, clock)
                }
            }

            // streams, Fit and the scrubber
            if (snap != null) {
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .background(c.bg)
                        .onSizeChanged { bottomH = it.height }
                        .navigationBarsPadding()
                        .padding(start = 20.dp, end = 12.dp, bottom = 8.dp),
                ) {
                    Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (reduced) {
                            Text("Streams: Lines, as animations are off", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
                        } else {
                            Segmented(
                                value = mode,
                                options = StreamMode.entries.map { it to it.label },
                                onChange = vm::setStreams,
                                modifier = Modifier.width(216.dp),
                            )
                            Spacer(Modifier.weight(1f))
                        }
                        OutlinedButton(
                            onClick = { request = MapViewRequest(request.n + 1, null, true) },
                            colors = outlineButtonColors(),
                            border = outlineButtonBorder(),
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text("Fit") }
                    }
                    val fallbackFrom = remember { System.currentTimeMillis() - 86_400_000 }
                    Scrubber(from = snap.from.takeIf { it > 0 } ?: fallbackFrom, at = replay, onChange = vm::setReplay, clock = clock)
                }
            }

            // a node's details from the bottom: the map stays in sight above
            AnimatedVisibility(
                visible = node != null && snap != null,
                enter = fadeIn(tween(if (reduced) 0 else 180)),
                exit = fadeOut(tween(if (reduced) 0 else 120)),
                modifier = Modifier.align(Alignment.BottomCenter),
            ) {
                val n = node
                val s = snap
                if (n != null && s != null) {
                    NodeDrawer(
                        node = n,
                        snap = s,
                        replay = replay != null,
                        clock = clock,
                        onSelect = { selected = it },
                        onClose = { selected = null },
                        onOpen = { open ->
                            when (open) {
                                is MapOpen.Chat -> onOpenChat(open.id)
                                is MapOpen.Session -> onOpenSession(open.id)
                                is MapOpen.Run -> onOpenRun(open.runId)
                            }
                        },
                        onStop = { vm.stop(n) },
                        modifier = Modifier.fillMaxWidth().heightIn(max = maxHeight * 0.66f).onSizeChanged { drawerH = it.height },
                    )
                }
            }
        }
    }
}

/** "Six running, one waiting on you. 3.4M tokens and $8.12 today." */
@Composable
private fun Sentence(snap: MapSnapshot, replay: Long?, online: Boolean, clock: (Long) -> String) {
    val c = Conclave.colors
    val s = MapWords.sentence(snap, replay, online, clock)
    val text = buildAnnotatedString {
        s.lead?.let { withStyle(SpanStyle(color = c.fg)) { append(it) } }
        if (s.nothing) append("Nothing running")
        s.running?.let { withStyle(SpanStyle(color = c.signal)) { append(it) } }
        if (s.running != null && s.waiting != null) append(", ")
        s.waiting?.let { withStyle(SpanStyle(color = c.warn)) { append(it) } }
        append(s.tail)
    }
    Text(text, style = ConclaveType.body.copy(fontSize = 14.sp, lineHeight = 19.6.sp), color = c.fg2, modifier = Modifier.semantics { contentDescription = MapWords.sentenceText(s) })
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * A line over the last 24 hours with a handle: drag it or tap the line to
 * see the hub at an earlier time; Back to live comes back. Near the right
 * end is live.
 */
@Composable
private fun Scrubber(from: Long, at: Long?, onChange: (Long?) -> Unit, clock: (Long) -> String) {
    val c = Conclave.colors
    val nowTick by rememberNow(60_000)
    val now = max(nowTick, System.currentTimeMillis())
    var drag by remember { mutableStateOf<Long?>(null) }
    var width by remember { mutableStateOf(1) }
    val live = at == null && drag == null
    val shown = drag ?: at ?: now
    val span = max(1L, now - from)
    val pct = ((shown - from).toFloat() / span).coerceIn(0f, 1f)
    val ticks = remember(from, now / 3_600_000) { MapWords.replayTicks(from, now, 6) }
    fun timeAt(x: Float): Long = from + ((x / max(1, width)).coerceIn(0f, 1f) * span).toLong()
    fun settle(t: Long): Long? = if (now - t < span * 0.01) null else t
    // the gestures stay alive across recompositions (span changes with the clock); they read the latest functions
    val timeAtNow by rememberUpdatedState(::timeAt)
    val settleNow by rememberUpdatedState(::settle)
    val onChangeNow by rememberUpdatedState(onChange)

    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .weight(1f)
                .height(52.dp)
                .onSizeChanged { width = it.width }
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { p -> onChangeNow(settleNow(timeAtNow(p.x))) })
                }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragStart = { p -> drag = timeAtNow(p.x) },
                        onDragEnd = {
                            drag?.let { onChangeNow(settleNow(it)) }
                            drag = null
                        },
                        onDragCancel = { drag = null },
                        onHorizontalDrag = { change, _ -> drag = timeAtNow(change.position.x) },
                    )
                }
                .semantics { contentDescription = if (live) "Replay the last 24 hours, live" else "Replay the last 24 hours, ${MapWords.clockWords(shown, now, clock)}" },
        ) {
            val d = LocalDensity.current.density
            Canvas(Modifier.fillMaxSize()) {
                val y = 26 * d
                // the day, as a hairline with an hour tick every few hours
                drawLine(c.rule2, Offset(0f, y), Offset(size.width, y), strokeWidth = d)
                for (t in ticks) {
                    val x = (t - from).toFloat() / span * size.width
                    drawLine(c.rule2, Offset(x, y - 4 * d), Offset(x, y + 5 * d), strokeWidth = d)
                }
                // what has been shown: the part of the day before the handle
                if (!live) drawLine(c.fg3, Offset(0f, y), Offset(pct * size.width, y), strokeWidth = 2 * d)
                val hx = pct * size.width
                drawRoundRect(if (live) c.signal else c.fg, Offset(hx - 1.5f * d, y - 9.5f * d), Size(3 * d, 19 * d), CornerRadius(1.5f * d))
            }
            // the hours under the ticks
            for (t in ticks) {
                val x = ((t - from).toFloat() / span * width).roundToInt()
                Text(
                    clock(t),
                    style = ConclaveType.micro.copy(fontFeatureSettings = "tnum"),
                    color = c.fg3,
                    modifier = Modifier.offset { IntOffset(x - 14.dp.roundToPx(), 34.dp.roundToPx()) },
                )
            }
            if (!live) {
                val x = (pct * width).roundToInt()
                Text(
                    MapWords.clockWords(shown, now, clock),
                    style = ConclaveType.meta.copy(fontSize = 12.sp, fontFeatureSettings = "tnum"),
                    color = c.fg,
                    maxLines = 1,
                    modifier = Modifier
                        .offset { IntOffset((x - 20.dp.roundToPx()).coerceIn(0, max(0, width - 64.dp.roundToPx())), 0) }
                        .background(c.bg, RoundedCornerShape(3.dp))
                        .padding(horizontal = 4.dp),
                )
            }
        }
        // one width for both words, so the line never moves under a finger
        Box(Modifier.width(112.dp), contentAlignment = Alignment.CenterEnd) {
            if (live) {
                Text("Live", style = ConclaveType.button, color = c.signal, modifier = Modifier.padding(horizontal = 12.dp))
            } else {
                TextButton(onClick = { onChange(null) }) { Text("Back to live", style = ConclaveType.button, color = c.fg, maxLines = 1) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// A node's details
// ---------------------------------------------------------------------------

/**
 * A node's details from the bottom: its kind (and what it hangs off), its
 * title, state and how long, what runs now, where it runs, its last tools,
 * usage, subagents, and Open chat and Stop.
 */
@Composable
private fun NodeDrawer(
    node: MapNode,
    snap: MapSnapshot,
    replay: Boolean,
    clock: (Long) -> String,
    onSelect: (String) -> Unit,
    onClose: () -> Unit,
    onOpen: (MapOpen) -> Unit,
    onStop: () -> Job,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    val tickNow by rememberNow(1_000)
    val at = if (replay) snap.at else tickNow
    val n = node
    val parent = n.parentId?.let { p -> snap.nodes.firstOrNull { it.id == p } }
    val kids = MapWords.childrenOf(snap.nodes, n.id)
    val device = snap.devices.firstOrNull { it.id == n.device }
    val stuck = MapWords.stuckWords(n, at)
    val shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
    var stopping by remember(n.id) { mutableStateOf(false) }
    Column(modifier.background(c.bgRaise, shape).navigationBarsPadding()) {
        // a grab line that closes it
        Box(Modifier.fillMaxWidth().height(24.dp).clickable(onClickLabel = "Close the details", onClick = onClose), contentAlignment = Alignment.Center) {
            Box(Modifier.width(32.dp).height(4.dp).background(c.rule2, RoundedCornerShape(2.dp)))
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(MapWords.kindWord(n.kind) + if (parent != null) " of " else "", style = ConclaveType.meta, color = c.fg3)
                if (parent != null) {
                    Text(
                        parent.title,
                        style = ConclaveType.meta,
                        color = c.fg2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable(onClickLabel = "Open its details") { onSelect(parent.id) }.padding(vertical = 4.dp),
                    )
                }
            }
            Text(n.title.ifBlank { "Untitled" }, style = ConclaveType.title, color = c.fg)
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                val tone = if (stuck != null) c.warn else when (MapWords.tone(n.state)) {
                    dev.conclave.client.map.MapTone.SIGNAL -> c.signal
                    dev.conclave.client.map.MapTone.WARN -> c.warn
                    dev.conclave.client.map.MapTone.FAULT -> c.fault
                    dev.conclave.client.map.MapTone.DIM -> c.fg2
                }
                Text(stuck ?: MapWords.stateWord(n.state), style = ConclaveType.body, color = tone)
                MapWords.stateDetail(n, at, clock)?.let { Text("  $it", style = ConclaveType.body, color = c.fg3) }
                Spacer(Modifier.weight(1f))
                Text(MapWords.shortId(n.id), style = CodeStyle.copy(fontSize = 12.sp), color = c.fg3)
            }
            if (n.state == MapState.FAILED && !n.error.isNullOrBlank()) {
                Text(n.error.orEmpty(), style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fault, modifier = Modifier.padding(top = 6.dp))
            }

            Block("Now") {
                val tool = n.tool
                if (tool != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(tool.name, style = ConclaveType.rowTitle, color = if (n.state == MapState.WAITING) c.warn else c.fg)
                        tool.target?.let {
                            Text("  $it", style = CodeStyle.copy(fontSize = 13.sp), color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        } ?: Spacer(Modifier.weight(1f))
                        Text(MapWords.durationShort(at - tool.startedAt), style = ConclaveType.metaNum, color = c.fg3)
                    }
                } else {
                    Text(MapWords.nowWords(n), style = ConclaveType.body, color = c.fg3)
                }
                MapWords.waitingWords(n)?.let { Text(it, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.warn, modifier = Modifier.padding(top = 2.dp)) }
            }

            Block("About") {
                Fact("Agent", n.agent?.ifBlank { null } ?: "default")
                n.model?.takeIf { it.isNotBlank() }?.let { Fact("Model", Format.modelLabel(it)) }
                Fact("Device", device?.name?.ifBlank { null } ?: n.device)
                n.cwd?.takeIf { it.isNotBlank() }?.let { Fact("Folder", dev.conclave.client.logic.Paths.shortPath(it, 3), mono = true) }
                Fact("Started", clock(n.startedAt))
                Fact("Last activity", MapWords.lastActivity(n, at))
            }

            if (n.tools.isNotEmpty()) {
                Block("Recent tools") {
                    n.tools.forEach { t -> ToolLine(t) }
                }
            }

            Block("Usage") {
                val u = n.usage
                Fact("In", MapWords.compact(u.inputTokens.toDouble()))
                Fact("Out", MapWords.compact(u.outputTokens.toDouble()))
                Fact("Cache", "${MapWords.compact(u.cacheReadTokens.toDouble())} read, ${MapWords.compact(u.cacheWriteTokens.toDouble())} written")
                Fact("Cost", MapWords.usd(u.costUsd, precise = true))
                Fact("Tokens a minute", MapWords.compact(n.tokensPerMin), tone = if (n.state == MapState.RUNNING && n.tokensPerMin > 0) c.signal else null)
                Fact("Run time", MapWords.durationShort(MapWords.runFor(n, at)))
            }

            if (kids.isNotEmpty()) {
                Block(if (n.kind == dev.conclave.client.model.MapNodeKind.WORKFLOW) "Agents" else "Subagents") {
                    kids.forEach { k ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { onSelect(k.id) },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(k.title, style = ConclaveType.body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(MapWords.stateWord(k.state), style = ConclaveType.meta, color = if (MapWords.isBusy(k.state)) (if (k.state == MapState.WAITING) c.warn else c.signal) else c.fg3)
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onOpen(MapWords.open(n)) },
                colors = solidButtonColors(),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (n.kind == dev.conclave.client.model.MapNodeKind.WORKFLOW) "Open run" else "Open chat") }
            if (MapWords.canStop(n) && !replay) {
                OutlinedButton(
                    onClick = {
                        stopping = true
                        // a failed stop says so in the snackbar; the button comes back either way
                        onStop().invokeOnCompletion { stopping = false }
                    },
                    enabled = !stopping,
                    border = outlineButtonBorder(),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                ) { Text(if (stopping) "Stopping" else "Stop", color = c.fault) }
            }
        }
    }
}

@Composable
private fun Block(title: String, content: @Composable () -> Unit) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        HorizontalDivider(thickness = 1.dp, color = c.rule)
        Text(title, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
        content()
    }
}

@Composable
private fun Fact(k: String, v: String, mono: Boolean = false, tone: androidx.compose.ui.graphics.Color? = null) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(k, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg3, modifier = Modifier.width(132.dp))
        Text(v, style = if (mono) CodeStyle.copy(fontSize = 13.sp) else ConclaveType.body, color = tone ?: c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ToolLine(t: MapTool) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t.name, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg2)
        Text("  " + (t.target ?: ""), style = CodeStyle.copy(fontSize = 12.sp), color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        t.durationMs?.let { Text(MapWords.duration(it), style = ConclaveType.metaNum, color = if (t.error) c.fault else c.fg3) }
    }
}
