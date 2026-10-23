package dev.conclave.app.ui.map

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PointMode
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.motion.Knot
import dev.conclave.app.ui.motion.motionNow
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveColors
import dev.conclave.app.ui.theme.JetBrainsMono
import dev.conclave.app.ui.theme.MonaSans
import dev.conclave.client.map.Insets
import dev.conclave.client.map.LFont
import dev.conclave.client.map.LKind
import dev.conclave.client.map.LLink
import dev.conclave.client.map.LNode
import dev.conclave.client.map.LabelPlace
import dev.conclave.client.map.MapGlide
import dev.conclave.client.map.MapLayout
import dev.conclave.client.map.MapLayouts
import dev.conclave.client.map.MapStreams
import dev.conclave.client.map.MapTone
import dev.conclave.client.map.MapViewport
import dev.conclave.client.map.MapViews
import dev.conclave.client.map.MapWords
import dev.conclave.client.map.Measure
import dev.conclave.client.map.StreamMode
import dev.conclave.client.map.Streams
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.model.MapState
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * The Map's surface (docs/DESIGN.md 29), the web's MapCanvas on a Compose
 * Canvas: the links as curves, the streams of light along them, each mark
 * and its label, stuck rings and conflict links, and the hub's Knot over
 * the middle. A drag pans, two fingers zoom, a tap picks a node. Marks
 * glide to new places when the layout changes. It draws a frame only while
 * something moves; with reduced motion nothing moves and the streams are
 * Lines.
 *
 * Map units are dp at zoom 1 (map/MapLayout.kt). The view is in dp too, so
 * a map point (x, y) is at ((x * k + vx) * density, (y * k + vy) * density) px.
 */

/** Where the view goes when the caller asks: [n] counts the asks. */
class MapViewRequest(val n: Int, val view: MapViewport?, val fit: Boolean)

/** The house text sizes of the map's labels, in dp so the layout holds whatever the phone's font size. */
private const val TITLE_DP = 13f
private const val NAME_DP = 14f
private const val META_DP = 12f

/** The hub's knot box, in map units, as on the web. */
private const val KNOT_BOX = 76.0

/** Text widths for the layout, from the real fonts (the web measures with a canvas too). */
@Composable
fun rememberMapMeasure(measurer: TextMeasurer): Measure {
    val density = LocalDensity.current
    val styles = rememberLabelStyles()
    return remember(measurer, density, styles) {
        val cache = HashMap<String, Double>()
        val m: Measure = { text, font ->
            val key = "${font.ordinal}\u0000$text"
            cache.getOrPut(key) {
                val style = when (font) {
                    LFont.TITLE -> styles.title
                    LFont.NAME -> styles.name
                    LFont.META -> styles.meta
                }
                val px = measurer.measure(text, style, maxLines = 1, softWrap = false).size.width
                // padding round the text, as the web's label plate
                kotlin.math.ceil(px / density.density * 1.02) + 10.0
            }
        }
        m
    }
}

private class LabelStyles(val title: TextStyle, val name: TextStyle, val meta: TextStyle, val mono: TextStyle)

@Composable
private fun rememberLabelStyles(): LabelStyles {
    val fs = LocalDensity.current.fontScale
    return remember(fs) {
        LabelStyles(
            title = TextStyle(fontFamily = MonaSans, fontWeight = FontWeight.Medium, fontSize = (TITLE_DP / fs).sp, lineHeight = (16f / fs).sp),
            name = TextStyle(fontFamily = MonaSans, fontWeight = FontWeight.SemiBold, fontSize = (NAME_DP / fs).sp, lineHeight = (17f / fs).sp),
            meta = TextStyle(fontFamily = MonaSans, fontWeight = FontWeight.Normal, fontSize = (META_DP / fs).sp, lineHeight = (15f / fs).sp, fontFeatureSettings = "tnum"),
            mono = TextStyle(fontFamily = JetBrainsMono, fontWeight = FontWeight.Normal, fontSize = (META_DP / fs).sp, lineHeight = (15f / fs).sp),
        )
    }
}

/** A label's two lines, measured once per change. */
private class LabelText(val title: TextLayoutResult, val meta: TextLayoutResult)

