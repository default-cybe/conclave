package dev.conclave.client

import dev.conclave.client.motion.Dur
import dev.conclave.client.motion.Ease
import dev.conclave.client.motion.Ink
import dev.conclave.client.motion.InkClock
import dev.conclave.client.motion.InkRun
import dev.conclave.client.motion.KNOT_LENGTH
import dev.conclave.client.motion.KNOT_LOOP
import dev.conclave.client.motion.KNOT_STILL
import dev.conclave.client.motion.KNOT_TOOL_LEN
import dev.conclave.client.motion.KNOT_TOOL_LOOP
import dev.conclave.client.motion.KNOT_TURN
import dev.conclave.client.motion.KnotGeometry
import dev.conclave.client.motion.KnotMotion
import dev.conclave.client.motion.KnotPose
import dev.conclave.client.motion.KnotState
import dev.conclave.client.motion.Loop
import dev.conclave.client.motion.Morph
import dev.conclave.client.motion.RimBox
import dev.conclave.client.motion.RimMode
import dev.conclave.client.motion.RimMotion
import dev.conclave.client.motion.RimState
import dev.conclave.client.motion.Roll
import dev.conclave.client.motion.SendStop
import dev.conclave.client.motion.Spring
import dev.conclave.client.motion.Steps
import dev.conclave.client.motion.Stream
import dev.conclave.client.motion.ToastStack
import dev.conclave.client.motion.knotBrand
import dev.conclave.client.motion.knotEase
import dev.conclave.client.motion.knotHalo
import dev.conclave.client.motion.knotLit
import dev.conclave.client.motion.knotSpan
import dev.conclave.client.motion.knotStill
import dev.conclave.client.motion.knotTravel
import dev.conclave.client.motion.knotWidth
import dev.conclave.client.motion.spring
import dev.conclave.client.motion.springSettle
import dev.conclave.client.motion.springStiffness
import java.io.File
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The motion math (dev.conclave.client.motion): the Knot's geometry, light
 * and states, Ink's pace, Roll, the Rim, Steps and the toast stack. The Knot
 * must match the web frame for frame: KnotGeometry is generated from
 * docs/design/brand/knot.json (checked here), and the motion is a port of
 * packages/web/src/components/motion/knotMath.ts (docs/design/CHAT-AND-MOTION.md 1.7).
 */
class MotionTest {
    private fun near(expected: Double, actual: Double, eps: Double = 1e-6, what: String = "") =
        assertTrue(abs(expected - actual) <= eps, "$what expected $expected, got $actual")

    private val KnotPose.len get() = head - tail

