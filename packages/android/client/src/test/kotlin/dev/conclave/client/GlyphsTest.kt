package dev.conclave.client

import dev.conclave.client.motion.GLYPH_PATHS
import dev.conclave.client.motion.GlyphKind
import dev.conclave.client.motion.GlyphState
import dev.conclave.client.motion.PET_BODY
import dev.conclave.client.motion.PetState
import dev.conclave.client.motion.busiestKind
import dev.conclave.client.motion.glyphKind
import dev.conclave.client.motion.glyphState
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.motion.petState
import dev.conclave.client.motion.sessionPet
import dev.conclave.client.motion.stillRows
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The pure half of the pet and the agent glyphs, mirroring web test/pet-glyphs.test.tsx. */
class GlyphsTest {
    @Test
    fun kindsMatchTheirOwnTypeCaseInsensitively() {
        for (k in GlyphKind.entries) assertEquals(k, glyphKind(k.key.uppercase()))
    }

    @Test
    fun knownAliasesMapToTheirKind() {
        assertEquals(GlyphKind.RESEARCHER, glyphKind("web-searcher"))
        assertEquals(GlyphKind.VERIFIER, glyphKind("fact-checker"))
        assertEquals(GlyphKind.GENERAL_PURPOSE, glyphKind("synthesizer"))
        assertEquals(GlyphKind.EXPLORE, glyphKind("Explore"))
        assertEquals(GlyphKind.GENERAL_PURPOSE, glyphKind("something-new"))
        assertEquals(GlyphKind.GENERAL_PURPOSE, glyphKind(null))
    }

    @Test
    fun statesFollowTheRules() {
        assertEquals(GlyphState.RUNNING, glyphState("running"))
        assertEquals(GlyphState.WAITING, glyphState("running", waiting = true))
        assertEquals(GlyphState.WAITING, glyphState("parked"))
        assertEquals(GlyphState.WAITING, glyphState("queued"))
        assertEquals(GlyphState.FAILED, glyphState("failed"))
        assertEquals(GlyphState.DONE, glyphState("done"))
        assertEquals(GlyphState.DONE, glyphState("cached"))
        assertEquals(GlyphState.DONE, glyphState("skipped"))
    }

    @Test
    fun posesFollowTheWork() {
        assertEquals(PetState.RESEARCHING, petState(GlyphKind.RESEARCHER))
        assertEquals(PetState.TESTING, petState(GlyphKind.TESTER))
        assertEquals(PetState.REVIEWING, petState(GlyphKind.REVIEWER))
        assertEquals(PetState.BUILDING, petState(GlyphKind.BUILDER))
        assertEquals(PetState.THINKING, petState(null))
        assertEquals(PetState.WAITING, petState(GlyphKind.BUILDER, GlyphState.WAITING))
        assertEquals(PetState.FAILED, petState(GlyphKind.BUILDER, GlyphState.FAILED))
    }

    @Test
    fun aChatsStatusPicksThePetOrNone() {
        assertEquals(PetState.WAITING, sessionPet(SessionStatus.WAITING_APPROVAL))
        assertEquals(PetState.WAITING, sessionPet(SessionStatus.WAITING_INPUT))
        assertEquals(PetState.PARKED, sessionPet(SessionStatus.WAITING_RESET))
        assertEquals(PetState.FAILED, sessionPet(SessionStatus.ERROR))
        for (s in listOf(SessionStatus.RUNNING, SessionStatus.IDLE, SessionStatus.PAUSED, null)) assertNull(sessionPet(s))
    }

    @Test
    fun theBusiestKindWinsTiesGoToTheFirst() {
        assertEquals(GlyphKind.RESEARCHER, busiestKind(listOf("web-searcher", "tester", "researcher")))
        assertEquals(GlyphKind.TESTER, busiestKind(listOf("tester", "reviewer")))
        assertNull(busiestKind(emptyList()))
    }

    @Test
    fun onlyTheFirstLiveRowsMove() {
        assertEquals(
            listOf(false, true, false, false, true, true),
            stillRows(listOf("running", "done", "running", "running", "running", "waiting").map { glyphState(it) }),
        )
    }

    @Test
    fun everyKindHasAStrokeAndThePetABody() {
        for (k in GlyphKind.entries) assertTrue(k == GlyphKind.GENERAL_PURPOSE || GLYPH_PATHS.getValue(k).startsWith("M"))
        // the body is one closed path in the left 4..24 of the 32x24 box, so props on the right never cover the face
        assertTrue(PET_BODY.startsWith("M") && PET_BODY.endsWith("Z"))
        val xs = Regex("(-?[\\d.]+) (-?[\\d.]+)").findAll(PET_BODY).map { it.groupValues[1].toFloat() }.toList()
        assertTrue(xs.isNotEmpty() && xs.all { it in 4f..24f })
    }
}
