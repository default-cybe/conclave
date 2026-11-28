package dev.conclave.client.logic

import dev.conclave.client.model.ProviderAccess
import dev.conclave.client.model.ProviderTestResult
import dev.conclave.client.model.SignInStart
import dev.conclave.client.model.SubscriptionAccount
import dev.conclave.client.model.SubscriptionProvider
import dev.conclave.client.model.SubscriptionsStatus
import java.util.Locale

/** A provider that takes an API key (web lib/providers.ts PROVIDERS, the keyed ones). */
data class KeyProvider(val id: String, val name: String, val description: String, val keyPrefix: String? = null)

/**
 * Settings, Providers and Subscriptions on the phone (web settings/providers.tsx,
 * people.tsx MemberProvidersSection, components/subscriptions): the words and
 * the choices, kept here so they are tested without a device.
 */
object Providers {
    /** The providers the web's Add a provider menu offers with a key, in its order. Local ones (Ollama, LM Studio) need no key. */
    val KEYED = listOf(
        KeyProvider("anthropic", "Anthropic", "Claude models with an API key", "sk-ant-"),
        KeyProvider("openai", "OpenAI", "GPT and o-series models", "sk-proj-"),
        KeyProvider("zai", "Z.ai", "GLM Coding plan"),
        KeyProvider("google", "Google Gemini", "Gemini through AI Studio", "AIza"),
        KeyProvider("openrouter", "OpenRouter", "One key for hundreds of models", "sk-or-"),
        KeyProvider("deepseek", "DeepSeek", "DeepSeek V3 and R1", "sk-"),
        KeyProvider("moonshot", "Moonshot", "Kimi models", "sk-"),
        KeyProvider("mistral", "Mistral", "Mistral and Codestral"),
        KeyProvider("groq", "Groq", "Fast open models", "gsk_"),
        KeyProvider("xai", "xAI", "Grok models", "xai-"),
        KeyProvider("qwen", "Qwen", "Qwen through Alibaba Cloud", "sk-"),
    )

    fun info(id: String): KeyProvider? = KEYED.firstOrNull { it.id == id }

    /** A row's name: the catalog's, the local ones by their product names, else the id. */
    fun name(id: String): String = info(id)?.name ?: when (id) {
        "ollama" -> "Ollama"
        "lmstudio" -> "LM Studio"
        else -> id
    }

    /** "Paste a key that starts with sk-or-", or "Paste a key". */
    fun placeholder(id: String): String = info(id)?.keyPrefix?.let { "Paste a key that starts with $it" } ?: "Paste a key"

    /** The owner's rows: every catalog provider with a key, then the hub's other keyed (custom) providers. cliproxy is on Subscriptions. */
    fun keyedRows(withKeys: Set<String>, configured: Set<String>): List<String> {
        val known = KEYED.map { it.id }.filter { it in withKeys || it in configured }
        val custom = configured.filter { it !in KEYED.map { k -> k.id } && it != "cliproxy" && it in withKeys }
        return known + custom.sorted()
    }

    /** The catalog providers the owner can still add a key for. */
    fun addable(rows: List<String>): List<KeyProvider> = KEYED.filter { it.id !in rows }

    /** A key test in words, as the web's ProviderResultWords: "Works, 7 models, 212 ms", "Rejected, 401", "Not set". */
    fun testWords(r: ProviderTestResult): Pair<String, Boolean> = when {
        r.ok -> ("Works, " + r.detail.replace(Regex("^Found\\s+", RegexOption.IGNORE_CASE), "") + (r.latencyMs?.let { ", $it ms" } ?: "")) to true
        Regex("no key set", RegexOption.IGNORE_CASE).containsMatchIn(r.detail) -> "Not set" to false
        else -> ("Rejected" + (Regex("\\b([45]\\d\\d)\\b").find(r.detail)?.groupValues?.get(1)?.let { ", $it" } ?: "")) to false
    }

