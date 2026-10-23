package dev.conclave.client.logic

import dev.conclave.client.ConclaveApiException
import dev.conclave.client.HubIdentityException
import dev.conclave.client.model.RemoteAddress
import dev.conclave.client.model.RemoteMode
import dev.conclave.client.model.RemoteState
import dev.conclave.client.model.RemoteStatus
import kotlinx.coroutines.sync.Mutex
import java.io.IOException
import java.net.URI

/*
 * Remote access on the phone (docs/INSTALL.md, Remote access). The hub lists
 * every address that reaches it, best first: a stable tunnel, a quick tunnel,
 * an own URL, then the same network. The app keeps that list, follows the hub
 * to a new tunnel address, and when the address in use stops answering moves
 * to the first saved one that does. The same rules as packages/web/src/lib/remote.ts.
 */

object HubAddresses {

    /**
     * "https://x.trycloudflare.com/" to "https://x.trycloudflare.com". Null for
     * anything that is not http or https with a host, or that carries a query,
     * a fragment or a login.
     */
    fun normalize(raw: String?): String? {
        val s = raw?.trim()?.trimEnd('/') ?: return null
        if (s.isEmpty()) return null
        val uri = try {
            URI(s)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrBlank()) return null
        if (uri.rawQuery != null || uri.rawFragment != null || uri.rawUserInfo != null) return null
        return s
    }

    fun host(url: String?): String = try {
        URI(url?.trim().orEmpty()).host?.trim('[', ']')?.lowercase().orEmpty()
    } catch (_: Exception) {
        ""
    }

    /** True for the same address, whatever the case or a trailing slash. */
    fun same(a: String?, b: String?): Boolean {
        val x = normalize(a) ?: return false
        val y = normalize(b) ?: return false
        return x.equals(y, ignoreCase = true)
    }

    /** A Cloudflare quick tunnel: its name changes on every restart and never comes back. */
    fun isQuickTunnel(url: String?): Boolean = host(url).endsWith(".trycloudflare.com")

    /** Valid addresses in order, each once. */
    fun dedupe(urls: List<String>): List<String> {
        val out = ArrayList<String>()
        for (u in urls) {
            val n = normalize(u) ?: continue
            if (out.none { it.equals(n, ignoreCase = true) }) out.add(n)
        }
        return out
    }

    /**
     * What to save at pairing: the hub's own list from the reply (best
     * first). From an older hub that sends none, only the address the code
     * worked on: the QR code's alts are not the hub's word, and the token
     * must never go to an address only a code named.
     */
    fun atPairing(used: String, reply: List<String>): List<String> {
        val fromHub = dedupe(reply)
        return fromHub.ifEmpty { dedupe(listOf(used)) }
    }

    /** The hub's addresses from GET /api/remote or remote.updated, best first. */
    fun fromStatus(s: RemoteStatus): List<String> = dedupe(s.addresses.map { it.url })

    /**
     * remote.updated: the new tunnel address, when the hub just replaced the
     * one this app uses ([RemoteStatus.previousUrl]) and the new one is on.
     * The old address keeps working for about 20 seconds.
     */
    fun moveTo(current: String, s: RemoteStatus): String? {
        if (s.state != RemoteState.ON) return null
        val prev = s.previousUrl ?: return null
        val next = normalize(s.url) ?: return null
        if (!same(prev, current) || same(next, current)) return null
        return next
    }

    /**
     * Where to look when [current] stops answering: the saved addresses in
     * the hub's order. The list is the hub's latest, so a quick tunnel
     * address it dropped is never tried (Cloudflare can give that name to
     * someone else later).
     */
    fun fallbacks(current: String, saved: List<String>): List<String> = saved.filterNot { same(it, current) }

    /** Nothing answers. Only a quick tunnel address is gone for good, so only then is a new code the way back. */
    fun needsNewCode(current: String): Boolean = isQuickTunnel(current)

