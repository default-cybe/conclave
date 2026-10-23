package dev.conclave.client.update

import dev.conclave.client.Ed25519Verifier
import java.util.Base64

/*
 * minisign signatures as the Tauri updater makes them (`tauri signer sign`),
 * the same check as packages/core/src/update/minisign.ts and the Rust daemon:
 * a prehashed ("ED") Ed25519 signature of the file's BLAKE2b-512, and a second
 * signature over that signature and its trusted comment. The key is the one
 * in packages/core/src/update/update-key.pub, built into the app (BuildConfig).
 */

class MinisignKey(val keyId: ByteArray, val key: ByteArray)

class MinisignSignature(val keyId: ByteArray, val signature: ByteArray, val trusted: String, val global: ByteArray)

/** A signature that does not check out; the message says why, for people. */
class SignatureException(message: String) : Exception(message)

object Minisign {
    const val NO_KEY = "This build has no update key yet, so it installs no updates. Update by hand this time."

    private val B64 = Regex("^[A-Za-z0-9+/=_-]+$")

    private fun b64(s: String): ByteArray = try {
        Base64.getDecoder().decode(s.trim())
    } catch (_: IllegalArgumentException) {
        throw SignatureException("The signature is not base64.")
    }

    /** A key or signature file's text: as given, or Tauri's base64 of it. */
    fun text(input: String): String {
        val t = input.trim()
        if (t.contains("untrusted comment:", ignoreCase = true)) return t
        if (B64.matches(t)) {
            val decoded = try {
                String(Base64.getDecoder().decode(t), Charsets.UTF_8)
            } catch (_: IllegalArgumentException) {
                return t
            }
            if (decoded.trimStart().startsWith("untrusted comment:", ignoreCase = true)) return decoded.trim()
        }
        return t
    }

    /** The key line of an update-key.pub: the last line that is not empty or a # comment. */
    fun keyLine(file: String): String = file.lines().map { it.trim() }.lastOrNull { it.isNotEmpty() && !it.startsWith("#") } ?: ""

    /** The key in an update-key.pub text (or its key line), or null for the placeholder or a broken key. */
    fun readKey(file: String): MinisignKey? {
        val line = keyLine(file)
        if (line.isEmpty() || line.equals("placeholder", ignoreCase = true)) return null
        return try {
            parseKey(line)
        } catch (_: SignatureException) {
            null
        }
    }

    fun parseKey(input: String): MinisignKey {
        val line = text(input).lines().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("untrusted comment:", ignoreCase = true) }.orEmpty()
        val raw = b64(line)
        if (raw.size != 42 || raw[0] != 0x45.toByte() || raw[1] != 0x64.toByte()) throw SignatureException("The update key is not a minisign Ed25519 public key.")
        return MinisignKey(raw.copyOfRange(2, 10), raw.copyOfRange(10, 42))
    }

    fun parseSignature(input: String): MinisignSignature {
        val lines = text(input).lines()
        val at = lines.indexOfFirst { it.trim().startsWith("untrusted comment:", ignoreCase = true) }
        if (at < 0 || lines.size < at + 4) throw SignatureException("The signature is not a minisign signature.")
        val trustedLine = lines[at + 2].trimEnd('\r')
        if (!trustedLine.startsWith("trusted comment: ")) throw SignatureException("The signature has no trusted comment.")
        val raw = b64(lines[at + 1])
        if (raw.size != 74) throw SignatureException("The signature has the wrong length.")
        if (raw[0] == 0x45.toByte() && raw[1] == 0x64.toByte()) throw SignatureException("The signature is the legacy kind, which updates do not take.")
        if (raw[0] != 0x45.toByte() || raw[1] != 0x44.toByte()) throw SignatureException("The signature is not an Ed25519 minisign signature.")
        val global = b64(lines[at + 3])
        if (global.size != 64) throw SignatureException("The signature has a broken global signature.")
        return MinisignSignature(raw.copyOfRange(2, 10), raw.copyOfRange(10, 74), trustedLine.removePrefix("trusted comment: "), global)
    }

    /** Check a signature against the file's BLAKE2b-512. Returns the trusted comment; throws [SignatureException]. */
    fun verifyPrehashed(prehash: ByteArray, signature: String, key: MinisignKey, ed: Ed25519Verifier): String {
        val sig = parseSignature(signature)
        if (!sig.keyId.contentEquals(key.keyId)) throw SignatureException("The update was signed with another key than the one this app trusts.")
        if (!ed.verify(key.key, prehash, sig.signature)) throw SignatureException("The update signature does not match the file. Nothing was installed.")
        if (!ed.verify(key.key, sig.signature + sig.trusted.toByteArray(Charsets.UTF_8), sig.global)) throw SignatureException("The signature comment was changed. Nothing was installed.")
        return sig.trusted
    }

    fun verify(data: ByteArray, signature: String, key: MinisignKey, ed: Ed25519Verifier): String = verifyPrehashed(Blake2b512.hash(data), signature, key, ed)
}
