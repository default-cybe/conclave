package dev.conclave.app.ui.memory

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import dev.conclave.app.ui.map.rememberLabelStyles
import dev.conclave.app.ui.map.rememberMapMeasure
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.logic.HoloMode
import dev.conclave.client.logic.MTKind
import dev.conclave.client.logic.MemoryIndex
import dev.conclave.client.logic.MemoryLinks
import dev.conclave.client.logic.MemoryMapState
import dev.conclave.client.logic.MemoryMaps
import dev.conclave.client.map.LBox
import dev.conclave.client.map.LFont
import dev.conclave.client.map.MapViewport
import dev.conclave.client.map.MapViews
import dev.conclave.client.model.MemoryGraph
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/*
 * Memory > Map's three views on Compose Canvas (MemoryMapScreen.kt holds
 * the screen). Tree: the mind map's labels and links, pinch and pan, a tap
 * opens an area or a "k more" row, or picks an item. Rings: every item a
 * tick on one circle, every drawn link a bundled curve through its area's
 * anchor and the core, the picked one in signal violet. 3D: Clusters or
 * Timeline projected with a perspective camera, points and links in violet
 * as the web's WebGL view draws them; one finger orbits, two zoom. Rings
 * and 3D draw at most [PHONE_CAP] links (pickEdges: every item's strongest
 * first), as the web does on phones.
 */

private const val PHONE_CAP = 1400
private const val SEG = 5
private const val FOV = 48.0

/** Text layouts by font and text, measured once per view. */
private class Labels(private val measurer: TextMeasurer) {
    private val cache = HashMap<String, TextLayoutResult>()
    fun get(text: String, style: TextStyle, maxPx: Int = Constraints.Infinity): TextLayoutResult =
        cache.getOrPut("${style.fontSize}\u0000${style.fontWeight}\u0000${style.color}\u0000$maxPx\u0000$text") {
            measurer.measure(text, style, overflow = TextOverflow.Ellipsis, softWrap = false, maxLines = 1, constraints = Constraints(maxWidth = maxPx))
        }
}

/** Greedy box test: a label is drawn only where no earlier one is. */
private class Boxes {
    private val taken = ArrayList<Rect>()
    fun claim(r: Rect): Boolean {
        if (taken.any { it.overlaps(r) }) return false
        taken.add(r)
        return true
    }
}

// ----- Tree ------------------------------------------------------------------------

