package dev.conclave.client

import dev.conclave.client.logic.Providers
import dev.conclave.client.model.ProviderTestResult
import dev.conclave.client.model.SignInStart
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Settings, Providers and Subscriptions: keys go to /api/secrets, plan sign-in through /api/subscriptions. */
class ProvidersTest {
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

    private fun client() = ConclaveClient(server.url("/").toString(), "tok")

    @Test
    fun keySaveAndRemoveSendTheSecret() = runBlocking {
        server.enqueue(MockResponse(body = """{"ok":true}"""))
        server.enqueue(MockResponse(body = """{"ok":true}"""))
        client().setProviderKey("openrouter", "sk-or-1")
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/secrets", put.url.encodedPath)
        assertEquals("""{"kind":"providers","key":"openrouter","value":"sk-or-1"}""", put.body?.utf8())
        client().setProviderKey("openrouter", null)
        assertEquals("""{"kind":"providers","key":"openrouter","value":null}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun signInStartsPollsAndTakesThePastedAddress() = runBlocking {
        server.enqueue(MockResponse(body = """{"state":"st 1","provider":"claude","url":"https://claude.ai/oauth","flow":"redirect","expiresAt":1,"caught":false,"callbackHost":"localhost:54545"}"""))
        server.enqueue(MockResponse(body = """{"state":"st 1","status":"wait"}"""))
        server.enqueue(MockResponse(body = """{"state":"st 1","status":"ok","account":{"name":"claude-a.json","provider":"claude","state":"active"}}"""))
        val start = client().startSignIn("claude")
        assertEquals("""{"provider":"claude"}""", server.takeRequest().body?.utf8())
        assertTrue(Providers.needsPaste(start, forced = false))
        assertEquals("wait", client().signInStatus(start.state).status)
        assertEquals("/api/subscriptions/signin/st%201", server.takeRequest().url.encodedPath)
        val done = client().finishSignIn(start.state, "http://localhost:54545/callback?code=x")
        val post = server.takeRequest()
        assertEquals("/api/subscriptions/signin/st%201/callback", post.url.encodedPath)
        assertEquals("""{"url":"http://localhost:54545/callback?code=x"}""", post.body?.utf8())
        assertEquals("ok", done.status)
    }

    @Test
    fun aMemberOnlyStartsTheBuiltInOne() = runBlocking {
        server.enqueue(MockResponse(body = """{"mode":"builtin","state":"starting","providers":[{"id":"claude","name":"Claude","plan":"Claude Pro or Max","more":false},{"id":"qwen","name":"Qwen","more":true}],"accounts":[]}"""))
        val s = client().startBuiltinSubscriptions()
        assertEquals("""{"mode":"builtin"}""", server.takeRequest().body?.utf8())
        assertTrue(Providers.needsStart(s))
        assertEquals(listOf("claude"), Providers.rows(s, more = false).map { it.id })
        assertEquals("Sign in", Providers.action(s, s.providers[0]))
    }

    @Test
    fun wordsAndRows() {
        assertEquals("Works, 7 models, 212 ms" to true, Providers.testWords(ProviderTestResult(true, "Found 7 models", 212)))
        assertEquals("Rejected, 401" to false, Providers.testWords(ProviderTestResult(false, "HTTP 401 unauthorized")))
        assertEquals("Not set" to false, Providers.testWords(ProviderTestResult(false, "No key set")))
        assertEquals("Paste a key that starts with sk-or-", Providers.placeholder("openrouter"))
        assertEquals("Paste a key", Providers.placeholder("zai"))
        val rows = Providers.keyedRows(setOf("openai", "mine", "cliproxy"), setOf("anthropic", "mine", "cliproxy"))
        assertEquals(listOf("anthropic", "openai", "mine"), rows)
        assertFalse(Providers.addable(rows).any { it.id == "openai" })
        val secrets = Json.parseToJsonElement("""{"providers":["openai"],"values":[],"keyed":["zai"]}""")
        assertEquals(setOf("openai", "zai"), providersWithKeys(secrets))
        assertFalse(Providers.needsPaste(SignInStart(state = "s", url = "u", flow = "device"), forced = true))
    }
}
