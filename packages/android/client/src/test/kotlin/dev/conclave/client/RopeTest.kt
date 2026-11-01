package dev.conclave.client

import dev.conclave.client.motion.KnotGeometry
import dev.conclave.client.motion.KnotMotion
import dev.conclave.client.motion.KnotState
import dev.conclave.client.motion.ROPE_LEAD
import dev.conclave.client.motion.ROPE_OVER
import dev.conclave.client.motion.ROPE_UNDER
import dev.conclave.client.motion.RopeGeometry
import dev.conclave.client.motion.RopeLight
import dev.conclave.client.motion.RopeMoment
import dev.conclave.client.motion.easeInOutCubic
import dev.conclave.client.motion.knotBrand
import dev.conclave.client.motion.knotStill
import dev.conclave.client.motion.ropeBox
import dev.conclave.client.motion.ropeCamera
import dev.conclave.client.motion.ropeCameraAt
import dev.conclave.client.motion.ropeCaps
import dev.conclave.client.motion.ropeCinch
import dev.conclave.client.motion.ropeDuration
import dev.conclave.client.motion.ropeHeadFrom
import dev.conclave.client.motion.ropeHeadTo
import dev.conclave.client.motion.ropeLapAt
import dev.conclave.client.motion.ropeLapTo
import dev.conclave.client.motion.ropePoint
import dev.conclave.client.motion.ropePose
import dev.conclave.client.motion.ropeRest
import dev.conclave.client.motion.ropeRing
import dev.conclave.client.motion.ropeSpan
import dev.conclave.client.motion.ropeSwap
import dev.conclave.client.motion.ropeW
import java.io.File
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The rope (docs/design/KNOT-MOTION.md): RopeGeometry, generated from
 * docs/design/brand/knot.json (checked here), and the rope math in
 * dev.conclave.client.motion, a port of the rope section of
 * packages/web/src/components/motion/knotMath.ts. The same cases as
 * packages/web/test/knot-rope.test.ts.
 */
class RopeTest {
    private fun near(expected: Double, actual: Double, eps: Double = 1e-6, what: String = "") =
        assertTrue(abs(expected - actual) <= eps, "$what expected $expected, got $actual")

    private val paths = RopeGeometry.PATHS
    private val knot = paths.filter { it.kind != ROPE_LEAD }
    private fun path(i: Int) = paths[i]
    private val IN = 0
    private val K0 = 1
    private val K1 = 2
    private val K2 = 3
    private val K3 = 4
    private val K4 = 5
    private val K5 = 6
    private val K6 = 7
    private val OUT = 8