@Composable
fun MemoryTreeCanvas(ix: MemoryIndex, center: String, picked: String?, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val d = LocalDensity.current.density
    val measurer = rememberTextMeasurer(cacheSize = 64)
    val measure = rememberMapMeasure(measurer)
    val styles = rememberLabelStyles()
    var size by remember { mutableStateOf(Size.Zero) }
    var open by remember(center) { mutableStateOf(emptySet<String>()) }
    var more by remember(center) { mutableStateOf(emptyMap<String, Int>()) }
    val budget = max(12, (size.height / d / MemoryMaps.ROW_PHONE).toInt())
    val layout = remember(ix, center, open, more, budget, measure) {
        val tree = MemoryMaps.buildTree(ix, MemoryMapState(center = center, open = open, more = more, budget = budget))
        MemoryMaps.layoutTree(tree.root, ix, measure, rightOnly = true, phone = true)
    }
    val box = layout.bounds.let { LBox(it[0], it[1], it[2], it[3]) }
    var view by remember(center) { mutableStateOf<MapViewport?>(null) }
    if (view == null && size.width > 0) {
        val root = layout.nodes.first()
        view = MapViews.start(box, LBox(root.x - 8, root.y - 60, root.w + 200, 120.0), size.width / d.toDouble(), size.height / d.toDouble(), dev.conclave.client.map.Insets.NONE, 1.0)
    }
    val labels = remember(measurer, styles) { Labels(measurer) }
    val chain = remember(layout, picked) { picked?.let { MemoryMaps.chainTo(layout, it).toSet() } ?: emptySet() }
    val current by rememberUpdatedState(layout)
    val pick by rememberUpdatedState(onPick)

    Canvas(
        modifier
            .onSizeChanged { size = Size(it.width.toFloat(), it.height.toFloat()) }
            .pointerInput(center) {
                detectTransformGestures { centroid, pan, zoom, _ ->
                    val v = view ?: return@detectTransformGestures
                    val next = MapViews.gesture(v, centroid.x / d.toDouble(), centroid.y / d.toDouble(), pan.x / d.toDouble(), pan.y / d.toDouble(), zoom.toDouble())
                    view = MapViews.clamp(next, current.bounds.let { LBox(it[0], it[1], it[2], it[3]) }, size.width / d.toDouble(), size.height / d.toDouble())
                }
            }
            .pointerInput(center) {
                detectTapGestures(onTap = { pos ->
                    val v = view ?: return@detectTapGestures
                    val (wx, wy) = MapViews.toWorld(v, pos.x / d.toDouble(), pos.y / d.toDouble())
                    val hit = MemoryMaps.hit(current, wx, wy, 8.0 / v.k) ?: return@detectTapGestures
                    when (hit.t.kind) {
                        MTKind.AREA, MTKind.GROUP -> open = if (hit.id in open) open - hit.id else open + hit.id
                        MTKind.MORE -> hit.t.key?.let { k -> more = more + (k to (more[k] ?: 0) + MemoryMaps.MORE_STEP) }
                        MTKind.NODE, MTKind.FOCUS -> hit.t.item?.let { pick(it) }
                        MTKind.BRAIN -> Unit
                    }
                })
            }
            .semantics { contentDescription = "Memory map, tree of areas and items" },
    ) {
        val v = view ?: return@Canvas
        val k = v.k.toFloat()
        val sx = { x: Double -> ((x * v.k + v.x) * d).toFloat() }
        val sy = { y: Double -> ((y * v.k + v.y) * d).toFloat() }
        // links: a soft S from the parent's outer edge to the child's inner edge
        val plain = Path()
        val lit = Path()
        for ((from, to) in layout.links) {
            val a = layout.byId[from] ?: continue
            val b = layout.byId[to] ?: continue
            val x0 = sx(a.outX(b.side))
            val x1 = sx(b.inX)
            val y0 = sy(a.y)
            val y1 = sy(b.y)
            val p = if (from in chain && to in chain) lit else plain
            p.moveTo(x0, y0)
            val mx = (x0 + x1) / 2
            p.cubicTo(mx, y0, mx, y1, x1, y1)
        }
        drawPath(plain, c.fg4.copy(alpha = 0.7f), style = Stroke(width = max(1f, 1f * d * min(1f, k))))
        drawPath(lit, c.signal, style = Stroke(width = 1.5f * d))
        val small = k * 13f < 7f
        for (p in layout.nodes) {
            val x = sx(p.x)
            val y = sy(p.y)
            val w = (p.w * v.k * d).toFloat()
            val h = (p.h * v.k * d).toFloat()
            if (x > size.width || x + w < 0 || y - h > size.height || y + h < 0) continue
            val on = p.item?.id == picked || (p.t.kind == MTKind.FOCUS)
            val color = when {
                p.item?.id == picked -> c.signal
                p.t.kind == MTKind.MORE || p.t.kind == MTKind.GROUP -> c.fg3
                else -> c.fg
            }
            if (small) {
                drawLine(color.copy(alpha = 0.5f), Offset(x, y), Offset(x + w * 0.8f, y), strokeWidth = max(1f, h * 0.25f))
                continue
            }
            // a plate under the text, so links never run through a word
            drawRoundRect(if (on) c.signalDim else c.bg, Offset(x, y - h / 2), Size(w, h), CornerRadius(3f * d * k))
            val style = when (p.font) {
                LFont.NAME -> styles.name
                LFont.TITLE -> styles.title
                LFont.META -> styles.meta
            }
            val scale = if (p.t.kind == MTKind.BRAIN) 1.22f else 1f
            val countW = p.count?.let { (measure(it, LFont.META) - 6) * d } ?: 0.0
            // only the title is scaled up (layoutTree's width), so the count comes off before the scale
            val titleMaxPx = ((p.w * d - countW) / scale - 10 * d).toInt().coerceAtLeast(1)
            val t = labels.get(p.title, style.copy(color = color), titleMaxPx)
            withTransform({
                translate(x, y)
                scale(k * scale, k * scale, Offset.Zero)
            }) {
                drawText(t, topLeft = Offset(5f * d, -t.size.height / 2f))
            }
            p.count?.let { n ->
                val cl = labels.get(n, styles.meta.copy(color = c.fg3))
                withTransform({
                    translate(x + (5f * d + t.size.width) * scale * k, y)
                    scale(k, k, Offset.Zero)
                }) {
                    drawText(cl, topLeft = Offset(4f * d, -cl.size.height / 2f))
                }
            }
        }
    }
}

