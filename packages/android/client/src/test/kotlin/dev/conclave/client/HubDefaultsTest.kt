package dev.conclave.client

import dev.conclave.client.logic.HubDefaults
import dev.conclave.client.model.MePatch
import dev.conclave.client.model.MemberMemory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Settings, Defaults: limits as the hub takes them, a member's memory falling back to the hub's, a member's patch on /api/me. */
class HubDefaultsTest {
    private val tokens = HubDefaults.LIMIT_FIELDS[0]
    private val cost = HubDefaults.LIMIT_FIELDS[1]

    @Test
    fun limitsMatchTheHubRange() {
        assertEquals(0.0, HubDefaults.limitValue("  ", tokens))
        assertEquals(1_000_000.0, HubDefaults.limitValue("1,000,000", tokens))
        assertNull(HubDefaults.limitValue("1.5", tokens))
        assertNull(HubDefaults.limitValue("-1", tokens))
        assertNull(HubDefaults.limitValue("10000000001", tokens))
        assertEquals(2.5, HubDefaults.limitValue("2.5", cost))
        assertNull(HubDefaults.limitValue("100001", cost))
        assertEquals("1000", HubDefaults.limitJson(1000.0, tokens).toString())
        assertEquals("", HubDefaults.limitText(Json.parseToJsonElement("0")))
        assertEquals("120", HubDefaults.limitText(Json.parseToJsonElement("120")))
        assertEquals("Output tokens", HubDefaults.limitLabel(tokens))
        assertEquals("Cost, USD", HubDefaults.limitLabel(cost))
    }

    @Test
    fun memberMemoryFallsBackToTheHub() {
        val hub = Json.parseToJsonElement("""{"enabled":true,"autoInject":false,"injectLimit":10}""").jsonObject
        assertFalse(HubDefaults.memberFlag(null, hub, "autoInject", true))
        assertTrue(HubDefaults.memberFlag(MemberMemory(autoInject = true), hub, "autoInject", true))
        assertFalse(HubDefaults.memberFlag(null, JsonObject(emptyMap()), "recallEpisodes", false))
        assertEquals(10, HubDefaults.memberNotes(null, hub))
        assertEquals(3, HubDefaults.memberNotes(MemberMemory(injectLimit = 3), hub))
        assertEquals("The hub", HubDefaults.deviceName("local", emptyList()))
        assertEquals("Laptop", HubDefaults.deviceName("d1", listOf("d1" to "Laptop")))
    }

    @Test
    fun aMemberSavesOnlyTheirOwnDefaults() = runBlocking {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse(body = "{}"))
        ConclaveClient(server.url("/").toString(), "tok").updateMe(MePatch(reviewer = "openai/gpt-5", memory = MemberMemory(injectLimit = 6)))
        val r = server.takeRequest()
        assertEquals("PATCH", r.method)
        assertEquals("/api/me", r.url.encodedPath)
        assertEquals("""{"reviewer":"openai/gpt-5","memory":{"injectLimit":6}}""", r.body?.utf8())
        server.close()
    }
}
