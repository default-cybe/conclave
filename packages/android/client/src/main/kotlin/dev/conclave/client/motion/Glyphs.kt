package dev.conclave.client.motion

import dev.conclave.client.model.SessionStatus

/*
 * The agent glyphs and the pet (docs/design/CHAT-AND-MOTION.md 1.11), the
 * pure half, a port of packages/web/src/components/motion/agentGlyphs.ts:
 * which glyph an agent type gets, which glyph state a call or task is in,
 * which pet pose that is, and the strokes, all on a 16 (glyph) or 32x24
 * (pet) grid. No Compose here, so GlyphsTest can read it; the app draws it
 * in ui/motion/AgentGlyph.kt and ui/motion/Pet.kt.
 */

/** The glyph kinds; the names are the web's, lowercased. */
enum class GlyphKind(val key: String) {
    EXPLORE("explore"),
    RESEARCHER("researcher"),
    BUILDER("builder"),
    TESTER("tester"),
    REVIEWER("reviewer"),
    DEBUGGER("debugger"),
    DESIGNER("designer"),
    VERIFIER("verifier"),
    GENERAL_PURPOSE("general-purpose"),
    WORKFLOW("workflow"),
    DELEGATE("delegate"),
}

/** What a glyph says about a call or a task. */
enum class GlyphState { RUNNING, DONE, FAILED, WAITING }

/** The pet's poses, one per state of the work. */
enum class PetState { IDLE, THINKING, RESEARCHING, BUILDING, TESTING, REVIEWING, WAITING, PARKED, DONE, FAILED }

/** Agent types seen in the wild that are another glyph's job. */
private val ALIAS: Map<String, GlyphKind> = mapOf(
    "web-searcher" to GlyphKind.RESEARCHER,
    "research" to GlyphKind.RESEARCHER,
    "searcher" to GlyphKind.RESEARCHER,
    "explorer" to GlyphKind.EXPLORE,
    "fact-checker" to GlyphKind.VERIFIER,
    "verify" to GlyphKind.VERIFIER,
    "test" to GlyphKind.TESTER,
    "review" to GlyphKind.REVIEWER,
    "code-reviewer" to GlyphKind.REVIEWER,
    "build" to GlyphKind.BUILDER,
    "coder" to GlyphKind.BUILDER,
    "debug" to GlyphKind.DEBUGGER,
    "design" to GlyphKind.DESIGNER,
    "synthesizer" to GlyphKind.GENERAL_PURPOSE,
)

/** The glyph for an agent type ("Explore", "web-searcher"); unknown types draw general-purpose. */
fun glyphKind(agentType: String?): GlyphKind {
    val t = agentType?.trim()?.lowercase() ?: ""
    GlyphKind.entries.forEach { if (it.key == t) return it }
    return ALIAS[t] ?: GlyphKind.GENERAL_PURPOSE
}

/** A workflow call's or a subagent's state, as the glyph says it. Queued holds dim like waiting; anything not live or failed is done. */
fun glyphState(state: String, waiting: Boolean = false): GlyphState = when {
    waiting || state == "parked" || state == "waiting" || state == "queued" -> GlyphState.WAITING
    state == "running" -> GlyphState.RUNNING
    state == "failed" || state == "error" -> GlyphState.FAILED
    else -> GlyphState.DONE
}

/** The pet's pose for the busiest kind of work, or for a state that is not work. */
fun petState(kind: GlyphKind?, state: GlyphState = GlyphState.RUNNING): PetState = when (state) {
    GlyphState.WAITING -> PetState.WAITING
    GlyphState.FAILED -> PetState.FAILED
    GlyphState.DONE -> PetState.DONE
    else -> when (kind) {
        GlyphKind.EXPLORE, GlyphKind.RESEARCHER -> PetState.RESEARCHING
        GlyphKind.BUILDER, GlyphKind.DESIGNER, GlyphKind.DEBUGGER, GlyphKind.WORKFLOW -> PetState.BUILDING
        GlyphKind.TESTER, GlyphKind.VERIFIER -> PetState.TESTING
        GlyphKind.REVIEWER -> PetState.REVIEWING
        else -> PetState.THINKING
    }
}

/** The kind most of the running agents are ("busiest"); ties go to the first seen. */
fun busiestKind(agentTypes: List<String?>): GlyphKind? {
    val n = HashMap<GlyphKind, Int>()
    var best: GlyphKind? = null
    for (t in agentTypes) {
        val k = glyphKind(t)
        n[k] = (n[k] ?: 0) + 1
        if (best == null || n[k]!! > n[best]!!) best = k
    }
    return best
}

/** At most this many list rows animate at once (CHAT-AND-MOTION 1.9); the rest draw their still frame. */
const val LIVE_ROWS = 3

/** For each row, whether it stays still: only the first LIVE_ROWS running rows move. */
fun stillRows(states: List<GlyphState>): List<Boolean> {
    var live = 0
    return states.map { !(it == GlyphState.RUNNING && live++ < LIVE_ROWS) }
}

