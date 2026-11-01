package dev.conclave.client.logic

import java.util.Base64

/*
 * The two pictures the hub sends as SVG, read into something the phone can
 * draw on a Canvas (Android has no SVG view):
 *
 *   QrCode     the invite's QR code (FriendInvite.qrSvg), as the qrcode
 *              package writes it: one stroked path of runs, "M x y+0.5 h n
 *              m dx 0 h n ...", inside a viewBox of the code's size.
 *   MapsPicture  a maps card's picture drawn from OpenStreetMap tiles
 *              (core maps/osm.ts): rects, tile images as base64 PNG, the
 *              route as paths, markers as circles with a letter, and the
 *              attribution text.
 *
 * Both only read what the hub writes; anything else is left out.
 */

/** A QR code as modules: [size] by [size], true where dark. */
class QrMatrix(val size: Int, private val dark: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = x in 0 until size && y in 0 until size && dark[y * size + x]

    /** Dark modules, for a test or a quick count. */
    val count: Int get() = dark.count { it }
}

object QrCode {
    private val VIEW_BOX = Regex("""viewBox="0 0 (\d+) (\d+)"""")
    private val STROKE_PATH = Regex("""<path[^>]*\sstroke="[^"]*"[^>]*\sd="([^"]*)"""")
    private val STROKE_PATH_D_FIRST = Regex("""<path[^>]*\sd="([^"]*)"[^>]*\sstroke="[^"]*"""")
    private val COMMAND = Regex("""([MmHhVv])\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?""")

    /** The modules of the QR code in [svg], or null when it is not one the hub wrote. */
    fun parse(svg: String): QrMatrix? {
        val vb = VIEW_BOX.find(svg) ?: return null
        val size = vb.groupValues[1].toIntOrNull() ?: return null
        if (size <= 0 || size > 400 || vb.groupValues[2].toIntOrNull() != size) return null
        val d = (STROKE_PATH.find(svg) ?: STROKE_PATH_D_FIRST.find(svg))?.groupValues?.get(1) ?: return null
        val dark = BooleanArray(size * size)
        var x = 0.0
        var y = 0.0
        // a run only ever marks modules inside the code: clamped to it, so a huge or odd number cannot loop for long
        fun mark(row: Int, from: Long, to: Long) {
            if (row !in 0 until size) return
            val lo = maxOf(0L, minOf(from, to)).toInt()
            val hi = minOf(size.toLong(), maxOf(from, to)).toInt()
            for (c in lo until hi) dark[row * size + c] = true
        }
        for (m in COMMAND.findAll(d)) {
            val a = m.groupValues[2].toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
            val b = m.groupValues[3].toDoubleOrNull()?.let { if (it.isFinite()) it else return null }
            when (m.groupValues[1]) {
                "M" -> {
                    x = a
                    y = b ?: return null
                }
                "m" -> {
                    x += a
                    y += b ?: 0.0
                }
                "h" -> {
                    // a run of dark modules on the row the stroke's middle is in
                    mark(kotlin.math.floor(y).toInt(), Math.round(x), Math.round(x + a))
                    x += a
                }
                "H" -> {
                    val from = Math.round(x)
                    val to = Math.round(a)
                    if (to > from) mark(kotlin.math.floor(y).toInt(), from, to)
                    x = a
                }
                "v" -> y += a
                "V" -> y = a
            }
        }
        return QrMatrix(size, dark)
    }
}

/** One thing a maps picture draws, in its own units (the picture's width and height). */
sealed class PictureOp {
    data class Rect(val x: Double, val y: Double, val w: Double, val h: Double, val fill: Long, val opacity: Double) : PictureOp()

    /** A tile: PNG bytes. */
    class Image(val x: Double, val y: Double, val w: Double, val h: Double, val png: ByteArray) : PictureOp()

    /** A route: points joined by lines. */
    data class Line(val points: List<Pair<Double, Double>>, val stroke: Long, val width: Double, val opacity: Double) : PictureOp()

    data class Circle(val cx: Double, val cy: Double, val r: Double, val fill: Long, val stroke: Long?, val strokeWidth: Double) : PictureOp()

    /** [anchor]: start, middle or end. [dy]: the baseline below y. */
    data class Text(val x: Double, val y: Double, val dy: Double, val text: String, val size: Double, val bold: Boolean, val fill: Long, val anchor: String) : PictureOp()
}

/** A maps picture: its size and what it draws, in order. */
class MapsPicture(val width: Double, val height: Double, val ops: List<PictureOp>) {
    companion object {
        private val SVG_SIZE = Regex("""<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"""")
        private val TAG = Regex("""<(rect|image|path|circle|text)\b([^>]*?)(/>|>([^<]*)</text>)""")
        private val ATTR = Regex("""([a-zA-Z-]+)="([^"]*)"""")

        private fun color(v: String?): Long? {
            val s = v?.trim()?.removePrefix("#") ?: return null
            val hex = when (s.length) {
                3 -> s.map { "$it$it" }.joinToString("")
                6 -> s
                else -> return null
            }
            return hex.toLongOrNull(16)?.let { 0xFF000000L or it }
        }

        private fun unescape(s: String): String = s
            .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&")

        /** The points of a route path: "M x y L x y L x y". */
        private fun points(d: String): List<Pair<Double, Double>> {
            val nums = Regex("""-?[\d.]+""").findAll(d).mapNotNull { it.value.toDoubleOrNull()?.takeIf { v -> v.isFinite() } }.toList()
            return (0 until nums.size / 2).map { nums[it * 2] to nums[it * 2 + 1] }
        }

        /** The picture in [svg], or null when it is not one the hub drew. */
        fun parse(svg: String): MapsPicture? {
            val size = SVG_SIZE.find(svg) ?: return null
            val w = size.groupValues[1].toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 } ?: return null
            val h = size.groupValues[2].toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 } ?: return null
            val ops = ArrayList<PictureOp>()
            // the picture's own title is the alt text the card shows already
            val body = svg.replace(Regex("""<title>.*?</title>""", RegexOption.DOT_MATCHES_ALL), "")
            for (m in TAG.findAll(body)) {
                val a = ATTR.findAll(m.groupValues[2]).associate { it.groupValues[1] to it.groupValues[2] }
                // "NaN" and "Infinity" read as numbers too: they would close the app where a size or place is rounded
                fun num(k: String, def: Double = 0.0) = a[k]?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: def
                when (m.groupValues[1]) {
                    "rect" -> ops += PictureOp.Rect(num("x"), num("y"), num("width", w), num("height", h), color(a["fill"]) ?: continue, num("opacity", 1.0))
                    "image" -> {
                        val href = a["href"] ?: a["xlink:href"] ?: continue
                        if (!href.startsWith("data:image/png;base64,")) continue
                        val png = try {
                            Base64.getDecoder().decode(href.substringAfter(","))
                        } catch (_: IllegalArgumentException) {
                            continue
                        }
                        ops += PictureOp.Image(num("x"), num("y"), num("width"), num("height"), png)
                    }
                    "path" -> {
                        val pts = points(a["d"] ?: continue)
                        if (pts.size < 2 || a["fill"] != "none") continue
                        ops += PictureOp.Line(pts, color(a["stroke"]) ?: continue, num("stroke-width", 1.0), num("opacity", 1.0))
                    }
                    "circle" -> ops += PictureOp.Circle(num("cx"), num("cy"), num("r"), color(a["fill"]) ?: continue, color(a["stroke"]), num("stroke-width"))
                    "text" -> {
                        val text = unescape(m.groupValues[4]).trim()
                        if (text.isEmpty()) continue
                        ops += PictureOp.Text(num("x"), num("y"), num("dy"), text, num("font-size", 12.0).coerceIn(1.0, 200.0), (a["font-weight"]?.toIntOrNull() ?: 400) >= 600, color(a["fill"]) ?: 0xFF333333L, a["text-anchor"] ?: "start")
                    }
                }
            }
            return MapsPicture(w, h, ops)
        }

        /** An SVG the hub sent, by its content type or its first bytes. */
        fun isSvg(contentType: String, bytes: ByteArray): Boolean {
            if (contentType.contains("svg", ignoreCase = true)) return true
            val head = bytes.copyOfRange(0, minOf(bytes.size, 64)).decodeToString().trimStart()
            return head.startsWith("<svg") || head.startsWith("<?xml")
        }
    }
}