    /**
     * Pairing: [attempt] at each of [urls] in order (the code's best address,
     * then its alts), moving on only when an address does not answer. The
     * hub's own answer (a wrong or used code) and another machine at the
     * address ([HubIdentityException]) stop at once. Returns the address that
     * worked with its result, or throws the last failure.
     */
    suspend fun <T> firstAnswer(urls: List<String>, attempt: suspend (String) -> T): kotlin.Pair<String, T> {
        var failure: IOException? = null
        for (url in urls) {
            try {
                return url to attempt(url)
            } catch (e: ConclaveApiException) {
                throw e
            } catch (e: HubIdentityException) {
                throw e
            } catch (e: IOException) {
                failure = e
            }
        }
        throw failure ?: IOException("Could not reach the hub. Check the address, or scan the code again.")
    }
}

/**
 * The live connection dropped: is the hub still at its address, at another
 * saved one, or gone? Checks GET /api/health (no token) on the address in
 * use, then on the saved ones in order, and moves to the first that answers.
 * At most one round every [minGapMs] while the address is down.
 */
class AddressRecovery(
    private val answers: suspend (String) -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
    private val minGapMs: Long = 15_000,
) {
    sealed class Outcome {
        /** The address in use answers: the socket closed for another reason (a hub restart). */
        data object Fine : Outcome()

        /** A round ran too recently, or one is running. */
        data object Later : Outcome()

        data class Move(val url: String) : Outcome()

        /** Nothing answers. [newCode]: the address was a quick tunnel, so the owner has to scan a new code. */
        data class Lost(val newCode: Boolean) : Outcome()
    }

    private val running = Mutex()

    @Volatile
    private var lastRound = 0L

    suspend fun recover(current: String, saved: List<String>): Outcome {
        if (!running.tryLock()) return Outcome.Later
        try {
            // still answers: nothing to do, and no wait counted
            if (answers(current)) return Outcome.Fine
            val t = now()
            if (lastRound != 0L && t - lastRound < minGapMs) return Outcome.Later
            lastRound = t
            for (url in HubAddresses.fallbacks(current, saved)) {
                if (answers(url)) return Outcome.Move(url)
            }
            return Outcome.Lost(HubAddresses.needsNewCode(current))
        } finally {
            running.unlock()
        }
    }

    /** A new network or a new address: the next round may run at once. */
    fun reset() {
        lastRound = 0L
    }
}

/** The words of the Remote access screen, as on the web (features/settings/remote.tsx). */
object RemoteWords {

    /** The order of the choice. */
    val MODES = listOf(RemoteMode.QUICK, RemoteMode.STABLE, RemoteMode.TAILSCALE, RemoteMode.CUSTOM, RemoteMode.OFF)

    fun label(m: RemoteMode): String = when (m) {
        RemoteMode.QUICK -> "Quick tunnel"
        RemoteMode.STABLE -> "Stable address on your domain"
        RemoteMode.TAILSCALE -> "Tailscale"
        RemoteMode.CUSTOM -> "My own URL"
        RemoteMode.OFF -> "Local only"
    }

    fun help(m: RemoteMode): String = when (m) {
        RemoteMode.QUICK -> "Built in, no account. The hub runs a Cloudflare tunnel and gets an https address. The address changes when the hub restarts; this app follows it."
        RemoteMode.STABLE -> "A fixed name such as conclave.example.com, through your Cloudflare account. Paste an API token once and pick the domain."
        RemoteMode.TAILSCALE -> "Only devices on your tailnet. Tailscale has to run on the hub and on this phone."
        RemoteMode.CUSTOM -> "A reverse proxy or domain you already run in front of the hub."
        RemoteMode.OFF -> "No outside address. This phone connects only on the hub's network."
    }

    enum class Tone { OK, FAULT, DIM, LIVE }

    data class StateLine(val word: String, val tone: Tone, val rest: String)

    /** The first address that works away from home, if any. */
    fun outside(s: RemoteStatus): RemoteAddress? = s.addresses.firstOrNull { it.kind != "lan" }

