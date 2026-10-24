package dev.conclave.client

import dev.conclave.client.model.LimitState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** A limit state's account, and its key: provider, or provider:account, as core's limitKey. */
class LimitKeyTest {
    @Test
    fun decodesTheAccount() {
        val l = ConclaveJson.decodeFromString(LimitState.serializer(), """{"provider":"cliproxy","account":"claude-b","label":"Claude Max 20x · Account 2","source":"ledger"}""")
        assertEquals("claude-b", l.account)
        assertEquals("cliproxy:claude-b", l.key)
        val bare = ConclaveJson.decodeFromString(LimitState.serializer(), """{"provider":"anthropic"}""")
        assertNull(bare.account)
        assertEquals("anthropic", bare.key)
        assertEquals("openai", LimitState("openai", account = "").key)
    }

    @Test
    fun twoAccountsOnOneProviderKeepTheirOwnState() {
        val a = LimitState("cliproxy", account = "a", label = "A")
        val b = LimitState("cliproxy", account = "b", label = "B")
        val b2 = b.copy(label = "B new")
        // the replacement HubRepository applies on limit_updated
        val list = listOf(a, b).filterNot { it.key == b2.key } + b2
        assertEquals(listOf(a, b2), list)
    }
}
