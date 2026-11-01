package dev.conclave.client

import dev.conclave.client.logic.HubAddress
import dev.conclave.client.logic.HubAddresses
import dev.conclave.client.logic.NetworkKind
import dev.conclave.client.model.HubIdentity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.NoSuchAlgorithmException
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/*
 * Hub identity (docs/design/HUB-LOGIN-AND-IDENTITY.md section 2): the phone
 * never sends its token to a stranger. The hub holds an Ed25519 key pair and
 * signs `conclave-hub-identity-v1\n<nonce>` for a fresh nonce. The app keeps
 * the hub's public key next to its token and checks an address before the
 * first request or socket there that carries the token.
 */

/** The address answered with another key, or a bad signature: nothing with a secret in it was sent. */
class HubIdentityException(
    val address: String,
    message: String = NOT_YOUR_HUB,
) : IOException(message) {
    companion object {
        const val NOT_YOUR_HUB = "This address is not your hub. Conclave did not send your sign-in."
        const val NOT_THE_CODES_HUB = "This address is not the hub that made the code."

        /** The hub's network refusal during the check: the app's own words, not the answering machine's. */
        const val NETWORK_REFUSED = "Your hub does not take connections from this network. Settings, Remote access on the hub shows the address to use."
    }
}

/** Plain http to a public address: the password is never sent there. */
class PasswordOverHttpException : IOException(PasswordRule.REFUSED)

/** Checks an Ed25519 signature. The app plugs in Tink: Android has no Ed25519 in java.security before version 14. */
fun interface Ed25519Verifier {
    /** False for a bad signature. */
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
}

/** java.security Ed25519 (Java 15 and newer): the default on the JVM and in tests. */
object JdkEd25519 : Ed25519Verifier {
    // X.509 SubjectPublicKeyInfo for Ed25519 (OID 1.3.101.112); the 32 raw key bytes follow
    private val X509_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    override fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        val factory = try {
            KeyFactory.getInstance("Ed25519")
        } catch (e: NoSuchAlgorithmException) {
            // no way to check here: treat it as no answer, so nothing is sent
            throw IOException("This device cannot check the hub's identity.", e)
        }
        return try {
            val key = factory.generatePublic(X509EncodedKeySpec(X509_PREFIX + publicKey))
            val sig = Signature.getInstance("Ed25519")
            sig.initVerify(key)
            sig.update(message)
            sig.verify(signature)
        } catch (_: GeneralSecurityException) {
            false
        }
    }
}

/** Keys, fingerprints and the signed text, the same as the hub (packages/server). */
object HubKeys {
    const val CONTEXT = "conclave-hub-identity-v1\n"

    private val random = SecureRandom()

    /** 24 random bytes as 32 base64url characters (the hub takes 16 to 128). */
    fun nonce(): String = encode(ByteArray(24).also { random.nextBytes(it) })

    /** The UTF-8 text the hub signs for [nonce]. */
    fun signedText(nonce: String): ByteArray = (CONTEXT + nonce).toByteArray(Charsets.UTF_8)

    /** Base64url without padding. */
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Base64url, padding optional. Null when it is not base64url. */
    fun decode(s: String): ByteArray? = try {
        Base64.getUrlDecoder().decode(s.trim())
    } catch (_: IllegalArgumentException) {
        null
    }

    /** The 32 raw key bytes, or null when [publicKey] is not an Ed25519 key in base64url. */
    fun rawKey(publicKey: String?): ByteArray? = publicKey?.let { decode(it) }?.takeIf { it.size == 32 }

