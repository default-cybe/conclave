package dev.conclave.client.logic

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Where a hub URL points, for the plain-HTTP warning on the pairing screen.
 * VPN is a private VPN range (100.64.0.0/10, *.ts.net): reachable only
 * through that VPN, so plain http there is no worse than on a home network.
 */
enum class NetworkKind { LOCALHOST, VPN, LAN, PUBLIC }

data class HubAddress(
    val url: String,
    val scheme: String,
    val host: String,
    val kind: NetworkKind,
) {
    val isHttps: Boolean get() = scheme == "https"

    /** Plain http to a public address: traffic and token travel unencrypted. */
    val needsWarning: Boolean get() = !isHttps && kind == NetworkKind.PUBLIC

    /** This machine, a home or office network, or a private VPN range: plain http is allowed there without asking. */
    val isPrivate: Boolean get() = kind != NetworkKind.PUBLIC

    companion object {
        /**
         * Normalizes and classifies a hub URL. Adds http:// for bare private
         * hosts and https:// otherwise. Returns null when it cannot be parsed.
         */
        fun parse(raw: String): HubAddress? {
            var s = raw.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (!s.contains("://")) {
                val hostGuess = s.substringBefore('/').substringBefore(':')
                s = (if (classifyHost(hostGuess) == NetworkKind.PUBLIC) "https://" else "http://") + s
            }
            val uri = try {
                URI(s)
            } catch (_: Exception) {
                return null
            }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.trim('[', ']')?.lowercase() ?: return null
            if (host.isEmpty()) return null
            return HubAddress(s, scheme, host, classifyHost(host))
        }

        fun classifyHost(hostRaw: String): NetworkKind {
            val host = hostRaw.trim().trim('[', ']').lowercase().trimEnd('.')
            if (host == "localhost" || host.endsWith(".localhost")) return NetworkKind.LOCALHOST
            if (host.endsWith(".ts.net")) return NetworkKind.VPN
            if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".internal")) {
                return NetworkKind.LAN
            }
            ipv4(host)?.let { o ->
                return when {
                    o[0] == 127 -> NetworkKind.LOCALHOST
                    o[0] == 100 && o[1] in 64..127 -> NetworkKind.VPN // 100.64.0.0/10 (CGNAT, VPNs such as Tailscale)
                    o[0] == 10 -> NetworkKind.LAN
                    o[0] == 172 && o[1] in 16..31 -> NetworkKind.LAN
                    o[0] == 192 && o[1] == 168 -> NetworkKind.LAN
                    o[0] == 169 && o[1] == 254 -> NetworkKind.LAN
                    else -> NetworkKind.PUBLIC
                }
            }
            if (host.contains(':')) {
                // IPv6
                if (host == "::1") return NetworkKind.LOCALHOST
                if (host.startsWith("fd7a:115c:a1e0:")) return NetworkKind.VPN
                if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return NetworkKind.LAN
                return NetworkKind.PUBLIC
            }
            // Single-label names (e.g. "nas") only resolve on a local network.
            if (!host.contains('.')) return NetworkKind.LAN
            return NetworkKind.PUBLIC
        }

        private fun ipv4(host: String): IntArray? {
            val parts = host.split('.')
            if (parts.size != 4) return null
            val out = IntArray(4)
            for (i in 0 until 4) {
                val n = parts[i].toIntOrNull() ?: return null
                if (n !in 0..255) return null
                out[i] = n
            }
            return out
        }
    }
}

/** Parsed app deep links. */
sealed class DeepLink {
    /**
     * conclave://pair?url=...&code=...&fp=...&alt=...&alt=... [url] is the hub's
     * best address; each alt is another one (the same network, an own URL),
     * best first. The app keeps them all and tries them when one stops
     * answering. [fp] is the hub's identity fingerprint: an address must prove
     * it before the code goes there. Null from hubs older than that.
     */
    data class Pair(val url: String, val code: String, val alts: List<String> = emptyList(), val fp: String? = null) : DeepLink()

    /** conclave://session/<id> or a hub path like /s/<id> */
    data class Session(val id: String) : DeepLink()

    /** conclave://chat/<id> or a hub path like /chat/<id>: one chat on the Chat tab. */
    data class Chat(val id: String) : DeepLink()

    /** conclave://new or conclave://chat: a new chat. */
    data object NewChat : DeepLink()

    /** conclave://approvals */
    data object Approvals : DeepLink()

