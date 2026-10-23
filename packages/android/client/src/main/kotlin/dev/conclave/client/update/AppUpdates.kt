package dev.conclave.client.update

import dev.conclave.client.Ed25519Verifier
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.InputStream
import java.security.MessageDigest

/*
 * The app's own updates (docs/DESIGN.md, Updates): the manifest Publish
 * public writes on each release (packages/core/src/update/manifest.ts), the
 * version order, and the check of a downloaded APK. The Android side (the
 * download, the system installer) is in the app module, app/update.
 */

@Serializable
data class UpdateArtifact(
    val file: String,
    val url: String,
    val sha256: String,
    val size: Long,
    val signature: String? = null,
)

/** conclave-update.json; only what the app reads. */
@Serializable
data class UpdateManifest(
    val schema: Int = 0,
    val version: String = "",
    val tag: String = "",
    val notes: String = "",
    val pubDate: String = "",
    val signed: Boolean = false,
    val android: UpdateArtifact? = null,
)

object AppUpdates {
    /** The newest release's manifest on the public releases. */
    const val MANIFEST_URL = "https://github.com/default-cybe/conclave/releases/latest/download/conclave-update.json"

    /** Look again after a day. */
    const val EVERY_MS = 24L * 60 * 60 * 1000

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** Parse a manifest; null when it is not one this app reads. */
    fun parse(text: String): UpdateManifest? = try {
        json.decodeFromString(UpdateManifest.serializer(), text).takeIf { it.schema == 1 && parseVersion(it.version) != null }
    } catch (_: Exception) {
        null
    }

    private class Version(val nums: List<Long>, val pre: List<String>)

    private val VERSION = Regex("""^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$""")

    private fun parseVersion(v: String): Version? {
        val m = VERSION.matchEntire(v.trim()) ?: return null
        val g = m.groupValues
        val nums = listOf(g[1], g[2].ifEmpty { "0" }, g[3].ifEmpty { "0" }).map { it.toLongOrNull() ?: return null }
        return Version(nums, if (g[4].isEmpty()) emptyList() else g[4].split('.'))
    }

    /** Semver order (manifest.ts compareVersions); a string that is not a version sorts first. */
    fun compareVersions(a: String, b: String): Int {
        val x = parseVersion(a)
        val y = parseVersion(b)
        if (x == null || y == null) return if (x != null) 1 else if (y != null) -1 else 0
        for (i in 0 until 3) if (x.nums[i] != y.nums[i]) return x.nums[i].compareTo(y.nums[i]).coerceIn(-1, 1)
        if (x.pre.isEmpty() || y.pre.isEmpty()) return if (x.pre.size == y.pre.size) 0 else if (x.pre.isEmpty()) 1 else -1
        for (i in 0 until maxOf(x.pre.size, y.pre.size)) {
            val p = x.pre.getOrNull(i) ?: return -1
            val q = y.pre.getOrNull(i) ?: return 1
            val pn = p.toLongOrNull()
            val qn = q.toLongOrNull()
            val c = when {
                pn != null && qn != null -> pn.compareTo(qn)
                pn != null -> -1
                qn != null -> 1
                else -> p.compareTo(q)
            }
            if (c != 0) return c.coerceIn(-1, 1)
        }
        return 0
    }

    /** latest is newer than current. A test build ("test-123") or a debug one ("0.5.0-debug") is never behind. */
    fun isNewer(latest: String, current: String): Boolean =
        parseVersion(current) != null && parseVersion(latest) != null && !current.endsWith("-debug") && compareVersions(latest, current) > 0

    /** What Settings shows for a manifest. */
    sealed interface Offer {
        /** A newer, signed APK to install. */
        data class Install(val version: String, val notes: String, val apk: UpdateArtifact) : Offer

        /** A newer release this app cannot install by itself, and why. */
        data class ByHand(val version: String, val why: String) : Offer
    }

    /** The offer for this app, or null when it is up to date. */
    fun offer(m: UpdateManifest, current: String, key: MinisignKey?): Offer? {
        if (!isNewer(m.version, current)) return null
        val apk = m.android ?: return Offer.ByHand(m.version, "This release has no app for Android yet.")
        if (key == null) return Offer.ByHand(m.version, Minisign.NO_KEY)
        if (!m.signed || apk.signature.isNullOrBlank()) return Offer.ByHand(m.version, "This release is unsigned, so the app does not install it. Download it by hand.")
        if (!apk.url.startsWith("https://")) return Offer.ByHand(m.version, "The download address is not https.")
        return Offer.Install(m.version, m.notes, apk)
    }

    /**
     * Check a downloaded APK: its size, SHA-256 and signature, in one read.
     * Throws [SignatureException] with a sentence for people.
     */
    fun verify(input: InputStream, apk: UpdateArtifact, key: MinisignKey, ed: Ed25519Verifier) {
        val sha = MessageDigest.getInstance("SHA-256")
        val b2 = Blake2b512()
        val buf = ByteArray(64 * 1024)
        var size = 0L
        input.use { s ->
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                size += n
                if (size > apk.size) throw SignatureException("The download is larger than the release says. Nothing was installed.")
                sha.update(buf, 0, n)
                b2.update(buf, 0, n)
            }
        }
        if (size != apk.size) throw SignatureException("The download was cut off at $size of ${apk.size} bytes. Try again.")
        val hex = sha.digest().joinToString("") { "%02x".format(it) }
        if (!hex.equals(apk.sha256, ignoreCase = true)) throw SignatureException("The download does not match the SHA-256 of the release. Nothing was installed.")
        Minisign.verifyPrehashed(b2.digest(), apk.signature ?: throw SignatureException("This release is unsigned."), key, ed)
    }
}