// ----- Rings -----------------------------------------------------------------------

@Composable
fun MemoryRingsCanvas(g: MemoryGraph, ix: MemoryIndex, picked: String?, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val d = LocalDensity.current.density
    val measurer = rememberTextMeasurer(cacheSize = 32)
    val styles = rememberLabelStyles()
    val labels = remember(measurer, styles) { Labels(measurer) }
    val links = remember(g, ix) { MemoryLinks.layoutLinks(g, ix) }
    val hud = remember(links) { MemoryLinks.layoutHud(links, ix) }
    val drawn = remember(links) { drawnEdges(g, links) }
    val R = MemoryLinks.R
    val base = remember(hud, drawn) {
        val p = Path()
        for (e in drawn) bezier(p, hud.pts[e])
        p
    }
    val ticks = remember(hud) {
        val p = Path()
        for (i in links.items.indices) {
            val a = hud.angle[i]
            val len = 4 + min(18.0, 3 * sqrt(g.nodes[links.items[i].node].degree.toDouble()))
            p.moveTo((cos(a) * R).toFloat(), (sin(a) * R).toFloat())
            p.lineTo((cos(a) * (R + len)).toFloat(), (sin(a) * (R + len)).toFloat())
        }
        p
    }
    val pickedAt = picked?.let { links.byId[it] }
    val lit = remember(hud, pickedAt) {
        val p = Path()
        if (pickedAt != null) for (e in links.edgesOf[pickedAt]) if (links.edges[e].label != "mentions") bezier(p, hud.pts[e])
        p
    }
    var size by remember { mutableStateOf(Size.Zero) }
    var view by remember { mutableStateOf<MapViewport?>(null) }
    val world = LBox(-R - 80, -R - 80, 2 * R + 160, 2 * R + 160)
    if (view == null && size.width > 0) view = MapViews.fit(world, size.width / d.toDouble(), size.height / d.toDouble(), maxK = 3.0)
    val pick by rememberUpdatedState(onPick)

    Canvas(
        modifier
            .onSizeChanged { size = Size(it.width.toFloat(), it.height.toFloat()) }
            .pointerInput(Unit) {
                detectTransformGestures { centroid, pan, zoom, _ ->
                    val v = view ?: return@detectTransformGestures
                    view = MapViews.clamp(MapViews.gesture(v, centroid.x / d.toDouble(), centroid.y / d.toDouble(), pan.x / d.toDouble(), pan.y / d.toDouble(), zoom.toDouble()), world, size.width / d.toDouble(), size.height / d.toDouble())
                }
            }
            .pointerInput(links) {
                detectTapGestures(onTap = { pos ->
                    val v = view ?: return@detectTapGestures
                    val (wx, wy) = MapViews.toWorld(v, pos.x / d.toDouble(), pos.y / d.toDouble())
                    val r = hypot(wx, wy)
                    if (r < R * 0.85 || r > R + 50) return@detectTapGestures
                    val i = MemoryLinks.itemAtAngle(hud, atan2(wy, wx), max(0.004, 16.0 / (R * v.k))) ?: return@detectTapGestures
                    pick(links.items[i].id)
                })
            }
            .semantics { contentDescription = "Memory map, rings of areas with their links" },
    ) {
        val v = view ?: return@Canvas
        val s = (v.k * d).toFloat()
        withTransform({
            translate((v.x * d).toFloat(), (v.y * d).toFloat())
            scale(s, s, Offset.Zero)
        }) {
            drawCircle(c.rule2, radius = (R * MemoryLinks.CORE).toFloat(), center = Offset.Zero, style = Stroke(width = 1f / s))
            drawPath(base, c.fg.copy(alpha = if (c.dark) 0.09f else 0.08f), style = Stroke(width = 1f / s))
            drawPath(ticks, c.fg3.copy(alpha = 0.8f), style = Stroke(width = 1f / s))
            for (a in hud.areas) {
                val r = (R + 28).toFloat()
                drawArc(c.fg3, startAngle = Math.toDegrees(a.a0).toFloat(), sweepAngle = Math.toDegrees(a.a1 - a.a0).toFloat(), useCenter = false, topLeft = Offset(-r, -r), size = Size(2 * r, 2 * r), style = Stroke(width = 1.5f / s))
            }
            if (pickedAt != null) {
                drawPath(lit, c.signal.copy(alpha = 0.85f), style = Stroke(width = 1.6f / s))
                val a = hud.angle[pickedAt]
                drawLine(c.signal, Offset((cos(a) * (R - 6)).toFloat(), (sin(a) * (R - 6)).toFloat()), Offset((cos(a) * (R + 24)).toFloat(), (sin(a) * (R + 24)).toFloat()), strokeWidth = 2.5f / s)
            }
        }
        // area names, horizontal, outside the arcs; a name that would touch another waits
        val boxes = Boxes()
        val order = hud.areas.sortedByDescending { it.items.size }
        for (a in order) {
            val mid = (a.a0 + a.a1) / 2
            val px = ((cos(mid) * (R + 52) * v.k + v.x) * d).toFloat()
            val py = ((sin(mid) * (R + 52) * v.k + v.y) * d).toFloat()
            val t = labels.get("${a.name} ${MemoryMaps.num(a.items.size)}", styles.meta.copy(color = c.fg2))
            val left = if (cos(mid) < -0.2) px - t.size.width else if (cos(mid) > 0.2) px else px - t.size.width / 2f
            val r = Rect(left, py - t.size.height / 2f, left + t.size.width, py + t.size.height / 2f)
            if (boxes.claim(r.inflate(3f * d))) drawText(t, topLeft = r.topLeft)
        }
        if (pickedAt != null) pickedLabel(this, labels, styles.title.copy(color = c.fg), ix, links.items[pickedAt].id, hud.angle[pickedAt], v, d, c.bgRaise, c.rule2)
    }
}