    /** conclave://workflow-run/<id> or the hub path /workflows/runs/<id>: one workflow run. */
    data class WorkflowRun(val id: String) : DeepLink()

    /** conclave://friend?fp=...&url=...&s=...&exp=...: a friend's invite, which Friends shows before it is used. */
    data class FriendInvite(val link: String) : DeepLink()

    /** The hub path /settings/friends (a friend notice), or /settings/friends/<id>: Friends, or one friend. */
    data class Friends(val id: String? = null) : DeepLink()

    /** The hub path /shares, or /shares/<id>: the shares, or one from a friend. */
    data class Shares(val id: String? = null) : DeepLink()

    /** conclave://map or the hub path /map. */
    data object MapPage : DeepLink()

    companion object {
        fun parse(raw: String?): DeepLink? {
            if (raw.isNullOrBlank()) return null
            val s = raw.trim()
            // Hub notice links are app paths: /s/<id>, /sessions/<id> or /chat/<id>
            if (s.startsWith("/")) return sessionFromPath(s)
            val uri = try {
                URI(s)
            } catch (_: Exception) {
                return null
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme == "conclave") {
                val host = uri.host ?: uri.authority ?: ""
                val path = uri.rawPath.orEmpty().trim('/')
                return when (host.lowercase()) {
                    "pair" -> {
                        val q = query(uri.rawQuery)
                        val url = q["url"]?.firstOrNull { it.isNotBlank() } ?: return null
                        val code = q["code"]?.firstOrNull { it.isNotBlank() } ?: return null
                        val alts = q["alt"].orEmpty().map { it.trim() }.filter { it.isNotEmpty() && it != url }.distinct()
                        val fp = q["fp"]?.firstOrNull { it.isNotBlank() }?.trim()?.lowercase()
                        Pair(url, code, alts, fp)
                    }
                    "session", "s" -> path.substringBefore('/').takeIf { it.isNotBlank() }?.let { Session(decode(it)) }
                    "chat" -> path.substringBefore('/').takeIf { it.isNotBlank() }?.let { Chat(decode(it)) } ?: NewChat
                    "new" -> NewChat
                    "approvals" -> Approvals
                    "workflow-run" -> path.substringBefore('/').takeIf { it.isNotBlank() }?.let { WorkflowRun(decode(it)) }
                    "friend" -> FriendWords.parseLink(s)?.let { FriendInvite(it.link) }
                    "friends" -> Friends(path.substringBefore('/').takeIf { it.isNotBlank() }?.let { decode(it) })
                    "shares", "share" -> Shares(path.substringBefore('/').takeIf { it.isNotBlank() }?.let { decode(it) })
                    "map" -> MapPage
                    else -> null
                }
            }
            if (scheme == "http" || scheme == "https") return uri.rawPath?.let { sessionFromPath(it) }
            return null
        }

        private fun sessionFromPath(path: String): DeepLink? {
            val parts = path.trim('/').split('/')
            if (parts.size >= 2 && (parts[0] == "s" || parts[0] == "sessions" || parts[0] == "session") && parts[1].isNotBlank()) {
                return Session(decode(parts[1]))
            }
            if (parts.size >= 2 && parts[0] == "chat" && parts[1].isNotBlank()) return Chat(decode(parts[1]))
            if (parts.size >= 3 && parts[0] == "workflows" && parts[1] == "runs" && parts[2].isNotBlank()) return WorkflowRun(decode(parts[2]))
            if (parts.size >= 2 && parts[0] == "settings" && parts[1] == "friends") return Friends(parts.getOrNull(2)?.takeIf { it.isNotBlank() }?.let { decode(it) })
            if (parts[0] == "shares") return Shares(parts.getOrNull(1)?.takeIf { it.isNotBlank() }?.let { decode(it) })
            if (parts.size == 1 && parts[0] == "map") return MapPage
            return null
        }

        /** Every value of each key, in order (alt repeats). */
        private fun query(raw: String?): Map<String, List<String>> {
            if (raw.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, MutableList<String>>()
            for (pair in raw.split('&')) {
                if (pair.isEmpty()) continue
                val k = pair.substringBefore('=')
                val v = if (pair.contains('=')) pair.substringAfter('=') else ""
                out.getOrPut(decode(k)) { ArrayList() }.add(decode(v))
            }
            return out
        }

        private fun decode(s: String): String = try {
            URLDecoder.decode(s, StandardCharsets.UTF_8.name())
        } catch (_: Exception) {
            s
        }
    }
}