    /** Walks up from the working directory to the repo's docs. */
    private fun repoFile(path: String): File? {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val f = File(dir, path)
            if (f.isFile) return f
            dir = dir.parentFile
        }
        return null
    }

    // -- the knot's geometry -------------------------------------------------

    /** docs/design/brand/knot.json, the source the geometry is generated from. */
    private fun knotJson(): JsonObject {
        val f = repoFile("docs/design/brand/knot.json")
        assertNotNull(f, "docs/design/brand/knot.json")
        return Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun pointsOf(d: String): FloatArray =
        Regex("(-?[\\d.]+) (-?[\\d.]+)").findAll(d).flatMap { m -> sequenceOf(m.groupValues[1].toFloat(), m.groupValues[2].toFloat()) }.toList().toFloatArray()

    @Test
    fun geometryIsKnotJson() {
        val doc = knotJson()
        val pieces = doc["pieces"]!!.jsonArray
        assertEquals(pieces.size, KnotGeometry.PIECES.size)
        pieces.forEachIndexed { i, e ->
            val o = e.jsonObject
            val p = KnotGeometry.PIECES[i]
            assertEquals(o["kind"]!!.jsonPrimitive.content == "over", p.over, "piece $i kind")
            near(o["from"]!!.jsonPrimitive.double, p.from, 1e-9, "piece $i from")
            near(o["length"]!!.jsonPrimitive.double, p.length, 1e-9, "piece $i length")
            assertTrue(pointsOf(o["d"]!!.jsonPrimitive.content).contentEquals(p.points), "piece $i points")
        }
        val halos = doc["halos"]!!.jsonArray
        assertEquals(halos.size, KnotGeometry.HALOS.size)
        halos.forEachIndexed { i, e ->
            assertTrue(pointsOf(e.jsonObject["d"]!!.jsonPrimitive.content).contentEquals(KnotGeometry.HALOS[i]), "halo $i")
            assertEquals(e.jsonObject["over"]!!.jsonPrimitive.int, KnotGeometry.HALO_OVER[i])
        }
        val light = doc["light"]!!.jsonObject
        near(light["brand"]!!.jsonObject["from"]!!.jsonPrimitive.double, KnotGeometry.BRAND_FROM, 1e-9)
        near(light["brand"]!!.jsonObject["length"]!!.jsonPrimitive.double, KnotGeometry.BRAND_LENGTH, 1e-9)
        near(light["tool"]!!.jsonObject["length"]!!.jsonPrimitive.double, KnotGeometry.TOOL_LENGTH, 1e-9)
        val stroke = doc["stroke"]!!.jsonObject
        near(stroke["width"]!!.jsonPrimitive.double, KnotGeometry.WIDTH.toDouble(), 1e-6)
        near(stroke["halo"]!!.jsonPrimitive.double, KnotGeometry.HALO.toDouble(), 1e-6)
    }

    @Test
    fun sixPiecesUnderAndOverByTurnsSharingAPath100Long() {
        val p = KnotGeometry.PIECES
        assertEquals(listOf(false, true, false, true, false, true), p.map { it.over })
        near(KNOT_LENGTH, p.sumOf { it.length }, 1e-6)
        p.forEachIndexed { i, a ->
            val b = p[(i + 1) % p.size]
            near(b.from, (a.from + a.length) % KNOT_LENGTH, 1e-6, "piece $i ends where the next starts")
            near(b.points[0].toDouble(), a.points[a.points.size - 2].toDouble(), 1e-6)
            near(b.points[1].toDouble(), a.points[a.points.size - 1].toDouble(), 1e-6)
        }
    }

    @Test
    fun theLightAtHomeIsTheLast16OfThePath() {
        val b = knotBrand()
        near(84.0, b.tail)
        near(100.0, b.head)
        val out = DoubleArray(4)
        assertEquals(1, knotLit(KnotGeometry.PIECES[4], b.tail, b.head, out))
        near(84 - 77.74, out[0])
        near(17.64, out[1])
        assertEquals(1, knotLit(KnotGeometry.PIECES[5], b.tail, b.head, out))
        near(0.0, out[0])
        near(100 - 95.38, out[1])
        for (i in 0..3) assertEquals(0, knotLit(KnotGeometry.PIECES[i], b.tail, b.head, out))
    }

    @Test
    fun theLightWrapsRoundThePathEnd() {
        val out = DoubleArray(4)
        // the last piece runs past 100, round to the start
        assertEquals(1, knotLit(KnotGeometry.PIECES[5], 105.0, 115.0, out))
        near(105 - 95.38, out[0])
        near(15.69, out[1])
        assertEquals(1, knotLit(KnotGeometry.PIECES[0], 205.0, 215.0, out))
        near(0.0, out[0])
        near(115 - 111.07, out[1])
        // a long light touches both ends of one piece: two segments, in order
        assertEquals(2, knotLit(KnotGeometry.PIECES[0], 20.0, 115.0, out))
        near(0.0, out[0])
        near(3.93, out[1])
        near(8.93, out[2])
        near(17.64, out[3])
        // the whole knot, and nothing
        for (p in KnotGeometry.PIECES) {
            assertEquals(1, knotLit(p, 3.0, 103.0, out))
            near(p.length, out[1])
        }
        assertEquals(0, knotLit(KnotGeometry.PIECES[0], 40.0, 40.0, out))
    }

    @Test
    fun thirtyTwoAndUnderDrawTheHeavierStroke() {
        assertEquals(7f, knotWidth(16.0))
        assertEquals(11f, knotHalo(32.0))
        assertEquals(5.2f, knotWidth(33.0))
        assertEquals(9f, knotHalo(112.0))
    }

    // -- the thinking loop ---------------------------------------------------

    @Test
    fun thinkingWritesTheKnotThenLetsGoFromTheTail() {
        near(1650.0, KNOT_TURN, 1e-9)
        near(0.0, knotSpan(0.0).head, 1e-9)
        // the ease is symmetric: halfway through the write, half the knot
        near(50.0, knotSpan(KNOT_TURN / 2).head, 1e-3)
        near(100.0, knotSpan(KNOT_TURN).head, 1e-9)
        near(0.0, knotSpan(KNOT_TURN).tail, 1e-9)
        near(50.0, knotSpan((KNOT_TURN + KNOT_LOOP) / 2).tail, 1e-3)
        // closes after 3s, one lap on, with no jump at the seam
        val a = knotSpan(KNOT_LOOP)
        near(100.0, a.tail, 1e-9)
        near(100.0, a.head, 1e-9)
        assertTrue(abs(knotSpan(KNOT_LOOP - 0.01).tail - a.tail) < 1e-3)
    }

    @Test
    fun theLightOnlyMovesForward() {
        var prev = knotSpan(0.0)
        var t = 10.0
        while (t <= KNOT_LOOP * 2) {
            val s = knotSpan(t)
            assertTrue(s.head >= prev.head - 1e-9)
            assertTrue(s.tail >= prev.tail - 1e-9)
            assertTrue(s.head - s.tail in -1e-9..100.0 + 1e-9)
            prev = s
            t += 10
        }
    }

    @Test
    fun theSameNumbersAsTheWeb() {
        // web: test/knot.test.ts and knotMath.ts; KnotGeometry carries knot.json
        near(Loop.KNOT.toDouble(), KNOT_LOOP, 1e-9)
        near(Loop.KNOT_TOOL.toDouble(), KNOT_TOOL_LOOP, 1e-9)
        near(14.0, KNOT_TOOL_LEN, 1e-9)
        near(1000.0, KNOT_STILL, 1e-9)
        val still = knotStill(KnotState.THINKING)
        near(0.0, still.tail)
        assertTrue(still.head in 70.0..80.0)
        val tool = knotTravel(KNOT_TOOL_LOOP, 3.0)
        near(103.0, tool.tail, 1e-9)
        near(117.0, tool.head, 1e-9)
    }

    @Test
    fun easingMatchesCss() {
        // cubic-bezier(.6, 0, .4, 1): symmetric, firm at both ends
        near(0.0, Ease.morph(0.0))
        near(1.0, Ease.morph(1.0))
        near(0.5, Ease.morph(0.5), 1e-4)
        assertTrue(Ease.morph(0.2) < 0.1)
        // the Knot's write is the same curve
        near(Ease.morph(0.3), knotEase(0.3), 1e-12)
        // --ease is fast out of the gate
        assertTrue(Ease.out(0.2) > 0.5)
    }

    // -- states --------------------------------------------------------------

    private fun run(m: KnotMotion, from: Double, to: Double, step: Double = 16.0): KnotPose {
        var t = from
        while (t < to) {
            m.pose(t)
            t += step
        }
        return m.pose(to)
    }

    private fun same(a: KnotPose, b: KnotPose, eps: Double = 1e-6) {
        near(a.tail, b.tail, eps, "tail")
        near(a.head, b.head, eps, "head")
    }

    @Test
    fun waitingHoldsTheFrameAndThinkingResumesFromIt() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        run(m, 0.0, 700.0)
        val before = m.pose(700.0)
        m.set(KnotState.WAITING, 700.0)
        val held = run(m, 700.0, 3000.0)
        same(before, held)
        near(1.0, held.light)
        assertFalse(m.moving(3000.0))
        val phase = m.phase
        m.set(KnotState.THINKING, 3000.0)
        run(m, 3000.0, 3100.0)
        assertTrue(m.phase > phase)
        assertTrue(m.phase - phase < 120)
    }

    @Test
    fun anApprovalWithItsToolCallHoldsTheToolLight() {
        // what Knot(WAITING) does in the app when the tool and the approval arrive together
        val m = KnotMotion(KnotState.THINKING, 0.0)
        run(m, 0.0, 900.0)
        m.set(KnotState.TOOL, 900.0)
        m.set(KnotState.WAITING, 900.0)
        val p = run(m, 900.0, 2000.0)
        same(p, run(m, 2000.0, 4000.0))
        assertEquals(KnotState.TOOL, m.live)
        assertFalse(m.moving(4000.0))
        val fresh = KnotMotion(KnotState.WAITING, 0.0, via = KnotState.TOOL).pose(0.0)
        near(14.0, fresh.head - fresh.tail)
    }

    @Test
    fun aToolKeepsTheWrittenHeadAndRunsA14LongLight() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        val at = run(m, 0.0, 900.0)
        m.set(KnotState.TOOL, 900.0)
        same(at, m.pose(900.0))
        val p = run(m, 900.0, 1600.0)
        near(14.0, p.head - p.tail)
        near(at.head + 700 * 100 / KNOT_TOOL_LOOP, p.head)
        val q = run(m, 1600.0, 2100.0)
        near(500 * 100 / KNOT_TOOL_LOOP, q.tail - p.tail)
    }

    @Test
    fun backToThinkingTheToolLightLetsGoFromItsTail() {
        val m = KnotMotion(KnotState.TOOL, 0.0)
        val at = run(m, 0.0, 1000.0)
        m.set(KnotState.THINKING, 1000.0)
        same(at, m.pose(1000.0), 1e-3)
        var prev = at
        var t = 1016.0
        while (t < 1400) {
            val p = m.pose(t)
            near(at.head, p.head, 1e-3)
            assertTrue(p.tail >= prev.tail - 1e-9)
            prev = p
            t += 16
        }
        // then a new write starts at the old head
        val w = run(m, 1400.0, 2500.0)
        near(at.head, w.tail, 1e-3)
        assertTrue(w.head - w.tail > 14)
    }

    @Test
    fun doneFadesTheLightOutAndStops() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        run(m, 0.0, 2000.0)
        m.set(KnotState.DONE, 2000.0)
        near(0.0, run(m, 2000.0, 3000.0).light)
        assertFalse(m.moving(3000.0))
        // thinking again writes from the start of the path
        m.set(KnotState.THINKING, 3000.0)
        val q = run(m, 3000.0, 3000.0 + KNOT_TURN / 2)
        near(0.0, q.tail)
        near(1.0, q.light)
    }

    @Test
    fun failedStopsTheLightWhereItIs() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        val at = run(m, 0.0, 600.0)
        m.set(KnotState.FAILED, 600.0)
        same(at, run(m, 600.0, 1500.0))
        assertFalse(m.moving(1500.0))
    }

    @Test
    fun aLimitHoldsTheLightAndThinkingWritesOnFromIt() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        val at = run(m, 0.0, 500.0)
        m.set(KnotState.PAUSED, 500.0)
        same(at, run(m, 500.0, 2000.0))
        m.set(KnotState.THINKING, 2000.0)
        val q = run(m, 2000.0, 2300.0)
        near(at.tail, q.tail)
        assertTrue(q.head > at.head)
        // mounted in a limit: the light at home, and the write goes on from it
        val fresh = KnotMotion(KnotState.PAUSED, 0.0)
        val p = fresh.pose(0.0)
        near(84.0, p.tail)
        near(100.0, p.head, 1e-3)
        fresh.set(KnotState.THINKING, 0.0)
        assertTrue(run(fresh, 0.0, 200.0).head > 100)
    }

    @Test
    fun aClockStepIsAtMost100ms() {
        val m = KnotMotion(KnotState.THINKING, 0.0)
        m.pose(5000.0)
        assertTrue(m.phase <= 100.0)
    }

    @Test
    fun oneStillPosePerState() {
        assertEquals(KnotPose(84.0, 98.0, 1.0), knotStill(KnotState.TOOL))
        assertEquals(KnotPose(84.0, 100.0, 1.0), knotStill(KnotState.PAUSED))
        near(0.0, knotStill(KnotState.DONE).light)
        assertEquals(knotStill(KnotState.THINKING), knotStill(KnotState.WAITING))
        assertEquals(knotStill(KnotState.TOOL), knotStill(KnotState.FAILED, via = KnotState.TOOL))
        // mounted waiting shows the clear still pose
        same(knotStill(KnotState.THINKING), KnotMotion(KnotState.WAITING, 0.0).pose(0.0))
    }

    // -- tokens and the spring ----------------------------------------------

    @Test
    fun tokensMirrorTheWebCss() {
        val css = repoFile("packages/web/src/styles/motion.css")?.readText() ?: return
        val index = repoFile("packages/web/src/styles/index.css")?.readText() ?: return
        fun ms(text: String, name: String) = Regex("$name:\\s*(\\d+)ms").find(text)?.groupValues?.get(1)?.toInt()
        // every token the web defines must match; a checkout from before a token existed skips it
        fun same(expected: Int, text: String, name: String) = ms(text, name)?.let { assertEquals(expected, it, name) }
        same(Dur.D0, css, "--dur-0")
        same(Dur.D1, index, "--dur-1")
        same(Dur.D2, index, "--dur-2")
        same(Dur.D3, index, "--dur-3")
        same(Dur.D4, css, "--dur-4")
        same(Loop.KNOT, css, "--loop-knot")
        same(Loop.KNOT_TOOL, css, "--loop-knot-tool")
        same(Loop.RIM, css, "--loop-rim")
        same(Loop.BREATH, css, "--loop-breath")
        same(Loop.SHIMMER, css, "--loop-shimmer")
        same(Stream.WORD, css, "--stream-word")
        same(Stream.LAG, css, "--stream-lag")
        same(Spring.SETTLE, css, "--dur-spring")
    }

    @Test
    fun theSpringIsCriticallyDampedAndSettlesIn620ms() {
        assertEquals(Spring.SETTLE, springSettle())
        var prev = 0.0
        var t = 0.0
        while (t < 1000) {
            val v = spring(t)
            assertTrue(v >= prev - 1e-12 && v <= 1.0)
            prev = v
            t += 5
        }
        near(223.8, springStiffness(), 0.1)
    }

    // -- Ink -----------------------------------------------------------------

    @Test
    fun inkReleasesWords40msApartAndNeverMoreThan320msBehind() {
        val few = Ink.schedule(listOf(4, 4, 4), now = 1000.0, queueEnd = Double.NEGATIVE_INFINITY)
        near(1000.0, few[0])
        near(1040.0, few[1])
        near(1080.0, few[2])
        // a big chunk is spread over what is left of the 320ms
        val many = Ink.schedule(List(41) { 5 }, now = 0.0, queueEnd = Double.NEGATIVE_INFINITY)
        near(0.0, many.first())
        near(320.0, many.last(), 1e-9)
        assertTrue(many.toList().zipWithNext().all { (a, b) -> b - a <= Stream.WORD + 1e-9 })
        // after a queue, the next word waits 40ms, but never past the lag
        val queued = Ink.schedule(listOf(3), now = 100.0, queueEnd = 300.0)
        near(340.0, queued[0])
        val late = Ink.schedule(listOf(3), now = 100.0, queueEnd = 900.0)
        near(420.0, late[0])
    }

    @Test
    fun inkWordsKeepTheirSpaces() {
        assertEquals(listOf("Hello ", "world, ", "it works"), Ink.words("Hello world, it works").let { listOf(it[0], it[1], it[2] + it[3]) })
        assertEquals("  two  words ", Ink.words("  two  words ").joinToString(""))
    }

    @Test
    fun inkBoundaryWalksTheFront() {
        val runs = listOf(InkRun(0, 6, 0.0, 40.0), InkRun(6, 12, 40.0, 80.0))
        assertEquals(0, Ink.boundary(runs, -1.0, 12))
        assertEquals(4, Ink.boundary(runs, 20.0, 12))
        assertEquals(7, Ink.boundary(runs, 40.0, 12))
        assertEquals(12, Ink.boundary(runs, 80.0, 12))
    }

    @Test
    fun inkClockCoolsAndForgets() {
        val ink = InkClock()
        val text = "One two three four"
        ink.arrive(text, 0, 0.0)
        assertEquals(4, ink.pending.size)
        val b = ink.boundaries(0.0, text.length)
        // at the start only the first letter is out
        assertEquals(1, b[0])
        assertTrue(ink.active(200.0))
        val later = ink.boundaries(1000.0, text.length)
        assertTrue(later.all { it == text.length })
        assertFalse(ink.active(1000.0))
        assertTrue(ink.pending.isEmpty())
    }

    @Test
    fun inkShrinksWithTheText() {
        val ink = InkClock()
        ink.arrive("alpha beta gamma", 0, 0.0)
        ink.shrink(8)
        assertTrue(ink.pending.all { it.end <= 8 })
        assertEquals(2, ink.pending.size)
    }

    // -- Roll ----------------------------------------------------------------

    @Test
    fun rollOnlyChangedDigitsLowerFirst() {
        val c = Roll.cells("1,962", "1,963")
        assertEquals(listOf(null, null, null, null, "2"), c.map { it.prev })
        assertEquals(0, c[4].rank)
        val d = Roll.cells("4:59", "5:00")
        assertEquals(listOf(2, -1, 1, 0), d.map { it.rank })
        // a longer value: the new leading digit has no old one
        val e = Roll.cells("99", "100")
        assertEquals("", e[0].prev)
        assertEquals(listOf(2, 1, 0), e.map { it.rank })
        assertEquals(2 * Roll.LAG + 240, Roll.total(e, 240))
    }

    @Test
    fun rollDirectionAndClock() {
        assertTrue(Roll.up("1,962", "1,963"))
        assertFalse(Roll.up("4:59", "4:58"))
        assertTrue(Roll.up("$0.031", "$0.032"))
        assertEquals("4:59", Roll.clockLeft(298_100))
        assertEquals("0:00", Roll.clockLeft(-5))
        assertEquals("1:02:03", Roll.clockLeft(3_723_000))
        near(0.0, Roll.progress(10.0, 1, 240))
        near(1.0, Roll.progress(28.0 + 240, 1, 240))
    }

    // -- Rim, send to stop, steps, morph ------------------------------------

    @Test
    fun rimWalksTheRoundedBoxClockwise() {
        val box = RimBox(300.0, 100.0, 10.0)
        val p = box.perimeter
        near(2 * 280 + 2 * 80 + 2 * Math.PI * 10, p, 1e-9)
        val a = box.at(0.0)
        near(10.0, a[0]); near(0.0, a[1])
        val r = box.at(280 + Math.PI * 10 / 2 + 40)
        near(300.0, r[0]); near(50.0, r[1])
        val wrap = box.at(p + 5)
        near(15.0, wrap[0])
    }

    @Test
    fun rimStatesAndTheBreath() {
        val m = RimMotion(RimState.LIVE, 0.0)
        var t = 0.0
        while (t < 1000) { m.step(t); t += 16 }
        assertTrue(m.liveT > 900)
        m.set(RimState.DONE, 1000.0)
        assertEquals(RimMode.SETTLE, m.mode)
        assertTrue(m.step(1100.0))
        assertFalse(m.step(2700.0))
        val w = RimMotion(RimState.WAITING, 0.0)
        assertTrue(w.step(10.0))
        near(0.0, dev.conclave.client.motion.Rim.breath(0.0))
        near(1.0, dev.conclave.client.motion.Rim.breath(1600.0), 1e-6)
        near(0.0, dev.conclave.client.motion.Rim.breath(4000.0))
        // a failure with no light running still leaves the short mark, at once
        val f = RimMotion(RimState.IDLE, 0.0)
        f.set(RimState.FAILED, 0.0)
        assertEquals(RimMode.FAULT, f.mode)
    }

    @Test
    fun sendFoldsIntoStop() {
        val arrow = SendStop.points(0.0)
        val square = SendStop.points(1.0)
        near(15.0, arrow[0]); near(7.6, arrow[1])
        near(15.0, square[0]); near(10.8, square[1])
        // mid fold it dips toward the center
        val mid = SendStop.points(0.5)
        assertTrue(abs(mid[1] - 15) < abs((7.6 + 10.8) / 2 - 15))
    }

    @Test
    fun stepsNeverShareTheLine() {
        // the old step is gone (150ms plus at most 30ms) before the new one starts at 190ms
        near(1.0, Steps.partOut(180.0, 5))
        near(0.0, Steps.partIn(189.0, 0))
        assertEquals(190 + 3 * 32 + 300, Steps.landed(4))
        near(0.0, Steps.glint(0.0, 0))
        assertTrue(Steps.glint(170.0, 0) > 0.8)
    }

    @Test
    fun morphKeepsTheSharedStart() {
        val m = Morph.of("Thinking", "Thought for 6s")
        assertEquals("Th", m.shared)
        assertEquals("inking", m.old)
        assertEquals("ought for 6s", m.fresh)
        assertEquals(120 + 12 * 5, Morph.inAt(m.old))
    }

    // -- the toast stack -----------------------------------------------------

    @Test
    fun toastsStackAndFan() {
        val h = listOf(40, 40, 52)
        val stacked = ToastStack.layout(h, listOf(false, false, false), fan = false)
        assertEquals(listOf(0, 11, 22), stacked.map { it.offset })
        assertEquals(listOf(true, false, false), stacked.map { it.words })
        near(0.9, stacked[2].scale)
        assertEquals(40 + 2 * 11, ToastStack.height(h, listOf(false, false, false), fan = false))
        val fanned = ToastStack.layout(h, listOf(false, false, false), fan = true)
        assertEquals(listOf(0, 48, 96), fanned.map { it.offset })
        assertEquals(40 + 40 + 52 + 16, ToastStack.height(h, listOf(false, false, false), fan = true))
        // a leaving front toast keeps its slot; the next one moves to the front
        val leaving = ToastStack.layout(h, listOf(true, false, false), fan = false)
        assertEquals(listOf(0, 0, 1), leaving.map { it.idx })
    }
}