    private fun repoFile(p: String): File? {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val f = File(dir, p)
            if (f.isFile) return f
            dir = dir.parentFile
        }
        return null
    }

    private fun knotJson(): JsonObject {
        val f = repoFile("docs/design/brand/knot.json")
        assertNotNull(f, "docs/design/brand/knot.json")
        return Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun pointsOf(d: String): FloatArray =
        Regex("(-?[\\d.]+) (-?[\\d.]+)").findAll(d).flatMap { m -> sequenceOf(m.groupValues[1].toFloat(), m.groupValues[2].toFloat()) }.toList().toFloatArray()

    private fun span(p: Int, a: Double, b: Double): DoubleArray? {
        val out = DoubleArray(2)
        return if (ropeSpan(path(p).from, path(p).length, a, b, out)) out else null
    }

    private fun ring(p: Int, a: Double, b: Double): List<Pair<Double, Double>> {
        val out = DoubleArray(4)
        val n = ropeRing(path(p).from, path(p).length, a, b, out)
        return (0 until n).map { out[2 * it] to out[2 * it + 1] }
    }

    // -- geometry ------------------------------------------------------------

    @Test
    fun geometryIsKnotJson() {
        val rope = knotJson()["rope"]!!.jsonObject
        val list = rope["paths"]!!.jsonArray
        assertEquals(list.size, paths.size)
        list.forEachIndexed { i, e ->
            val o = e.jsonObject
            val kind = when (o["kind"]!!.jsonPrimitive.content) {
                "lead" -> ROPE_LEAD
                "under" -> ROPE_UNDER
                else -> ROPE_OVER
            }
            assertEquals(kind, paths[i].kind, "path $i kind")
            near(o["from"]!!.jsonPrimitive.double, paths[i].from, 1e-9, "path $i from")
            near(o["length"]!!.jsonPrimitive.double, paths[i].length, 1e-9, "path $i length")
            assertTrue(pointsOf(o["d"]!!.jsonPrimitive.content).contentEquals(paths[i].points), "path $i points")
        }
        val halos = rope["halos"]!!.jsonArray
        halos.forEachIndexed { i, e ->
            assertTrue(pointsOf(e.jsonObject["d"]!!.jsonPrimitive.content).contentEquals(RopeGeometry.HALOS[i]), "halo $i")
            near(e.jsonObject["from"]!!.jsonPrimitive.double, RopeGeometry.HALO_FROM[i], 1e-9)
        }
        near(rope["light"]!!.jsonObject["home"]!!.jsonPrimitive.double, RopeGeometry.LIGHT_HOME, 1e-9)
    }

    @Test
    fun sevenSegmentsOverAndUnder() {
        val from = doubleArrayOf(100.0, 111.07, 128.71, 144.41, 162.05, 177.74, 195.38)
        val len = doubleArrayOf(11.07, 17.64, 15.7, 17.64, 15.69, 17.64, 4.62)
        knot.forEachIndexed { i, p ->
            assertEquals(if (i % 2 == 0) ROPE_OVER else ROPE_UNDER, p.kind, "k$i kind")
            near(from[i], p.from, 1e-9, "k$i from")
            near(len[i], p.length, 1e-9, "k$i length")
        }
        near(100.0, knot.sumOf { it.length }, 1e-6)
    }

    @Test
    fun theStillMarkPiecesUnchanged() {
        for (i in 0 until 5) assertTrue(KnotGeometry.PIECES[i].points.contentEquals(knot[i + 1].points), "k${i + 1}")
        val k6 = path(K6).points
        val k0 = path(K0).points
        assertTrue((k6 + k0.copyOfRange(2, k0.size)).contentEquals(KnotGeometry.PIECES[5].points), "k6 then k0 is the last piece")
    }

    @Test
    fun oneRope() {
        for (i in 1 until paths.size) {
            val prev = paths[i - 1]
            val p = paths[i]
            near(p.from, prev.from + prev.length, 1e-6, "path $i from")
            assertEquals(prev.points[prev.points.size - 2], p.points[0], "path $i x")
            assertEquals(prev.points[prev.points.size - 1], p.points[1], "path $i y")
        }
        near(-40.0, paths.first().from)
        near(350.0, paths.last().from + paths.last().length)
        for (p in paths) {
            var len = 0.0
            for (i in 2 until p.points.size step 2) len += hypot((p.points[i] - p.points[i - 2]).toDouble(), (p.points[i + 1] - p.points[i - 1]).toDouble())
            assertTrue(abs(len / p.length / 2.0534 - 1) < 0.002, "one unit is the same length everywhere")
        }
    }

    // -- the window ----------------------------------------------------------

    @Test
    fun windowOnEachPath() {
        val a = span(IN, 0.0, 100.0)!!
        near(40.0, a[0])
        near(140.0, a[1])
        for (i in K0..K6) assertEquals(null, span(i, 0.0, 100.0))
        for (i in K0..K6) near(path(i).length, span(i, 100.0, 200.0)!![1])
        assertEquals(null, span(IN, 100.0, 200.0))
        assertEquals(null, span(OUT, 100.0, 200.0))
        near(150 - 144.41, span(K3, 50.0, 150.0)!![1])
        assertEquals(null, span(K4, 50.0, 150.0))
    }

    @Test
    fun roundTheKnot() {
        val r5 = ring(K5, 190.0, ropeLapTo(190.0))
        near(190 - 177.74, r5[0].first)
        near(4.62, ring(K6, 190.0, 206.0)[0].second)
        near(6.0, ring(K0, 190.0, 206.0)[0].second)
        assertEquals(0, ring(K1, 190.0, 206.0).size)
        assertEquals(ring(K0, 190.0, 206.0), ring(K0, 290.0, 306.0))
        val two = ring(K0, 105.0, 202.0)
        assertEquals(2, two.size)
        near(2.0, two[0].second)
        near(5.0, two[1].first)
    }

    @Test
    fun headLightTiedIsTheLapLightAtHome() {
        near(184.0, ropeHeadFrom(100.0))
        near(200.0, ropeHeadTo(100.0))
        for (i in K0..K6) {
            val head = span(i, ropeHeadFrom(100.0), ropeHeadTo(100.0))
            val lap = ring(i, RopeGeometry.LIGHT_HOME, ropeLapTo(RopeGeometry.LIGHT_HOME))
            if (head == null) assertEquals(0, lap.size) else {
                assertEquals(1, lap.size)
                near(head[0], lap[0].first)
                near(head[1], lap[0].second)
            }
        }
    }

    // -- moments -------------------------------------------------------------

    @Test
    fun launch() {
        val m = RopeGeometry.LAUNCH
        val tied = m.straight + m.move
        near(0.0, ropeW(m, 0.0))
        near(0.0, ropeW(m, m.straight))
        near(50.0, ropeW(m, m.straight + m.move / 2))
        near(100 * easeInOutCubic(0.25), ropeW(m, m.straight + m.move / 4))
        near(100.0, ropeW(m, tied))
        var last = -1.0
        var t = 0.0
        while (t <= tied) {
            val w = ropeW(m, t)
            assertTrue(w >= last)
            last = w
            t += 10
        }
        near(184.0, ropeLapAt(m, tied + m.lapAt))
        near(234.0, ropeLapAt(m, tied + m.lapAt + m.lap / 2))
        near(284.0, ropeLapAt(m, tied + m.lapAt + m.lap))
        near(0.0, ropePose(RopeMoment.LAUNCH, 0.0).fade)
        near(1.0, ropePose(RopeMoment.LAUNCH, m.fade).fade)
        near(250.0, m.straight)
        near(1600.0, m.move)
        near(450.0, m.cinch)
        near(1000.0, m.lap)
    }

    @Test
    fun theSwap() {
        val m = RopeGeometry.LAUNCH
        val tied = m.straight + m.move
        assertEquals(RopeLight.HEAD, ropeSwap(m, tied - 1))
        assertEquals(RopeLight.LAP, ropeSwap(m, tied))
        near(ropeHeadFrom(ropeW(m, tied)), ropeLapAt(m, tied))
        val r = RopeGeometry.RECEIVE
        assertEquals(RopeLight.HEAD, ropeSwap(r, r.move - 1))
        assertEquals(RopeLight.LAP, ropeSwap(r, r.move))
        for (t in doubleArrayOf(0.0, 100.0, 1250.0, 2500.0, 4000.0)) assertEquals(RopeLight.HEAD, ropeSwap(RopeGeometry.SEND, t))
    }

    @Test
    fun cinch() {
        near(1.0, ropeCinch(-0.1))
        near(1.0, ropeCinch(0.0))
        near(0.93, ropeCinch(0.32))
        near(1.025, ropeCinch(0.68))
        near(1.0, ropeCinch(1.0))
        val m = RopeGeometry.LAUNCH
        near(0.93, ropePose(RopeMoment.LAUNCH, m.straight + m.move + 0.32 * m.cinch).cinch)
    }

    @Test
    fun receiveAndSend() {
        val r = RopeGeometry.RECEIVE
        near(-36.0, ropeW(r, 0.0))
        near(100.0, ropeW(r, r.move))
        val b = DoubleArray(4)
        assertTrue(ropeBox(-36.0, 64.0, b))
        assertTrue(b[0] > 96)
        val s = RopeGeometry.SEND
        near(100.0, ropeW(s, 0.0))
        near(100 + 150 * 0.5.pow(2.2), ropeW(s, s.move / 2))
        near(250.0, ropeW(s, s.move))
        assertTrue(ropeBox(250.0, 350.0, b))
        assertTrue(b[2] < -32)
    }

    @Test
    fun run() {
        val p0 = ropePose(RopeMoment.RUN, 0.0)
        assertEquals(RopeLight.RUN, p0.light)
        near(166.0, p0.run)
        near(266.0, ropePose(RopeMoment.RUN, 2400.0).run)
        near(216.0, ropePose(RopeMoment.RUN, 1200.0).run)
        near(200.0, p0.run + RopeGeometry.RUN_LENGTH)
    }

    @Test
    fun success() {
        val spin = RopeGeometry.SUCCESS_SPIN
        near(184.0, ropePose(RopeMoment.SUCCESS, 0.0).lap)
        near(384.0, ropePose(RopeMoment.SUCCESS, spin).lap)
        assertTrue(ropePose(RopeMoment.SUCCESS, spin * 0.5).lap - 184 > 0.75 * 200)
        near(0.0, ropePose(RopeMoment.SUCCESS, 0.0).trail)
        near(1.0, ropePose(RopeMoment.SUCCESS, spin * 0.4).trail)
        near(0.0, ropePose(RopeMoment.SUCCESS, spin).trail)
        near(1.0, ropePose(RopeMoment.SUCCESS, RopeGeometry.SUCCESS_CINCH_AT - 1).cinch)
        near(0.93, ropePose(RopeMoment.SUCCESS, RopeGeometry.SUCCESS_CINCH_AT + 0.32 * RopeGeometry.SUCCESS_CINCH).cinch)
        near(1.0, ropePose(RopeMoment.SUCCESS, RopeGeometry.SUCCESS_CINCH_AT + RopeGeometry.SUCCESS_CINCH).cinch)
    }

    @Test
    fun durations() {
        near(3095.0, ropeDuration(RopeMoment.LAUNCH))
        near(6080.0, ropeDuration(RopeMoment.LAUNCH_LONG))
        near(4500.0, ropeDuration(RopeMoment.RECEIVE))
        near(2500.0, ropeDuration(RopeMoment.SEND))
        near(1680.0, ropeDuration(RopeMoment.SUCCESS))
        assertEquals(Double.POSITIVE_INFINITY, ropeDuration(RopeMoment.RUN))
    }

    @Test
    fun tiedMomentsEndAtRest() {
        val rest = ropeRest()
        for (m in listOf(RopeMoment.LAUNCH, RopeMoment.LAUNCH_LONG, RopeMoment.RECEIVE, RopeMoment.SUCCESS)) {
            val p = ropePose(m, ropeDuration(m))
            near(100.0, p.w)
            near(1.0, p.cinch)
            near(0.0, p.trail)
            for (i in K0..K6) assertEquals(ring(i, rest.lap, ropeLapTo(rest.lap)).map { Math.round(it.first * 1e6) to Math.round(it.second * 1e6) }, ring(i, p.lap, ropeLapTo(p.lap)).map { Math.round(it.first * 1e6) to Math.round(it.second * 1e6) }, "$m on path $i")
        }
    }

    // -- where things are ----------------------------------------------------

    @Test
    fun points() {
        val pt = DoubleArray(2)
        ropePoint(100.0, pt)
        near(43.97, pt[0], 1e-4)
        near(52.37, pt[1], 1e-4)
        ropePoint(200.0, pt)
        near(43.97, pt[0], 1e-4)
        ropePoint(-100.0, pt)
        near(path(IN).points[0].toDouble(), pt[0], 1e-4)
        ropePoint(30.0, pt)
        near((path(IN).points[0] + path(IN).points[2]).toDouble() / 2, pt[0], 1e-3)
    }

    @Test
    fun boxes() {
        val b = DoubleArray(4)
        assertTrue(ropeBox(100.0, 200.0, b))
        near(10.0, b[0], 0.05)
        near(11.65, b[1], 0.05)
        near(54.0, b[2], 0.05)
        near(52.37, b[3], 0.05)
        assertTrue(ropeBox(0.0, 100.0, b))
        near(205.34, b[2] - b[0], 0.5)
        assertFalse(ropeBox(400.0, 500.0, b))
    }

    @Test
    fun roundEnds() {
        val out = DoubleArray(3)
        fun at(w: Double): List<Double> {
            val n = ropeCaps(ropeRest().copy(light = RopeLight.HEAD, w = w), out)
            return (0 until n).map { out[it] }
        }
        assertEquals(listOf(105.0), at(105.0))
        assertEquals(emptyList(), at(120.0))
        assertEquals(listOf(130.0), at(130.0))
        assertEquals(emptyList(), at(0.0))
        assertEquals(emptyList(), at(-36.0))
        assertEquals(listOf(130.0), at(30.0))
        assertEquals(emptyList(), at(200.0))
        assertEquals(listOf(111.07), at(11.07).map { Math.round(it * 1000) / 1000.0 })
        assertEquals(1, ropeCaps(ropeRest(), out))
        near(100.0, out[0])
        assertEquals(1, ropeCaps(ropePose(RopeMoment.RUN, 0.0).copy(run = 180.0), out))
        near(100.0, out[0])
        val n = ropeCaps(ropePose(RopeMoment.RUN, 0.0), out)
        assertEquals(2, n)
        near(166.0, out[0])
        near(200.0, out[1])
    }

    @Test
    fun launchCamera() {
        val vw = RopeGeometry.CAMERA_VIEW_W
        val vh = RopeGeometry.CAMERA_VIEW_H
        val start = ropeCameraAt(0.0, vw, vh, 5.2)
        near(0.5416, start.s, 1e-3)
        near(52.37, start.y, 1e-2)
        near(146.6, start.x, 0.5)
        assertEquals(1.0, ropeCameraAt(100.0, vw, vh, 5.2).s)
        val m = RopeGeometry.LAUNCH
        val end = m.straight + m.move
        assertEquals(start, ropeCamera(m, 0.0, vw, vh, 5.2))
        val last = ropeCamera(m, end, vw, vh, 5.2)
        near(1.0, last.s)
        near(32.0, last.x)
        near(32.0, last.y)
        var prev = start
        var t = 0.0
        val b = DoubleArray(4)
        while (t <= end + 300) {
            val c = ropeCamera(m, t, vw, vh, 5.2)
            assertTrue(c.s <= 1.0)
            assertTrue(abs(c.s - prev.s) < 0.01)
            assertTrue(hypot(c.x - prev.x, c.y - prev.y) < 1.5)
            val w = ropeW(m, t)
            ropeBox(w, w + 100, b)
            assertTrue(vw / 2 + c.s * (b[0] - 2.6 - c.x) > 0)
            assertTrue(vw / 2 + c.s * (b[2] + 2.6 - c.x) < vw)
            assertTrue(vh / 2 + c.s * (b[1] - 2.6 - c.y) > 0)
            assertTrue(vh / 2 + c.s * (b[3] + 2.6 - c.y) < vh)
            prev = c
            t += 4
        }
    }

    // -- the Knot settles into the mark -------------------------------------

    @Test
    fun brandLetsGoToTheHome() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        m.pose(3000.0 + 1400)
        m.set(KnotState.BRAND, 3000.0 + 1400)
        val start = m.pose(3000.0 + 1400)
        val end = m.pose(3000.0 + 1400 + 2000)
        near(16.0, end.head - end.tail)
        near(0.0, end.head % 100)
        near(1.0, end.light)
        assertTrue(end.head >= start.head)
        assertTrue(end.tail > start.tail)
        assertFalse(m.moving(3000.0 + 1400 + 2000))
        assertEquals(knotBrand(), knotStill(KnotState.BRAND))
        assertEquals(knotBrand(), KnotMotion(KnotState.BRAND, 0.0).pose(0.0))
    }
}