private fun toneColor(c: ConclaveColors, t: MapTone): Color = when (t) {
    MapTone.SIGNAL -> c.signal
    MapTone.WARN -> c.warn
    MapTone.FAULT -> c.fault
    MapTone.DIM -> c.fg3
}

@Composable
fun MapCanvas(
    snap: MapSnapshot,
    layout: MapLayout,
    mode: StreamMode,
    selected: String?,
    onSelect: (String?) -> Unit,
    /** Room the overlays take, in dp. */
    insets: Insets,
    online: Boolean,
    replay: Boolean,
    /** A phone opens at zoom k on this box (the hub and its busiest project), so labels read. */
    focus: dev.conclave.client.map.LBox?,
    /** Fit and zoom asks from the buttons. */
    request: MapViewRequest,
    now: Long,
    measurer: TextMeasurer,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    val density = LocalDensity.current
    val d = density.density
    val reduced = reducedMotion()
    val styles = rememberLabelStyles()

    var size by remember { mutableStateOf(Size.Zero) }
    var view by remember { mutableStateOf(MapViewport(0.0, 0.0, 1.0)) }
    // moved: the owner panned or zoomed, so a new layout does not move the view; whole: Fit was asked for
    var moved by remember { mutableStateOf(false) }
    var whole by remember { mutableStateOf(false) }
    val glide = remember { MapGlide() }
    val streams = remember { MapStreams() }
    val tick = remember { mutableLongStateOf(0L) }
    // bumped when something starts moving: the frame loop starts again
    var wake by remember { mutableStateOf(0) }

    val wDp = size.width / d
    val hDp = size.height / d
    fun clamp(v: MapViewport) = MapViews.clamp(v, layout.bounds, wDp.toDouble(), hDp.toDouble())

    fun place() {
        if (size == Size.Zero) return
        val w = wDp.toDouble()
        val h = hDp.toDouble()
        view = if (focus != null && !whole) MapViews.start(layout.bounds, focus, w, h, insets) else MapViews.fit(layout.bounds, w, h, insets, if (w < 600) 1.0 else 1.15)
    }

    // the layout changed: marks glide from where they are drawn now
    LaunchedEffect(layout) {
        val to = HashMap<String, DoubleArray>()
        for (n in layout.nodes) to[n.id] = doubleArrayOf(n.x, n.y)
        glide.set(to, motionNow(), if (reduced) 0.0 else MapGlide.MOVE_MS)
        if (!moved) place()
        wake++
    }
    LaunchedEffect(size) { if (!moved) place() else view = clamp(view) }

    // the buttons: Fit shows the whole map, zoom keeps the middle in place
    LaunchedEffect(request.n) {
        if (request.n == 0) return@LaunchedEffect
        if (request.fit) {
            moved = false
            whole = true
            place()
        } else {
            request.view?.let {
                moved = true
                view = clamp(it)
            }
        }
    }

    // a picked node comes into sight above the drawer, moving the map only as far as it must
    LaunchedEffect(selected, insets.bottom) {
        val n = selected?.let { layout.byId[it] } ?: return@LaunchedEffect
        if (size == Size.Zero) return@LaunchedEffect
        val (dx, dy) = MapViews.reveal(view, n, wDp.toDouble(), hDp.toDouble(), insets)
        if (dx == 0.0 && dy == 0.0) return@LaunchedEffect
        val from = view
        val to = MapViewport(from.x + dx, from.y + dy, from.k)
        if (reduced) {
            view = to
            return@LaunchedEffect
        }
        val start = withFrameNanos { it }
        while (true) {
            val t = withFrameNanos { it }
            val p = MapGlide.easeOut(min(1.0, (t - start) / 320e6))
            view = MapViewport(from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p, from.k)
            if (p >= 1.0) break
        }
    }

    // what flows: running nodes and their token rates; a new tool sends a pulse
    val lastTools = remember { HashMap<String, String?>() }
    LaunchedEffect(snap, replay, reduced, mode) {
        streams.mode = if (reduced) StreamMode.LINES else mode
        streams.setSources(if (replay && reduced) emptyList() else Streams.sources(snap.nodes))
        if (!replay) {
            for (n in snap.nodes) {
                if (n.kind == MapNodeKind.WORKFLOW) continue
                val tool = n.tool?.id
                if (tool != null && lastTools.containsKey(n.id) && lastTools[n.id] != tool) streams.pulse(n.id)
            }
        }
        lastTools.clear()
        for (n in snap.nodes) lastTools[n.id] = n.tool?.id
        wake++
    }

    // the frame loop: only while particles move or marks glide
    LaunchedEffect(wake, reduced) {
        var last = withFrameNanos { it }
        while (true) {
            val t = withFrameNanos { it }
            streams.step((t - last) / 1e9)
            last = t
            tick.longValue = t
            if (!streams.active && !glide.moving(motionNow())) break
        }
    }

    // labels: measured when what they say changes, never per frame
    val nodes = remember(snap) { snap.nodes.associateBy { it.id } }
    val labels = remember(layout, snap, now, c, styles, d) { measureLabels(layout, nodes, snap, now, online, c, styles, measurer, d) }

    val currentLayout by rememberUpdatedState(layout)
    val currentSelect by rememberUpdatedState(onSelect)
    val currentSelected by rememberUpdatedState(selected)

    // the hub's knot: drawn at the zoom it is seen at, in steps, so it stays sharp
    val kq by remember { derivedStateOf { (view.k * 4).roundToInt() / 4.0 } }
    val hubKnot = MapWords.hubKnot(snap.hub.state, snap.nodes, online)
    val hubLabel = layout.byId["hub"]?.label

    val dotColor = if (c.dark) lerp(c.signal, c.fg, 0.28f) else c.signal
    val pulseColor = if (c.dark) lerp(c.signal, c.fg, 0.75f) else lerp(c.signal, Color(0xFF140A28), 0.25f)
    val linkBase = if (c.dark) c.rule2 else lerp(c.rule2, c.bg, 0.15f)
    val dotPaints = remember(dotColor, d) {
        List(4) { level ->
            Paint().apply {
                color = dotColor.copy(alpha = (level + 0.5f) / 4f)
                strokeWidth = 1.75f * d
                strokeCap = StrokeCap.Round
            }
        }
    }
    val xs = remember { FloatArray(streams.capacity) }
    val ys = remember { FloatArray(streams.capacity) }
    val levels = remember { IntArray(streams.capacity) }
    var lastFrame by remember { mutableLongStateOf(0L) }

    Box(
        modifier
            .onSizeChanged { size = Size(it.width.toFloat(), it.height.toFloat()) }
            .pointerInput(Unit) {
                detectTransformGestures { centroid, pan, zoom, _ ->
                    moved = true
                    // the state itself, not a copy: several events can come between two frames
                    val v = MapViews.gesture(view, centroid.x / d.toDouble(), centroid.y / d.toDouble(), pan.x / d.toDouble(), pan.y / d.toDouble(), zoom.toDouble())
                    view = MapViews.clamp(v, currentLayout.bounds, size.width / d.toDouble(), size.height / d.toDouble())
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(onTap = { pos ->
                    val v = view
                    val (wx, wy) = MapViews.toWorld(v, pos.x / d.toDouble(), pos.y / d.toDouble())
                    // a finger needs more than a 12dp dot
                    val hit = MapLayouts.hit(currentLayout, wx, wy, 14.0 / v.k)
                    currentSelect(if (hit == null || hit.id == currentSelected) null else hit.id)
                })
            }
            .semantics { contentDescription = "The hub, its devices, projects and agents" },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            tick.longValue
            val t0 = System.nanoTime()
            val v = view
            val at = glide.at(motionNow())
            fun sx(x: Double) = ((x * v.k + v.x) * d).toFloat()
            fun sy(y: Double) = ((y * v.k + v.y) * d).toFloat()
            fun pos(id: String, n: LNode): Pair<Double, Double> = at[id]?.let { it[0] to it[1] } ?: (n.x to n.y)

            // ----- links, as the layout draws them between where the marks are now -----
            val live = ArrayList<LLink>(layout.links.size)
            for (k in layout.links) {
                val a = layout.byId[k.from] ?: continue
                val b = layout.byId[k.to] ?: continue
                val (ax, ay) = pos(a.id, a)
                val (bx, by) = pos(b.id, b)
                val dx = bx - ax
                live.add(LLink(k.id, k.from, k.to, doubleArrayOf(ax, ay, ax + dx * 0.5, ay, bx - dx * 0.5, by, bx, by)))
            }
            streams.setLinks(live)

            // a link carries work when a running node lies below it
            val busy = HashMap<String, Boolean>()
            for (n in snap.nodes) {
                if (n.state != MapState.RUNNING && n.state != MapState.WAITING) continue
                busy[n.id] = n.state == MapState.WAITING
                if (n.state != MapState.RUNNING) continue
                var id: String? = n.id
                var hop = 0
                while (hop < 12 && id != null) {
                    val p = layout.byId[id]?.parent ?: break
                    if (!busy.containsKey(p)) busy[p] = false
                    id = p
                    hop++
                }
            }
            val lines = streams.mode == StreamMode.LINES
            for (k in live) {
                val p = k.p
                val path = Path().apply {
                    moveTo(sx(p[0]), sy(p[1]))
                    cubicTo(sx(p[2]), sy(p[3]), sx(p[4]), sy(p[5]), sx(p[6]), sy(p[7]))
                }
                val device = layout.byId[k.from]?.kind == LKind.DEVICE
                drawPath(path, linkBase, style = Stroke(width = d, pathEffect = if (device) PathEffect.dashPathEffect(floatArrayOf(2 * d, 4 * d), 0f) else null))
                val waits = busy[k.from] ?: continue
                val tone = if (waits) c.warn.copy(alpha = if (lines) 0.75f else 0.5f) else c.signal.copy(alpha = if (lines) 0.7f else if (c.dark) 0.3f else 0.38f)
                drawPath(path, tone, style = Stroke(width = (if (lines) 1.5f else 1.25f) * d))
            }

            // ----- a file two agents change at once: a dashed link in the fault color between them -----
            for (x in snap.conflicts) {
                val a = layout.byId[x.a] ?: continue
                val b = layout.byId[x.b] ?: continue
                val (ax, ay) = pos(a.id, a)
                val (bx, by) = pos(b.id, b)
                val mx = (ax + bx) / 2
                val my = (ay + by) / 2 - min(60.0, abs(ax - bx) * 0.2 + 18)
                val path = Path().apply {
                    moveTo(sx(ax), sy(ay))
                    quadraticTo(sx(mx), sy(my), sx(bx), sy(by))
                }
                drawPath(path, c.fault.copy(alpha = 0.9f), style = Stroke(width = 1.5f * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4 * d, 3 * d), 0f)))
            }

            // ----- the streams: dots in four levels of light, pulses with a trail -----
            if (!lines && streams.count > 0) {
                val count = streams.dots(xs, ys, levels)
                for (level in 0..3) {
                    var m = 0
                    for (i in 0 until count) if (levels[i] == level) m++
                    if (m == 0) continue
                    val pts = FloatArray(m * 2)
                    var j = 0
                    for (i in 0 until count) {
                        if (levels[i] != level) continue
                        pts[j++] = sx(xs[i].toDouble())
                        pts[j++] = sy(ys[i].toDouble())
                    }
                    drawIntoCanvas { it.drawRawPoints(PointMode.Points, pts, dotPaints[level]) }
                }
                streams.pulses { x, y, a, head ->
                    drawCircle(pulseColor.copy(alpha = a.toFloat().coerceIn(0f, 1f)), radius = (if (head) 1.4f else 0.9f) * d, center = Offset(sx(x), sy(y)))
                }
            }

            // ----- marks and labels -----
            val fresh = glide.fresh
            val appear = glide.progress(motionNow()).toFloat()
            for (ln in layout.nodes) {
                val (x, y) = pos(ln.id, ln)
                val alpha = if (ln.id in fresh) appear else 1f
                val center = Offset(sx(x), sy(y))
                val r = (ln.r * v.k * d).toFloat()
                when (ln.kind) {
                    // the links end under the knot, and the streams fade into it
                    LKind.HUB -> drawCircle(c.bg, radius = r, center = center)
                    LKind.DEVICE -> drawDevice(center, r, ln.device?.online, c, d, alpha)
                    LKind.GROUP -> drawGroup(center, r, ln.group?.let { MapWords.groupState(it.id, snap.nodes) } ?: MapState.IDLE, c, d, alpha)
                    LKind.NODE -> {
                        val n = nodes[ln.id] ?: ln.node ?: continue
                        drawNode(center, r, n, c, d, alpha, selected = ln.id == selected, stuck = MapWords.stuckWords(n, now) != null)
                    }
                }
                val label = labels[ln.id] ?: continue
                drawLabel(ln, x, y, label, v, d, c, alpha)
            }

            // ----- the file on each conflict link -----
            for (x in snap.conflicts) {
                val a = layout.byId[x.a] ?: continue
                val b = layout.byId[x.b] ?: continue
                val (ax, ay) = pos(a.id, a)
                val (bx, by) = pos(b.id, b)
                val mx = (ax + bx) / 2
                val my = (ay + by) / 2 - min(60.0, abs(ax - bx) * 0.2 + 18) / 2
                val text = measurer.measure(x.file, styles.mono.copy(color = c.fault), maxLines = 1, softWrap = false)
                withTransform({
                    translate(sx(mx), sy(my))
                    scale(v.k.toFloat(), v.k.toFloat(), Offset.Zero)
                }) {
                    val w = text.size.width.toFloat()
                    val h = text.size.height.toFloat()
                    val padX = 5 * d
                    val padY = 1 * d
                    drawRoundRect(c.bg, Offset(-w / 2 - padX, -h / 2 - padY), Size(w + 2 * padX, h + 2 * padY), CornerRadius(3 * d))
                    drawRoundRect(c.fault.copy(alpha = 0.6f), Offset(-w / 2 - padX, -h / 2 - padY), Size(w + 2 * padX, h + 2 * padY), CornerRadius(3 * d), style = Stroke(width = d))
                    drawText(text, topLeft = Offset(-w / 2, -h / 2))
                }
            }

            // the draw measures itself: slow frames lower the share of particles
            val t1 = System.nanoTime()
            val interval = if (lastFrame == 0L) 16.7 else (t1 - lastFrame) / 1e6
            lastFrame = t1
            streams.quality.update((t1 - t0) / 1e6, interval)
        }

        // the hub's knot over the middle: it says the hub's state
        val hub = layout.byId["hub"]
        if (hub != null) {
            val box = (KNOT_BOX * kq).toFloat().coerceIn(12f, 160f)
            Box(
                Modifier
                    .offset {
                        // the hub sits at the map's origin and never moves; the view does
                        val v = view
                        IntOffset((((hub.x * v.k + v.x) * d) - box * d / 2).roundToInt(), (((hub.y * v.k + v.y) * d) - box * d / 2).roundToInt())
                    }
                    .size(box.dp),
            ) {
                Knot(
                    hubKnot,
                    size = box.dp,
                    still = replay || reduced,
                    surface = c.bg,
                    label = "Hub ${hubLabel?.title.orEmpty()}, ${hubLabel?.meta.orEmpty()}",
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/** A device: a small square, like a machine; dashed while it is away. */
private fun DrawScope.drawDevice(center: Offset, r: Float, online: Boolean?, c: ConclaveColors, d: Float, alpha: Float) {
    val tl = Offset(center.x - r, center.y - r)
    val sz = Size(2 * r, 2 * r)
    drawRoundRect(c.bg, tl, sz, CornerRadius(3 * d), alpha = alpha)
    val off = online == false
    drawRoundRect(
        if (off) c.fg4 else c.fg3, tl, sz, CornerRadius(3 * d),
        style = Stroke(width = 1.5f * d, pathEffect = if (off) PathEffect.dashPathEffect(floatArrayOf(2 * d, 2 * d), 0f) else null),
        alpha = alpha,
    )
}

/** A project or folder: a ring with its state in the middle. */
private fun DrawScope.drawGroup(center: Offset, r: Float, state: MapState, c: ConclaveColors, d: Float, alpha: Float) {
    drawCircle(c.bg, radius = r, center = center, alpha = alpha)
    drawCircle(c.edge, radius = r - 0.75f * d, center = center, style = Stroke(width = 1.5f * d), alpha = alpha)
    val inner = when (state) {
        MapState.RUNNING -> c.signal
        MapState.WAITING -> c.warn
        else -> c.fg4
    }
    // the dot sits 4.5 in from the ring's 11, at any zoom
    drawCircle(inner, radius = r * (6.5f / 11f), center = center, alpha = alpha)
}

/** An agent: a dot by state, a ring a few dp out while it works or waits; a workflow run is a diamond. */
private fun DrawScope.drawNode(center: Offset, r: Float, n: MapNode, c: ConclaveColors, d: Float, alpha: Float, selected: Boolean, stuck: Boolean) {
    val k = r / max(0.001f, (MapLayouts.markRadius(LKind.NODE, n) * d).toFloat())
    if (n.kind == MapNodeKind.WORKFLOW) {
        val edge = when (n.state) {
            MapState.RUNNING -> c.signal
            MapState.FAILED -> c.fault
            else -> c.fg4
        }
        val half = r * 1.414f
        val outer = Path().apply {
            moveTo(center.x, center.y - half)
            lineTo(center.x + half, center.y)
            lineTo(center.x, center.y + half)
            lineTo(center.x - half, center.y)
            close()
        }
        drawPath(outer, c.bg, alpha = alpha)
        drawPath(outer, edge, style = Stroke(width = 1.5f * d * k), alpha = alpha)
        if (n.state != MapState.PAUSED) {
            val ih = max(0.5f, r - 2.5f * d * k) * 1.414f * 0.7f
            val inner = Path().apply {
                moveTo(center.x, center.y - ih)
                lineTo(center.x + ih, center.y)
                lineTo(center.x, center.y + ih)
                lineTo(center.x - ih, center.y)
                close()
            }
            drawPath(inner, edge, alpha = alpha)
        }
    } else {
        when (n.state) {
            MapState.RUNNING -> drawCircle(c.signal, r, center, alpha = alpha)
            MapState.WAITING -> drawCircle(c.warn, r, center, alpha = alpha)
            MapState.FAILED -> drawCircle(c.fault, r, center, alpha = alpha)
            MapState.IDLE -> drawCircle(c.fg4, r, center, alpha = alpha)
            MapState.DONE -> {
                drawCircle(c.bg, r, center, alpha = alpha)
                drawCircle(c.fg4, r - 0.75f * d * k, center, style = Stroke(width = 1.5f * d * k), alpha = alpha)
            }
            MapState.PAUSED -> {
                drawCircle(c.bg, r, center, alpha = alpha)
                drawCircle(c.fg3, r - 0.75f * d * k, center, style = Stroke(width = 1.5f * d * k), alpha = alpha)
            }
        }
        // a ring a few dp out on the ones that work or wait: still, not a glow
        if (n.state == MapState.RUNNING || n.state == MapState.WAITING) {
            val tone = if (n.state == MapState.RUNNING) c.signal else c.warn
            drawCircle(tone.copy(alpha = 0.4f), r + 4 * d * k, center, style = Stroke(width = d * k), alpha = alpha)
        }
    }
    // stuck: a dotted amber ring
    if (stuck) {
        drawCircle(
            c.warn, r + 6 * d * k, center,
            style = Stroke(width = 1.5f * d * k, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(0.01f, 3.5f * d * k), 0f)),
            alpha = alpha,
        )
    }
    if (selected) {
        drawCircle(c.bg, r + 3 * d * k, center, style = Stroke(width = 3 * d * k), alpha = alpha)
        drawCircle(c.fg, r + 3.75f * d * k, center, style = Stroke(width = 1.5f * d * k), alpha = alpha)
    }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

private fun measureLabels(
    layout: MapLayout,
    nodes: Map<String, MapNode>,
    snap: MapSnapshot,
    now: Long,
    online: Boolean,
    c: ConclaveColors,
    s: LabelStyles,
    measurer: TextMeasurer,
    d: Float,
): Map<String, LabelText> {
    val out = HashMap<String, LabelText>(layout.nodes.size)
    for (ln in layout.nodes) {
        val L = ln.label
        val max = ((L.w - 4) * d).toInt().coerceAtLeast(1)
        // a name above or below its node has room on both sides: it never cuts its words
        val centered = L.place != LabelPlace.BESIDE
        val cons = if (centered) Constraints(maxWidth = (max * 2).coerceAtLeast(1)) else Constraints(maxWidth = max)
        val titleStyle: TextStyle
        val meta: AnnotatedString
        when (ln.kind) {
            LKind.HUB -> {
                titleStyle = s.name.copy(color = c.fg)
                val tone = if (!online) c.fg3 else toneColor(c, MapWords.tone(snap.hub.state))
                meta = AnnotatedString(L.meta, SpanStyle(color = tone))
            }
            LKind.DEVICE -> {
                titleStyle = s.name.copy(color = c.fg)
                meta = AnnotatedString(L.meta, SpanStyle(color = if (ln.device?.online == true) c.ok else c.fg3))
            }
            LKind.GROUP -> {
                titleStyle = s.name.copy(color = c.fg)
                val g = ln.group
                val stats = if (g != null) MapWords.groupStats(g.id, snap.nodes) else null
                meta = buildAnnotatedString {
                    withStyle(SpanStyle(color = c.fg3)) {
                        if (stats == null || g == null) {
                            append(L.meta)
                        } else {
                            append("${stats.agents} ${MapWords.groupNoun(stats.agents, g.isChats)}")
                            if (stats.running > 0) {
                                append(", ")
                                withStyle(SpanStyle(color = c.signal)) { append("${stats.running} running") }
                            }
                            if (stats.waiting > 0) {
                                append(", ")
                                withStyle(SpanStyle(color = c.warn)) { append("${stats.waiting} waiting") }
                            }
                        }
                    }
                }
            }
            LKind.NODE -> {
                val n = nodes[ln.id] ?: ln.node
                if (n == null) continue
                titleStyle = s.title.copy(color = if (MapWords.isBusy(n.state)) c.fg else c.fg2)
                val stuck = MapWords.stuckWords(n, now)
                val word = stuck ?: MapWords.stateWord(n.state)
                val tone = if (stuck != null) c.warn else toneColor(c, MapWords.tone(n.state))
                meta = buildAnnotatedString {
                    withStyle(s.mono.toSpanStyle().copy(color = c.fg4)) { append(MapWords.shortId(n.id)) }
                    append("  ")
                    withStyle(SpanStyle(color = tone)) { append(word) }
                }
            }
        }
        val title = measurer.measure(L.title, titleStyle, overflow = TextOverflow.Ellipsis, maxLines = 1, softWrap = false, constraints = cons)
        val metaLayout = measurer.measure(meta, s.meta.copy(color = c.fg3), overflow = TextOverflow.Ellipsis, maxLines = 1, softWrap = false, constraints = cons)
        out[ln.id] = LabelText(title, metaLayout)
    }
    return out
}

/** A label: two lines on soft plates of the background, so the words read over the streams. */
private fun DrawScope.drawLabel(ln: LNode, x: Double, y: Double, t: LabelText, v: MapViewport, d: Float, c: ConclaveColors, alpha: Float) {
    val L = ln.label
    // the label moves with its mark while marks glide
    val lx = L.x + (x - ln.x)
    val ly = L.y + (y - ln.y)
    val k = v.k.toFloat()
    val left = ((lx * v.k + v.x) * d).toFloat()
    val top = ((ly * v.k + v.y) * d).toFloat()
    val w = (L.w * d).toFloat()
    val h = (L.h * d).toFloat()
    val plate = c.bg.copy(alpha = 0.82f * alpha)
    withTransform({
        translate(left, top)
        scale(k, k, Offset.Zero)
    }) {
        val lines = listOf(t.title, t.meta)
        val total = lines.sumOf { it.size.height }.toFloat()
        var yy = (h - total) / 2
        for (line in lines) {
            val lw = line.size.width.toFloat()
            val pad = 3 * d
            val lxx = when {
                L.place != LabelPlace.BESIDE -> (w - lw) / 2
                ln.side == -1 -> w - lw - 2 * d
                else -> 2 * d
            }
            drawRoundRect(plate, Offset(lxx - pad, yy), Size(lw + 2 * pad, line.size.height.toFloat()), CornerRadius(3 * d))
            drawText(line, topLeft = Offset(lxx, yy), alpha = alpha)
            yy += line.size.height
        }
    }
}
