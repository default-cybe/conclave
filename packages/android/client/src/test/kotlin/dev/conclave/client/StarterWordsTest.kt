package dev.conclave.client

import dev.conclave.client.logic.StarterWords
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.StarterLine
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The window starter's line on a plan's limit card (logic/StarterWords.kt),
 * the same words as the web's, and the hub's limit state carrying it.
 */
class StarterWordsTest {
    private val zone = ZoneId.of("Europe/Berlin")

    // Friday 23 October 2026, 12:00 in Berlin
    private val now = at(23, 12, 0)

    private fun at(d: Int, h: Int, m: Int): Long = LocalDateTime.of(2026, 10, d, h, m).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun nextStartAndStarted() {
        assertEquals("Next start 14:03.", StarterWords.line(StarterLine("scheduled", nextAt = at(23, 14, 3)), now, zone))
        assertEquals("Next start 14:03. Started 09:00.", StarterWords.line(StarterLine("scheduled", nextAt = at(23, 14, 3), startedAt = at(23, 9, 0)), now, zone))
        assertEquals("Next start Sat 07:00. Started yesterday 21:40.", StarterWords.line(StarterLine("scheduled", nextAt = at(24, 7, 0), startedAt = at(22, 21, 40)), now, zone))
        assertEquals("Failed: server error. Next try 12:05.", StarterWords.line(StarterLine("scheduled", nextAt = at(23, 12, 5), reason = "Server error"), now, zone))
    }

    @Test
    fun stoppedPausedAndTheRest() {
        assertEquals("Stopped until tomorrow: 429.", StarterWords.line(StarterLine("stopped", until = at(24, 7, 0), reason = "429"), now, zone))
        assertEquals("Paused: weekly limit used up until Tue 10:00.", StarterWords.line(StarterLine("paused", until = at(27, 10, 0)), now, zone))
        assertEquals("Waiting for the first usage read.", StarterWords.line(StarterLine("waiting", reason = "No usage read yet"), now, zone))
        assertEquals("This plan has no 5-hour window, so there is nothing to start.", StarterWords.line(StarterLine("never"), now, zone))
        assertNull(StarterWords.line(StarterLine("off"), now, zone))
    }

    @Test
    fun theLimitStateCarriesIt() {
        val l = ConclaveJson.decodeFromString(
            LimitState.serializer(),
            """{"provider":"cliproxy","account":"claude-b","label":"Claude Max 20x · Account 2","windows":[{"name":"5h","usedPercent":22}],"updatedAt":1,"source":"oauth","starter":{"state":"stopped","until":${at(24, 7, 0)},"reason":"429"}}""",
        )
        assertEquals(StarterLine("stopped", until = at(24, 7, 0), reason = "429"), l.starter)
        assertNull(ConclaveJson.decodeFromString(LimitState.serializer(), """{"provider":"anthropic"}""").starter)
    }
}
