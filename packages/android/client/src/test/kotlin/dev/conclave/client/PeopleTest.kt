package dev.conclave.client

import dev.conclave.client.model.MePatch
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Accounts (docs/design/ACCOUNTS.md): login with a name, who am I, invites. */
class PeopleTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun client(token: String? = null) = ConclaveClient(server.url("/").toString(), token)

    @Test
    fun loginSendsTheAccountOnlyWhenGiven() = runBlocking {
        val reply = """{"token":"tok","clientId":"cli_1","hub":{"name":"home"},"account":{"id":"acc_1","name":"sam","role":"member"}}"""
        server.enqueue(MockResponse(body = reply))
        server.enqueue(MockResponse(body = """{"token":"tok2","clientId":"cli_2","hub":{"name":"home"}}"""))
        val r = client().login("sams long password", "Pixel", account = " sam ")
        assertEquals("sam", r.account?.name)
        assertFalse(r.account!!.isOwner)
        assertEquals("""{"password":"sams long password","name":"Pixel","platform":"android","account":"sam"}""", server.takeRequest().body?.utf8())
        // a hub with one person: no account, and the reply from an older hub has none either
        val old = client().login("the owners password", "Pixel")
        assertNull(old.account)
        assertEquals("""{"password":"the owners password","name":"Pixel","platform":"android"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun healthSaysWhenThereAreSeveralPeople() = runBlocking {
        server.enqueue(MockResponse(body = """{"ok":true,"version":"1","uptimeMs":5,"people":true}"""))
        server.enqueue(MockResponse(body = """{"ok":true,"version":"0.9","uptimeMs":5}"""))
        assertTrue(client().health().people)
        assertFalse(client().health().people)
    }

    @Test
    fun meReadsRoleProvidersAndBudget() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """{"id":"acc_1","name":"sam","role":"member","people":true,"hubMachine":false,"passwordSet":true,
                "providers":[{"provider":"anthropic","name":"Anthropic","source":"hub","hubAllowed":true,"ownKey":false,"monthlyUsd":5,"spentUsd":5.2,"resetsAt":1793491200000},
                {"provider":"openai","name":"OpenAI","source":"none","hubAllowed":false,"ownKey":false,"spentUsd":0,"resetsAt":1793491200000}],
                "preferences":{"defaultModel":"anthropic/claude-sonnet-5-5"},"later":"ignored"}""",
            ),
        )
        val me = client("tok").me()
        assertFalse(me.isOwner)
        assertFalse(me.hubMachine)
        assertEquals(listOf("anthropic", "openai"), me.providers.map { it.provider })
        assertTrue(me.providers[0].overBudget)
        assertNull(me.providers[1].monthlyUsd)
        assertFalse(me.providers[1].overBudget)
        assertEquals("anthropic/claude-sonnet-5-5", me.preferences.defaultModel)
        assertEquals("/api/me", server.takeRequest().url.encodedPath)
    }

    @Test
    fun updateMeSendsOnlyWhatChanged() = runBlocking {
        server.enqueue(MockResponse(body = """{"ok":true}"""))
        client("tok").updateMe(MePatch(name = "sammy"))
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("""{"name":"sammy"}""", req.body?.utf8())
    }

    @Test
    fun invitesNeedNoToken() = runBlocking {
        val secret = "abcdefghijklmnopqrstuvwxyz012345"
        server.enqueue(MockResponse(body = """{"name":"sam","hub":"home","expiresAt":1}"""))
        server.enqueue(MockResponse(body = """{"token":"tok","clientId":"cli_1","hub":{"name":"home"},"account":{"id":"acc_1","name":"sam","role":"member"}}"""))
        val c = client("old-token")
        assertEquals("sam", c.invite(secret).name)
        val first = server.takeRequest()
        assertEquals("/api/invite/$secret", first.url.encodedPath)
        assertNull(first.headers["Authorization"])
        val r = c.acceptInvite(secret, "sams long password", "Pixel")
        assertEquals("acc_1", r.account?.id)
        val second = server.takeRequest()
        assertNull(second.headers["Authorization"])
        assertEquals("""{"password":"sams long password","name":"Pixel","platform":"android"}""", second.body?.utf8())
    }

    @Test
    fun inviteSecretFromALink() {
        assertEquals("abcdefghijklmnopqrstuvwxyz012345", inviteSecretOf("https://hub.example.com/invite/abcdefghijklmnopqrstuvwxyz012345"))
        assertEquals("abcdefghijklmnopqrstuvwxyz012345", inviteSecretOf(" https://hub.example.com/invite/abcdefghijklmnopqrstuvwxyz012345/ "))
        assertNull(inviteSecretOf("https://hub.example.com/invite/short"))
        assertNull(inviteSecretOf("https://hub.example.com/s/abcdefghijklmnopqrstuvwxyz012345"))
    }
}