    /** The first 16 bytes of SHA-256 of the raw key, as 32 lowercase hex characters. */
    fun fingerprint(raw: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(raw).copyOf(16).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    fun fingerprint(publicKey: String?): String? = rawKey(publicKey)?.let { fingerprint(it) }

    /** "21fe 31df a154 ...": groups of four, to read and compare with the hub's Settings. */
    fun groups(fingerprint: String): String = clean(fingerprint).chunked(4).joinToString(" ")

    /** The same fingerprint, whatever the case or spacing. */
    fun sameFingerprint(a: String?, b: String?): Boolean {
        val x = a?.let { clean(it) }.orEmpty()
        return x.length == 32 && x == b?.let { clean(it) }
    }

    /** The same key, however it was encoded. */
    fun sameKey(a: String?, b: String?): Boolean {
        val x = rawKey(a) ?: return false
        val y = rawKey(b) ?: return false
        return x.contentEquals(y)
    }

    /** True when [signature] (base64url) is [publicKey]'s signature of the text for [nonce]. */
    fun verify(publicKey: ByteArray, nonce: String, signature: String, verifier: Ed25519Verifier): Boolean {
        val sig = decode(signature)?.takeIf { it.size == 64 } ?: return false
        return verifier.verify(publicKey, signedText(nonce), sig)
    }

    private fun clean(fp: String): String = fp.filterNot { it.isWhitespace() || it == ':' || it == '-' }.lowercase()
}

/**
 * The hub's pinned key and which addresses proved it lately. One per pairing,
 * shared by every client for that hub, since the address in use changes.
 *
 * Before the first request or socket with the token to an address (not this
 * device), [ensure] asks it to sign a fresh nonce and checks the signature
 * with the pinned key. A success holds for [ttlMs] at that address; a
 * reconnect checks again ([forget]). A stranger (see
 * [ConclaveClient.proveIdentity]) throws [HubIdentityException] and nothing
 * with the token goes there. An address that does not answer throws the
 * IOException: the hub is offline, not a stranger. A 5xx or a 429 is the
 * hub's own [ConclaveApiException].
 *
 * A pairing from before this change has no pinned key. As the TypeScript
 * client and the CLI do, nothing blocks it: the first proof is kept
 * ([onPinned]) when there is one, and an answer that is not (a hub older than
 * identity has no /api/identity) leaves it as it was until the next check.
 */
class HubIdentityGuard(
    pinnedKey: String? = null,
    /** The first key a hub paired before this change proved: keep it with the token. */
    private val onPinned: suspend (HubIdentity) -> Unit = {},
    /** An address failed the check (for a screen that says so). */
    private val onMismatch: (HubIdentityException) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    val ttlMs: Long = DEFAULT_TTL_MS,
) {
    @Volatile
    var pinnedKey: String? = pinnedKey
        private set

    private val checked = ConcurrentHashMap<String, Long>()
    private val lock = Mutex()

    /** [address] proved the key less than [ttlMs] ago, or it is this device. */
    fun isFresh(address: String): Boolean {
        if (exempt(address)) return true
        val at = checked[key(address)] ?: return false
        return now() - at < ttlMs
    }

    /** The next request or socket to [address] checks it again (after a reconnect). */
    fun forget(address: String) {
        checked.remove(key(address))
    }

    /** [address] just proved the key (pairing checked it): no second check right away. */
    fun trust(address: String) {
        checked[key(address)] = now()
    }

    /** Proves the hub at [client]'s address holds the pinned key, unless it did lately. */
    suspend fun ensure(client: ConclaveClient) {
        val address = client.baseUrl
        if (isFresh(address)) return
        lock.withLock {
            if (isFresh(address)) return
            val pinned = pinnedKey
            if (pinned == null) {
                // trust on first use, best effort: a key to keep, or as before until the next check
                val first = try {
                    client.proveIdentity()
                } catch (_: HubIdentityException) {
                    null
                } catch (_: ConclaveApiException) {
                    null
                }
                if (first != null) {
                    pinnedKey = first.publicKey
                    onPinned(first)
                }
                trust(address)
                return
            }
            try {
                client.proveIdentity(expectedKey = pinned)
            } catch (e: HubIdentityException) {
                onMismatch(e)
                throw e
            }
            trust(address)
        }
    }

    private fun key(address: String): String = (HubAddresses.normalize(address) ?: address.trim()).lowercase()

    companion object {
        const val DEFAULT_TTL_MS = 10 * 60_000L

        /** This device: nothing to check. */
        fun exempt(address: String): Boolean = HubAddress.classifyHost(HubAddresses.host(address)) == NetworkKind.LOCALHOST
    }
}

/**
 * Where a password may go (HUB-LOGIN-AND-IDENTITY.md section 1): https, or
 * plain http to this device or a private address (10/8, 172.16/12,
 * 192.168/16, 100.64/10, fd00::/8, *.local, *.ts.net).
 */
object PasswordRule {
    const val REFUSED = "Use the https address of your hub to log in with a password."

    fun allowed(url: String): Boolean {
        val s = url.trim()
        val scheme = s.substringBefore("://", "").lowercase()
        if (scheme == "https") return true
        if (scheme != "http") return false
        return isPrivateAddress(s)
    }

    /** This machine or a private network (isPrivateAddress in the TypeScript client). Takes a URL or a bare host. */
    fun isPrivateAddress(urlOrHost: String): Boolean {
        val s = urlOrHost.trim()
        return privateHost(HubAddresses.host(if (s.contains("://")) s else "http://$s"))
    }

    fun privateHost(hostRaw: String): Boolean {
        val host = hostRaw.trim().trim('[', ']').lowercase().trimEnd('.')
        if (host.isEmpty()) return false
        if (host == "localhost" || host.endsWith(".localhost")) return true
        if (host.endsWith(".local") || host.endsWith(".ts.net")) return true
        ipv4(host)?.let { o ->
            return o[0] == 127 ||
                o[0] == 10 ||
                (o[0] == 172 && o[1] in 16..31) ||
                (o[0] == 192 && o[1] == 168) ||
                (o[0] == 100 && o[1] in 64..127)
        }
        if (host.contains(':')) {
            if (host == "::1") return true
            // fd00::/8: the first group is fdXX
            val first = host.substringBefore(':')
            return first.length == 4 && first.startsWith("fd") && first.all { it in '0'..'9' || it in 'a'..'f' }
        }
        return false
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