private fun pickedLabel(s: DrawScope, labels: Labels, style: TextStyle, ix: MemoryIndex, id: String, a: Double, v: MapViewport, d: Float, plate: Color, rule: Color) {
    val n = ix.byId[id] ?: return
    with(s) { pickedCard(labels, style, MemoryMaps.nodeLabel(n), a, v, d, plate, rule) }
}

private fun DrawScope.pickedCard(labels: Labels, style: TextStyle, title: String, a: Double, v: MapViewport, d: Float, plate: Color, rule: Color) {
    val R = MemoryLinks.R
    val px = ((cos(a) * (R * 0.62) * v.k + v.x) * d).toFloat()
    val py = ((sin(a) * (R * 0.62) * v.k + v.y) * d).toFloat()
    val t = labels.get(title, style, (200 * d).toInt())
    val w = t.size.width + 16 * d
    val h = t.size.height + 10 * d
    val x = (px - w / 2).coerceIn(4 * d, size.width - w - 4 * d)
    val y = (py - h / 2).coerceIn(4 * d, size.height - h - 4 * d)
    drawRoundRect(plate, Offset(x, y), Size(w, h), CornerRadius(4 * d))
    drawRoundRect(rule, Offset(x, y), Size(w, h), CornerRadius(4 * d), style = Stroke(1f))
    drawText(t, topLeft = Offset(x + 8 * d, y + 5 * d))
}

