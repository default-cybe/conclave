package dev.conclave.client

import dev.conclave.client.logic.SessionExtras
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The lane and connectors a session keeps in its meta (logic/SessionExtras.kt), as core lanes.ts and connectors.ts. */
class SessionExtrasTest {
    private fun meta(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    @Test
    fun laneReadsOnlyAKnownLane() {
        assertEquals("RE", SessionExtras.laneOf(meta("""{"lane":{"lane":"re","detected":["re","web"]}}"""))?.short)
        assertNull(SessionExtras.laneOf(meta("""{"lane":{"lane":"nope"}}""")))
        assertNull(SessionExtras.laneOf(meta("""{"lane":"re"}""")))
        assertNull(SessionExtras.laneOf(null))
        assertEquals(listOf("ctf", "variant", "exploit", "re", "source", "web"), SessionExtras.LANES.map { it.value })
    }

    @Test
    fun mcpOffReadsNamesAndToggles() {
        assertEquals(listOf("github", "notion"), SessionExtras.mcpOff(meta("""{"mcpOff":["github",3,"notion"]}""")))
        assertEquals(emptyList<String>(), SessionExtras.mcpOff(meta("""{"mcpOff":"github"}""")))
        assertEquals(emptyList<String>(), SessionExtras.mcpOff(null))
        assertEquals(listOf("github", "notion"), SessionExtras.toggled(listOf("github"), "notion", on = false))
        assertEquals(listOf("github"), SessionExtras.toggled(listOf("github"), "github", on = false))
        // the last one back on: an empty list, which turns all back on
        assertEquals(emptyList<String>(), SessionExtras.toggled(listOf("github"), "github", on = true))
    }
}