/** Where the light rests under reduced motion and in a held state: about 3/4 along (0 to 1 of the path), and how long it is. */
const val GLYPH_LIGHT_STILL = 0.36f
const val GLYPH_LIGHT_LEN = 0.22f

/** One stroke per kind on a 16 grid, the web's SVG path strings verbatim (the app parses them). */
val GLYPH_PATHS: Map<GlyphKind, String> = mapOf(
    GlyphKind.EXPLORE to "M8 8 A3 3 0 1 1 2 8 A3 3 0 1 1 8 8 C9.5 8 9.5 5 11.5 5 S13.5 9 15 9",
    GlyphKind.RESEARCHER to "M9.3 9.3 A4 4 0 1 1 3.7 3.7 A4 4 0 1 1 9.3 9.3 L14 14",
    GlyphKind.BUILDER to "M2 10 C2 4 8 4 7 8.5 C6.5 11 3 10.5 4.5 8.5 L9 8.5 L14 8.5 L14 13.5 L9 13.5 L9 8.5",
    GlyphKind.TESTER to "M5 11 C1.5 11 1.5 5 5 5 C8 5 8 8.5 6.5 9.5 L9 12 L14.5 4.5",
    GlyphKind.REVIEWER to "M6.5 9 A2.75 2.75 0 1 0 1 9 A2.75 2.75 0 1 0 6.5 9 Q8 7.2 9.5 9 A2.75 2.75 0 1 0 15 9 A2.75 2.75 0 1 0 9.5 9",
    GlyphKind.DEBUGGER to "M8 8 C11 5 13.5 5.5 13.5 8 C13.5 10.5 11 11 8 8 C5 5 2.5 5.5 2.5 8 C2.5 10.5 5 11 6.9 9.3",
    GlyphKind.DESIGNER to "M1.5 13 C4.5 5 8 13.5 11 6 L13.5 2.5 L14.5 5.5 L11 6",
    GlyphKind.VERIFIER to "M8 2.5 A5.5 5.5 0 1 1 7.99 2.5Z",
    GlyphKind.WORKFLOW to "M0.5 12 L3.5 12 C5.7 12 5.7 6.5 3.5 6.5 C1.3 6.5 1.3 12 3.5 12 L8 12 C10.2 12 10.2 6.5 8 6.5 C5.8 6.5 5.8 12 8 12 L12.5 12 C14.7 12 14.7 6.5 12.5 6.5 C10.3 6.5 10.3 12 12.5 12 L15.5 12",
    GlyphKind.DELEGATE to "M7.5 8 A3 3 0 1 0 1.5 8 A3 3 0 1 0 7.5 8 L14.5 8 L12 5.5",
)

/** The knot's path as one closed loop, mapped into a box (x, y, w, h): x,y pairs, like the web's knotLoop(). */
fun knotLoop(x: Float, y: Float, w: Float, h: Float, step: Int = 3): FloatArray {
    val pts = ArrayList<Float>()
    for (p in KnotGeometry.PIECES) {
        val all = p.points.size / 2
        for (i in 0 until all) {
            if (i % step != 0 && i != all - 1) continue
            // the knot sits in 10..54 by 11.65..52.37 of its 64 box
            pts.add(x + (p.points[2 * i] - 10f) / 44f * w)
            pts.add(y + (p.points[2 * i + 1] - 11.65f) / 40.72f * h)
        }
    }
    return pts.toFloatArray()
}

/** The general-purpose glyph: the small trefoil, the Knot's own path on the 16 grid. */
fun glyphPoints(kind: GlyphKind): FloatArray? = when (kind) {
    GlyphKind.GENERAL_PURPOSE -> knotLoop(1.5f, 2f, 13f, 12f)
    else -> null
}

/**
 * The pet in its 32x24 box, the web's strings verbatim: a soft dome ("mochi")
 * on a flat seat, a curl on top that is one turn of the Knot's rope, two dot
 * eyes. The body keeps the left 4..24 so the props get 24..32.
 */
const val PET_BODY = "M8.2 20.5C5.3 20.5 4 18.9 4 16.3C4 10 8.5 5 14 5C19.5 5 24 10 24 16.3C24 18.9 22.7 20.5 19.8 20.5Z"
const val PET_CURL = "M14 5C13.5 3.3 14.6 1.9 16 2.1C17.3 2.3 17.4 3.9 16.1 4.2"
const val PET_FEET = "M9.2 21.7H11.4M16.6 21.7H18.8"
const val PET_SHADOW = "M6.5 23H21.5"

/** The eyes' x and y on the body; what is drawn for them depends on the state. */
val PET_EYES = floatArrayOf(11f, 17f)
const val PET_EYE_Y = 12.6f

/** Where the arm leaves the body; props swing round it. */
val PET_SHOULDER = floatArrayOf(23.3f, 14.6f)

/** A chat's status as the pet's pose, for the places that say it with the pet; null draws none. */
fun sessionPet(status: SessionStatus?): PetState? = when (status) {
    SessionStatus.WAITING_APPROVAL, SessionStatus.WAITING_INPUT -> PetState.WAITING
    SessionStatus.WAITING_RESET -> PetState.PARKED
    SessionStatus.ERROR -> PetState.FAILED
    else -> null
}