    private fun sentence(text: String): String {
        val t = text.trim()
        return if (t.endsWith('.') || t.endsWith('!') || t.endsWith('?')) t else "$t."
    }

    /** "On. Phones and computers reach the hub at https://..." and the like. */
    fun state(s: RemoteStatus): StateLine = when (s.state) {
        RemoteState.ON -> {
            val out = outside(s)
            if (out != null) {
                StateLine("On.", Tone.OK, "Phones and computers reach the hub at ${out.url}.")
            } else {
                StateLine("On.", Tone.OK, "Devices on the same network can connect.")
            }
        }
        RemoteState.STARTING -> StateLine("Starting.", Tone.LIVE, sentence(s.detail ?: "Getting the tunnel ready"))
        RemoteState.INSTALLING -> StateLine("Installing.", Tone.LIVE, sentence(s.detail ?: "Getting the tunnel ready"))
        RemoteState.ERROR -> StateLine("Not working.", Tone.FAULT, sentence(s.error ?: "Remote access stopped. Try again, or pick another option"))
        RemoteState.OFF ->
            if (s.addresses.any { it.kind == "lan" }) {
                StateLine("Off.", Tone.DIM, "Only devices on the same network can reach the hub.")
            } else {
                StateLine("Off.", Tone.DIM, "Only the hub's own computer can reach it.")
            }
    }

    /** The help under "Devices on this network". */
    fun lanHelp(s: RemoteStatus): String {
        val fixed = s.lan.fixedHost
        if (fixed != null) return "The hub listens on $fixed, set by --host or server.host on the hub. Change it there."
        if (!s.lan.on) return "Off: only the hub's computer and the outside address reach the hub."
        val lan = s.addresses.firstOrNull { it.kind == "lan" }
            ?: return "On, but the hub has no address on a home or office network right now."
        return "Phones on the hub's Wi-Fi use ${lan.url}. It is plain http, so keep it to networks you trust."
    }

    /** Which kind of address [url] is in the hub's list: stable, quick, own or lan. Null when the hub does not list it. */
    fun kindOf(url: String, s: RemoteStatus): String? = s.addresses.firstOrNull { HubAddresses.same(it.url, url) }?.kind

    /**
     * Would switching to [mode] cut this phone off? It would when the phone
     * uses an outside address and the change leaves none (Local only). Other
     * changes are fine: the hub brings the new address up first and
     * announces it, and the app follows.
     */
    fun cutsOff(current: String, s: RemoteStatus, mode: RemoteMode): Boolean {
        val kind = kindOf(current, s) ?: return false
        return kind != "lan" && mode == RemoteMode.OFF && s.mode != RemoteMode.OFF
    }

    /** Would turning off devices on this network cut this phone off? */
    fun lanOffCutsOff(current: String, s: RemoteStatus): Boolean = kindOf(current, s) == "lan"

    /**
     * The hub refused the live connection, in words with what to do next.
     * [message] is the hub's own words, shown as they are when it sent some.
     */
    fun refusal(status: Int, message: String?, retryAfterSeconds: Long?): String = when (status) {
        401 -> "The hub no longer accepts this phone. Pair again in Settings."
        403 -> message?.trim()?.takeIf { it.isNotEmpty() }
            ?: "The hub does not take connections from this network. Connect from the hub's network, or turn on remote access on the hub."
        429 -> waitText(retryAfterSeconds)
        else -> message?.trim()?.takeIf { it.isNotEmpty() } ?: "The hub refused the connection ($status)."
    }

    /** A 429: too many failed tries from this address. */
    fun waitText(seconds: Long?): String = when {
        seconds == null || seconds <= 0 -> "Too many failed tries from this network. Wait a minute, then try again."
        seconds == 1L -> "Too many failed tries from this network. Wait 1 second, then try again."
        seconds < 120 -> "Too many failed tries from this network. Wait $seconds seconds, then try again."
        else -> "Too many failed tries from this network. Wait ${(seconds + 59) / 60} minutes, then try again."
    }
}
