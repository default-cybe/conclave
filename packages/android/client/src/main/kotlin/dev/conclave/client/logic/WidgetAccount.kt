package dev.conclave.client.logic

import java.security.MessageDigest

/** A pairing-scoped, memory-only snapshot. Late replies from a signed-out account cannot publish. */
class WidgetAccount {
    private var account: String? = null
    private var pages: List<WidgetPage> = emptyList()

    @Synchronized
    fun bind(key: String?) {
        if (account != key) pages = emptyList()
        account = key
    }

    @Synchronized
    fun publish(key: String, value: List<WidgetPage>): Boolean {
        if (account != key) return false
        pages = value
        return true
    }

    @Synchronized
    fun read(key: String?): List<WidgetPage> = if (key != null && key == account) pages else emptyList()

    companion object {
        /** Pending intents carry a digest, never the bearer token. Every pairing has a new token. */
        fun key(token: String?): String? = token?.takeIf { it.isNotBlank() }?.let {
            MessageDigest.getInstance("SHA-256").digest(it.toByteArray(Charsets.UTF_8)).joinToString("") { b -> "%02x".format(b) }
        }
    }
}