private fun bezier(p: Path, pts: FloatArray) {
    p.moveTo(pts[0], pts[1])
    var o = 2
    while (o + 5 < pts.size) {
        p.cubicTo(pts[o], pts[o + 1], pts[o + 2], pts[o + 3], pts[o + 4], pts[o + 5])
        o += 6
    }
}

/** The links a phone draws: mentions off as on the web, at most PHONE_CAP, every item's strongest first. */
private fun drawnEdges(g: MemoryGraph, l: dev.conclave.client.logic.LinkLayout): IntArray {
    val on = BooleanArray(l.edges.size) { MemoryLinks.edgeOn(l, l.edges[it], dev.conclave.client.logic.LinkFilter(setOf("mentions"))) }
    val deg = IntArray(l.items.size) { g.nodes[l.items[it].node].degree }
    return MemoryLinks.pickEdges(l, on, PHONE_CAP, deg)
}

// ----- 3D --------------------------------------------------------------------------

@Composable
fun MemoryHoloCanvas(g: MemoryGraph, ix: MemoryIndex, mode: HoloMode, picked: String?, onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val d = LocalDensity.current.density
    val measurer = rememberTextMeasurer(cacheSize = 32)
    val styles = rememberLabelStyles()
    val labels = remember(measurer, styles) { Labels(measurer) }
    val links = remember(g, ix) { MemoryLinks.layoutLinks(g, ix) }
    val holo = remember(links, mode) { MemoryLinks.layoutHolo(links, g.nodes, mode) }
    val drawn = remember(links) { drawnEdges(g, links) }
    val curves = remember(holo, drawn) {
        val out = FloatArray(drawn.size * SEG * 6)
        drawn.forEachIndexed { k, e -> MemoryLinks.linkCurve(holo, links, e, SEG, out, k * SEG * 6) }
        out
    }
    val n = links.items.size
    val deg = remember(links) { IntArray(n) { g.nodes[links.items[it].node].degree } }
    val hot = remember(deg) { deg.sortedDescending().getOrElse(n / 12) { 0 }.coerceAtLeast(3) }
    // orbit: yaw round y, pitch round x, the camera's distance from the origin
    // Timeline as the web's home on a phone: square to history, looking down from (0, 0.7, 1)·d, with
    // d fitting 1.2 SPAN across the width (f below spans FOV over the narrower side, the width on a phone)
    var yaw by remember(mode) { mutableStateOf(if (mode == HoloMode.TIMELINE) 0.0 else 0.6) }
    var pitch by remember(mode) { mutableStateOf(if (mode == HoloMode.TIMELINE) atan(0.7) else 0.3) }
    var dist by remember(holo) {
        mutableStateOf(if (mode == HoloMode.TIMELINE) MemoryLinks.SPAN * 0.6 / tan(Math.toRadians(FOV / 2)) * hypot(1.0, 0.7) else holo.extent * 2.5)
    }
    var size by remember { mutableStateOf(Size.Zero) }
    val sx = remember(n) { FloatArray(n) }
    val sy = remember(n) { FloatArray(n) }
    val seen = remember(n) { BooleanArray(n) }
    val pick by rememberUpdatedState(onPick)
    val pickedAt = picked?.let { links.byId[it] }

    val linkPaint = remember { android.graphics.Paint().apply { isAntiAlias = true; style = android.graphics.Paint.Style.STROKE } }
    val dotPaint = remember { android.graphics.Paint().apply { isAntiAlias = true; strokeCap = android.graphics.Paint.Cap.ROUND } }

    Canvas(
        modifier
            .onSizeChanged { size = Size(it.width.toFloat(), it.height.toFloat()) }
            .pointerInput(holo) {
                detectTransformGestures { _, pan, zoom, _ ->
                    yaw += pan.x / d * 0.008
                    pitch = (pitch + pan.y / d * 0.008).coerceIn(-1.45, 1.45)
                    dist = (dist / zoom).coerceIn(holo.extent * 0.35, holo.extent * 5)
                }
            }
            .pointerInput(holo) {
                detectTapGestures(onTap = { pos ->
                    var best = -1
                    var bd = 22f * d
                    for (i in 0 until n) {
                        if (!seen[i]) continue
                        val dd = hypot(sx[i] - pos.x, sy[i] - pos.y)
                        if (dd < bd) {
                            bd = dd
                            best = i
                        }
                    }
                    if (best >= 0) pick(links.items[best].id)
                })
            }
            .semantics { contentDescription = if (mode == HoloMode.CLUSTERS) "Memory map in 3D, areas as clusters" else "Memory map in 3D, along a timeline" },
    ) {
        val cx = size.width / 2
        val cy = size.height / 2
        val f = (min(size.width, size.height) / 2 / tan(Math.toRadians(FOV / 2))).toFloat()
        val cyw = cos(yaw).toFloat()
        val syw = sin(yaw).toFloat()
        val cp = cos(pitch).toFloat()
        val sp = sin(pitch).toFloat()
        val dz = dist.toFloat()
        val near = 1f
        // world to screen; NaN when behind the camera
        val out = FloatArray(3)
        fun project(x: Float, y: Float, z: Float): Boolean {
            val x1 = x * cyw + z * syw
            val z1 = -x * syw + z * cyw
            val y2 = y * cp - z1 * sp
            val z2 = y * sp + z1 * cp + dz
            if (z2 < near) return false
            val s = f / z2
            out[0] = cx + x1 * s
            out[1] = cy - y2 * s
            out[2] = z2
            return true
        }
        for (i in 0 until n) {
            seen[i] = project(holo.pos[i * 3], holo.pos[i * 3 + 1], holo.pos[i * 3 + 2])
            sx[i] = out[0]
            sy[i] = out[1]
        }
        val segs = FloatArray(curves.size / 6 * 4)
        var m = 0
        var o = 0
        while (o < curves.size) {
            if (project(curves[o], curves[o + 1], curves[o + 2])) {
                val ax = out[0]
                val ay = out[1]
                if (project(curves[o + 3], curves[o + 4], curves[o + 5])) {
                    segs[m++] = ax
                    segs[m++] = ay
                    segs[m++] = out[0]
                    segs[m++] = out[1]
                }
            }
            o += 6
        }
        drawIntoCanvas { canvas ->
            val nc = canvas.nativeCanvas
            // the time axis under everything
            if (mode == HoloMode.TIMELINE && project((-MemoryLinks.SPAN / 2).toFloat(), 0f, 0f)) {
                val ax = out[0]
                val ay = out[1]
                if (project((MemoryLinks.SPAN / 2 + 200).toFloat(), 0f, 0f)) {
                    linkPaint.color = c.fg3.toArgb()
                    linkPaint.strokeWidth = 1f * d
                    nc.drawLine(ax, ay, out[0], out[1], linkPaint)
                }
            }
            linkPaint.color = c.signal.copy(alpha = if (c.dark) 0.2f else 0.26f).toArgb()
            linkPaint.strokeWidth = 0.8f * d
            nc.drawLines(segs, 0, m, linkPaint)
            if (pickedAt != null) {
                linkPaint.color = c.signal.toArgb()
                linkPaint.strokeWidth = 1.6f * d
                for (e in links.edgesOf[pickedAt]) {
                    val a = links.edges[e].a
                    val b = links.edges[e].b
                    if (seen[a] && seen[b]) nc.drawLine(sx[a], sy[a], sx[b], sy[b], linkPaint)
                }
            }
            // points: faint at rest, fuller the more linked, the most linked brighter
            for (pass in 0..1) {
                dotPaint.color = (if (pass == 0) c.signal.copy(alpha = 0.55f) else (if (c.dark) c.waveHot else c.signal)).toArgb()
                dotPaint.strokeWidth = (if (pass == 0) 2.6f else 4.2f) * d
                val pts = FloatArray(n * 2)
                var k = 0
                for (i in 0 until n) if (seen[i] && (deg[i] >= hot) == (pass == 1)) {
                    pts[k++] = sx[i]
                    pts[k++] = sy[i]
                }
                nc.drawPoints(pts, 0, k, dotPaint)
            }
        }
        val boxes = Boxes()
        // the origin's label, then the areas', then month ticks on the Timeline
        if (mode == HoloMode.CLUSTERS && project(0f, 0f, 0f)) {
            drawCircle(c.fg, radius = 3f * d, center = Offset(out[0], out[1]))
            val t = labels.get("Memory ${MemoryMaps.num(n)}", styles.meta.copy(color = c.fg2))
            val r = Rect(out[0] + 6 * d, out[1] - t.size.height / 2f, out[0] + 6 * d + t.size.width, out[1] + t.size.height / 2f)
            if (boxes.claim(r)) drawText(t, topLeft = r.topLeft)
        }
        if (pickedAt != null && seen[pickedAt]) {
            val p = Offset(sx[pickedAt], sy[pickedAt])
            drawCircle(c.signal, radius = 7f * d, center = p, style = Stroke(1.5f * d))
            drawCircle(c.fg, radius = 2.5f * d, center = p)
            val t = labels.get(MemoryMaps.nodeLabel(ix.byId[links.items[pickedAt].id]!!), styles.title.copy(color = c.fg), (180 * d).toInt())
            val w = t.size.width + 14 * d
            val h = t.size.height + 8 * d
            val x = (p.x + 16 * d).let { if (it + w > size.width - 4 * d) p.x - 16 * d - w else it }
            val y = (p.y - 34 * d).coerceIn(4 * d, size.height - h - 4 * d)
            drawLine(c.signal, p, Offset(if (x > p.x) x else x + w, y + h / 2), strokeWidth = 1f * d)
            drawRoundRect(c.bgRaise, Offset(x, y), Size(w, h), CornerRadius(4 * d))
            drawRoundRect(c.rule2, Offset(x, y), Size(w, h), CornerRadius(4 * d), style = Stroke(1f))
            drawText(t, topLeft = Offset(x + 7 * d, y + 4 * d))
            boxes.claim(Rect(x, y, x + w, y + h))
        }
        val order = links.areas.indices.sortedByDescending { links.areas[it].to - links.areas[it].from }
        for (a in order) {
            if (!project(holo.centers[a * 3], holo.centers[a * 3 + 1] + (if (mode == HoloMode.CLUSTERS) holo.radius[a] else 0f), holo.centers[a * 3 + 2])) continue
            val ar = links.areas[a]
            val t = labels.get("${ar.name} ${MemoryMaps.num(ar.to - ar.from)}", styles.meta.copy(color = c.fg))
            val r = Rect(out[0] - t.size.width / 2f, out[1] - t.size.height - 4 * d, out[0] + t.size.width / 2f, out[1] - 4 * d)
            if (r.right < 0 || r.left > size.width || r.bottom < 0 || r.top > size.height) continue
            if (boxes.claim(r.inflate(3 * d))) drawText(t, topLeft = r.topLeft)
        }
        if (mode == HoloMode.TIMELINE) for (tk in holo.ticks.filter { it.year } + holo.ticks.filter { !it.year }) {
            if (!project(tk.x.toFloat(), 0f, 0f)) continue
            val t = labels.get(tk.label, styles.meta.copy(color = c.fg3))
            val r = Rect(out[0] - t.size.width / 2f, out[1] + 6 * d, out[0] + t.size.width / 2f, out[1] + 6 * d + t.size.height)
            if (boxes.claim(r.inflate(4 * d))) {
                drawLine(c.fg3, Offset(out[0], out[1] - 4 * d), Offset(out[0], out[1] + 4 * d), strokeWidth = 1f * d)
                drawText(t, topLeft = r.topLeft)
            }
        }
    }
}