    /** A member's provider: whose key a call uses, in words, and its line (web people.tsx accessWords). Tone: ok, warn or dim. */
    fun accessWords(p: ProviderAccess, resets: (Long) -> String): Triple<String, String, String> {
        if (p.source == "own") return Triple("Your key", "ok", "Calls use your key and your account with the provider.")
        if (p.source == "hub") {
            val cap = p.monthlyUsd
            val left = if (cap != null) "${usd(p.spentUsd)} of ${usd(cap)} this month, resets ${resets(p.resetsAt)}" else "${usd(p.spentUsd)} this month, no cap"
            return if (p.overBudget) Triple("Budget used", "warn", left) else Triple("The hub's key", "ok", left)
        }
        return Triple("No access", "dim", "Add your own key, or ask the owner.")
    }

    private fun usd(v: Double): String = "$" + String.format(Locale.US, "%.2f", v)

    // ---------------------------------------------------------------- subscriptions

    /** An account's state word and tone (web lib/subscriptions.ts ACCOUNT_WORD). */
    fun accountWord(state: String): Pair<String, String> = when (state) {
        "active" -> "Active" to "ok"
        "refreshing" -> "Refreshing" to "live"
        "disabled" -> "Turned off" to "dim"
        "unavailable" -> "Limited" to "warn"
        "error" -> "Failed" to "fault"
        else -> "Unknown" to "dim"
    }

    fun accountLabel(a: SubscriptionAccount): String = a.label?.ifBlank { null } ?: a.providerName

    /** Who is signed in to [p]: "Not signed in", the one account, or "2 accounts". */
    fun who(s: SubscriptionsStatus, p: SubscriptionProvider): String {
        val mine = s.accounts.filter { it.provider == p.id }
        return when (mine.size) {
            0 -> "Not signed in"
            1 -> accountLabel(mine[0])
            else -> "${mine.size} accounts"
        }
    }

    /** The row's button: "Sign in", or "Add account" once one is signed in. */
    fun action(s: SubscriptionsStatus, p: SubscriptionProvider): String = if (s.accounts.any { it.provider == p.id }) "Add account" else "Sign in"

    /** Sign in works: off (the first sign-in starts the built-in one), or a CLIProxyAPI whose management answers. */
    fun usable(s: SubscriptionsStatus): Boolean = s.mode == "off" || s.management

    /** Start the built-in CLIProxyAPI first: it is off, or not answering yet. */
    fun needsStart(s: SubscriptionsStatus): Boolean = s.mode == "off" || s.state != "on"

    /** The main rows, then the "More" ones once [more] (open by itself while one of those has an account). */
    fun rows(s: SubscriptionsStatus, more: Boolean): List<SubscriptionProvider> = if (more || s.providers.any { it.more && it.accounts > 0 }) s.providers else s.providers.filter { !it.more }

    /** A redirect sign-in the hub does not catch (a phone always): the address from the browser bar has to be pasted. */
    fun needsPaste(start: SignInStart, forced: Boolean): Boolean = start.flow == "redirect" && (!start.caught || forced)

    /** What the waiting panel says ([name]: "Claude"). */
    fun waitingLine(start: SignInStart, name: String, paste: Boolean): String = when {
        start.flow == "device" -> "Type this code on the $name page that opened. This updates by itself when you are done."
        paste -> "$name ends on a ${start.callbackHost ?: "localhost"} page that will not load on this phone, because the hub is on another computer. Copy that page's address from the browser bar and paste it here."
        else -> "The $name sign-in opened in the browser. Finish there and come back; this updates by itself."
    }

    /** The status line over the rows (web statusSentence): word and rest. */
    fun statusLine(s: SubscriptionsStatus): Pair<String, String> {
        val n = s.accounts.size
        val accounts = if (n == 0) "No account is signed in yet." else if (n == 1) "One account is signed in." else "$n accounts are signed in."
        return when (s.state) {
            "on" -> "On." to accounts
            "installing" -> "Installing." to (s.detail ?: "Downloading CLIProxyAPI.")
            "starting" -> "Starting." to (s.detail ?: "Starting CLIProxyAPI.")
            "error" -> "Not working." to (s.error ?: "CLIProxyAPI does not answer.")
            else -> "Off." to "The first sign-in starts CLIProxyAPI on the hub."
        }
    }
}
