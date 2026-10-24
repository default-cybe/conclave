package dev.conclave.client

import dev.conclave.client.update.AppUpdates
import dev.conclave.client.update.Blake2b512
import dev.conclave.client.update.Minisign
import dev.conclave.client.update.SignatureException
import dev.conclave.client.update.UpdateArtifact
import dev.conclave.client.update.UpdateManifest
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UpdateTest {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    // From `tauri signer generate` and `tauri signer sign` over "conclave release bytes"; the private key was thrown away.
    // The TypeScript and Rust tests use the same pair.
    private val tauriPub = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0NkJEQjQ3MEM2Q0MxQUQKUldTdHdXd01SOXRyTkZwNE84WHF0Rmk0UUMrWHZxK3FiOGdzYnZwQ3pIWkM1dVYySTVITmhJckMK"
    private val tauriSig = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdHdXd01SOXRyTkg1dmVUZFRUMk4zVWlyODE4Z3NLVWVOa2UzMWVWblRqRmVzbFBWNmZidm5EM2k0NE9jOTBTbHBZSlVGeGlCRmRpZFNNMjNYWkNVRGpJMzNVSzNHMndjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNTk0ODY5CWZpbGU6ZGF0YS5iaW4KS0hrUm01bHIrRGFUeElwdklONEp1MDdWOURJWnpQeGJJMjBHTFNlbXJsV1l1RWZFY25iUGZVR2UzaGxOejNXVHlPUGU0RXJuTWJkMTF2ZDVjUktrQUE9PQo="
    // another throwaway key's signature of a small shell script
    private val otherSig = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSYVdscGFBUUlEQkZXY1N4eTZZMzV5YllXb0E1SHhRWWE5OWd0VXo3RXMrQzNFMmcxcEFnckFXS0cxTzdxa0dxcUlEK1pvOTFhaVhxZzMxdjNmZHNYOFhycmxkTW1jYlFRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzAwMDAwMDAwCWZpbGU6Y29uY2xhdmUtZGFlbW9uCm13ZlAyR3RLQXkzQThuelJ2WndaazZMTXZDLy9qdUxCTzZLVDBubGxMREtkZXhXN3E4bHNxemtUNEF3MXd3SVhhT3A5UlBPQTBQREQrQUo3c2sxVERBPT0K"
    private val data = "conclave release bytes".toByteArray()

    @Test
    fun blake2b512MatchesRfc7693() {
        assertEquals(
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
            hex(Blake2b512.hash(ByteArray(0))),
        )
        assertEquals(
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            hex(Blake2b512.hash("abc".toByteArray())),
        )
        // in pieces across block edges, the same as in one go
        val big = ByteArray(1000) { (it * 7).toByte() }
        val pieces = Blake2b512()
        var at = 0
        for (n in listOf(1, 127, 128, 129, 300, 315)) {
            pieces.update(big, at, n)
            at += n
        }
        assertEquals(hex(Blake2b512.hash(big)), hex(pieces.digest()))
    }

    @Test
    fun aTauriSignatureChecksOut() {
        val key = assertNotNull(Minisign.readKey("# comment\n$tauriPub\n"))
        assertEquals("timestamp:1792594869\tfile:data.bin", Minisign.verify(data, tauriSig, key, JdkEd25519))
        val changed = assertFailsWith<SignatureException> { Minisign.verify("conclave release bytez".toByteArray(), tauriSig, key, JdkEd25519) }
        assertTrue(changed.message!!.contains("does not match"))
        val other = assertFailsWith<SignatureException> { Minisign.verify(data, otherSig, key, JdkEd25519) }
        assertTrue(other.message!!.contains("another key"))
        // a changed trusted comment
        val text = Minisign.text(tauriSig).replace("file:data.bin", "file:other.bin")
        val comment = assertFailsWith<SignatureException> { Minisign.verify(data, text, key, JdkEd25519) }
        assertTrue(comment.message!!.contains("comment was changed"))
    }

    @Test
    fun thePlaceholderIsNoKey() {
        assertNull(Minisign.readKey("# Conclave update key\nPLACEHOLDER\n"))
        assertNull(Minisign.readKey("# only comments\n"))
        assertNull(Minisign.readKey("not a key"))
        // the bare RWQ line is the same key
        val bare = Minisign.text(tauriPub).lines()[1]
        assertTrue(Minisign.readKey(bare)!!.key.contentEquals(Minisign.readKey(tauriPub)!!.key))
    }

    @Test
    fun versionsSortAsSemver() {
        assertEquals(1, AppUpdates.compareVersions("0.10.0", "0.9.9"))
        assertEquals(1, AppUpdates.compareVersions("1.0.0", "1.0.0-rc.2"))
        assertEquals(1, AppUpdates.compareVersions("1.0.0-rc.10", "1.0.0-rc.2"))
        assertEquals(0, AppUpdates.compareVersions("v0.4.1", "0.4.1"))
        assertTrue(AppUpdates.isNewer("0.5.0", "0.4.1"))
        // a test build and a debug build have their own key: never offered a release
        assertTrue(!AppUpdates.isNewer("9.9.9", "test-123"))
        assertTrue(!AppUpdates.isNewer("9.9.9", "0.4.1-debug"))
    }

    private fun manifest(signed: Boolean = true, android: UpdateArtifact? = UpdateArtifact("conclave-v0.5.0.apk", "https://example.com/conclave-v0.5.0.apk", "a".repeat(64), 10, "sig")) =
        UpdateManifest(schema = 1, version = "0.5.0", notes = "What changed", signed = signed, android = android)

    @Test
    fun theManifestAndWhatSettingsOffers() {
        val m = assertNotNull(AppUpdates.parse("""{"schema":1,"version":"0.5.0","notes":"n","signed":true,"hub":{},"android":{"file":"conclave-v0.5.0.apk","url":"https://x/a.apk","sha256":"${"b".repeat(64)}","size":5,"signature":"s"},"extra":1}"""))
        assertEquals("conclave-v0.5.0.apk", m.android?.file)
        assertNull(AppUpdates.parse("""{"schema":2,"version":"0.5.0"}"""))
        assertNull(AppUpdates.parse("not json"))
        val key = Minisign.readKey(tauriPub)
        assertIs<AppUpdates.Offer.Install>(AppUpdates.offer(manifest(), "0.4.1", key))
        assertNull(AppUpdates.offer(manifest(), "0.5.0", key))
        assertIs<AppUpdates.Offer.ByHand>(AppUpdates.offer(manifest(), "0.4.1", null))
        assertIs<AppUpdates.Offer.ByHand>(AppUpdates.offer(manifest(signed = false), "0.4.1", key))
        assertIs<AppUpdates.Offer.ByHand>(AppUpdates.offer(manifest(android = null), "0.4.1", key))
    }

    @Test
    fun aDownloadIsCheckedForSizeHashAndSignature() {
        val key = Minisign.readKey(tauriPub)!!
        val sha = hex(MessageDigest.getInstance("SHA-256").digest(data))
        val apk = UpdateArtifact("conclave-v0.5.0.apk", "https://x", sha, data.size.toLong(), tauriSig)
        AppUpdates.verify(ByteArrayInputStream(data), apk, key, JdkEd25519)
        assertTrue(assertFailsWith<SignatureException> { AppUpdates.verify(ByteArrayInputStream(data.copyOf(10)), apk, key, JdkEd25519) }.message!!.contains("cut off"))
        assertTrue(assertFailsWith<SignatureException> { AppUpdates.verify(ByteArrayInputStream(data), apk.copy(sha256 = "0".repeat(64)), key, JdkEd25519) }.message!!.contains("SHA-256"))
        assertTrue(assertFailsWith<SignatureException> { AppUpdates.verify(ByteArrayInputStream(data), apk.copy(signature = otherSig), key, JdkEd25519) }.message!!.contains("another key"))
    }

    @Test
    fun aColdStartLooksAtOnceAndComingBackAfterAnHour() {
        val t = 10L * AppUpdates.EVERY_MS
        assertEquals(60L * 60 * 1000, AppUpdates.EVERY_MS)
        assertTrue(AppUpdates.isDue(now = t, checkedAt = t, coldStart = true))
        assertTrue(!AppUpdates.isDue(now = t + AppUpdates.EVERY_MS - 1, checkedAt = t, coldStart = false))
        assertTrue(AppUpdates.isDue(now = t + AppUpdates.EVERY_MS, checkedAt = t, coldStart = false))
        assertTrue(AppUpdates.isDue(now = t, checkedAt = 0L, coldStart = false))
        // the clock went back
        assertTrue(AppUpdates.isDue(now = t, checkedAt = t + 5, coldStart = false))
    }
}
